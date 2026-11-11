import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_SCHEMA_BY_NAME, type RunnerConfig } from '@cloud-harness/contracts';
import type { GitHubBindingService } from '../src/github-binding-service.js';
import { hasGitHubFallbackCredential, legacyFallbackLaneOpen, resolveGitHubFallbackCredential } from '../src/github-credential-fallback.js';
import { InMemoryGitHubInstallationStore } from '../src/github-installation-store.js';
import { GitHubUserAuthorizationService } from '../src/github-user-authorization-service.js';
import { githubUserAuthorizationRequired } from '../src/github-user-lane.js';
import { MetadataStore } from '../src/metadata-store.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';
import type * as GitHubAppBroker from '../src/github-app-broker.js';
import { deferred, fakeAuthorizer, pair } from './github-user-fixtures.js';

const docker = vi.hoisted(() => ({
  runDocker: vi.fn(),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined)
}));
const broker = vi.hoisted(() => ({
  mintRepositoryToken: vi.fn(async () => undefined),
  mintPrincipalRepositoryToken: vi.fn(async () => undefined),
  mintPrincipalRepositoryScopedToken: vi.fn(async () => undefined)
}));

vi.mock('../src/docker-engine.js', () => docker);
vi.mock('../src/github-app-broker.js', async (importOriginal) => ({ ...(await importOriginal<typeof GitHubAppBroker>()), ...broker }));
vi.mock('../src/repository-policy.js', () => ({ validateRepositoryUrl: vi.fn(async (value: string) => new URL(value)) }));

import { WorkspaceService } from '../src/workspace-service.js';

const USER_TOKEN = 'ghu_user_lane_token_0000000000';
const REFRESHED_TOKEN = 'ghu_user_lane_token_refreshed_0';
const PAT = 'github_pat_principal_secret_0000000000';
const GH_HELPER = '/opt/harness/gh-helper.sh';
const TRANSFER_HELPER = '/opt/harness/git-transfer-helper.sh';
const ok = { stdout: '', stderr: '', exitCode: 0, truncated: false };
const failure = (stderr: string, exitCode = 1) => ({ stdout: '', stderr, exitCode, truncated: false });

const directories: string[] = [];
const closers: Array<() => void> = [];

