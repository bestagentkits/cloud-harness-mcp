import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const repositoryToken = 'repository-write-token-that-must-not-leak';
const docker = vi.hoisted(() => ({
  runDocker: vi.fn(async (args: string[]) => {
    if (args.includes('/opt/harness/worker-runner.sh')) {
      return { stdout: JSON.stringify({ ok: true, message: 'worker complete', data: { output: 'worker-ok' }, truncated: false }), stderr: '', exitCode: 0, truncated: false };
    }
    return { stdout: args[0] === 'exec' && args.includes('--show-current') ? 'main\n' : '', stderr: '', exitCode: 0, truncated: false };
  }),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined)
}));

vi.mock('../src/docker-engine.js', () => docker);
vi.mock('../src/repository-policy.js', () => ({ validateRepositoryUrl: vi.fn(async (value: string) => new URL(value)) }));
vi.mock('../src/github-app-broker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubAppBroker>()),
  mintRepositoryToken: vi.fn(async () => repositoryToken)
}));

import type * as GitHubAppBroker from '../src/github-app-broker.js';
import { WorkspaceService, gitTransferVolumes } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(idCharacter: string) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-git-transfer-'));
  temporaryDirectories.push(directory);
  const workspaceId = `ws_${idCharacter.repeat(24)}`;
  const workspacePath = join(directory, 'jobs', workspaceId);
  mkdirSync(join(workspacePath, 'repo'), { recursive: true });
  const config: RunnerConfig = {
    host: '127.0.0.1', port: 3001, serviceToken: 'runner-test-token-that-is-longer-than-32-characters',
    jobsRoot: join(directory, 'jobs'), stateDb: join(directory, 'state.db'), executorImage: 'executor',
    allowedGitHosts: ['github.com'], networkProfile: 'network-none', wallTtlSeconds: 300, idleTtlSeconds: 180,
    maxOutputBytes: 262_144, minFreeBytes: 0, maxWorkspaceBytes: 536_870_912, reaperIntervalSeconds: 30,
    githubApp: { appId: 123, installationId: 456, privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----' }
  };
  const store = new StateStore(config.stateDb);
  const now = Date.now();
  const record: WorkspaceRecord = {
    id: workspaceId, ownerId: 'owner', idempotencyKey: `git-transfer-${idCharacter}`,
    repositoryUrl: 'https://github.com/example/private-repo.git', repositoryRef: null,
    containerName: 'executor-container', workspacePath, status: 'ACTIVE', networkProfile: 'network-none',
    createdAt: now, lastActivityAt: now, expiresAt: now + 60_000, generation: 1, error: null
  };
  store.create(record);
  return { workspaceId, store, service: new WorkspaceService(config, store) };
}

