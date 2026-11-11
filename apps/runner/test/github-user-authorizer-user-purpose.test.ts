import { describe, expect, it } from 'vitest';
import { GitHubApiUserAuthorizer, GitHubUserTokenRejectedError } from '../src/github-user-authorizer.js';

type Route = { status?: number; body?: unknown; headers?: Record<string, string>; throws?: boolean };
const credentials = { appId: 123, clientId: 'Iv23client', clientSecret: 'client-secret-value' };
const redirectUri = 'https://dashboard.example.com/dashboard/integrations/github';
const input = { code: 'github-code', codeVerifier: 'v'.repeat(43), redirectUri };
const NOW = 5_000_000;
const pairBody = { access_token: 'ghu_new_access', token_type: 'bearer', refresh_token: 'ghr_new_refresh', expires_in: 28_800, refresh_token_expires_in: 15_811_200 };

/** A GitHub stand-in keyed by `METHOD path`; token-endpoint bodies and revocations are recorded. */
function github(routes: Record<string, Route>) {
  const tokenRequests: Array<Record<string, unknown>> = [];
  const revocations: Array<{ authorization: string | null; body: unknown }> = [];
  const apiCalls: Array<{ key: string; authorization: string | null }> = [];
  const request = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const key = `${init.method ?? 'GET'} ${parsed.host === 'github.com' ? parsed.pathname : `${parsed.pathname}${parsed.search}`}`;
    const route = routes[key];
    if (init.method === 'DELETE') {
      revocations.push({ authorization: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
      if (route?.throws) throw new TypeError('network down');
      return new Response(null, { status: route?.status ?? 204 });
    }
    if (parsed.host === 'github.com') tokenRequests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    else apiCalls.push({ key, authorization: new Headers(init.headers).get('authorization') });
    if (!route) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200, headers: route.headers ?? {} });
  }) as typeof fetch;
  return { tokenRequests, revocations, apiCalls, authorizer: new GitHubApiUserAuthorizer(credentials, request, 10_000, () => NOW) };
}

const token = (body: unknown, status = 200): Record<string, Route> => ({ 'POST /login/oauth/access_token': { body, status } });
const user: Record<string, Route> = { 'GET /user': { body: { id: 789, login: 'alice' } } };