beforeEach(() => {
  docker.runDocker.mockReset();
  docker.runDocker.mockImplementation(async () => ok);
  // `vi.clearAllMocks` keeps implementations, so a test that scripts the broker must not leak into the next.
  broker.mintRepositoryToken.mockReset();
  broker.mintRepositoryToken.mockImplementation(async () => undefined);
  broker.mintPrincipalRepositoryToken.mockReset();
  broker.mintPrincipalRepositoryToken.mockImplementation(async () => undefined);
  broker.mintPrincipalRepositoryScopedToken.mockReset();
  broker.mintPrincipalRepositoryScopedToken.mockImplementation(async () => undefined);
});
afterEach(() => {
  vi.clearAllMocks();
  for (const close of closers.splice(0)) {
    try { close(); } catch { /* already closed */ }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type LaneKind = 'user' | 'legacy' | 'owner-not-visible' | 'revoked';

/**
 * The credential policy reads the stored authorization row, as production does: `lane` writes that row.
 * Only the token lifecycle is a stand-in. `lifecycle: 'real'` swaps in the real service over a fake GitHub;
 * `lifecycle: false` leaves it out the way a runner without the GitHub App client credentials or the keyring
 * does; `app: false` is a runner with no GitHub App at all, which has neither a binding nor a lifecycle.
 */
function fixture(options: { secret?: boolean; lifecycle?: boolean | 'real'; app?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ch-user-lane-'));
  directories.push(directory);
  const workspaceId = `ws_${'d'.repeat(24)}`;
  const workspacePath = join(directory, 'jobs', workspaceId);
  mkdirSync(join(workspacePath, 'repo'), { recursive: true });
  const config = {
    authMode: 'cloudflare-access',
    host: '127.0.0.1', port: 3001, serviceToken: 'runner-token-that-is-longer-than-32-characters',
    jobsRoot: join(directory, 'jobs'), stateDb: join(directory, 'state.db'), executorImage: 'executor',
    allowedGitHosts: ['github.com'], networkProfile: 'network-none', wallTtlSeconds: 300, idleTtlSeconds: 180,
    maxOutputBytes: 262_144, minFreeBytes: 0, maxWorkspaceBytes: 1_048_576, reaperIntervalSeconds: 30,
    ...(options.app === false ? {} : { githubApp: { appId: 123, privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----', appSlug: 'cloud-harness-test' } })
  } as RunnerConfig;
  const store = new StateStore(config.stateDb);
  const principalSelector = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'member' };
  const principalId = store.resolveExternalPrincipal(principalSelector);
  const metadata = new MetadataStore(config.stateDb, new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]));
  closers.push(() => metadata.close(), () => store.close());
  if (options.secret !== false) metadata.createGlobalSecret(principalId, 'GH_TOKEN', PAT, 0, null, 'runtime');
  const userAuthorizations = {
    credentialFor: vi.fn(),
    recoverRejected: vi.fn(),
    cachedOwnerVisible: vi.fn((): boolean | undefined => undefined)
  };
  const reconcile = vi.fn(async () => undefined);
  const authorizer = fakeAuthorizer();
  const lifecycle = new GitHubUserAuthorizationService(metadata.githubUserAuthorizations, authorizer);
  const binding = options.app === false ? undefined : {
    reconcile,
    ...(options.lifecycle === false ? {} : { userAuthorizations: options.lifecycle === 'real' ? lifecycle : userAuthorizations })
  } as unknown as GitHubBindingService;
  const installations = new InMemoryGitHubInstallationStore();
  const service = new WorkspaceService(config, store, metadata, installations, binding);
  const now = Date.now();
  const record: WorkspaceRecord = {
    id: workspaceId, ownerId: principalId, idempotencyKey: 'user-lane',
    repositoryUrl: 'https://github.com/bestagentkits/cloud-harness-mcp.git', repositoryRef: null,
    containerName: 'executor-container', workspacePath, status: 'ACTIVE', networkProfile: 'network-none',
    createdAt: now, lastActivityAt: now, expiresAt: now + 60_000, generation: 1, error: null
  };
  store.create(record);
  const rows = metadata.githubUserAuthorizations;
  const lane = (kind: LaneKind) => {
    rows.connect(principalId, { githubUserId: '789', login: 'alice', ...pair(now, 'lane') });
    if (kind === 'revoked') rows.markRevoked(principalId, rows.get(principalId)!.generation, 'bad_refresh_token');
    if (kind === 'legacy') rows.disconnect(principalId);
    userAuthorizations.credentialFor.mockImplementation(async () => {
      if (kind === 'user') return { lane: 'user', credential: { token: USER_TOKEN, generation: 3, login: 'alice' } };
      return { lane: kind };
    });
  };
  const clone = (service as unknown as { clone: (record: WorkspaceRecord, url: URL) => Promise<string> }).clone.bind(service);
  const cloneRepository = () => clone(record, new URL(record.repositoryUrl));
  const action = (extra: Record<string, unknown> = {}) => service.execute(principalSelector, 'github_action', {
    workspaceId, action: 'pr_update', prNumber: 42, title: 'Updated title', body: 'Updated body', base: 'develop', state: 'closed', ...extra
  });
  const audits = () => metadata.listAudit(principalId, 50);
  return {
    config, store, metadata, service, record, workspaceId, principalId, principalSelector, userAuthorizations, reconcile, installations,
    authorizer, lifecycle, lane, cloneRepository, action, audits
  };
}

const helperCalls = (script: string) => docker.runDocker.mock.calls.filter(([args]) => (args as string[]).includes(script));
const stdins = () => docker.runDocker.mock.calls.map(([, options]) => (options as { stdin?: string } | undefined)?.stdin);
const launchArguments = () => JSON.stringify(docker.runDocker.mock.calls.map(([args]) => args));

describe('clone credential selection with a GitHub user authorization', () => {
  it('uses the connected user token and never retries with an App token or a secret after GitHub refuses it', async () => {
    const { cloneRepository, lane, reconcile, userAuthorizations } = fixture();
    lane('user');
    docker.runDocker.mockResolvedValue(failure('remote: Permission to bestagentkits/cloud-harness-mcp.git denied to alice.\nfatal: unable to access: The requested URL returned error: 403', 128));
    const error = await cloneRepository().catch((caught: unknown) => caught as Error);
    expect(error.message).toContain('repository clone failed (credential: github-user)');
    expect(docker.runDocker).toHaveBeenCalledTimes(1);
    expect(stdins()).toEqual([`${USER_TOKEN}\n`]);
    // Only the binding lookup minted; the reconcile-and-retry-with-an-App-token path is closed to the user lane.
    expect(broker.mintPrincipalRepositoryToken).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
    expect(userAuthorizations.recoverRejected).not.toHaveBeenCalled();
    expect(error.message).not.toContain(USER_TOKEN);
    expect(error.message).not.toContain(PAT);
    expect(launchArguments()).not.toContain(USER_TOKEN);
  });

  it('answers a revoked authorization with GITHUB_USER_AUTHORIZATION_REQUIRED and starts no helper, though a fallback secret exists', async () => {
    const { cloneRepository, lane } = fixture();
    lane('revoked');
    await expect(cloneRepository()).rejects.toMatchObject({ code: 'GITHUB_USER_AUTHORIZATION_REQUIRED', retryable: false, message: expect.stringContaining('Dashboard → Integrations → GitHub → GitHub user') });
    expect(docker.runDocker).not.toHaveBeenCalled();
  });

  it('opens the legacy lane again once the person disconnected', async () => {
    const { cloneRepository, lane } = fixture();
    lane('legacy');
    docker.runDocker.mockResolvedValue(failure('remote: Write access to repository not granted.', 128));
    const error = await cloneRepository().catch((caught: unknown) => caught as Error);
    expect(error.message).toContain('repository clone failed (credential: principal-global-secret)');
    expect(stdins()[0]).toBe(`${PAT}\n`);
    expect(error.message).not.toContain(PAT);
  });

  it('gives a connected user no credential for an owner it cannot reach, and never the fallback secret', async () => {
    const { cloneRepository, lane } = fixture();
    lane('owner-not-visible');
    await expect(cloneRepository()).resolves.toContain('repo');
    expect(stdins()).toEqual(['\n']);
    expect(JSON.stringify(docker.runDocker.mock.calls)).not.toContain(PAT);
  });

  it('treats an unreachable owner as final: a failed anonymous clone is followed by no reconcile and no App retry', async () => {
    const { cloneRepository, lane, reconcile, installations } = fixture();
    lane('owner-not-visible');
    // An installation of the owner is on record, so a clone that were allowed to retry would reconcile and mint.
    vi.spyOn(installations, 'listInstallations').mockReturnValue([{ installationId: '11', accountLogin: 'bestagentkits', status: 'active' }] as never);
    broker.mintPrincipalRepositoryToken.mockResolvedValueOnce(undefined).mockResolvedValueOnce('ghs_app_retry_token' as never);
    docker.runDocker.mockResolvedValue(failure('fatal: could not read Username for https://github.com: terminal prompts disabled', 128));
    const error = await cloneRepository().catch((caught: unknown) => caught as Error);
    expect(error.message).toContain('repository clone failed (credential: none)');
    expect(error.message).toContain('cannot reach a GitHub App installation of bestagentkits');
    expect(docker.runDocker).toHaveBeenCalledTimes(1);
    expect(stdins()).toEqual(['\n']);
    expect(reconcile).not.toHaveBeenCalled();
    expect(broker.mintPrincipalRepositoryToken).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(docker.runDocker.mock.calls)).not.toContain('ghs_app_retry_token');
  });

  it('recovers a rejected token once with the user lane\'s own token, and treats a second refusal as final', async () => {
    const { cloneRepository, lane, userAuthorizations, principalId } = fixture();
    lane('user');
    userAuthorizations.recoverRejected.mockResolvedValue({ token: REFRESHED_TOKEN, generation: 4, login: 'alice' });
    const rejected = failure("remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/bestagentkits/cloud-harness-mcp.git/'", 128);
    docker.runDocker.mockResolvedValueOnce(rejected).mockResolvedValueOnce(ok);
    await expect(cloneRepository()).resolves.toContain('repo');
    expect(userAuthorizations.recoverRejected).toHaveBeenCalledWith(principalId, 3);
    expect(stdins()).toEqual([`${USER_TOKEN}\n`, `${REFRESHED_TOKEN}\n`]);

    docker.runDocker.mockReset();
    docker.runDocker.mockResolvedValue(rejected);
    await expect(cloneRepository()).rejects.toThrow('repository clone failed (credential: github-user)');
    expect(docker.runDocker).toHaveBeenCalledTimes(2);
    expect(broker.mintPrincipalRepositoryToken).toHaveBeenCalledTimes(2);

    userAuthorizations.recoverRejected.mockRejectedValue(githubUserAuthorizationRequired('bad_refresh_token'));
    docker.runDocker.mockReset();
    docker.runDocker.mockResolvedValue(rejected);
    await expect(cloneRepository()).rejects.toMatchObject({ code: 'GITHUB_USER_AUTHORIZATION_REQUIRED' });
    expect(docker.runDocker).toHaveBeenCalledTimes(1);
  });

  it('reports a SAML refusal per organization and neither refreshes nor revokes', async () => {
    const { cloneRepository, lane, userAuthorizations } = fixture();
    lane('user');
    docker.runDocker.mockResolvedValue(failure('remote: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.', 128));
    await expect(cloneRepository()).rejects.toMatchObject({
      code: 'GITHUB_PERMISSION_MISSING', retryable: false, message: expect.stringContaining('https://github.com/orgs/bestagentkits/sso')
    });
    expect(userAuthorizations.recoverRejected).not.toHaveBeenCalled();
    expect(docker.runDocker).toHaveBeenCalledTimes(1);
  });
});

describe('github_action and github_read credential selection with a GitHub user authorization', () => {
  it('runs with the user token, reports github-user, and never switches to the fallback secret after a 403', async () => {
    const { action, lane, audits } = fixture();
    lane('user');
    docker.runDocker.mockImplementation(async (args: string[]) => (args.includes(GH_HELPER) ? failure('gh: Resource not accessible by integration (HTTP 403)') : ok));
    const result = await action();
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'GITHUB_PERMISSION_MISSING', retryable: false });
    expect(result.message).toContain('connected GitHub user');
    expect(result.message).not.toContain('GH_TOKEN');
    expect(helperCalls(GH_HELPER)).toHaveLength(1);
    expect(helperCalls(GH_HELPER)[0]?.[1]).toMatchObject({ stdin: `${USER_TOKEN}\n` });
    const audit = audits().find((event) => event.action === 'github_action.pr_update');
    expect(audit).toMatchObject({ subjectType: 'workspace', details: { credentialSource: 'github-user', success: false, errorCode: 'GITHUB_PERMISSION_MISSING' } });
    // The token reaches only the helper's stdin: never launch arguments, results, or audit.
    expect(launchArguments()).not.toContain(USER_TOKEN);
    for (const surface of [JSON.stringify(result), JSON.stringify(audits())]) {
      expect(surface).not.toContain(USER_TOKEN);
      expect(surface).not.toContain(PAT);
    }
    expect(audit?.details).not.toHaveProperty('principalId');
  });

  it('refuses a revoked principal for github_action and github_read, starting no helper and reporting no credential source', async () => {
    const { action, lane, audits, service, principalSelector, workspaceId } = fixture();
    lane('revoked');
    await expect(action()).rejects.toMatchObject({ code: 'GITHUB_USER_AUTHORIZATION_REQUIRED', retryable: false });
    await expect(service.execute(principalSelector, 'github_read', { workspaceId, action: 'pr_view', prNumber: 7 }))
      .rejects.toMatchObject({ code: 'GITHUB_USER_AUTHORIZATION_REQUIRED' });
    expect(helperCalls(GH_HELPER)).toHaveLength(0);
    const audit = audits().find((event) => event.action === 'github_action.pr_update');
    expect(audit?.details).toMatchObject({ success: false, errorCode: 'GITHUB_USER_AUTHORIZATION_REQUIRED' });
    expect(audit?.details).not.toHaveProperty('credentialSource');
    expect(JSON.stringify(audits())).not.toContain(PAT);
    expect(JSON.stringify(audits())).not.toContain('principal-global-secret');
  });

  it('resolves a disconnected principal to the legacy lane with the same secret', async () => {
    const { action, lane, audits } = fixture();
    lane('legacy');
    docker.runDocker.mockImplementation(async (args: string[]) => (args.includes(GH_HELPER) ? { ...ok, stdout: 'done' } : ok));
    expect((await action()).ok).toBe(true);
    expect(helperCalls(GH_HELPER)[0]?.[1]).toMatchObject({ stdin: `${PAT}\n` });
    expect(audits().find((event) => event.action === 'github_action.pr_update')?.details).toMatchObject({ credentialSource: 'principal-global-secret', success: true });
  });

  it('gives a connected user no credential for an owner it cannot reach, never the fallback secret', async () => {
    const { action, lane, audits } = fixture();
    lane('owner-not-visible');
    await expect(action()).rejects.toMatchObject({
      code: 'REPOSITORY_OPERATION_NOT_AUTHORIZED', message: expect.stringContaining('cannot reach a GitHub App installation on bestagentkits')
    });
    expect(helperCalls(GH_HELPER)).toHaveLength(0);
    expect(audits().find((event) => event.action === 'github_action.pr_update')?.details).toMatchObject({ errorCode: 'REPOSITORY_OPERATION_NOT_AUTHORIZED' });
  });

  it('keeps an installation token first and reports it as github-app', async () => {
    const { action, lane, audits, userAuthorizations } = fixture();
    lane('user');
    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce({ token: 'app-installation-token', permissions: { pull_requests: 'write', contents: 'read' } } as never);
    docker.runDocker.mockImplementation(async (args: string[]) => (args.includes(GH_HELPER) ? { ...ok, stdout: 'done' } : ok));
    expect((await action()).ok).toBe(true);
    expect(helperCalls(GH_HELPER)[0]?.[1]).toMatchObject({ stdin: 'app-installation-token\n' });
    expect(userAuthorizations.credentialFor).not.toHaveBeenCalled();
    expect(audits().find((event) => event.action === 'github_action.pr_update')?.details).toMatchObject({ credentialSource: 'github-app' });
  });

  it('recovers a 401 once with the user lane\'s own token', async () => {
    const { action, lane, audits, userAuthorizations, principalId } = fixture();
    lane('user');
    userAuthorizations.recoverRejected.mockResolvedValue({ token: REFRESHED_TOKEN, generation: 4, login: 'alice' });
    let helperRuns = 0;
    docker.runDocker.mockImplementation(async (args: string[]) => {
      if (!args.includes(GH_HELPER)) return ok;
      helperRuns += 1;
      return helperRuns === 1 ? failure('gh: Bad credentials (HTTP 401)') : { ...ok, stdout: 'done' };
    });
    expect((await action()).ok).toBe(true);
    expect(userAuthorizations.recoverRejected).toHaveBeenCalledWith(principalId, 3);
    expect(helperCalls(GH_HELPER).map(([, options]) => (options as { stdin?: string }).stdin)).toEqual([`${USER_TOKEN}\n`, `${REFRESHED_TOKEN}\n`]);
    expect(audits().find((event) => event.action === 'github_action.pr_update')?.details).toMatchObject({ credentialSource: 'github-user', success: true });

    userAuthorizations.recoverRejected.mockRejectedValue(githubUserAuthorizationRequired('bad_refresh_token'));
    docker.runDocker.mockReset();
    docker.runDocker.mockImplementation(async (args: string[]) => (args.includes(GH_HELPER) ? failure('gh: Bad credentials (HTTP 401)') : ok));
    await expect(action()).rejects.toMatchObject({ code: 'GITHUB_USER_AUTHORIZATION_REQUIRED' });
    expect(helperCalls(GH_HELPER)).toHaveLength(1);
  });

  it('reports a SAML refusal per organization and does not touch the authorization', async () => {
    const { action, lane, userAuthorizations } = fixture();
    lane('user');
    docker.runDocker.mockImplementation(async (args: string[]) => (args.includes(GH_HELPER) ? failure('GraphQL: Resource protected by organization SAML enforcement. (organization)') : ok));
    const result = await action();
    expect(result.error).toMatchObject({ code: 'GITHUB_PERMISSION_MISSING', retryable: false });
    expect(result.message).toContain('SSO');
    expect(userAuthorizations.recoverRejected).not.toHaveBeenCalled();
  });
});

describe('the credential policy without the token lifecycle', () => {
  it('fails closed for a connected user whose connection this runner cannot use: no helper, no secret, no capability', async () => {
    const { cloneRepository, action, lane, service, record, audits } = fixture({ lifecycle: false });
    lane('user');
    await expect(cloneRepository()).rejects.toMatchObject({
      code: 'UNAVAILABLE', retryable: false, message: expect.stringContaining('cannot use the connection')
    });
    expect(docker.runDocker).not.toHaveBeenCalled();
    await expect(action()).rejects.toMatchObject({ code: 'UNAVAILABLE', message: expect.stringContaining('cannot use the connection') });
    expect(helperCalls(GH_HELPER)).toHaveLength(0);
    expect(audits().find((event) => event.action === 'github_action.pr_update')?.details).toMatchObject({ success: false, errorCode: 'UNAVAILABLE' });
    expect(service.computeWorkspaceCapabilities(record).capabilities.repository).toMatchObject({ push: false, issuesWrite: false, pullRequestsWrite: false });
    expect(JSON.stringify(docker.runDocker.mock.calls)).not.toContain(PAT);
  });

  it('refuses a revoked principal as the lifecycle would, and offers no capability from the secret it still holds', async () => {
    const { cloneRepository, action, lane, service, record } = fixture({ lifecycle: false });
    lane('revoked');
    await expect(cloneRepository()).rejects.toMatchObject({ code: 'GITHUB_USER_AUTHORIZATION_REQUIRED', retryable: false });
    expect(docker.runDocker).not.toHaveBeenCalled();
    await expect(action()).rejects.toMatchObject({ code: 'GITHUB_USER_AUTHORIZATION_REQUIRED' });
    expect(helperCalls(GH_HELPER)).toHaveLength(0);
    expect(service.computeWorkspaceCapabilities(record).capabilities.repository.push).toBe(false);
  });

  it.each(['disconnected', 'never connected'])('leaves the legacy lane open for a principal that is %s', async (state) => {
    const { cloneRepository, lane, service, record } = fixture({ lifecycle: false });
    if (state === 'disconnected') lane('legacy');
    docker.runDocker.mockResolvedValue(failure('remote: Write access to repository not granted.', 128));
    const error = await cloneRepository().catch((caught: unknown) => caught as Error);
    expect(error.message).toContain('repository clone failed (credential: principal-global-secret)');
    expect(stdins()[0]).toBe(`${PAT}\n`);
    expect(service.computeWorkspaceCapabilities(record).capabilities.repository.push).toBe(true);
  });
});

describe('helper output never carries the credentials an operation used', () => {
  const recoverable = () => {
    const context = fixture();
    context.lane('user');
    context.userAuthorizations.recoverRejected.mockResolvedValue({ token: REFRESHED_TOKEN, generation: 4, login: 'alice' });
    return context;
  };
  const expectClean = (...surfaces: string[]) => {
    for (const surface of surfaces) {
      expect(surface).not.toContain(USER_TOKEN);
      expect(surface).not.toContain(REFRESHED_TOKEN);
    }
  };

  it('cleans a clone failure of the old and the refreshed token', async () => {
    const { cloneRepository } = recoverable();
    docker.runDocker
      .mockResolvedValueOnce(failure(`fatal: Authentication failed for 'https://x-access-token:${USER_TOKEN}@github.com/bestagentkits/cloud-harness-mcp.git/'`, 128))
      .mockResolvedValueOnce(failure(`fatal: unable to access (retried with ${REFRESHED_TOKEN}, earlier ${USER_TOKEN}): The requested URL returned error: 403`, 128));
    const error = await cloneRepository().catch((caught: unknown) => caught as Error);
    expect(error.message).toContain('repository clone failed (credential: github-user)');
    expect(error.message).toContain('[REDACTED]');
    expectClean(error.message);
  });

  it('cleans a fetch failure of the old and the refreshed token', async () => {
    const { service, record } = recoverable();
    let fetches = 0;
    docker.runDocker.mockImplementation(async (args: string[]) => {
      if (!args.includes(TRANSFER_HELPER) || !args.includes('fetch')) return ok;
      fetches += 1;
      return fetches === 1
        ? failure(`fatal: Authentication failed (${USER_TOKEN})`, 128)
        : failure(`fatal: unable to access: The requested URL returned error: 403 (${REFRESHED_TOKEN} after ${USER_TOKEN})`, 128);
    });
    const fetch = (service as unknown as { remoteFetch: (record: WorkspaceRecord, ref: string | undefined) => Promise<unknown> }).remoteFetch.bind(service);
    const error = await fetch(record, undefined).catch((caught: unknown) => caught as Error);
    expect(fetches).toBe(2);
    expect(error.message).toContain('Git fetch failed');
    expect(error.message).toContain('[REDACTED]');
    expectClean(error.message);
  });

  it('cleans a push failure of the old and the refreshed token, and the operation state it persists', async () => {
    const { service, record, store, principalId, workspaceId } = recoverable();
    let pushes = 0;
    docker.runDocker.mockImplementation(async (args: string[]) => {
      if (args.includes('rev-parse')) return { ...ok, stdout: `${'a'.repeat(40)}\n` };
      if (!args.includes(TRANSFER_HELPER) || !args.includes('push')) return ok;
      pushes += 1;
      return pushes === 1
        ? failure(`fatal: Authentication failed for 'https://x-access-token:${USER_TOKEN}@github.com/bestagentkits/cloud-harness-mcp.git/'`, 128)
        : failure(`fatal: unable to access: The requested URL returned error: 500 (${REFRESHED_TOKEN} after ${USER_TOKEN})`, 128);
    });
    const push = (service as unknown as {
      remotePush: (record: WorkspaceRecord, input: Record<string, unknown>) => Promise<unknown>;
    }).remotePush.bind(service);
    const error = await push(record, { refspec: 'HEAD:refs/heads/main', idempotencyKey: 'push-redaction-0001' }).catch((caught: unknown) => caught as Error);
    expect(pushes).toBe(2);
    expect(error).toMatchObject({ code: 'UNKNOWN_REMOTE_STATE' });
    expect((error as Error).message).toContain('[REDACTED]');
    const persisted = store.getGitOperation(principalId, workspaceId, 'push-redaction-0001');
    expect(persisted?.status).toBe('UNKNOWN_REMOTE_STATE');
    expectClean((error as Error).message, JSON.stringify(persisted));
  });

  it('cleans github_action results and failures, and github_read output, of the old and the refreshed token', async () => {
    const { action, audits, service, principalSelector, workspaceId } = recoverable();
    let runs = 0;
    docker.runDocker.mockImplementation(async (args: string[]) => {
      if (!args.includes(GH_HELPER)) return ok;
      runs += 1;
      return runs === 1
        ? failure(`gh: Bad credentials (HTTP 401) for ${USER_TOKEN}`)
        : { ...ok, stdout: `updated with ${REFRESHED_TOKEN}; before that ${USER_TOKEN}` };
    });
    const succeeded = await action();
    expect(succeeded.ok).toBe(true);
    expect(JSON.stringify(succeeded)).toContain('[REDACTED]');
    expectClean(JSON.stringify(succeeded), JSON.stringify(audits()));

    runs = 0;
    docker.runDocker.mockImplementation(async (args: string[]) => {
      if (!args.includes(GH_HELPER)) return ok;
      runs += 1;
      return runs === 1
        ? failure(`gh: Bad credentials (HTTP 401) for ${USER_TOKEN}`)
        : failure(`gh: HTTP 500 Internal Server Error (${REFRESHED_TOKEN} after ${USER_TOKEN})`);
    });
    const failed = await action();
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).toContain('[REDACTED]');
    expectClean(JSON.stringify(failed), JSON.stringify(audits()));

    docker.runDocker.mockImplementation(async (args: string[]) => (args.includes(GH_HELPER) ? { ...ok, stdout: `title: ${USER_TOKEN}` } : ok));
    const read = await service.execute(principalSelector, 'github_read', { workspaceId, action: 'pr_view', prNumber: 7 });
    expect(JSON.stringify(read)).toContain('[REDACTED]');
    expectClean(JSON.stringify(read));
  });
});

