import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HarnessError, type RunnerConfig } from '@cloud-harness/contracts';
import { CODING_GIT_ARGS, CODING_GIT_ENV, type CodingGitCommit } from '../src/agent-governance/coding-git.js';
import { InMemoryGitHubInstallationStore } from '../src/github-installation-store.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const TREE = 'c'.repeat(40);

type DockerResult = { stdout: string; stderr: string; exitCode: number; truncated: boolean };
const ok = (stdout = '', truncated = false): DockerResult => ({ stdout, stderr: '', exitCode: 0, truncated });

const docker = vi.hoisted(() => ({
  runDocker: vi.fn(),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined)
}));

const broker = vi.hoisted(() => ({
  mintRepositoryToken: vi.fn(async () => undefined),
  mintPrincipalRepositoryToken: vi.fn(async () => 'write-token'),
  mintPrincipalRepositoryScopedToken: vi.fn()
}));

vi.mock('../src/docker-engine.js', () => docker);
vi.mock('../src/github-app-broker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubAppBroker>()),
  ...broker
}));
vi.mock('../src/repository-policy.js', () => ({ validateRepositoryUrl: vi.fn(async (value: string) => new URL(value)) }));

import type * as GitHubAppBroker from '../src/github-app-broker.js';
import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
const stores: StateStore[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** The transfer helper's mode is the first argument after the image name. */
function transferMode(args: readonly string[]): string | undefined {
  if (!args.includes('/opt/harness/git-transfer-helper.sh')) return undefined;
  return args[args.indexOf('executor') + 1];
}

function inspection(parents: string[], paths: string[]): string {
  const raw = [`tree ${TREE}`, ...parents.map((parent) => `parent ${parent}`), 'author A <a@example.com> 0 +0000', '', 'feat: change', ''].join('\n');
  return `${SHA}\n${Buffer.from(raw).toString('base64')}\npaths\n${paths.map((path) => `${path}\0`).join('')}`;
}

function fixture(overrides: Partial<WorkspaceRecord> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-coding-git-'));
  temporaryDirectories.push(directory);
  const workspaceId = `ws_${'d'.repeat(24)}`;
  const workspacePath = join(directory, 'jobs', workspaceId);
  mkdirSync(join(workspacePath, 'repo'), { recursive: true });
  const config = {
    authMode: 'cloudflare-access',
    host: '127.0.0.1', port: 3001, serviceToken: 'runner-token-that-is-longer-than-32-characters',
    jobsRoot: join(directory, 'jobs'), stateDb: join(directory, 'state.db'), executorImage: 'executor',
    allowedGitHosts: ['github.com'], networkProfile: 'network-none', wallTtlSeconds: 300, idleTtlSeconds: 180,
    maxOutputBytes: 262_144, minFreeBytes: 0, maxWorkspaceBytes: 1_048_576, reaperIntervalSeconds: 30,
    githubApp: { appId: 123, privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----', appSlug: 'cloud-harness-test' }
  } as RunnerConfig;
  const store = new StateStore(config.stateDb);
  stores.push(store);
  const principalSelector = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'user-a' };
  const principalId = store.resolveExternalPrincipal(principalSelector);
  const otherId = store.resolveExternalPrincipal({ ...principalSelector, subject: 'user-b' });
  const installations = new InMemoryGitHubInstallationStore();
  installations.replaceVerified(principalId, {
    appId: 123, installationId: 888, accountId: 789, accountLogin: 'bestagentkits', issues: null, pullRequests: null, status: 'active',
    repositories: [{ owner: 'bestagentkits', repository: 'githatch', contents: 'write' }]
  }, 1_000);
  const now = Date.now();
  const record: WorkspaceRecord = {
    id: workspaceId, ownerId: principalId, idempotencyKey: 'coding-git-test',
    repositoryUrl: 'https://github.com/bestagentkits/githatch.git', repositoryRef: null,
    containerName: 'executor-container', workspacePath, status: 'ACTIVE', networkProfile: 'network-none',
    createdAt: now, lastActivityAt: now, expiresAt: now + 60_000, generation: 1, error: null,
    ...overrides
  };
  store.create(record);
  const service = new WorkspaceService(config, store, undefined, installations);
  return { service, record, workspaceId, principalId, otherId, principalSelector };
}

describe('runCodingGit', () => {
  it('refuses a subcommand outside the inspection allowlist before touching Docker', async () => {
    const { service, principalId, workspaceId } = fixture();
    for (const subcommand of ['config', 'log', 'show', '-c', '']) {
      await expect(service.runCodingGit(principalId, workspaceId, [subcommand, 'HEAD'])).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(docker.runDocker).not.toHaveBeenCalled();
  });

  it('answers NOT_FOUND for another owner and for a workspace that is not active', async () => {
    const owned = fixture();
    await expect(owned.service.runCodingGit(owned.otherId, owned.workspaceId, ['rev-parse', 'HEAD'])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const closed = fixture({ status: 'CLOSED' as WorkspaceRecord['status'] });
    await expect(closed.service.runCodingGit(closed.principalId, closed.workspaceId, ['rev-parse', 'HEAD'])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(docker.runDocker).not.toHaveBeenCalled();
  });

  it('reads in a fresh hardened helper container with a clean Git environment, never in the executor', async () => {
    const { service, principalId, workspaceId, record } = fixture();
    docker.runDocker.mockResolvedValueOnce(ok(`${SHA}\n`, true));
    const result = await service.runCodingGit(principalId, workspaceId, ['rev-parse', '--verify', 'HEAD^{commit}']);
    expect(result).toEqual({ exitCode: 0, stdout: `${SHA}\n`, truncated: true });

    expect(docker.runDocker).toHaveBeenCalledTimes(1);
    const args = docker.runDocker.mock.calls[0]![0] as string[];
    expect(args[0]).toBe('run');
    expect(args).not.toContain('exec');
    expect(args).not.toContain('executor-container');
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(flag('--network')).toBe('none');
    expect(flag('--pull')).toBe('never');
    expect(flag('--user')).toBe('10001:10001');
    expect(flag('--cap-drop')).toBe('ALL');
    expect(flag('--security-opt')).toBe('no-new-privileges');
    expect(flag('--memory')).toBe(flag('--memory-swap'));
    expect(args).toContain('--read-only');
    expect(args).toContain('--pids-limit');
    expect(args).toContain(`${record.workspacePath}/repo:/workspace:ro`);
    const env = args.flatMap((value, index) => (args[index - 1] === '--env' ? [value] : []));
    expect(env).toEqual([...CODING_GIT_ENV]);
    const image = args.indexOf('executor');
    expect(args.slice(image + 1)).toEqual([...CODING_GIT_ARGS, 'rev-parse', '--verify', 'HEAD^{commit}']);

    expect(docker.removeContainer).toHaveBeenCalledWith(flag('--name'));
  });

  it('removes the helper container even when Docker fails', async () => {
    const { service, principalId, workspaceId } = fixture();
    docker.runDocker.mockRejectedValueOnce(new HarnessError('TIMEOUT', 'timed out', 504, true));
    await expect(service.runCodingGit(principalId, workspaceId, ['status'])).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(docker.removeContainer).toHaveBeenCalledTimes(1);
  });
});

describe('verified git_push', () => {
  function route(inspectStdout: string) {
    docker.runDocker.mockImplementation(async (args: string[]) => {
      if (args[0] === 'exec' && args.includes('rev-parse')) return ok(`${SHA}\n`);
      const mode = transferMode(args);
      if (mode === 'inspect') return ok(inspectStdout);
      if (mode === 'push') return ok(`To origin\n*\t${SHA}:refs/heads/feat\t[new branch]\nDone\n`);
      return ok();
    });
  }

  const modes = () => docker.runDocker.mock.calls.map(([args]) => transferMode(args as string[])).filter(Boolean);

  function push(service: WorkspaceService, selector: ReturnType<typeof fixture>['principalSelector'], workspaceId: string, verify: (commit: CodingGitCommit | null) => Promise<string | null>) {
    return service.execute(selector, 'git_push', { workspaceId, remote: 'origin', refspec: `${SHA}:refs/heads/feat`, expectedAbsent: true, forceWithLease: true }, undefined, {
      pushVerifier: { sha: SHA, base: BASE, verify }
    });
  }

  it('stages an isolated clone, inspects it, and pushes only after the verifier accepts', async () => {
    const { service, principalSelector, workspaceId } = fixture();
    route(inspection([BASE], ['src/app.ts']));
    const verify = vi.fn(async () => null);
    const result = await push(service, principalSelector, workspaceId, verify);

    expect(result.ok).toBe(true);
    expect(modes()).toEqual(['stage-push', 'inspect', 'push']);
    const stage = docker.runDocker.mock.calls.find(([args]) => transferMode(args as string[]) === 'stage-push')![0] as string[];
    expect(stage[stage.indexOf('stage-push') + 4]).toBe('isolated');
    const inspect = docker.runDocker.mock.calls.find(([args]) => transferMode(args as string[]) === 'inspect')![0] as string[];
    expect(inspect[inspect.indexOf('--network') + 1]).toBe('none');
    expect(verify).toHaveBeenCalledWith({ sha: SHA, parents: [BASE], message: 'feat: change\n', paths: ['src/app.ts'], truncated: false });
  });

  it('sends nothing when the verifier refuses what the transfer clone holds', async () => {
    const { service, principalSelector, workspaceId } = fixture();
    route(inspection([BASE], ['.github/workflows/ci.yml']));
    await expect(push(service, principalSelector, workspaceId, async () => 'PATH_OUT_OF_SCOPE'))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('PATH_OUT_OF_SCOPE') });
    expect(modes()).toEqual(['stage-push', 'inspect']);
    expect(broker.mintPrincipalRepositoryToken).toHaveBeenCalled();
  });

  it('treats a malformed inspection or a throwing verifier as an unverified commit', async () => {
    const { service, principalSelector, workspaceId } = fixture();
    route('not an inspection');
    const verify = vi.fn(async (commit: CodingGitCommit | null) => (commit ? null : 'COMMIT_UNVERIFIED'));
    await expect(push(service, principalSelector, workspaceId, verify)).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('COMMIT_UNVERIFIED') });
    expect(verify).toHaveBeenCalledWith(null);

    vi.clearAllMocks();
    route(inspection([BASE], ['src/app.ts']));
    await expect(push(service, principalSelector, workspaceId, async () => { throw new Error('boom'); }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('COMMIT_UNVERIFIED') });
    expect(modes()).not.toContain('push');
  });

  it('refuses a verified push whose source is not the verified commit', async () => {
    const { service, principalSelector, workspaceId } = fixture();
    route(inspection([BASE], []));
    await expect(service.execute(principalSelector, 'git_push', { workspaceId, remote: 'origin', refspec: 'HEAD:refs/heads/feat', expectedAbsent: true, forceWithLease: true }, undefined, {
      pushVerifier: { sha: SHA, base: BASE, verify: async () => null }
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(modes()).not.toContain('push');
  });

  it('keeps an ordinary push on the shared stage without an inspection', async () => {
    const { service, principalSelector, workspaceId } = fixture();
    route('');
    await service.execute(principalSelector, 'git_push', { workspaceId, remote: 'origin', refspec: `${SHA}:refs/heads/feat`, expectedAbsent: true, forceWithLease: true });
    expect(modes()).toEqual(['stage-push', 'push']);
    const stage = docker.runDocker.mock.calls.find(([args]) => transferMode(args as string[]) === 'stage-push')![0] as string[];
    expect(stage[stage.indexOf('stage-push') + 4]).toBe('');
  });
});