describe('remote Git credential boundary', () => {
  it('passes the write token only to the credentialed push helper over stdin', async () => {
    const { workspaceId, store, service } = fixture('a');
    try {
      const result = await service.execute('owner', 'git_push', { workspaceId, remote: 'origin', forceWithLease: false });
      expect(result.ok).toBe(true);
      expect(JSON.stringify(result)).not.toContain(repositoryToken);
      expect(JSON.stringify(docker.runDocker.mock.calls.map(([args]) => args))).not.toContain(repositoryToken);
      const credentialCalls = docker.runDocker.mock.calls.filter(([, options]) => options?.stdin === `${repositoryToken}\n`);
      expect(credentialCalls).toHaveLength(1);
      expect(credentialCalls[0]?.[0]).toEqual(expect.arrayContaining(['/opt/harness/git-transfer-helper.sh', 'executor', 'push']));
      expect(docker.removeContainer).toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
  it('normalizes shorthand refspecs to canonical destination refs', async () => {
    const { workspaceId, store, service } = fixture('c');
    try {
      const result = await service.execute('owner', 'git_push', { workspaceId, remote: 'origin', refspec: 'HEAD:main', forceWithLease: false });
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ refspec: 'HEAD:refs/heads/main' });
      const pushCall = docker.runDocker.mock.calls.find(([args]) => args.includes('push') && args.includes('/opt/harness/git-transfer-helper.sh'));
      expect(pushCall?.[0]).toContain('HEAD:refs/heads/main');
    } finally {
      store.close();
    }
  });


  it('mounts each transfer helper on its own transfer repository, never the whole workspace', async () => {
    const { workspaceId, store, service } = fixture('d');
    try {
      const workspacePath = store.byId(workspaceId)!.workspacePath;
      await service.execute('owner', 'git_push', { workspaceId, remote: 'origin', forceWithLease: false });
      await service.execute('owner', 'git_fetch', { workspaceId, remote: 'origin', branch: 'main' });
      const helperCalls = docker.runDocker.mock.calls.map(([args]) => args).filter((args) => args.includes('/opt/harness/git-transfer-helper.sh'));
      const volumes = (args: string[]) => args.flatMap((value, index) => args[index - 1] === '--volume' ? [value] : []);
      const byMode = (mode: string) => helperCalls.find((args) => args[args.indexOf('executor') + 1] === mode)!;
      const transferOf = (args: string[]) => args[args.indexOf('executor') + 4]!;
      for (const args of helperCalls) expect(volumes(args).some((volume) => volume.startsWith(`${workspacePath}:`))).toBe(false);

      const staged = transferOf(byMode('stage-push'));
      const stagedDirectory = staged.slice(0, -'/repository.git'.length);
      const hostOf = (directory: string) => `${workspacePath}${directory.slice('/job'.length)}`;
      expect(staged).toMatch(/^\/job\/git-transfer-[0-9a-f]{24}\/repository\.git$/);
      expect(transferOf(byMode('push'))).toBe(staged);
      expect(volumes(byMode('stage-push'))).toEqual([`${workspacePath}/repo:/job/repo:ro`, `${hostOf(stagedDirectory)}:${stagedDirectory}:rw`]);
      expect(volumes(byMode('push'))).toEqual([`${hostOf(stagedDirectory)}:${stagedDirectory}:rw`]);

      const fetched = transferOf(byMode('fetch'));
      const fetchedDirectory = fetched.slice(0, -'/repository.git'.length);
      expect(fetchedDirectory).not.toBe(stagedDirectory);
      expect(volumes(byMode('fetch'))).toEqual([`${hostOf(fetchedDirectory)}:${fetchedDirectory}:rw`]);
      expect(volumes(byMode('import'))).toEqual([`${workspacePath}/repo:/job/repo:rw`, `${hostOf(fetchedDirectory)}:${fetchedDirectory}:ro`]);
      expect(JSON.stringify(volumes(byMode('import')))).not.toContain(stagedDirectory);
    } finally {
      store.close();
    }
  });

  it('binds the checkout tree root, never a scoped checkout path the executor could swap for a symlink', () => {
    for (const mode of ['fetch', 'import', 'stage-push', 'inspect', 'push'] as const) {
      const sources = gitTransferVolumes(mode, '/jobs/ws_a', 'git-transfer-x').filter((value) => value !== '--volume').map((value) => value.split(':')[0]);
      for (const source of sources) expect(['/jobs/ws_a/repo', '/jobs/ws_a/git-transfer-x']).toContain(source);
    }
    // An inspection only reads the staged clone, so it mounts that alone and read-only.
    expect(gitTransferVolumes('inspect', '/jobs/ws_a', 'git-transfer-x')).toEqual(['--volume', '/jobs/ws_a/git-transfer-x:/job/git-transfer-x:ro']);
  });

  it('orchestrates pull as credentialed fetch plus uncredentialed rebase inside the executor', async () => {
    const { workspaceId, store, service } = fixture('b');
    try {
      const result = await service.execute('owner', 'git_pull', { workspaceId, remote: 'origin', branch: 'main', strategy: 'rebase' });
      expect(result.ok).toBe(true);
      const calls = docker.runDocker.mock.calls;
      expect(calls.some(([args]) => args.includes('fetch'))).toBe(true);
      expect(calls.some(([args]) => args.includes('import'))).toBe(true);
      const workerCall = calls.find(([args]) => args.includes('/opt/harness/worker-runner.sh'));
      expect(workerCall?.[1]?.stdin).toContain('"operation":"git_rebase"');
      expect(workerCall?.[1]?.stdin).toContain('"upstream":"FETCH_HEAD"');
      expect(JSON.stringify(calls.map(([args]) => args))).not.toContain(repositoryToken);
      expect(calls.filter(([, options]) => options?.stdin === `${repositoryToken}\n`)).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