describe('finalize reconciliation under the credential policy', () => {
  const SHA = 'c'.repeat(40);
  const KEY = 'finalize-reconcile-0001';

  /** A finalize whose push was interrupted: the retry finds an `UNKNOWN_REMOTE_STATE` operation and reconciles. */
  function interrupted(options: Parameters<typeof fixture>[0] = {}) {
    const context = fixture(options);
    const { store, principalId, workspaceId, service, principalSelector } = context;
    const input = { workspaceId, commitMessage: 'ship it', branch: 'main', idempotencyKey: KEY };
    const validated = TOOL_SCHEMA_BY_NAME.workspace_finalize.parse(input);
    store.acquireGitOperation({
      ownerId: principalId, workspaceId, idempotencyKey: KEY, operation: 'finalize',
      requestFingerprint: createHash('sha256').update(JSON.stringify(validated)).digest('hex'),
      targetRef: 'refs/heads/main', expectedRemoteOid: null, localCommitSha: null, createdAt: Date.now()
    });
    store.updateGitOperationStatus(principalId, workspaceId, KEY, 'UNKNOWN_REMOTE_STATE', null, null, SHA);
    return {
      ...context,
      finalize: () => service.execute(principalSelector, 'workspace_finalize', input),
      operation: () => store.getGitOperation(principalId, workspaceId, KEY)
    };
  }

  it('refuses a revoked authorization before any probe helper runs, and leaves the operation unknown', async () => {
    const { finalize, lane, operation } = interrupted();
    lane('revoked');
    await expect(finalize()).rejects.toMatchObject({ code: 'GITHUB_USER_AUTHORIZATION_REQUIRED', retryable: false });
    expect(helperCalls('probe-helper')).toHaveLength(0);
    expect(operation()?.status).toBe('UNKNOWN_REMOTE_STATE');
    expect(JSON.stringify(docker.runDocker.mock.calls)).not.toContain(PAT);
  });

  it('refuses a connection this runner cannot use before any probe helper runs', async () => {
    const { finalize, lane, operation } = interrupted({ lifecycle: false });
    lane('user');
    await expect(finalize()).rejects.toMatchObject({ code: 'UNAVAILABLE', message: expect.stringContaining('cannot use the connection') });
    expect(helperCalls('probe-helper')).toHaveLength(0);
    expect(operation()?.status).toBe('UNKNOWN_REMOTE_STATE');
    expect(JSON.stringify(docker.runDocker.mock.calls)).not.toContain(PAT);
  });

  it('probes a disconnected principal with its own secret and reconciles from the remote state', async () => {
    const { finalize, lane, operation } = interrupted();
    lane('legacy');
    docker.runDocker.mockImplementation(async (args: string[]) => (args.includes('probe-helper') ? { ...ok, stdout: `${SHA}\trefs/heads/main\n` } : ok));
    await expect(finalize()).resolves.toMatchObject({ ok: true, data: { alreadyFinalized: true } });
    expect(helperCalls('probe-helper')[0]?.[1]).toMatchObject({ stdin: `${PAT}\n` });
    expect(operation()?.status).toBe('SUCCEEDED');
  });

  it('probes with the user token, recovers a 401 once, and reconciles from the remote state', async () => {
    const { finalize, lane, userAuthorizations, operation, principalId } = interrupted();
    lane('user');
    userAuthorizations.recoverRejected.mockResolvedValue({ token: REFRESHED_TOKEN, generation: 4, login: 'alice' });
    let probes = 0;
    docker.runDocker.mockImplementation(async (args: string[]) => {
      if (!args.includes('probe-helper')) return ok;
      probes += 1;
      return probes === 1
        ? failure("fatal: Authentication failed for 'https://github.com/bestagentkits/cloud-harness-mcp.git/'", 128)
        : { ...ok, stdout: `${SHA}\trefs/heads/main\n` };
    });
    await expect(finalize()).resolves.toMatchObject({ ok: true, data: { commitSha: SHA, branch: 'main', pushed: true, alreadyFinalized: true } });
    expect(userAuthorizations.recoverRejected).toHaveBeenCalledWith(principalId, 3);
    expect(helperCalls('probe-helper').map(([, options]) => (options as { stdin?: string }).stdin)).toEqual([`${USER_TOKEN}\n`, `${REFRESHED_TOKEN}\n`]);
    expect(operation()?.status).toBe('SUCCEEDED');
  });

  it('stops with the lifecycle error, not an unknown remote state, when the rejected token cannot be recovered', async () => {
    const { finalize, lane, userAuthorizations, operation } = interrupted();
    lane('user');
    userAuthorizations.recoverRejected.mockRejectedValue(githubUserAuthorizationRequired('bad_refresh_token'));
    docker.runDocker.mockImplementation(async (args: string[]) => (args.includes('probe-helper') ? failure('fatal: Authentication failed', 128) : ok));
    await expect(finalize()).rejects.toMatchObject({ code: 'GITHUB_USER_AUTHORIZATION_REQUIRED' });
    expect(helperCalls('probe-helper')).toHaveLength(1);
    expect(operation()?.status).toBe('UNKNOWN_REMOTE_STATE');
  });

  it('reports a SAML refusal per organization instead of an unknown remote state', async () => {
    const { finalize, lane, userAuthorizations, operation } = interrupted();
    lane('user');
    docker.runDocker.mockImplementation(async (args: string[]) => (args.includes('probe-helper')
      ? failure('remote: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.', 128)
      : ok));
    await expect(finalize()).rejects.toMatchObject({
      code: 'GITHUB_PERMISSION_MISSING', message: expect.stringContaining('https://github.com/orgs/bestagentkits/sso')
    });
    expect(userAuthorizations.recoverRejected).not.toHaveBeenCalled();
    expect(operation()?.status).toBe('UNKNOWN_REMOTE_STATE');
  });

  it('keeps "remote state unknown" for a probe that was genuinely indeterminate', async () => {
    const { service, record } = fixture();
    const probe = (service as unknown as {
      probeRemoteRefOid: (record: WorkspaceRecord, branch: string, credential: { token: string; source: string; userGeneration: number } | undefined) => Promise<string | null | undefined>;
    }).probeRemoteRefOid.bind(service);
    const credential = { token: USER_TOKEN, source: 'github-user', userGeneration: 3 };
    docker.runDocker.mockResolvedValue(failure('fatal: unable to access: Could not resolve host: github.com', 128));
    await expect(probe(record, 'main', credential)).resolves.toBeUndefined();
    docker.runDocker.mockRejectedValue(new Error('docker is unavailable'));
    await expect(probe(record, 'main', credential)).resolves.toBeUndefined();
    docker.runDocker.mockReset();
    docker.runDocker.mockResolvedValue({ ...ok, stdout: `${SHA}\trefs/heads/main\n` });
    await expect(probe(record, 'main', credential)).resolves.toBe(SHA);
    docker.runDocker.mockResolvedValue(ok);
    await expect(probe(record, 'main', credential)).resolves.toBeNull();
  });

  it.each([
    ['revoked', 'GITHUB_USER_AUTHORIZATION_REQUIRED'],
    ['connected, with no lifecycle to use it', 'UNAVAILABLE']
  ] as const)('refuses a %s authorization before any probe runs, even when the App reconcile rejects', async (state, code) => {
    const { finalize, lane, operation, reconcile, installations } = interrupted({ lifecycle: state === 'revoked' });
    lane(state === 'revoked' ? 'revoked' : 'user');
    // A matching installation is on record, so the write resolution reconciles it first, and GitHub is down.
    vi.spyOn(installations, 'listInstallations').mockReturnValue([{ installationId: '11', accountLogin: 'bestagentkits', status: 'active' }] as never);
    reconcile.mockRejectedValue(new Error('GitHub is unreachable'));
    await expect(finalize()).rejects.toMatchObject({ code });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(helperCalls('probe-helper')).toHaveLength(0);
    expect(operation()?.status).toBe('UNKNOWN_REMOTE_STATE');
    expect(JSON.stringify(docker.runDocker.mock.calls)).not.toContain(PAT);
  });

  it.each([
    ['revoked', 'GITHUB_USER_AUTHORIZATION_REQUIRED'],
    ['connected, with no lifecycle to use it', 'UNAVAILABLE']
  ] as const)('refuses a %s authorization before any probe runs when no GitHub App is configured', async (state, code) => {
    const { finalize, lane, operation } = interrupted({ app: false });
    lane(state === 'revoked' ? 'revoked' : 'user');
    await expect(finalize()).rejects.toMatchObject({ code });
    expect(helperCalls('probe-helper')).toHaveLength(0);
    expect(operation()?.status).toBe('UNKNOWN_REMOTE_STATE');
    expect(JSON.stringify(docker.runDocker.mock.calls)).not.toContain(PAT);
  });
});

