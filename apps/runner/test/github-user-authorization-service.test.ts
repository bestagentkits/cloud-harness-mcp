import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubUserAuthorizationViewSchema, HarnessError } from '@cloud-harness/contracts';
import { GitHubUserAuthorizationService } from '../src/github-user-authorization-service.js';
import { GitHubUserAuthorizationStore } from '../src/github-user-authorization-store.js';
import { GitHubUserTokenRejectedError } from '../src/github-user-authorizer.js';
import { MetadataStore } from '../src/metadata-store.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore } from '../src/state-store.js';
import { MINUTE, deferred, exchange, fakeAuthorizer, refreshed } from './github-user-fixtures.js';

const closers: Array<() => void> = [];
const directories: string[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) {
    try { close(); } catch { /* already closed */ }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function open() {
  const directory = mkdtempSync(join(tmpdir(), 'ch-github-user-service-'));
  directories.push(directory);
  const path = join(directory, 'state.db');
  const state = new StateStore(path);
  const keyring = new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]);
  const metadata = new MetadataStore(path, keyring);
  closers.push(() => metadata.close(), () => state.close());
  const principalId = state.resolvePrincipal({ kind: 'owner', ownerId: 'principal_1' });
  const clock = { now: 10_000_000 };
  const store = new GitHubUserAuthorizationStore(metadata.database, keyring, () => clock.now);
  const authorizer = fakeAuthorizer();
  const service = new GitHubUserAuthorizationService(store, authorizer, () => clock.now);
  const connect = (suffix: string, overrides: Parameters<typeof exchange>[2] = {}) => service.connect(principalId, exchange(suffix, clock.now, overrides));
  const audit = (action: string) => metadata.listAudit(principalId, 100).filter((event) => event.action === action);
  return { principalId, clock, store, authorizer, service, connect, audit, metadata };
}

