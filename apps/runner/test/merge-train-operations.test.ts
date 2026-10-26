import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HarnessError, type RunnerConfig } from '@cloud-harness/contracts';
import { InMemoryGitHubInstallationStore } from '../src/github-installation-store.js';
import { MetadataStore } from '../src/metadata-store.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';
import type * as GitHubAppBroker from '../src/github-app-broker.js';

type DockerResult = { stdout: string; stderr: string; exitCode: number; truncated: boolean };
const ok = (stdout = ''): DockerResult => ({ stdout, stderr: '', exitCode: 0, truncated: false });
const LOCAL_HEAD = 'c'.repeat(40);
const REMOTE_OID = 'd'.repeat(40);

const docker = vi.hoisted(() => ({
  ghResult: { stdout: '{"ok":true}', stderr: '', exitCode: 0, truncated: false } as DockerResult,
  pushResults: [] as DockerResult[],
  probeResult: { stdout: '', stderr: '', exitCode: 0, truncated: false } as DockerResult,
  runDocker: vi.fn(async (args: string[]): Promise<DockerResult> => {
    if (args.includes('/opt/harness/gh-helper.sh')) return docker.ghResult;
    if (args.includes('/opt/harness/git-transfer-helper.sh') && args.includes('push')) {
      return docker.pushResults.shift() ?? { stdout: '', stderr: '', exitCode: 0, truncated: false };
    }
    if (args.includes('probe-helper')) return docker.probeResult;
    if (args[0] === 'exec' && args.includes('rev-parse')) return { stdout: `${'c'.repeat(40)}\n`, stderr: '', exitCode: 0, truncated: false };
    return { stdout: '', stderr: '', exitCode: 0, truncated: false };
  }),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined)
}));

const broker = vi.hoisted(() => ({
  mintRepositoryToken: vi.fn(async () => undefined),
  mintPrincipalRepositoryToken: vi.fn(async () => 'push-write-token'),
  mintPrincipalRepositoryScopedToken: vi.fn()
}));

vi.mock('../src/docker-engine.js', () => docker);
vi.mock('../src/github-app-broker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubAppBroker>()),
  ...broker
}));
vi.mock('../src/repository-policy.js', () => ({ validateRepositoryUrl: vi.fn(async (value: string) => new URL(value)) }));

import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
const openStores: StateStore[] = [];
const openMetadataStores: MetadataStore[] = [];
afterEach(() => {
  docker.ghResult = ok('{"ok":true}');
  docker.pushResults = [];
  docker.probeResult = ok();
  vi.clearAllMocks();
  for (const store of openStores.splice(0)) store.close();
  for (const metadata of openMetadataStores.splice(0)) metadata.database.close();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-merge-train-'));
  temporaryDirectories.push(directory);
  const workspaceId = `ws_${'e'.repeat(24)}`;
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
  openStores.push(store);
  const principalSelector = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'merge-train' };
  const principalId = store.resolveExternalPrincipal(principalSelector);
  const installations = new InMemoryGitHubInstallationStore();
  installations.replaceVerified(principalId, {
    appId: 123, installationId: 888, accountId: 789, accountLogin: 'bestagentkits', status: 'active',
    repositories: [{ owner: 'bestagentkits', repository: 'cloud-harness-mcp', contents: 'write' }]
  }, 1_000);
  const now = Date.now();
  const record: WorkspaceRecord = {
    id: workspaceId, ownerId: principalId, idempotencyKey: 'merge-train-test',
    repositoryUrl: 'https://github.com/bestagentkits/cloud-harness-mcp.git', repositoryRef: null,
    containerName: 'executor-container', workspacePath, status: 'ACTIVE', networkProfile: 'network-none',
    createdAt: now, lastActivityAt: now, expiresAt: now + 60_000, generation: 1, error: null
  };
  store.create(record);
  const metadata = new MetadataStore(config.stateDb);
  openMetadataStores.push(metadata);
  const service = new WorkspaceService(config, store, metadata, installations);
  return { service, metadata, workspaceId, principalId, principalSelector };
}