describe('capabilities and the legacy lane', () => {
  it('advertises push for a connected user unless the cache says the owner is unreachable', () => {
    const { service, record, lane, userAuthorizations } = fixture({ secret: false });
    lane('user');
    expect(service.computeWorkspaceCapabilities(record).capabilities.repository).toMatchObject({ read: true, push: true, issuesWrite: true, pullRequestsWrite: true });
    expect(service.computeWorkspaceCapabilities(record).operations).toMatchObject({ gitPush: true, workflowDispatch: true });
    userAuthorizations.cachedOwnerVisible.mockReturnValue(false);
    expect(service.computeWorkspaceCapabilities(record).capabilities.repository.push).toBe(false);
  });

  it('lets a connected or revoked authorization close the fallback secret, and a disconnected one reopen it', () => {
    const { service, record, lane } = fixture();
    lane('legacy');
    expect(service.computeWorkspaceCapabilities(record).capabilities.repository.push).toBe(true);
    lane('revoked');
    expect(service.computeWorkspaceCapabilities(record).capabilities.repository.push).toBe(false);
    lane('owner-not-visible');
    expect(service.computeWorkspaceCapabilities(record).capabilities.repository.push).toBe(true);
    const bare = fixture({ secret: false });
    expect(bare.service.computeWorkspaceCapabilities(bare.record).capabilities.repository.push).toBe(false);
  });

  it('decides the fallback by status alone, never by whether token material is present', () => {
    const config = { authMode: 'cloudflare-access' } as RunnerConfig;
    const metadata = { globalSecretValue: (_principal: string, name: string) => (name === 'GH_TOKEN' ? PAT : undefined), listGlobalSecrets: () => [{ name: 'GH_TOKEN' }] } as unknown as MetadataStore;
    for (const status of [undefined, 'disconnected'] as const) {
      expect(legacyFallbackLaneOpen(status)).toBe(true);
      expect(resolveGitHubFallbackCredential({ config, principalId: 'p', metadata, userAuthorization: status })).toEqual({ token: PAT, source: 'principal-global-secret' });
      expect(hasGitHubFallbackCredential(config, 'p', metadata, status)).toBe(true);
    }
    for (const status of ['connected', 'revoked'] as const) {
      expect(legacyFallbackLaneOpen(status)).toBe(false);
      expect(resolveGitHubFallbackCredential({ config, principalId: 'p', metadata, userAuthorization: status })).toBeUndefined();
      expect(hasGitHubFallbackCredential(config, 'p', metadata, status)).toBe(false);
    }
  });
});

