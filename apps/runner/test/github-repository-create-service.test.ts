import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrincipalCapabilityResultSchema, WorkspaceCapabilityResultSchema, type RunnerConfig } from '@cloud-harness/contracts';
import { InMemoryGitHubInstallationStore } from '../src/github-installation-store.js';
import { MetadataStore } from '../src/metadata-store.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore } from '../src/state-store.js';

const INSTALLATION_TOKEN = 'ghs_serviceLevelInstallationToken0123456789';

vi.mock('../src/docker-engine.js', () => ({
  runDocker: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, truncated: false })),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined)
}));
vi.mock('@octokit/auth-app', () => ({
  createAppAuth: () => async (parameters: { type: string }) => parameters.type === 'app'
    ? { token: 'app-jwt-secret' }
    : { token: INSTALLATION_TOKEN, permissions: { administration: 'write' } }
}));

import { WorkspaceService } from '../src/workspace-service.js';

const directories: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const close of closers.splice(0)) { try { close(); } catch { /* ignore */ } }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(administration: 'write' | 'read') {
  const posts: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/app/installations/456') {
      return Response.json({ id: 456, app_id: 123, suspended_at: null, account: { id: 789, login: 'acme', type: 'Organization' }, permissions: { administration } });
    }
    if (url.pathname === '/orgs/acme/repos' && init.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return Response.json({ id: 42, full_name: 'acme/fresh', html_url: 'https://github.com/acme/fresh', visibility: 'public', default_branch: 'main' }, { status: 201 });
    }
    return Response.json({ message: 'Not Found' }, { status: 404 });
  }));
  const directory = mkdtempSync(join(tmpdir(), 'ch-repo-create-svc-'));
  directories.push(directory);
  mkdirSync(join(directory, 'jobs'), { recursive: true });
  const config = {
    authMode: 'cloudflare-access',
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
    githubApp: { appId: 123, privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----' }
  } as RunnerConfig;
  const store = new StateStore(config.stateDb);
  closers.push(() => store.close());
  const metadata = new MetadataStore(config.stateDb, new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]));
  closers.unshift(() => metadata.database.close());
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'principal_1' });
  const installations = new InMemoryGitHubInstallationStore();
  installations.replaceVerified(ownerId, {
    appId: 123, installationId: 456, accountId: 789, accountLogin: 'acme', issues: 'write', pullRequests: 'write',
    administration, accountType: 'Organization', status: 'active', repositories: []
  }, Date.now());
  const service = new WorkspaceService(config, store, metadata, installations);
  return { service, metadata, ownerId, posts };
}

describe('github_repository_create through the runner service', () => {
  it('creates without a workspace, replays the key, and audits without the token', async () => {
    const { service, metadata, ownerId, posts } = fixture('write');
    const input = { owner: 'acme', name: 'fresh', visibility: 'public', idempotencyKey: 'bootstrap-fresh-1' };
    const created = await service.execute('principal_1', 'github_repository_create', input);
    const replayed = await service.execute('principal_1', 'github_repository_create', input);

    expect(created).toMatchObject({ ok: true, data: { fullName: 'acme/fresh', repositoryId: 42, visibility: 'public', created: true } });
    expect(replayed).toMatchObject({ ok: true, data: { repositoryId: 42, replayed: true, created: false } });
    expect(posts).toEqual([{ name: 'fresh', visibility: 'public' }]);

    const audits = metadata.listAudit(ownerId).filter((entry) => entry.action === 'github.repository_create');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ subjectType: 'github_repository', subjectId: '42' });
    expect(JSON.stringify(audits)).toContain('"visibility":"public"');
    expect(JSON.stringify([created, replayed, metadata.listAudit(ownerId)])).not.toContain(INSTALLATION_TOKEN);
  });

  it('rejects malformed owner and name input at the boundary', async () => {
    const { service } = fixture('write');
    await expect(service.execute('principal_1', 'github_repository_create', { owner: '-acme', name: 'x', visibility: 'public', idempotencyKey: 'bootstrap-fresh-1' })).rejects.toThrow();
    await expect(service.execute('principal_1', 'github_repository_create', { owner: 'acme', name: 'bad name', visibility: 'public', idempotencyKey: 'bootstrap-fresh-1' })).rejects.toThrow();
    await expect(service.execute('principal_1', 'github_repository_create', { owner: 'acme', name: 'fresh', idempotencyKey: 'bootstrap-fresh-1' })).rejects.toThrow();
  });

  it('reports principal-level availability from workspace_capabilities when no workspace is active', async () => {
    const granted = fixture('write');
    const available = await granted.service.execute('principal_1', 'workspace_capabilities', {});
    expect(available.ok).toBe(true);
    const data = PrincipalCapabilityResultSchema.parse(available.data);
    expect(data.githubRepositoryCreate).toMatchObject({ available: true, organizations: [{ login: 'acme', administration: 'write', available: true }] });

    const readOnly = fixture('read');
    const unavailable = PrincipalCapabilityResultSchema.parse((await readOnly.service.execute('principal_1', 'workspace_capabilities', {})).data);
    expect(unavailable.githubRepositoryCreate).toMatchObject({ available: false, organizations: [{ login: 'acme', available: false }] });
    // The permission is checked live, so a read-only installation never reaches the create endpoint.
    const refused = await readOnly.service.execute('principal_1', 'github_repository_create', { owner: 'acme', name: 'fresh', visibility: 'private', idempotencyKey: 'bootstrap-fresh-2' });
    expect(refused.error?.code).toBe('GITHUB_PERMISSION_MISSING');
    expect(readOnly.posts).toHaveLength(0);
  });

  it('keeps NOT_FOUND for an explicit unknown workspace', async () => {
    const { service } = fixture('write');
    await expect(service.execute('principal_1', 'workspace_capabilities', { workspaceId: `ws_${'z'.repeat(24)}` })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('keeps the workspace capability contract valid with the added block', () => {
    expect(() => WorkspaceCapabilityResultSchema.parse({
      workspaceId: 'ws_x', repository: null, repositoryUrl: 'https://github.com/acme/x.git',
      capabilities: {
        repository: { read: true, push: true, issuesRead: true, issuesWrite: true, pullRequestsRead: true, pullRequestsWrite: true },
        workspace: { shell: true, tasks: true, sessions: true, deployments: true, networkProfile: 'network-none' }
      },
      permissions: { contents: { read: true, write: true }, issues: { read: true, write: true }, pullRequests: { read: true, write: true } },
      operations: { gitFetch: true, gitPull: true, gitPush: true, issueList: true, issueView: true, issueCreate: true, issueComment: true, issueUpdate: true, issuePublish: true, labelCreate: true, pullRequestList: true, pullRequestView: true, pullRequestCreate: true, execRun: true, privilegedExec: false, deploymentsRun: true },
      githubRepositoryCreate: { tool: 'github_repository_create', available: false, organizations: [], personalAccounts: false, requiredPermission: 'administration:write' }
    })).not.toThrow();
  });
});