describe('GitHub user authorizer, user purpose', () => {
  it('requests offline_access for the user purpose only', () => {
    const { authorizer } = github({});
    const base = { state: 's'.repeat(43), codeChallenge: 'c'.repeat(43), redirectUri };
    const userUrl = new URL(authorizer.authorizeUserUrl(base));
    expect(Object.fromEntries(userUrl.searchParams)).toEqual({
      client_id: 'Iv23client', redirect_uri: redirectUri, state: base.state, code_challenge: base.codeChallenge, code_challenge_method: 'S256', scope: 'offline_access'
    });
    expect(new URL(authorizer.authorizeUrl(base)).searchParams.has('scope')).toBe(false);
  });

  it('exchanges the code for the pair, its expiry times, and the GitHub identity', async () => {
    const { authorizer, tokenRequests, revocations, apiCalls } = github({ ...token(pairBody), ...user });
    await expect(authorizer.exchangeUserCode(input)).resolves.toEqual({
      accessToken: 'ghu_new_access', refreshToken: 'ghr_new_refresh',
      accessExpiresAt: NOW + 28_800_000, refreshExpiresAt: NOW + 15_811_200_000, userId: '789', login: 'alice'
    });
    expect(tokenRequests).toEqual([{ client_id: 'Iv23client', client_secret: 'client-secret-value', code: 'github-code', redirect_uri: redirectUri, code_verifier: 'v'.repeat(43) }]);
    expect(apiCalls).toEqual([{ key: 'GET /user', authorization: 'Bearer ghu_new_access' }]);
    expect(revocations).toEqual([]);
  });

  it.each([
    ['a refresh token', { refresh_token: undefined }],
    ['expires_in', { expires_in: undefined }],
    ['refresh_token_expires_in', { refresh_token_expires_in: undefined }],
    ['a usable expires_in', { expires_in: 0 }]
  ])('fails closed without %s, naming the cause and revoking what GitHub issued', async (_label, missing) => {
    const { authorizer, revocations, apiCalls } = github({ ...token({ ...pairBody, ...missing }), ...user });
    const failure = authorizer.exchangeUserCode(input);
    await expect(failure).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: false });
    await expect(failure).rejects.toThrow('refresh token');
    await expect(failure).rejects.not.toThrow('ghu_new_access');
    expect(revocations).toEqual([{ authorization: `Basic ${Buffer.from('Iv23client:client-secret-value').toString('base64')}`, body: { access_token: 'ghu_new_access' } }]);
    expect(apiCalls).toEqual([]);
  });

  it('refuses an expired code and revokes a token whose identity could not be read', async () => {
    const refused = github(token({ error: 'bad_verification_code' }));
    await expect(refused.authorizer.exchangeUserCode(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(refused.revocations).toEqual([]);
    const unreadable = github({ ...token(pairBody), 'GET /user': { status: 500 } });
    await expect(unreadable.authorizer.exchangeUserCode(input)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(unreadable.revocations).toHaveLength(1);
  });

  it('rotates the pair on refresh, and reads GitHub\'s HTTP 200 error body', async () => {
    const rotated = github(token(pairBody));
    await expect(rotated.authorizer.refresh('ghr_old_refresh')).resolves.toEqual({
      status: 'refreshed', accessToken: 'ghu_new_access', refreshToken: 'ghr_new_refresh',
      accessExpiresAt: NOW + 28_800_000, refreshExpiresAt: NOW + 15_811_200_000
    });
    expect(rotated.tokenRequests).toEqual([{ client_id: 'Iv23client', client_secret: 'client-secret-value', grant_type: 'refresh_token', refresh_token: 'ghr_old_refresh' }]);

    await expect(github(token({ error: 'bad_refresh_token' })).authorizer.refresh('ghr_old_refresh')).resolves.toEqual({ status: 'revoked', reasonCode: 'bad_refresh_token' });
    for (const error of ['incorrect_client_credentials', 'unauthorized_client']) {
      const failure = github(token({ error })).authorizer.refresh('ghr_old_refresh');
      await expect(failure).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      await expect(failure).rejects.not.toThrow('client-secret-value');
    }
    await expect(github(token({}, 500)).authorizer.refresh('ghr_old_refresh')).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });

    const incomplete = github(token({ ...pairBody, refresh_token: undefined }));
    await expect(incomplete.authorizer.refresh('ghr_old_refresh')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(incomplete.revocations).toEqual([{ authorization: expect.stringMatching(/^Basic /), body: { access_token: 'ghu_new_access' } }]);
  });

  it('revokes one token at GitHub as the App client, best effort and never the grant', async () => {
    const { authorizer, revocations } = github({});
    await expect(authorizer.revoke('ghu_old_access')).resolves.toBeUndefined();
    expect(revocations).toEqual([{ authorization: `Basic ${Buffer.from('Iv23client:client-secret-value').toString('base64')}`, body: { access_token: 'ghu_old_access' } }]);
    const down = github({ 'DELETE /applications/Iv23client/token': { throws: true }, });
    await expect(down.authorizer.revoke('ghu_old_access')).resolves.toBeUndefined();
    const refused = github({ 'DELETE /applications/Iv23client/token': { status: 500 } });
    await expect(refused.authorizer.revoke('ghu_old_access')).resolves.toBeUndefined();
  });

  it('lists the lowercased owners of this App\'s installations the user can reach, across pages', async () => {
    const installation = (id: number, login: string, appId = 123) => ({ id, app_id: appId, account: { id: id + 1_000, login, type: 'Organization' } });
    const first = Array.from({ length: 100 }, (_, index) => installation(index + 1, `org-${index}`, index === 3 ? 999 : 123));
    const { authorizer, apiCalls } = github({
      'GET /user/installations?per_page=100&page=1': { body: { total_count: 101, installations: first } },
      'GET /user/installations?per_page=100&page=2': { body: { total_count: 101, installations: [installation(500, 'Acme')] } }
    });
    const owners = await authorizer.userInstallationOwners('ghu_access');
    expect(owners.has('acme')).toBe(true);
    expect(owners.has('org-0')).toBe(true);
    expect(owners.has('org-3')).toBe(false);
    expect(owners.size).toBe(100);
    expect(apiCalls.every((call) => call.authorization === 'Bearer ghu_access')).toBe(true);
  });

  it('classifies the owners call: 401 is a rejection, a rate limit is retryable, an outage is unavailable', async () => {
    const page = 'GET /user/installations?per_page=100&page=1';
    await expect(github({ [page]: { status: 401 } }).authorizer.userInstallationOwners('ghu_access')).rejects.toBeInstanceOf(GitHubUserTokenRejectedError);
    for (const headers of [{ 'x-ratelimit-remaining': '0' }, { 'retry-after': '30' }]) {
      await expect(github({ [page]: { status: 403, headers } }).authorizer.userInstallationOwners('ghu_access'))
        .rejects.toMatchObject({ code: 'GITHUB_RATE_LIMITED', retryable: true });
    }
    await expect(github({ [page]: { status: 429 } }).authorizer.userInstallationOwners('ghu_access')).rejects.toMatchObject({ code: 'GITHUB_RATE_LIMITED' });
    await expect(github({ [page]: { status: 500 } }).authorizer.userInstallationOwners('ghu_access')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});