describe('the persisted policy when the App path cannot supply a credential', () => {
  const states = [
    ['revoked', 'GITHUB_USER_AUTHORIZATION_REQUIRED'],
    ['connected, with no lifecycle to use it', 'UNAVAILABLE']
  ] as const;
  const gitOperations = (service: WorkspaceService) => ({
    fetch: (service as unknown as { remoteFetch: (record: WorkspaceRecord, ref: string | undefined) => Promise<unknown> }).remoteFetch.bind(service),
    push: (service as unknown as { remotePush: (record: WorkspaceRecord, input: Record<string, unknown>) => Promise<unknown> }).remotePush.bind(service)
  });

  it.each(states)('refuses a %s authorization for clone, fetch and push when no GitHub App is configured', async (state, code) => {
    const { cloneRepository, lane, service, record } = fixture({ app: false });
    lane(state === 'revoked' ? 'revoked' : 'user');
    const { fetch, push } = gitOperations(service);
    await expect(cloneRepository()).rejects.toMatchObject({ code, retryable: false });
    await expect(fetch(record, undefined)).rejects.toMatchObject({ code });
    await expect(push(record, { refspec: 'HEAD:refs/heads/main' })).rejects.toMatchObject({ code });
    expect(docker.runDocker).not.toHaveBeenCalled();
  });

  it.each(states)('refuses a %s authorization for a push when the App reconcile rejects', async (state, code) => {
    const { lane, service, record, reconcile, installations } = fixture({ lifecycle: state === 'revoked' });
    lane(state === 'revoked' ? 'revoked' : 'user');
    vi.spyOn(installations, 'listInstallations').mockReturnValue([{ installationId: '11', accountLogin: 'bestagentkits', status: 'active' }] as never);
    reconcile.mockRejectedValue(new Error('GitHub is unreachable'));
    await expect(gitOperations(service).push(record, { refspec: 'HEAD:refs/heads/main' })).rejects.toMatchObject({ code });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(docker.runDocker).not.toHaveBeenCalled();
  });

  it('leaves the fallback secret to a principal with no authorization when no GitHub App is configured', async () => {
    const { cloneRepository } = fixture({ app: false });
    docker.runDocker.mockResolvedValue(failure('remote: Write access to repository not granted.', 128));
    const error = await cloneRepository().catch((caught: unknown) => caught as Error);
    expect(error.message).toContain('repository clone failed (credential: principal-global-secret)');
    expect(stdins()[0]).toBe(`${PAT}\n`);
  });
});