describe('GitHub user authorization lifecycle', () => {
  it('serves the stored token while more than five minutes remain and refreshes ahead of expiry below that', async () => {
    const { service, authorizer, principalId, clock, connect, store } = open();
    await connect('one', { accessExpiresAt: clock.now + 6 * MINUTE });
    await expect(service.accessToken(principalId)).resolves.toEqual({ token: 'ghu_access_one', generation: 1, login: 'alice' });
    expect(authorizer.refresh).not.toHaveBeenCalled();

    clock.now += 2 * MINUTE;
    authorizer.refresh.mockResolvedValueOnce(refreshed('two', clock.now));
    await expect(service.accessToken(principalId)).resolves.toEqual({ token: 'ghu_access_two', generation: 2, login: 'alice' });
    expect(authorizer.refresh).toHaveBeenCalledTimes(1);
    expect(authorizer.refresh).toHaveBeenCalledWith('ghr_refresh_one');
    expect(store.load(principalId)).toMatchObject({ record: { generation: 2 }, tokens: { refreshToken: 'ghr_refresh_two' } });
    // The renewed token is served without another request.
    await service.accessToken(principalId);
    expect(authorizer.refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes once for two concurrent callers', async () => {
    const { service, authorizer, principalId, clock, connect } = open();
    await connect('one', { accessExpiresAt: clock.now + MINUTE });
    const gate = deferred<ReturnType<typeof refreshed>>();
    authorizer.refresh.mockReturnValue(gate.promise);
    const first = service.accessToken(principalId);
    const second = service.accessToken(principalId);
    gate.resolve(refreshed('two', clock.now));
    const [a, b] = await Promise.all([first, second]);
    expect(authorizer.refresh).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ token: 'ghu_access_two', generation: 2 });
  });

  it('cannot resurrect a token the person disconnected while a refresh was in flight', async () => {
    const { service, authorizer, principalId, clock, connect, store, audit } = open();
    await connect('one', { accessExpiresAt: clock.now + MINUTE });
    const gate = deferred<ReturnType<typeof refreshed>>();
    authorizer.refresh.mockReturnValue(gate.promise);
    const pending = service.accessToken(principalId);
    await service.disconnect(principalId);
    gate.resolve(refreshed('two', clock.now));
    await expect(pending).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    expect(store.load(principalId)).toEqual({ record: expect.objectContaining({ status: 'disconnected' }) });
    expect(authorizer.revoke).toHaveBeenCalledWith('ghu_access_one');
    // The pair GitHub issued to the lost refresh is dropped and revoked, never written back.
    expect(authorizer.revoke).toHaveBeenCalledWith('ghu_access_two');
    expect(audit('github.user_disconnected')).toHaveLength(1);
  });

  it('answers a 401 for an older generation with the current token and revokes nothing', async () => {
    const { service, authorizer, principalId, connect, store } = open();
    await connect('one');
    await connect('two');
    expect(authorizer.revoke).toHaveBeenCalledWith('ghu_access_one');
    await expect(service.recoverRejected(principalId, 1)).resolves.toMatchObject({ token: 'ghu_access_two', generation: 2 });
    expect(authorizer.refresh).not.toHaveBeenCalled();
    expect(store.get(principalId)).toMatchObject({ status: 'connected', generation: 2 });
  });

  it('refreshes once for a 401 of the current generation, and only GitHub refusing that refresh revokes', async () => {
    const { service, authorizer, principalId, clock, connect, store, audit } = open();
    await connect('one');
    authorizer.refresh.mockResolvedValueOnce(refreshed('two', clock.now));
    await expect(service.recoverRejected(principalId, 1)).resolves.toMatchObject({ token: 'ghu_access_two', generation: 2 });

    authorizer.refresh.mockResolvedValueOnce({ status: 'revoked', reasonCode: 'bad_refresh_token' });
    await expect(service.recoverRejected(principalId, 2)).rejects.toMatchObject({
      code: 'GITHUB_USER_AUTHORIZATION_REQUIRED', retryable: false, message: expect.stringContaining('Dashboard → Integrations → GitHub → GitHub user')
    });
    expect(store.get(principalId)).toMatchObject({ status: 'revoked', reasonCode: 'bad_refresh_token', generation: 3 });
    expect(audit('github.user_authorization_revoked')).toEqual([expect.objectContaining({ details: { reasonCode: 'bad_refresh_token' } })]);
    // A late rejection of the old token neither refreshes nor changes the revoked row.
    await expect(service.recoverRejected(principalId, 1)).rejects.toMatchObject({ code: 'GITHUB_USER_AUTHORIZATION_REQUIRED' });
    expect(authorizer.refresh).toHaveBeenCalledTimes(2);
    expect(store.get(principalId)).toMatchObject({ status: 'revoked', generation: 3 });
  });

  it('revokes an expired refresh token without calling GitHub, and keeps the pair through a transient failure', async () => {
    const expired = open();
    await expired.connect('one', { refreshExpiresAt: expired.clock.now + 1_000 });
    expired.clock.now += 2_000;
    await expect(expired.service.accessToken(expired.principalId)).rejects.toMatchObject({ code: 'GITHUB_USER_AUTHORIZATION_REQUIRED' });
    expect(expired.authorizer.refresh).not.toHaveBeenCalled();
    expect(expired.store.get(expired.principalId)).toMatchObject({ status: 'revoked', reasonCode: 'refresh_token_expired' });

    const transient = open();
    await transient.connect('one', { accessExpiresAt: transient.clock.now + MINUTE });
    transient.authorizer.refresh.mockRejectedValueOnce(new HarnessError('UNAVAILABLE', 'GitHub user authorization failed', 502, true));
    await expect(transient.service.accessToken(transient.principalId)).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    expect(transient.store.load(transient.principalId)).toMatchObject({ record: { status: 'connected', generation: 1 }, tokens: { refreshToken: 'ghr_refresh_one' } });
    transient.authorizer.refresh.mockResolvedValueOnce(refreshed('two', transient.clock.now));
    await expect(transient.service.accessToken(transient.principalId)).resolves.toMatchObject({ token: 'ghu_access_two' });
  });

  it('decides the lane from the stored status and the owners the user can reach', async () => {
    const { service, authorizer, principalId, clock, connect, store } = open();
    await expect(service.credentialFor(principalId, 'acme')).resolves.toEqual({ lane: 'legacy' });

    await connect('one');
    await expect(service.credentialFor(principalId, 'Acme')).resolves.toMatchObject({ lane: 'user', credential: { token: 'ghu_access_one', generation: 1 } });
    await expect(service.credentialFor(principalId, 'other')).resolves.toEqual({ lane: 'owner-not-visible' });
    expect(authorizer.userInstallationOwners).toHaveBeenCalledTimes(1);
    expect(service.cachedOwnerVisible(principalId, 'acme')).toBe(true);
    expect(service.cachedOwnerVisible(principalId, 'other')).toBe(false);
    clock.now += 6 * MINUTE;
    expect(service.cachedOwnerVisible(principalId, 'acme')).toBeUndefined();
    await service.credentialFor(principalId, 'acme');
    expect(authorizer.userInstallationOwners).toHaveBeenCalledTimes(2);

    // A 401 on the owners call recovers once with the user lane's own token.
    await connect('two');
    authorizer.userInstallationOwners.mockRejectedValueOnce(new GitHubUserTokenRejectedError());
    authorizer.refresh.mockResolvedValueOnce(refreshed('three', clock.now));
    await expect(service.credentialFor(principalId, 'acme')).resolves.toMatchObject({ lane: 'user', credential: { token: 'ghu_access_three', generation: 3 } });
    expect(authorizer.userInstallationOwners).toHaveBeenLastCalledWith('ghu_access_three');

    // Disconnect reopens the legacy lane and drops the cache; a revoked authorization never does.
    await service.disconnect(principalId);
    await expect(service.credentialFor(principalId, 'acme')).resolves.toEqual({ lane: 'legacy' });
    expect(service.cachedOwnerVisible(principalId, 'acme')).toBeUndefined();
    await connect('four');
    store.markRevoked(principalId, store.get(principalId)!.generation, 'bad_refresh_token');
    await expect(service.credentialFor(principalId, 'acme')).rejects.toMatchObject({ code: 'GITHUB_USER_AUTHORIZATION_REQUIRED' });
  });

  it('projects status only', async () => {
    const { service, principalId, connect } = open();
    expect(service.view(principalId)).toBeUndefined();
    await connect('one');
    const view = service.view(principalId);
    expect(GitHubUserAuthorizationViewSchema.parse(view)).toEqual({
      status: 'connected', login: 'alice', githubUserId: '789', refreshExpiresAt: expect.any(Number), reasonCode: null
    });
    expect(JSON.stringify(view)).not.toMatch(/ghu_|ghr_/);
    await service.disconnect(principalId);
    expect(service.view(principalId)).toEqual({ status: 'disconnected', login: 'alice', githubUserId: '789', refreshExpiresAt: null, reasonCode: null });
  });
});

