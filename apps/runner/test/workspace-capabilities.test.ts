import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HarnessError, type RunnerConfig } from '@cloud-harness/contracts';
import { InMemoryGitHubInstallationStore } from '../src/github-installation-store.js';
import { MetadataStore } from '../src/metadata-store.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';
import type * as GitHubAppBroker from '../src/github-app-broker.js';

const docker = vi.hoisted(() => ({
  runDocker: vi.fn(async (args: string[]) => {
    if (args.includes('/opt/harness/worker-runner.sh')) {
      return { stdout: JSON.stringify({ ok: true, message: 'worker complete', data: { output: 'ok' }, truncated: false }), stderr: '', exitCode: 0, truncated: false };
    }
    if (args.includes('branch') && args.includes('--show-current')) {
      return { stdout: 'main\n', stderr: '', exitCode: 0, truncated: false };
    }
    if (args.includes('/opt/harness/git-transfer-helper.sh')) {
      return { stdout: 'push-ok', stderr: '', exitCode: 0, truncated: false };
    }
    return { stdout: '', stderr: '', exitCode: 0, truncated: false };
  }),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined)
}));

const broker = vi.hoisted(() => ({
  mintRepositoryToken: vi.fn(async () => undefined),
  mintPrincipalRepositoryToken: vi.fn(),
  mintPrincipalRepositoryScopedToken: vi.fn()
}));

vi.mock('../src/docker-engine.js', () => docker);
vi.mock('../src/github-app-broker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubAppBroker>()),
  mintRepositoryToken: broker.mintRepositoryToken,
  mintPrincipalRepositoryToken: broker.mintPrincipalRepositoryToken,
  mintPrincipalRepositoryScopedToken: broker.mintPrincipalRepositoryScopedToken
}));
vi.mock('../src/repository-policy.js', () => ({ validateRepositoryUrl: vi.fn(async (value: string) => new URL(value)) }));

import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
const openStores: StateStore[] = [];
const openMetadataStores: MetadataStore[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const metadata of openMetadataStores.splice(0)) {
    try { metadata.database.close(); } catch { /* ignore */ }
  }
  for (const store of openStores.splice(0)) {
    try { store.close(); } catch { /* ignore */ }
  }
  for (const path of temporaryDirectories.splice(0)) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function createFixture(options: { authMode?: 'owner-bearer' | 'cloudflare-access'; githubApp?: RunnerConfig['githubApp']; githubToken?: string; githubSecret?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ch-cap-test-'));
  temporaryDirectories.push(directory);
  const workspaceId = `ws_${'c'.repeat(24)}`;
  const workspacePath = join(directory, 'jobs', workspaceId);
  mkdirSync(join(workspacePath, 'repo'), { recursive: true });

  const config: RunnerConfig = {
    authMode: options.authMode ?? 'owner-bearer',
    host: '127.0.0.1',
    port: 3001,
    serviceToken: 'runner-token-that-is-longer-than-32-characters',
    jobsRoot: join(directory, 'jobs'),
    stateDb: join(directory, 'state.db'),
    executorImage: 'executor',
    allowedGitHosts: ['github.com'],
    networkProfile: 'network-none',
    wallTtlSeconds: 300,
    idleTtlSeconds: 180,
    maxOutputBytes: 262_144,
    minFreeBytes: 0,
    maxWorkspaceBytes: 1_048_576,
    reaperIntervalSeconds: 30,
    githubApp: options.githubApp,
    githubToken: options.githubToken
  };

  const store = new StateStore(config.stateDb);
  openStores.push(store);
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'principal_1' });
  let metadata: MetadataStore | undefined;
  if (options.githubSecret) {
    metadata = new MetadataStore(config.stateDb, new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]));
    openMetadataStores.push(metadata);
    metadata.createGlobalSecret(ownerId, 'GH_TOKEN', options.githubSecret, 0, null, 'runtime');
  }
  const installations = new InMemoryGitHubInstallationStore();
  const service = new WorkspaceService(config, store, metadata, installations);
  const now = Date.now();
  const record: WorkspaceRecord = {
    id: workspaceId,
    ownerId,
    idempotencyKey: 'idemp-1',
    repositoryUrl: 'https://github.com/test-org/test-repo.git',
    repositoryRef: 'main',
    containerName: 'cont_1',
    workspacePath,
    status: 'ACTIVE',
    networkProfile: 'network-none',
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + 180_000,
    hardExpiresAt: now + 300_000,
    gitAuthorName: 'Test Dev',
    gitAuthorEmail: 'dev@test.org',
    mutationLockedUntil: null,
    generation: 1,
    error: null
  };
  store.create(record);

  return { config, store, installations, service, record, workspaceId, ownerId };
}