describe('the legacy lane follows the status at the moment of the decision', () => {
  it.each(['clone', 'fetch'] as const)('selects the fallback secret when the person disconnects while the owner lookup is pending (%s)', async (operation) => {
    const { lane, lifecycle, authorizer, principalId, cloneRepository, service, record } = fixture({ lifecycle: 'real' });
    lane('user');
    const lookup = deferred<Set<string>>();
    authorizer.userInstallationOwners.mockReturnValueOnce(lookup.promise);
    const fetch = (service as unknown as { remoteFetch: (record: WorkspaceRecord, ref: string | undefined) => Promise<unknown> }).remoteFetch.bind(service);
    const running = operation === 'clone' ? cloneRepository() : fetch(record, undefined);
    // The clone prepares its directory first, with real file system calls, so wait for the lookup itself.
    await vi.waitFor(() => expect(authorizer.userInstallationOwners).toHaveBeenCalledTimes(1));
    // Nothing runs before the lane has decided.
    expect(docker.runDocker).not.toHaveBeenCalled();

    await lifecycle.disconnect(principalId);
    lookup.resolve(new Set(['bestagentkits']));
    await running;

    // The stale lookup is not repeated or used: a disconnected principal answers `legacy`, which opens the secret.
    expect(authorizer.userInstallationOwners).toHaveBeenCalledTimes(1);
    const helper = helperCalls(operation === 'clone' ? '/opt/harness/clone-helper.sh' : TRANSFER_HELPER)[0];
    expect(helper?.[1]).toMatchObject({ stdin: `${PAT}\n` });
    expect(JSON.stringify(docker.runDocker.mock.calls)).not.toContain('ghu_access_lane');
  });
});