const settle = () => new Promise<void>((done) => setImmediate(done));

describe('GitHub user authorization completions', () => {
  it('voids a completion begun before a Disconnect, with or without a row, and revokes the pair it received', async () => {
    const { service, store, authorizer, principalId, clock } = open();
    const ticket = service.beginCompletion(principalId);
    await service.disconnect(principalId);
    await expect(service.complete(ticket, exchange('late', clock.now))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(store.get(principalId)).toBeUndefined();
    expect(authorizer.revoke).toHaveBeenCalledWith('ghu_access_late');
  });

  it('keeps a Disconnect final over an existing connection, and lets a later completion connect again', async () => {
    const { service, store, authorizer, principalId, clock, connect } = open();
    await connect('one');
    const ticket = service.beginCompletion(principalId);
    await service.disconnect(principalId);
    authorizer.revoke.mockClear();
    await expect(service.complete(ticket, exchange('two', clock.now))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(store.get(principalId)).toMatchObject({ status: 'disconnected' });
    expect(authorizer.revoke).toHaveBeenCalledTimes(1);
    expect(authorizer.revoke).toHaveBeenCalledWith('ghu_access_two');
    await expect(connect('three')).resolves.toMatchObject({ status: 'connected' });
  });

  it('never lets an older completion overwrite a newer one, whichever response arrives first', async () => {
    const { service, store, authorizer, principalId, clock } = open();
    const older = service.beginCompletion(principalId);
    const newer = service.beginCompletion(principalId);
    await service.complete(newer, exchange('newer', clock.now, { login: 'bob', userId: '900' }));
    await expect(service.complete(older, exchange('older', clock.now))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(store.load(principalId)).toMatchObject({ record: { login: 'bob', githubUserId: '900' }, tokens: { accessToken: 'ghu_access_newer' } });
    expect(authorizer.revoke).toHaveBeenCalledWith('ghu_access_older');
    expect(authorizer.revoke).not.toHaveBeenCalledWith('ghu_access_newer');

    // The later start that also arrives later replaces the earlier connection, which is then revoked.
    const first = service.beginCompletion(principalId);
    const second = service.beginCompletion(principalId);
    await service.complete(first, exchange('first', clock.now, { login: 'carol', userId: '901' }));
    await service.complete(second, exchange('second', clock.now, { login: 'dave', userId: '902' }));
    expect(store.load(principalId)).toMatchObject({ record: { login: 'dave' }, tokens: { accessToken: 'ghu_access_second' } });
    expect(authorizer.revoke).toHaveBeenCalledWith('ghu_access_first');
  });

  it('does not let a refresh of the old authorization void a reconnect that is in flight', async () => {
    const { service, store, authorizer, principalId, clock, connect } = open();
    await connect('one', { accessExpiresAt: clock.now + MINUTE });
    const ticket = service.beginCompletion(principalId);
    authorizer.refresh.mockResolvedValueOnce(refreshed('two', clock.now));
    await service.accessToken(principalId);
    await expect(service.complete(ticket, exchange('three', clock.now, { login: 'bob', userId: '900' })))
      .resolves.toMatchObject({ status: 'connected', login: 'bob' });
    expect(store.load(principalId)).toMatchObject({ tokens: { accessToken: 'ghu_access_three' } });
  });
});

describe('GitHub user installation owners', () => {
  it('does not use an owners request that was in flight across a reconnect', async () => {
    const { service, authorizer, principalId, clock, connect } = open();
    await connect('one');
    const gate = deferred<Set<string>>();
    authorizer.userInstallationOwners.mockReturnValueOnce(gate.promise).mockResolvedValueOnce(new Set(['other']));
    const stale = service.credentialFor(principalId, 'acme');
    await settle();
    expect(authorizer.userInstallationOwners).toHaveBeenCalledTimes(1);
    expect(authorizer.userInstallationOwners).toHaveBeenNthCalledWith(1, 'ghu_access_one');

    // The person reconnects as someone else while the first request is still pending.
    await service.connect(principalId, exchange('two', clock.now, { login: 'bob', userId: '900' }));
    await expect(service.credentialFor(principalId, 'acme')).resolves.toEqual({ lane: 'owner-not-visible' });
    expect(authorizer.userInstallationOwners).toHaveBeenCalledTimes(2);
    expect(authorizer.userInstallationOwners).toHaveBeenNthCalledWith(2, 'ghu_access_two');

    // The first request settles for an authorization that no longer exists: it is neither published nor used.
    gate.resolve(new Set(['acme']));
    await expect(stale).resolves.toEqual({ lane: 'owner-not-visible' });
    expect(authorizer.userInstallationOwners).toHaveBeenCalledTimes(2);
    expect(service.cachedOwnerVisible(principalId, 'acme')).toBe(false);
    expect(service.cachedOwnerVisible(principalId, 'other')).toBe(true);
  });

  it('answers from the current state when the authorization is disconnected while the owners are being read', async () => {
    const { service, authorizer, principalId, connect } = open();
    await connect('one');
    const gate = deferred<Set<string>>();
    authorizer.userInstallationOwners.mockReturnValueOnce(gate.promise);
    const pending = service.credentialFor(principalId, 'acme');
    await settle();
    await service.disconnect(principalId);
    gate.resolve(new Set(['acme']));
    await expect(pending).resolves.toEqual({ lane: 'legacy' });
    expect(service.cachedOwnerVisible(principalId, 'acme')).toBeUndefined();
  });

  it('reads the owners again when a refresh replaced the token while they were being read', async () => {
    const { service, authorizer, principalId, clock, connect } = open();
    await connect('one');
    const gate = deferred<Set<string>>();
    authorizer.userInstallationOwners.mockReturnValueOnce(gate.promise).mockResolvedValueOnce(new Set(['acme']));
    authorizer.refresh.mockResolvedValueOnce(refreshed('two', clock.now));
    const pending = service.credentialFor(principalId, 'acme');
    await settle();
    await service.recoverRejected(principalId, 1);
    gate.resolve(new Set(['stale-owner']));
    await expect(pending).resolves.toEqual({ lane: 'user', credential: { token: 'ghu_access_two', generation: 2, login: 'alice' } });
    expect(authorizer.userInstallationOwners).toHaveBeenCalledTimes(2);
    expect(authorizer.userInstallationOwners).toHaveBeenNthCalledWith(2, 'ghu_access_two');
  });
});