describe('Workspace Capabilities and Authorization Preflight', () => {
  it('computes full write capabilities in owner-bearer mode when githubApp installation is configured', async () => {
    const { service, workspaceId } = createFixture({
      authMode: 'owner-bearer',
      githubApp: {
        appId: 123,
        installationId: 456,
        privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
        appSlug: 'test-app'
      }
    });

    const res = await service.execute('principal_1', 'workspace_capabilities', { workspaceId });
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;
    expect(data.workspaceId).toBe(workspaceId);
    expect(data.repository).toBe('test-org/test-repo');

    const capabilities = data.capabilities as { repository: Record<string, boolean>; workspace: Record<string, unknown> };
    expect(capabilities.repository.read).toBe(true);
    expect(capabilities.repository.push).toBe(true);
    expect(capabilities.repository.issuesRead).toBe(true);
    expect(capabilities.repository.issuesWrite).toBe(true);
    expect(capabilities.repository.pullRequestsRead).toBe(true);
    expect(capabilities.repository.pullRequestsWrite).toBe(true);

    const permissions = data.permissions as { contents: { read: boolean; write: boolean }; issues: { read: boolean; write: boolean }; pullRequests: { read: boolean; write: boolean } };
    expect(permissions.contents.read).toBe(true);
    expect(permissions.contents.write).toBe(true);
    expect(permissions.issues.write).toBe(true);
    expect(permissions.pullRequests.write).toBe(true);

    const operations = data.operations as Record<string, boolean>;
    expect(operations.gitFetch).toBe(true);
    expect(operations.gitPush).toBe(true);
    expect(operations.issueCreate).toBe(true);
    expect(operations.pullRequestCreate).toBe(true);
  });

  it('computes read-only capabilities in owner-bearer mode when no githubApp installation is configured', async () => {
    const { service, workspaceId } = createFixture({
      authMode: 'owner-bearer'
    });

    const res = await service.execute('principal_1', 'workspace_capabilities', { workspaceId });
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;

    const capabilities = data.capabilities as { repository: Record<string, boolean> };
    expect(capabilities.repository.read).toBe(true);
    expect(capabilities.repository.push).toBe(false);
    expect(capabilities.repository.issuesRead).toBe(false);
    expect(capabilities.repository.issuesWrite).toBe(false);
    expect(capabilities.repository.pullRequestsRead).toBe(false);
    expect(capabilities.repository.pullRequestsWrite).toBe(false);

    const operations = data.operations as Record<string, boolean>;
    expect(operations.gitPush).toBe(false);
    expect(operations.issueCreate).toBe(false);
    expect(operations.pullRequestCreate).toBe(false);
  });

  it('enforces structured error when git_push is attempted without write authorization', async () => {
    const { service, workspaceId } = createFixture({
      authMode: 'owner-bearer'
    });

    try {
      await service.execute('principal_1', 'git_push', { workspaceId });
      expect.unreachable('git_push should have thrown');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(HarnessError);
      const harnessErr = err as HarnessError;
      expect(harnessErr.code).toBe('REPOSITORY_OPERATION_NOT_AUTHORIZED');
      expect(harnessErr.operation).toBe('git_push');
      expect(harnessErr.repository).toBe('test-org/test-repo');
      expect(harnessErr.requiredCapability).toBe('repository.push');
    }
  });

  it('computes permissions accurately in cloudflare-access mode based on repository grants', async () => {
    const { service, installations, workspaceId, ownerId } = createFixture({
      authMode: 'cloudflare-access',
      githubApp: {
        appId: 100,
        privateKey: 'key',
        appSlug: 'test-app'
      }
    });

    // 1. Initial state: no grant
    const resNoGrant = await service.execute('principal_1', 'workspace_capabilities', { workspaceId });
    const dataNoGrant = resNoGrant.data as { capabilities: { repository: Record<string, boolean> } };
    expect(dataNoGrant.capabilities.repository.push).toBe(false);
    expect(dataNoGrant.capabilities.repository.issuesWrite).toBe(false);

    // 2. Add verified read-only grant
    installations.replaceVerified(ownerId, {
      appId: 100,
      installationId: 'inst_1',
      accountId: 'acc_1',
      accountLogin: 'test-org',
      status: 'active',
      issues: 'read',
      pullRequests: 'read',
      repositories: [
        { owner: 'test-org', repository: 'test-repo', contents: 'read' }
      ]
    }, Date.now());

    const resReadGrant = await service.execute('principal_1', 'workspace_capabilities', { workspaceId });
    const dataReadGrant = resReadGrant.data as { capabilities: { repository: Record<string, boolean> } };
    expect(dataReadGrant.capabilities.repository.read).toBe(true);
    expect(dataReadGrant.capabilities.repository.push).toBe(false);
    expect(dataReadGrant.capabilities.repository.issuesRead).toBe(true);
    expect(dataReadGrant.capabilities.repository.issuesWrite).toBe(false);

    // 3. Update to write grant
    installations.replaceVerified(ownerId, {
      appId: 100,
      installationId: 'inst_1',
      accountId: 'acc_1',
      accountLogin: 'test-org',
      status: 'active',
      issues: 'write',
      pullRequests: 'write',
      repositories: [
        { owner: 'test-org', repository: 'test-repo', contents: 'write' }
      ]
    }, Date.now());

    const resWriteGrant = await service.execute('principal_1', 'workspace_capabilities', { workspaceId });
    const dataWriteGrant = resWriteGrant.data as { capabilities: { repository: Record<string, boolean> } };
    expect(dataWriteGrant.capabilities.repository.read).toBe(true);
    expect(dataWriteGrant.capabilities.repository.push).toBe(true);
    expect(dataWriteGrant.capabilities.repository.issuesRead).toBe(true);
    expect(dataWriteGrant.capabilities.repository.issuesWrite).toBe(true);
    expect(dataWriteGrant.capabilities.repository.pullRequestsRead).toBe(true);
    expect(dataWriteGrant.capabilities.repository.pullRequestsWrite).toBe(true);
  });

  it('reports issue and pull-request access from the granted installation level', async () => {
    const scoped = createFixture({
      authMode: 'cloudflare-access',
      githubApp: { appId: 100, installationId: 999, privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----', appSlug: 'test-app' }
    });
    scoped.installations.replaceVerified(scoped.ownerId, {
      appId: 100, installationId: 'inst_levels', accountId: 'acc_1', accountLogin: 'test-org', status: 'active',
      issues: 'none', pullRequests: 'read',
      repositories: [{ owner: 'test-org', repository: 'test-repo', contents: 'write' }]
    }, Date.now());

    const scopedRes = await scoped.service.execute('principal_1', 'workspace_capabilities', { workspaceId: scoped.workspaceId });
    const scopedCaps = (scopedRes.data as { capabilities: { repository: Record<string, boolean> } }).capabilities.repository;
    expect(scopedCaps.push).toBe(true);
    expect(scopedCaps.issuesRead).toBe(false);
    expect(scopedCaps.issuesWrite).toBe(false);
    expect(scopedCaps.pullRequestsRead).toBe(true);
    expect(scopedCaps.pullRequestsWrite).toBe(false);

    const bound = createFixture({
      authMode: 'owner-bearer',
      githubApp: { appId: 100, installationId: 777, privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----', appSlug: 'test-app' }
    });
    bound.installations.replaceVerified(bound.ownerId, {
      appId: 100, installationId: '777', accountId: 'acc_1', accountLogin: 'test-org', status: 'active',
      issues: 'read', pullRequests: 'none',
      repositories: [{ owner: 'test-org', repository: 'test-repo', contents: 'write' }]
    }, Date.now());

    const boundRes = await bound.service.execute('principal_1', 'workspace_capabilities', { workspaceId: bound.workspaceId });
    const boundCaps = (boundRes.data as { capabilities: { repository: Record<string, boolean> } }).capabilities.repository;
    expect(boundCaps.push).toBe(true);
    expect(boundCaps.issuesRead).toBe(true);
    expect(boundCaps.issuesWrite).toBe(false);
    expect(boundCaps.pullRequestsRead).toBe(false);
    expect(boundCaps.pullRequestsWrite).toBe(false);
  });

  it('advertises the credential-backed write path when the App grant denies an independent permission', async () => {
    const scoped = createFixture({
      authMode: 'cloudflare-access',
      githubApp: { appId: 100, installationId: 999, privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----', appSlug: 'test-app' },
      githubSecret: `ghp_${'d'.repeat(36)}`
    });
    // Contents are writable, so the App path alone would suppress the fallback while
    // the principal's own credential can still perform issue and pull-request writes.
    scoped.installations.replaceVerified(scoped.ownerId, {
      appId: 100, installationId: 'inst_fallback', accountId: 'acc_1', accountLogin: 'test-org', status: 'active',
      issues: 'none', pullRequests: 'none',
      repositories: [{ owner: 'test-org', repository: 'test-repo', contents: 'write' }]
    }, Date.now());

    const res = await scoped.service.execute('principal_1', 'workspace_capabilities', { workspaceId: scoped.workspaceId });
    const caps = (res.data as { capabilities: { repository: Record<string, boolean> } }).capabilities.repository;
    expect(caps.push).toBe(true);
    expect(caps.issuesWrite).toBe(true);
    expect(caps.pullRequestsWrite).toBe(true);
  });

  it('enriches workspace_status and workspace_context with capabilities', async () => {
    const { service, workspaceId } = createFixture({
      authMode: 'owner-bearer',
      githubApp: {
        appId: 123,
        installationId: 456,
        privateKey: 'key',
        appSlug: 'slug'
      }
    });

    const statusRes = await service.execute('principal_1', 'workspace_status', { workspaceId });
    expect(statusRes.ok).toBe(true);
    const statusData = statusRes.data as Record<string, unknown>;
    expect(statusData.capabilities).toBeDefined();
    expect((statusData.capabilities as { repository: Record<string, boolean> }).repository.push).toBe(true);
    expect(statusData.permissions).toBeDefined();
    expect(statusData.operations).toBeDefined();

    const contextRes = await service.execute('principal_1', 'workspace_context', { workspaceId });
    expect(contextRes.ok).toBe(true);
    const contextData = contextRes.data as Record<string, unknown>;
    expect(contextData.capabilities).toBeDefined();
    expect((contextData.capabilities as { repository: Record<string, boolean> }).repository.push).toBe(true);
  });

  it('reports GitHub write capabilities in owner-bearer mode from an operator-supplied fallback credential', async () => {
    const { service, workspaceId } = createFixture({
      authMode: 'owner-bearer',
      githubToken: `ghp_${'f'.repeat(36)}`
    });

    const res = await service.execute('principal_1', 'workspace_capabilities', { workspaceId });
    const data = res.data as { capabilities: { repository: Record<string, boolean> }; operations: Record<string, boolean> };
    expect(data.capabilities.repository.push).toBe(true);
    expect(data.capabilities.repository.issuesWrite).toBe(true);
    expect(data.capabilities.repository.pullRequestsWrite).toBe(true);
    expect(data.operations.gitPush).toBe(true);
    expect(data.operations.issueCreate).toBe(true);
  });

  it('refuses the operator-wide fallback credential in cloudflare-access mode so it cannot stand in for a grant', async () => {
    const { service, workspaceId } = createFixture({
      authMode: 'cloudflare-access',
      githubApp: {
        appId: 100,
        privateKey: 'key',
        appSlug: 'test-app'
      },
      githubToken: `ghp_${'f'.repeat(36)}`
    });

    const res = await service.execute('principal_1', 'workspace_capabilities', { workspaceId });
    const data = res.data as { capabilities: { repository: Record<string, boolean> } };
    expect(data.capabilities.repository.push).toBe(false);
    expect(data.capabilities.repository.issuesWrite).toBe(false);

    const token = await (service as unknown as {
      repositoryToken: (ownerId: string, url: URL, permission: 'read' | 'write') => Promise<string | undefined>;
    }).repositoryToken('principal_1', new URL('https://github.com/test-org/test-repo.git'), 'write');
    expect(token).toBeUndefined();
  });

  it('resolves the fallback credential for Git read and write operations when no App token is minted', async () => {
    const fallbackToken = `ghp_${'f'.repeat(36)}`;
    const { service } = createFixture({
      authMode: 'owner-bearer',
      githubToken: fallbackToken
    });
    const call = (service as unknown as {
      repositoryToken: (ownerId: string, url: URL, permission: 'read' | 'write') => Promise<string | undefined>;
    });
    const repositoryUrl = new URL('https://github.com/test-org/test-repo.git');
    await expect(call.repositoryToken('principal_1', repositoryUrl, 'read')).resolves.toBe(fallbackToken);
    await expect(call.repositoryToken('principal_1', repositoryUrl, 'write')).resolves.toBe(fallbackToken);
  });

  it('reads owner skills from the workspace toolkit projection instead of a host-global executor path', async () => {
    const { service, workspaceId, record } = createFixture();
    const decoyRoot = mkdtempSync(join(tmpdir(), 'ch-decoy-owner-'));
    temporaryDirectories.push(decoyRoot);
    process.env.CH_OWNER_SKILLS_ROOT = decoyRoot;
    try {
      const projectionSkillDir = join(record.workspacePath, 'toolkit-projection', 'owner-skills', 'deploy');
      mkdirSync(projectionSkillDir, { recursive: true });
      writeFileSync(join(projectionSkillDir, 'SKILL.md'), '# Owner deploy');
      const decoySkillDir = join(decoyRoot, 'decoy-tool');
      mkdirSync(decoySkillDir, { recursive: true });
      writeFileSync(join(decoySkillDir, 'SKILL.md'), '# Decoy tool');

      const runWorkerSpy = vi.spyOn(
        service as unknown as { runWorker: (...args: unknown[]) => Promise<unknown> },
        'runWorker'
      );
      runWorkerSpy.mockResolvedValue({
        ok: true,
        message: 'Workspace context',
        data: { manifest: { contractVersion: 1, returnedBytes: 0, scannedFiles: 0, scannedSourceBytes: 0, truncated: false, truncationReasons: [], items: [], warnings: [] } },
        truncated: false
      });

      const res = await service.execute('principal_1', 'workspace_context', { workspaceId, include: ['skills'] });
      expect(res.ok).toBe(true);
      const manifest = (res.data as Record<string, unknown>).manifest as Record<string, unknown>;
      const items = (manifest.items ?? []) as Array<Record<string, any>>;

      const owner = items.find((it) => it.id === 'ctx_skill_deploy');
      expect(owner).toBeDefined();
      expect(owner?.provenance.source).toBe('owner');
      expect(owner?.provenance.trust).toBe('owner-controlled');
      expect(owner?.provenance.mutableBy).toBe('owner');
      expect(owner?.path).toBe(join(projectionSkillDir, 'SKILL.md'));

      // The host-global override can never stand in for the workspace-scoped trusted partition.
      expect(items.find((it) => it.id === 'ctx_skill_decoy-tool')).toBeUndefined();
    } finally {
      delete process.env.CH_OWNER_SKILLS_ROOT;
    }
  });
});