describe('the user token acts only on the workspace repository', () => {
  const OWN = 'bestagentkits/cloud-harness-mcp';
  const OWN_URL = 'https://github.com/bestagentkits/cloud-harness-mcp.git';
  const VICTIM = 'victim/private-repo';

  /** Another repository named everywhere a checkout or a caller could name one: remotes, rewrites, and push URLs. */
  function poisonCheckout(workspacePath: string) {
    mkdirSync(join(workspacePath, 'repo', '.git'), { recursive: true });
    writeFileSync(join(workspacePath, 'repo', '.git', 'config'), [
      '[remote "origin"]', `\turl = https://github.com/${VICTIM}.git`, `\tpushurl = https://github.com/${VICTIM}.git`,
      `[url "https://github.com/${VICTIM}.git"]`, `\tinsteadOf = ${OWN_URL}`, ''
    ].join('\n'));
  }
  const ghRepo = (args: string[]) => args.find((value) => value.startsWith('GH_REPO='));
  const launches = () => docker.runDocker.mock.calls.map(([args]) => args as string[]);
  const urlsGiven = (script: string) => launches().filter((args) => args.includes(script));
  const expectNoVictim = () => expect(launchArguments()).not.toContain('victim');

  it('derives the owner pre-check, GH_REPO, and the helper target from the workspace record, never from the caller', async () => {
    const { action, lane, userAuthorizations, principalId } = fixture();
    lane('user');
    docker.runDocker.mockImplementation(async (args: string[]) => (args.includes(GH_HELPER) ? { ...ok, stdout: 'done' } : ok));
    // A caller that names another repository in any spelling it can: the schema keeps none of them.
    const result = await action({ repository: VICTIM, repo: VICTIM, owner: 'victim', url: `https://github.com/${VICTIM}`, remote: `https://github.com/${VICTIM}.git` });
    expect(result.ok).toBe(true);
    expect(userAuthorizations.credentialFor).toHaveBeenCalledTimes(1);
    expect(userAuthorizations.credentialFor).toHaveBeenCalledWith(principalId, 'bestagentkits');
    const [helper] = urlsGiven(GH_HELPER);
    expect(ghRepo(helper!)).toBe(`GH_REPO=${OWN}`);
    expect(helper!.filter((value) => value.startsWith('GH_REPO='))).toHaveLength(1);
    // The helper never mounts a checkout, so no `.git/config` of it can name another repository.
    expect(helper).not.toContain('--volume');
    expectNoVictim();
  });

  it('refuses a pull request or issue target that is a URL of another repository, before any credential is resolved', async () => {
    const { service, principalSelector, workspaceId, userAuthorizations, lane } = fixture();
    lane('user');
    for (const [operation, input] of [
      ['github_read', { action: 'pr_view', prNumber: `https://github.com/${VICTIM}/pull/1` }],
      ['github_read', { action: 'issue_view', issueNumber: `${VICTIM}#1` }],
      ['github_action', { action: 'pr_comment', prNumber: `https://github.com/${VICTIM}/pull/1`, body: 'hi' }]
    ] as const) {
      await expect(service.execute(principalSelector, operation, { workspaceId, ...input })).rejects.toMatchObject({ name: 'ZodError' });
    }
    expect(userAuthorizations.credentialFor).not.toHaveBeenCalled();
    expect(helperCalls(GH_HELPER)).toHaveLength(0);
  });

  it('clones the workspace repository with the owner pre-check of the workspace owner', async () => {
    const { cloneRepository, lane, userAuthorizations, principalId, record } = fixture();
    lane('user');
    await cloneRepository();
    expect(userAuthorizations.credentialFor).toHaveBeenCalledWith(principalId, 'bestagentkits');
    const [helper] = urlsGiven('/opt/harness/clone-helper.sh');
    const afterImage = helper!.slice(helper!.indexOf('executor') + 1);
    expect(afterImage[0]).toBe(record.repositoryUrl);
    expect(afterImage.filter((value) => value.includes('github.com'))).toEqual([OWN_URL]);
    expect(stdins()).toEqual([`${USER_TOKEN}\n`]);
  });

  it('fetches and pushes only to the workspace repository when the checkout names another one', async () => {
    const { service, record, lane, userAuthorizations, principalId } = fixture();
    lane('user');
    poisonCheckout(record.workspacePath);
    docker.runDocker.mockImplementation(async (args: string[]) => (args.includes('rev-parse') ? { ...ok, stdout: `${'a'.repeat(40)}\n` } : ok));
    const internals = service as unknown as {
      remoteFetch: (record: WorkspaceRecord, ref: string | undefined) => Promise<unknown>;
      remotePush: (record: WorkspaceRecord, input: Record<string, unknown>) => Promise<unknown>;
    };
    await internals.remoteFetch(record, `refs/heads/${'main'}`);
    await internals.remotePush(record, { refspec: 'HEAD:refs/heads/main' });
    expect(userAuthorizations.credentialFor.mock.calls.map(([, owner]) => owner)).toEqual(['bestagentkits', 'bestagentkits']);
    expect(userAuthorizations.credentialFor).toHaveBeenCalledWith(principalId, 'bestagentkits');
    // Only the two transfers that hold the token run on the network; each is handed the workspace URL.
    const networked = urlsGiven(TRANSFER_HELPER).filter((args) => args.includes('bridge'));
    expect(networked.map((args) => args[args.indexOf('executor') + 2])).toEqual([record.repositoryUrl, record.repositoryUrl]);
    expect(networked.map((args) => args[args.indexOf('executor') + 1])).toEqual(['fetch', 'push']);
    const tokenHolders = docker.runDocker.mock.calls.filter(([, options]) => (options as { stdin?: string } | undefined)?.stdin === `${USER_TOKEN}\n`);
    expect(tokenHolders).toHaveLength(2);
    // The token-holding helpers get no mount of the agent-written checkout either: only the transfer volume.
    for (const [args] of tokenHolders) expect((args as string[]).filter((value) => value.includes(record.workspacePath))).toEqual([`${record.workspacePath}:/job:rw`]);
    expectNoVictim();
  });

  it('refuses a push or fetch that names a remote, URL, or refspec destination of another repository, and starts no token-holding helper', async () => {
    const { service, principalSelector, workspaceId, lane, userAuthorizations } = fixture();
    lane('user');
    const victimUrl = `https://github.com/${VICTIM}.git`;
    for (const [operation, input] of [
      ['git_push', { remote: victimUrl, refspec: 'HEAD:refs/heads/main' }],
      ['git_push', { remote: 'upstream', refspec: 'HEAD:refs/heads/main' }],
      ['git_push', { refspec: `HEAD:${victimUrl}` }],
      ['git_push', { refspec: `${victimUrl}:refs/heads/main` }],
      ['git_fetch', { remote: victimUrl }],
      ['git_fetch', { refspec: victimUrl }],
      ['git_pull', { remote: victimUrl }]
    ] as const) {
      await expect(service.execute(principalSelector, operation, { workspaceId, ...input })).rejects.toMatchObject({ name: 'ZodError' });
    }
    expect(userAuthorizations.credentialFor).not.toHaveBeenCalled();
    expect(stdins()).not.toContain(`${USER_TOKEN}\n`);
    expect(helperCalls(TRANSFER_HELPER)).toHaveLength(0);
  });

  it('probes the remote branch of the workspace repository with the user token, whatever the checkout names', async () => {
    const { service, record, lane, userAuthorizations, principalId } = fixture();
    lane('user');
    poisonCheckout(record.workspacePath);
    const probe = (service as unknown as {
      probeRemoteRefOid: (record: WorkspaceRecord, branch: string, credential: unknown) => Promise<string | null | undefined>;
    }).probeRemoteRefOid.bind(service);
    docker.runDocker.mockResolvedValue({ ...ok, stdout: `${'c'.repeat(40)}\trefs/heads/main\n` });
    await expect(probe(record, 'main', { token: USER_TOKEN, source: 'github-user', userGeneration: 3 })).resolves.toBe('c'.repeat(40));
    const [helper] = urlsGiven('probe-helper');
    expect(helper!.slice(helper!.indexOf('probe-helper'))).toEqual(['probe-helper', record.repositoryUrl, 'refs/heads/main']);
    expect(helper).not.toContain('--volume');
    expect(stdins()).toEqual([`${USER_TOKEN}\n`]);
    expect(userAuthorizations.credentialFor).not.toHaveBeenCalled();
    expect(principalId).toBeTruthy();
    expectNoVictim();
  });
});
