import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubStatusResultSchema, type GitHubStatusResult, type MetadataRunnerRequest, type RunnerConfig } from '@cloud-harness/contracts';
import { ArtifactStore } from '../src/artifact-store.js';
import { DashboardControlService } from '../src/dashboard-control-service.js';
import { GitHubAuthorizationStateStore, GitHubBindingService, GitHubSetupStateStore } from '../src/github-binding-service.js';
import { InMemoryGitHubInstallationStore } from '../src/github-installation-store.js';
import { GitHubUserAuthorizationService } from '../src/github-user-authorization-service.js';
import type { GitHubUserTokenExchange } from '../src/github-user-authorizer.js';
import { MetadataStore } from '../src/metadata-store.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore } from '../src/state-store.js';
import type { WorkspaceService } from '../src/workspace-service.js';
import { deferred, exchange, fakeAuthorizer, pair } from './github-user-fixtures.js';

const REDIRECT_URI = 'https://dashboard.example.com/dashboard/integrations/github';
const BROWSER = 'b'.repeat(43);
const principal = { kind: 'external' as const, issuer: 'https://team.cloudflareaccess.com', subject: 'operator-a' };
const roots: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) {
    try { close(); } catch { /* already closed */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const request = (operation: string, input: Record<string, unknown>, selected = principal) =>
  ({ version: 2, principal: selected, operation, input }) as MetadataRunnerRequest;

function setup(options: { persistent?: boolean; lifecycle?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ch-github-user-flow-'));
  roots.push(root);
  const path = join(root, 'state.db');
  const principals = new StateStore(path);
  const keyring = new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]);
  const metadata = new MetadataStore(path, keyring);
  closers.push(() => metadata.close(), () => principals.close());
  const artifacts = new ArtifactStore(principals.database, { root: join(root, 'artifacts'), maxArtifactBytes: 1024, maxPrincipalBytes: 4096, defaultRetentionMs: 60_000, maxRetentionMs: 120_000 });
  const installations = new InMemoryGitHubInstallationStore();
  const verifier = {
    verifyInstallation: async (id: string) => ({
      appId: '1', installationId: id, accountId: '201', accountLogin: 'acme', issues: null, pullRequests: null, status: 'active' as const,
      repositories: [{ owner: 'acme', repository: 'app', contents: 'write' as const }]
    })
  };
  const authorizer = fakeAuthorizer({
    proveInstallationAdministration: vi.fn(async ({ installationId }: { installationId: string }) => ({
      userId: '201', userLogin: 'alice', appId: '1', installationId, accountId: '201', accountLogin: 'acme', relation: 'owner' as const
    }))
  });
  authorizer.exchangeUserCode.mockImplementation(async () => exchange('one', Date.now()));
  const userAuthorizations = options.lifecycle === false ? undefined : new GitHubUserAuthorizationService(metadata.githubUserAuthorizations, authorizer);
  const states = new GitHubAuthorizationStateStore(options.persistent ? principals.database : undefined);
  const binding = new GitHubBindingService(new GitHubSetupStateStore(principals.database), installations, verifier, Date.now, {
    states, authorizer, ...(userAuthorizations ? { userAuthorizations } : {})
  });
  const controls = new DashboardControlService(
    { artifactRetentionSeconds: 60, githubApp: { appSlug: 'test-app', appId: 1 } } as RunnerConfig,
    principals, metadata, artifacts, {} as WorkspaceService, installations, binding
  );
  const begin = async (purpose: 'user' | 'bind') => {
    const begun = await controls.execute(request('github_authorize_begin', purpose === 'user'
      ? { purpose: 'user', redirectUri: REDIRECT_URI, browserBinding: BROWSER }
      : { installationId: '456', redirectUri: REDIRECT_URI, browserBinding: BROWSER }));
    return new URL((begun.data as { url: string }).url).searchParams.get('state')!;
  };
  const complete = (state: string, selected = principal, browserBinding = BROWSER) =>
    controls.execute(request('github_setup_complete', { state, code: 'github-code', browserBinding }, selected));
  const status = async (selected = principal) => (await controls.execute(request('github_status', {}, selected))).data as GitHubStatusResult;
  const audits = (selected = principal) => metadata.listAudit(principals.resolvePrincipal(selected), 100);
  const row = () => metadata.database.prepare('SELECT * FROM github_user_authorizations').get() as Record<string, unknown> | undefined;
  return { controls, principals, metadata, authorizer, begin, complete, status, audits, row };
}

describe('GitHub user authorization flow', () => {
  it.each([false, true])('completes a state as the purpose it was started with, never as the other (persisted states: %s)', async (persistent) => {
    const { authorizer, begin, complete } = setup({ persistent });
    const userState = await begin('user');
    expect(authorizer.authorizeUserUrl).toHaveBeenCalledTimes(1);
    expect(authorizer.authorizeUrl).not.toHaveBeenCalled();
    const connected = await complete(userState);
    expect(connected.message).toBe('GitHub user connected');
    expect(authorizer.exchangeUserCode).toHaveBeenCalledWith({ code: 'github-code', codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), redirectUri: REDIRECT_URI });
    expect(authorizer.proveInstallationAdministration).not.toHaveBeenCalled();
    const afterUser = GitHubStatusResultSchema.parse(connected.data);
    expect(afterUser.installations).toEqual([]);
    expect(afterUser.userAuthorization).toEqual({ status: 'connected', login: 'alice', githubUserId: '789', refreshExpiresAt: expect.any(Number), reasonCode: null });

    const bindState = await begin('bind');
    expect(authorizer.authorizeUrl).toHaveBeenCalledTimes(1);
    const bound = await complete(bindState);
    expect(bound.message).toBe('GitHub installation connected');
    expect(authorizer.proveInstallationAdministration).toHaveBeenCalledTimes(1);
    expect(authorizer.exchangeUserCode).toHaveBeenCalledTimes(1);
    const afterBind = GitHubStatusResultSchema.parse(bound.data);
    expect(afterBind.installations).toHaveLength(1);
    expect(afterBind.userAuthorization).toMatchObject({ status: 'connected' });

    // A spent state cannot be replayed as either purpose.
    await expect(complete(userState)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(complete(bindState)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(authorizer.exchangeUserCode).toHaveBeenCalledTimes(1);
    expect(authorizer.proveInstallationAdministration).toHaveBeenCalledTimes(1);
  });

  it('stores the pair encrypted, audits github.user_authorized, and exposes no token anywhere', async () => {
    const { begin, complete, status, audits, row } = setup();
    const result = await complete(await begin('user'));
    const stored = row()!;
    expect(stored).toMatchObject({ status: 'connected', generation: 1, github_login: 'alice', github_user_id: '789' });
    expect(Buffer.from(stored.ciphertext as Uint8Array).toString('latin1')).not.toContain('ghu_access_one');
    expect(audits().find((event) => event.action === 'github.user_authorized')).toMatchObject({
      subjectType: 'github_user_authorization', subjectId: '789', details: { login: 'alice', githubUserId: '789' }
    });
    const everything = JSON.stringify([result, audits(), await status()]);
    for (const secret of ['ghu_access_one', 'ghr_refresh_one', 'github-code']) expect(everything).not.toContain(secret);
  });

  it('disconnects, audits, clears the envelope, revokes the token at GitHub, and is idempotent', async () => {
    const { controls, begin, complete, authorizer, audits, row } = setup();
    await complete(await begin('user'));
    const disconnected = await controls.execute(request('github_user_disconnect', {}));
    expect(disconnected.message).toBe('GitHub user disconnected');
    expect(GitHubStatusResultSchema.parse(disconnected.data).userAuthorization).toEqual({
      status: 'disconnected', login: 'alice', githubUserId: '789', refreshExpiresAt: null, reasonCode: null
    });
    expect(authorizer.revoke).toHaveBeenCalledWith('ghu_access_one');
    expect(row()).toMatchObject({ status: 'disconnected', ciphertext: null, nonce: null, auth_tag: null, key_version: null });
    expect(audits().filter((event) => event.action === 'github.user_disconnected')).toHaveLength(1);

    await controls.execute(request('github_user_disconnect', {}));
    expect(audits().filter((event) => event.action === 'github.user_disconnected')).toHaveLength(1);
    // A principal that never connected reports no authorization.
    const other = await controls.execute(request('github_user_disconnect', {}, { ...principal, subject: 'operator-b' }));
    expect(GitHubStatusResultSchema.parse(other.data).userAuthorization).toBeNull();
  });

  it('refuses the user purpose without a keyring-backed lifecycle and keeps the bind purpose working', async () => {
    const { controls, begin } = setup({ lifecycle: false });
    await expect(controls.execute(request('github_authorize_begin', { purpose: 'user', redirectUri: REDIRECT_URI, browserBinding: BROWSER })))
      .rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: false });
    await expect(controls.execute(request('github_user_disconnect', {}))).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(begin('bind')).resolves.toEqual(expect.any(String));
  });

  it('treats a persisted state from before purposes existed as a bind', async () => {
    const { principals, complete, authorizer } = setup({ persistent: true });
    const state = 'legacy-state-'.padEnd(43, 'x');
    principals.database.prepare(`INSERT INTO github_authorization_states
      (state_hash, principal_id, browser_binding, payload, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      createHash('sha256').update(state).digest('base64url'), principals.resolvePrincipal(principal), BROWSER,
      JSON.stringify({ installationId: '456', expectedAppId: '1', redirectUri: REDIRECT_URI, codeVerifier: 'v'.repeat(43) }),
      Date.now() + 600_000, Date.now()
    );
    expect((await complete(state)).message).toBe('GitHub installation connected');
    expect(authorizer.proveInstallationAdministration).toHaveBeenCalledTimes(1);
    expect(authorizer.exchangeUserCode).not.toHaveBeenCalled();
  });
});

const settle = () => new Promise<void>((done) => setImmediate(done));

describe('GitHub user authorization races and status', () => {
  it('does not let a connection finish after the person disconnected while its code exchange was in flight', async () => {
    const { authorizer, begin, complete, controls, status, row } = setup();
    const state = await begin('user');
    const gate = deferred<GitHubUserTokenExchange>();
    authorizer.exchangeUserCode.mockReturnValueOnce(gate.promise);
    const completing = complete(state).catch((error: unknown) => error);
    await settle();
    expect(authorizer.exchangeUserCode).toHaveBeenCalledTimes(1);
    await controls.execute(request('github_user_disconnect', {}));
    gate.resolve(exchange('late', Date.now()));
    expect(await completing).toMatchObject({ code: 'FORBIDDEN' });
    expect(row()).toBeUndefined();
    expect((await status()).userAuthorization).toBeNull();
    expect(authorizer.revoke).toHaveBeenCalledWith('ghu_access_late');
  });

  it('lets the newer of two concurrent completions win, whichever response arrives first', async () => {
    const { authorizer, begin, complete, status } = setup();
    const olderState = await begin('user');
    const newerState = await begin('user');
    const olderGate = deferred<GitHubUserTokenExchange>();
    const newerGate = deferred<GitHubUserTokenExchange>();
    authorizer.exchangeUserCode.mockReturnValueOnce(olderGate.promise).mockReturnValueOnce(newerGate.promise);
    const older = complete(olderState).catch((error: unknown) => error);
    await settle();
    const newer = complete(newerState);
    await settle();
    newerGate.resolve(exchange('newer', Date.now(), { login: 'bob', userId: '900' }));
    await newer;
    olderGate.resolve(exchange('older', Date.now()));
    expect(await older).toMatchObject({ code: 'FORBIDDEN' });
    expect((await status()).userAuthorization).toMatchObject({ status: 'connected', login: 'bob' });
    expect(authorizer.revoke).toHaveBeenCalledWith('ghu_access_older');
    expect(authorizer.revoke).not.toHaveBeenCalledWith('ghu_access_newer');
  });

  it('reports the stored status from the database even when this runner cannot run the lifecycle', async () => {
    const { metadata, principals, status } = setup({ lifecycle: false });
    const principalId = principals.resolvePrincipal(principal);
    const rows = metadata.githubUserAuthorizations;
    rows.connect(principalId, { githubUserId: '789', login: 'alice', ...pair(Date.now(), 'one') });
    expect((await status()).userAuthorization).toMatchObject({ status: 'connected', login: 'alice', reasonCode: null });
    rows.markRevoked(principalId, rows.get(principalId)!.generation, 'bad_refresh_token');
    expect((await status()).userAuthorization).toMatchObject({ status: 'revoked', reasonCode: 'bad_refresh_token' });
  });
});