const helperArgs = (script: string, mode: string) => {
  const call = docker.runDocker.mock.calls.find(([args]) => args.includes(script) && args.includes(mode));
  if (!call) return undefined;
  const args = call[0];
  return args.slice(args.indexOf(mode));
};
const pushCalls = () => docker.runDocker.mock.calls.filter(([args]) => args.includes('/opt/harness/git-transfer-helper.sh') && args.includes('push'));
const scopedToken = (scope: string, level: 'read' | 'write') =>
  broker.mintPrincipalRepositoryScopedToken.mockResolvedValue({ token: `${scope}-${level}-token`, permissions: { [scope]: level, contents: 'read' } });

describe('merge-train GitHub actions', () => {
  it('creates a commit status with statuses:write, maps every field, and replays by idempotency key', async () => {
    const { service, metadata, workspaceId, principalId, principalSelector } = fixture();
    scopedToken('statuses', 'write');
    docker.ghResult = ok('{"id":1,"sha":"x","state":"pending","context":"merge-train"}');
    const input = {
      workspaceId, action: 'commit_status_create', sha: LOCAL_HEAD, state: 'pending', context: 'merge-train',
      description: 'Queued at position 2', targetUrl: 'https://ci.example.test/train/1', idempotencyKey: 'status-train-1'
    };
    expect((await service.execute(principalSelector, 'github_action', input)).ok).toBe(true);
    expect(broker.mintPrincipalRepositoryScopedToken).toHaveBeenCalledWith(expect.objectContaining({ permissionScope: 'statuses', requiredPermission: 'write' }));
    expect(helperArgs('/opt/harness/gh-helper.sh', 'commit_status_create')).toEqual(['commit_status_create', LOCAL_HEAD, 'pending', 'merge-train', 'Queued at position 2', 'https://ci.example.test/train/1']);

    docker.runDocker.mockClear();
    expect((await service.execute(principalSelector, 'github_action', input)).ok).toBe(true);
    expect(helperArgs('/opt/harness/gh-helper.sh', 'commit_status_create')).toBeUndefined();
    await expect(service.execute(principalSelector, 'github_action', { ...input, state: 'success' })).rejects.toMatchObject({ code: 'CONFLICT' });

    const audits = metadata.listAudit(principalId).filter((event) => event.action === 'github_action.commit_status_create');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toMatchObject({ sha: LOCAL_HEAD, statusContext: 'merge-train', success: true });
  });

  it('creates a check run with checks:write in the bound repository and replays it by idempotency key', async () => {
    const { service, metadata, workspaceId, principalId, principalSelector } = fixture();
    scopedToken('checks', 'write');
    docker.ghResult = ok('{"id":4242,"name":"Cloud Harness: Review","status":"in_progress","conclusion":null}');
    const input = {
      workspaceId, action: 'check_run_create', sha: LOCAL_HEAD, name: 'Cloud Harness: Review', externalId: 'wfl_1',
      title: 'Agent running', summary: 'The agent has started.', idempotencyKey: 'check-run-create-1'
    };
    expect(await service.execute(principalSelector, 'github_action', input)).toMatchObject({ ok: true, data: { output: expect.stringContaining('4242') } });
    expect(broker.mintPrincipalRepositoryScopedToken).toHaveBeenCalledWith(expect.objectContaining({ permissionScope: 'checks', requiredPermission: 'write' }));
    expect(helperArgs('/opt/harness/gh-helper.sh', 'check_run_create')).toEqual(['check_run_create', LOCAL_HEAD, 'Cloud Harness: Review', 'in_progress', '', 'wfl_1', 'Agent running', 'The agent has started.']);
    const helper = docker.runDocker.mock.calls.map(([args]) => args as string[]).find((args) => args.includes('check_run_create'))!;
    expect(helper).toContain('GH_REPO=bestagentkits/cloud-harness-mcp');
    expect(helper.join(' ')).not.toContain('checks-write-token');

    docker.runDocker.mockClear();
    expect((await service.execute(principalSelector, 'github_action', input)).ok).toBe(true);
    expect(helperArgs('/opt/harness/gh-helper.sh', 'check_run_create')).toBeUndefined();
    const audits = metadata.listAudit(principalId).filter((event) => event.action === 'github_action.check_run_create');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toMatchObject({ sha: LOCAL_HEAD, success: true });
  });

  it('completes a check run with checks:write and maps every field', async () => {
    const { service, metadata, workspaceId, principalId, principalSelector } = fixture();
    scopedToken('checks', 'write');
    await service.execute(principalSelector, 'github_action', {
      workspaceId, action: 'check_run_update', checkRunId: 4242, status: 'completed', conclusion: 'timed_out', title: 'Agent timed out', summary: 'Ran out of time.'
    });
    expect(broker.mintPrincipalRepositoryScopedToken).toHaveBeenCalledWith(expect.objectContaining({ permissionScope: 'checks', requiredPermission: 'write' }));
    expect(helperArgs('/opt/harness/gh-helper.sh', 'check_run_update')).toEqual(['check_run_update', '4242', 'completed', 'timed_out', 'Agent timed out', 'Ran out of time.']);
    expect(metadata.listAudit(principalId).find((event) => event.action === 'github_action.check_run_update')?.details)
      .toMatchObject({ checkRunId: 4242, conclusion: 'timed_out', success: true });
  });

  it('refuses a check run write the App installation cannot grant without running the helper', async () => {
    const { service, workspaceId, principalSelector } = fixture();
    broker.mintPrincipalRepositoryScopedToken.mockRejectedValueOnce(new HarnessError('FORBIDDEN', 'cannot grant', 403, false, { reason: 'permission_not_granted' }));
    await expect(service.execute(principalSelector, 'github_action', { workspaceId, action: 'check_run_update', checkRunId: 1, status: 'completed', conclusion: 'success' }))
      .rejects.toMatchObject({ code: 'GITHUB_PERMISSION_MISSING', retryable: false });
    expect(helperArgs('/opt/harness/gh-helper.sh', 'check_run_update')).toBeUndefined();
  });

  it('dispatches a workflow with actions:write and passes inputs as one JSON argument', async () => {
    const { service, workspaceId, principalSelector } = fixture();
    scopedToken('actions', 'write');
    const result = await service.execute(principalSelector, 'github_action', {
      workspaceId, action: 'workflow_dispatch', workflow: 'ci.yml', ref: 'refs/heads/dev', inputs: { train: '7' }, idempotencyKey: 'dispatch-1'
    });
    expect(result.ok).toBe(true);
    expect(broker.mintPrincipalRepositoryScopedToken).toHaveBeenCalledWith(expect.objectContaining({ permissionScope: 'actions', requiredPermission: 'write' }));
    expect(helperArgs('/opt/harness/gh-helper.sh', 'workflow_dispatch')).toEqual(['workflow_dispatch', 'ci.yml', 'refs/heads/dev', '{"train":"7"}']);
  });

  it('re-runs failed jobs with actions:write', async () => {
    const { service, workspaceId, principalSelector } = fixture();
    scopedToken('actions', 'write');
    await service.execute(principalSelector, 'github_action', { workspaceId, action: 'workflow_run_rerun_failed', runId: 9001, idempotencyKey: 'rerun-run-9001' });
    expect(helperArgs('/opt/harness/gh-helper.sh', 'workflow_run_rerun_failed')).toEqual(['workflow_run_rerun_failed', '9001']);
  });

  it('serves the merge-train reads through github_read with the narrowest scope', async () => {
    const { service, workspaceId, principalSelector } = fixture();
    const cases: Array<[Record<string, unknown>, string, string[]]> = [
      [{ action: 'workflow_runs_list', workflow: 'ci.yml', headSha: LOCAL_HEAD, event: 'workflow_dispatch', limit: 5 }, 'actions', ['workflow_runs_list', '5', 'ci.yml', LOCAL_HEAD, '', 'workflow_dispatch', '']],
      [{ action: 'workflow_run_view', runId: 9001 }, 'actions', ['workflow_run_view', '9001']],
      [{ action: 'commit_status_get', sha: LOCAL_HEAD }, 'statuses', ['commit_status_get', LOCAL_HEAD]],
      [{ action: 'check_runs_list', sha: LOCAL_HEAD, checkName: 'build' }, 'checks', ['check_runs_list', LOCAL_HEAD]],
      [{ action: 'pr_reviews', prNumber: 12 }, 'pull_requests', ['pr_reviews', '12']],
      [{ action: 'ref_get', ref: 'refs/heads/merge-lock' }, 'contents', ['ref_get', 'refs/heads/merge-lock']]
    ];
    for (const [input, scope, argsPrefix] of cases) {
      docker.runDocker.mockClear();
      broker.mintPrincipalRepositoryScopedToken.mockClear();
      scopedToken(scope, 'read');
      expect((await service.execute(principalSelector, 'github_read', { workspaceId, ...input })).ok).toBe(true);
      expect(broker.mintPrincipalRepositoryScopedToken).toHaveBeenCalledWith(expect.objectContaining({ permissionScope: scope, requiredPermission: 'read' }));
      expect(helperArgs('/opt/harness/gh-helper.sh', argsPrefix[0]!)?.slice(0, argsPrefix.length)).toEqual(argsPrefix);
    }
  });

  it('keeps merge-train writes off github_read', async () => {
    const { service, workspaceId, principalSelector } = fixture();
    await expect(service.execute(principalSelector, 'github_read', { workspaceId, action: 'workflow_dispatch', workflow: 'ci.yml', ref: 'main' })).rejects.toThrow();
    expect(broker.mintPrincipalRepositoryScopedToken).not.toHaveBeenCalled();
  });
});

describe('git_push atomic ref leases', () => {
  it('passes a create-only lease and a delete-if-match refspec to the transfer helper', async () => {
    const { service, workspaceId, principalSelector } = fixture();
    await service.execute(principalSelector, 'git_push', { workspaceId, refspec: 'HEAD:merge-lock', forceWithLease: true, expectedAbsent: true });
    expect(helperArgs('/opt/harness/git-transfer-helper.sh', 'push')?.slice(-3, -1)).toEqual(['HEAD:refs/heads/merge-lock', 'absent']);

    docker.runDocker.mockClear();
    await service.execute(principalSelector, 'git_push', { workspaceId, refspec: 'merge-lock', forceWithLease: true, expectedRemoteOid: REMOTE_OID, delete: true });
    expect(helperArgs('/opt/harness/git-transfer-helper.sh', 'push')?.slice(-3, -1)).toEqual([':refs/heads/merge-lock', REMOTE_OID]);
  });

  it('pushes a fully qualified source without a destination to the same branch', async () => {
    const { service, workspaceId, principalSelector } = fixture();
    await service.execute(principalSelector, 'git_push', { workspaceId, refspec: 'refs/heads/feature' });
    expect(helperArgs('/opt/harness/git-transfer-helper.sh', 'push')?.at(-3)).toBe('refs/heads/feature:refs/heads/feature');

    docker.runDocker.mockClear();
    await service.execute(principalSelector, 'git_push', { workspaceId, refspec: 'feature' });
    expect(helperArgs('/opt/harness/git-transfer-helper.sh', 'push')?.at(-3)).toBe('feature:refs/heads/feature');
  });

  it('reports a lease collision as a non-retryable CONFLICT', async () => {
    const { service, workspaceId, principalSelector } = fixture();
    // Real `push --porcelain` output: the ref status line goes to stdout, only the summary to stderr.
    docker.pushResults = [{ stdout: 'To https://github.com/acme/widgets.git\n!\tHEAD:refs/heads/merge-lock\t[rejected] (stale info)\nDone\n', stderr: 'error: failed to push some refs to \'https://github.com/acme/widgets.git\'\n', exitCode: 1, truncated: false }];
    await expect(service.execute(principalSelector, 'git_push', { workspaceId, refspec: 'HEAD:merge-lock', forceWithLease: true, expectedAbsent: true }))
      .rejects.toMatchObject({ code: 'CONFLICT', retryable: false });
  });

  it('reports a protected-branch refusal as FORBIDDEN instead of a retryable transport failure', async () => {
    const { service, workspaceId, principalSelector } = fixture();
    docker.pushResults = [{ stdout: 'To https://github.com/acme/widgets.git\n!\tHEAD:refs/heads/dev\t[remote rejected] (protected branch hook declined)\nDone\n', stderr: 'remote: error: GH006: Protected branch update failed for refs/heads/dev.\n' + 'error: failed to push some refs to \'https://github.com/acme/widgets.git\'\n', exitCode: 1, truncated: false }];
    await expect(service.execute(principalSelector, 'git_push', { workspaceId, refspec: 'HEAD:dev' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', retryable: false });

    docker.pushResults = [{ stdout: "To https://github.com/acme/widgets.git\n!\tHEAD:refs/heads/dev\t[remote rejected] (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)\nDone\n", stderr: 'error: failed to push some refs to \'https://github.com/acme/widgets.git\'\n', exitCode: 1, truncated: false }];
    await expect(service.execute(principalSelector, 'git_push', { workspaceId, refspec: 'HEAD:dev' }))
      .rejects.toMatchObject({ code: 'GITHUB_PERMISSION_MISSING' });
  });

  it('reports a create-only push onto a branch that already holds the commit as CONFLICT', async () => {
    const { service, workspaceId, principalSelector } = fixture();
    docker.pushResults = [{ stdout: 'To https://github.com/acme/widgets.git\n=\tHEAD:refs/heads/merge-lock\t[up to date]\nDone\n', stderr: 'lease rejected: refs/heads/merge-lock already holds the pushed commit\n', exitCode: 1, truncated: false }];
    await expect(service.execute(principalSelector, 'git_push', { workspaceId, refspec: 'HEAD:merge-lock', forceWithLease: true, expectedAbsent: true }))
      .rejects.toMatchObject({ code: 'CONFLICT', retryable: false });
  });

  it('classifies a ruleset refusal on a release branch as FORBIDDEN, not a lease conflict', async () => {
    const { service, workspaceId, principalSelector } = fixture();
    docker.pushResults = [{
      stdout: 'To https://github.com/acme/widgets.git\n!\tHEAD:refs/heads/release/1.2\t[remote rejected] (push declined due to repository rule violations)\nDone\n',
      stderr: 'remote: error: GH013: Repository rule violations found for refs/heads/release/1.2.\nerror: failed to push some refs\n',
      exitCode: 1,
      truncated: false
    }];
    await expect(service.execute(principalSelector, 'git_push', { workspaceId, refspec: 'HEAD:release/1.2' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', retryable: false });
  });

  it('keeps a lease conflict on a GH-numbered branch in a gh-named repository a CONFLICT', async () => {
    const { service, workspaceId, principalSelector } = fixture();
    docker.pushResults = [{
      stdout: 'To https://github.com/acme/gh007.git\n!\tHEAD:refs/heads/GH001-lock\t[rejected] (stale info)\nDone\n',
      stderr: 'error: failed to push some refs to \'https://github.com/acme/gh007.git\'\n',
      exitCode: 1,
      truncated: false
    }];
    await expect(service.execute(principalSelector, 'git_push', { workspaceId, refspec: 'HEAD:GH001-lock', forceWithLease: true, expectedAbsent: true }))
      .rejects.toMatchObject({ code: 'CONFLICT', retryable: false });
  });

  it('reports a push source missing from the staged clone as non-retryable INVALID_INPUT', async () => {
    const { service, workspaceId, principalSelector } = fixture();
    docker.pushResults = [{ stdout: '', stderr: 'error: src refspec origin/feature does not match any\nerror: failed to push some refs\n', exitCode: 1, truncated: false }];
    await expect(service.execute(principalSelector, 'git_push', { workspaceId, refspec: 'origin/feature:feature' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', retryable: false });
  });

  it('reconciles a lock pushed from a branch other than HEAD against that branch commit', async () => {
    const { service, workspaceId, principalSelector } = fixture();
    const input = { workspaceId, refspec: 'lock-holder-7:merge-lock', forceWithLease: true, expectedAbsent: true, idempotencyKey: 'merge-lock-4' };
    docker.pushResults = [{ stdout: '', stderr: 'fatal: Connection timed out', exitCode: 128, truncated: false }];
    await expect(service.execute(principalSelector, 'git_push', input)).rejects.toMatchObject({ code: 'UNKNOWN_REMOTE_STATE' });
    const revParse = docker.runDocker.mock.calls.map(([args]) => args as string[]).find((args) => args.includes('rev-parse'));
    expect(revParse?.slice(-3)).toEqual(['--verify', '--quiet', 'lock-holder-7^{commit}']);

    docker.probeResult = ok(`${LOCAL_HEAD}\trefs/heads/merge-lock\n`);
    expect(await service.execute(principalSelector, 'git_push', input)).toMatchObject({ ok: true, data: { alreadyFinalized: true } });
  });

  it('reconciles an interrupted create-only push from the remote value', async () => {
    const { service, workspaceId, principalSelector } = fixture();
    const input = { workspaceId, refspec: 'HEAD:merge-lock', forceWithLease: true, expectedAbsent: true, idempotencyKey: 'merge-lock-1' };
    docker.pushResults = [{ stdout: '', stderr: 'fatal: unable to access: Connection timed out', exitCode: 128, truncated: false }];
    await expect(service.execute(principalSelector, 'git_push', input)).rejects.toMatchObject({ code: 'UNKNOWN_REMOTE_STATE' });

    // The remote now holds this workspace's commit, so the push landed before the connection dropped.
    docker.probeResult = ok(`${LOCAL_HEAD}\trefs/heads/merge-lock\n`);
    const replay = await service.execute(principalSelector, 'git_push', input);
    expect(replay).toMatchObject({ ok: true, data: { alreadyFinalized: true } });
    expect(pushCalls()).toHaveLength(1);
  });

  it('turns an interrupted create-only push into CONFLICT when another holder owns the ref', async () => {
    const { service, workspaceId, principalSelector } = fixture();
    const input = { workspaceId, refspec: 'HEAD:merge-lock', forceWithLease: true, expectedAbsent: true, idempotencyKey: 'merge-lock-2' };
    docker.pushResults = [{ stdout: '', stderr: 'fatal: Connection reset by peer', exitCode: 128, truncated: false }];
    await expect(service.execute(principalSelector, 'git_push', input)).rejects.toMatchObject({ code: 'UNKNOWN_REMOTE_STATE' });
    docker.probeResult = ok(`${REMOTE_OID}\trefs/heads/merge-lock\n`);
    await expect(service.execute(principalSelector, 'git_push', input)).rejects.toMatchObject({ code: 'CONFLICT', currentRemoteOid: REMOTE_OID, retryable: false });
  });

  it('retries an interrupted create-only push while the ref is still absent', async () => {
    const { service, workspaceId, principalSelector } = fixture();
    const input = { workspaceId, refspec: 'HEAD:merge-lock', forceWithLease: true, expectedAbsent: true, idempotencyKey: 'merge-lock-3' };
    docker.pushResults = [{ stdout: '', stderr: 'fatal: Connection timed out', exitCode: 128, truncated: false }];
    await expect(service.execute(principalSelector, 'git_push', input)).rejects.toMatchObject({ code: 'UNKNOWN_REMOTE_STATE' });
    docker.probeResult = ok('');
    expect((await service.execute(principalSelector, 'git_push', input)).ok).toBe(true);
    expect(pushCalls()).toHaveLength(2);
  });

  it('treats an interrupted delete as complete once the ref is gone', async () => {
    const { service, workspaceId, principalSelector } = fixture();
    const input = { workspaceId, refspec: 'merge-lock', forceWithLease: true, expectedRemoteOid: REMOTE_OID, delete: true, idempotencyKey: 'merge-unlock-1' };
    docker.pushResults = [{ stdout: '', stderr: 'fatal: Connection timed out', exitCode: 128, truncated: false }];
    await expect(service.execute(principalSelector, 'git_push', input)).rejects.toMatchObject({ code: 'UNKNOWN_REMOTE_STATE' });
    docker.probeResult = ok('');
    expect(await service.execute(principalSelector, 'git_push', input)).toMatchObject({ ok: true, data: { alreadyFinalized: true } });
    expect(pushCalls()).toHaveLength(1);
  });
});
