import { describe, expect, it } from 'vitest';
import { GitHubApiUserAuthorizer } from '../src/github-user-authorizer.js';

type Route = { status?: number; body: unknown; headers?: Record<string, string> };
const TOKEN = 'ghu_user-token-value';
const credentials = { appId: 123, clientId: 'Iv23client', clientSecret: 'client-secret-value' };
const input = { code: 'github-code', codeVerifier: 'v'.repeat(43), redirectUri: 'https://dashboard.example.com/dashboard/integrations/github', installationId: '456' };

function installation(id: number, account: { id: number; login: string; type: string }, appId = 123) {
  return { id, app_id: appId, account };
}

/** A GitHub stand-in keyed by `METHOD path`; every API call must carry the user token. */
function github(routes: Record<string, Route>) {
  const calls: { key: string; init: RequestInit }[] = [];
  const revocations: { url: string; authorization: string | null; body: unknown }[] = [];
  const request = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const key = `${init.method ?? 'GET'} ${parsed.host === 'github.com' ? parsed.pathname : `${parsed.pathname}${parsed.search}`}`;
    calls.push({ key, init });
    const route = routes[key];
    if (init.method === 'DELETE') {
      revocations.push({ url: String(url), authorization: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
      if (route?.status === 0) throw new TypeError('network down');
      return new Response(null, { status: route?.status ?? 204 });
    }
    if (parsed.host === 'api.github.com') expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    if (!route) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: route.headers ?? {} });
  }) as typeof fetch;
  return { calls, revocations, authorizer: new GitHubApiUserAuthorizer(credentials, request) };
}

const tokenRoute = { 'POST /login/oauth/access_token': { body: { access_token: TOKEN, token_type: 'bearer' } } };
const user = { 'GET /user': { body: { id: 789, login: 'alice' } } };

describe('GitHub App user authorization', () => {
  it('builds a PKCE authorize URL for the App client', () => {
    const url = new URL(github({}).authorizer.authorizeUrl({ state: 's'.repeat(43), codeChallenge: 'c'.repeat(43), redirectUri: input.redirectUri }));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'Iv23client', redirect_uri: input.redirectUri, state: 's'.repeat(43), code_challenge: 'c'.repeat(43), code_challenge_method: 'S256'
    });
  });

  it('proves the owner of a personal-account installation and redeems the code with its verifier', async () => {
    const { authorizer, calls } = github({
      ...tokenRoute, ...user,
      'GET /user/installations?per_page=100&page=1': { body: { total_count: 1, installations: [installation(456, { id: 789, login: 'alice', type: 'User' })] } }
    });
    await expect(authorizer.proveInstallationAdministration(input)).resolves.toEqual({
      userId: '789', userLogin: 'alice', appId: '123', installationId: '456', accountId: '789', accountLogin: 'alice', relation: 'owner'
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      client_id: 'Iv23client', client_secret: 'client-secret-value', code: 'github-code', redirect_uri: input.redirectUri, code_verifier: 'v'.repeat(43)
    });
  });

  it('revokes the user token after a successful proof, authenticating as the App client', async () => {
    const { authorizer, revocations } = github({
      ...tokenRoute, ...user,
      'GET /user/installations?per_page=100&page=1': { body: { total_count: 1, installations: [installation(456, { id: 789, login: 'alice', type: 'User' })] } }
    });
    await authorizer.proveInstallationAdministration(input);
    expect(revocations).toEqual([{
      url: 'https://api.github.com/applications/Iv23client/token',
      authorization: `Basic ${Buffer.from('Iv23client:client-secret-value').toString('base64')}`,
      body: { access_token: TOKEN }
    }]);
  });

  it('revokes the token when the proof is refused, and a failed revocation changes neither outcome', async () => {
    const refused = github({
      ...tokenRoute, ...user,
      'GET /user/installations?per_page=100&page=1': { body: { total_count: 0, installations: [] } },
      'DELETE /applications/Iv23client/token': { status: 500, body: {} }
    });
    await expect(refused.authorizer.proveInstallationAdministration(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(refused.revocations).toHaveLength(1);

    const unreachable = github({
      ...tokenRoute, ...user,
      'GET /user/installations?per_page=100&page=1': { body: { total_count: 1, installations: [installation(456, { id: 789, login: 'alice', type: 'User' })] } },
      'DELETE /applications/Iv23client/token': { status: 0, body: {} }
    });
    await expect(unreachable.authorizer.proveInstallationAdministration(input)).resolves.toMatchObject({ relation: 'owner' });
    expect(unreachable.revocations).toHaveLength(1);
  });

  it('does not revoke when the code exchange produced no token', async () => {
    const { authorizer, revocations } = github({ 'POST /login/oauth/access_token': { body: { error: 'bad_verification_code' } } });
    await expect(authorizer.proveInstallationAdministration(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(revocations).toEqual([]);
  });

  it.each([
    ['an exhausted rate limit', { 'x-ratelimit-remaining': '0' }],
    ['a secondary rate limit', { 'retry-after': '30' }]
  ])('treats a membership 403 caused by %s as retryable, not as "not an owner"', async (_label, headers) => {
    const { authorizer } = github({
      ...tokenRoute, ...user,
      'GET /user/installations?per_page=100&page=1': { body: { total_count: 1, installations: [installation(456, { id: 900, login: 'acme', type: 'Organization' })] } },
      'GET /user/memberships/orgs/acme': { status: 403, body: { message: 'rate limit' }, headers }
    });
    const failure = authorizer.proveInstallationAdministration(input);
    await expect(failure).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    await expect(failure).rejects.not.toThrow('owner of the acme organization');
  });

  it('finds the installation on a later page and proves an active organization owner', async () => {
    const others = Array.from({ length: 100 }, (_, index) => installation(1_000 + index, { id: 5_000 + index, login: `org-${index}`, type: 'Organization' }));
    const { authorizer } = github({
      ...tokenRoute, ...user,
      'GET /user/installations?per_page=100&page=1': { body: { total_count: 101, installations: others } },
      'GET /user/installations?per_page=100&page=2': { body: { total_count: 101, installations: [installation(456, { id: 900, login: 'Acme', type: 'Organization' })] } },
      'GET /user/memberships/orgs/Acme': { body: { state: 'active', role: 'admin' } }
    });
    await expect(authorizer.proveInstallationAdministration(input)).resolves.toMatchObject({ accountId: '900', relation: 'organization_admin' });
  });

  it.each([
    ['an installation the user cannot see', { 'GET /user/installations?per_page=100&page=1': { body: { total_count: 0, installations: [] } } }, 'cannot access installation 456'],
    ['an installation of another App', { 'GET /user/installations?per_page=100&page=1': { body: { total_count: 1, installations: [installation(456, { id: 789, login: 'alice', type: 'User' }, 999)] } } }, 'cannot access installation 456'],
    ['another user\'s personal account', { 'GET /user/installations?per_page=100&page=1': { body: { total_count: 1, installations: [installation(456, { id: 790, login: 'bob', type: 'User' })] } } }, 'Only the owner of the GitHub account bob'],
    ['an organization member who is not an owner', {
      'GET /user/installations?per_page=100&page=1': { body: { total_count: 1, installations: [installation(456, { id: 900, login: 'acme', type: 'Organization' })] } },
      'GET /user/memberships/orgs/acme': { body: { state: 'active', role: 'member' } }
    }, 'owner of the acme organization'],
    ['a pending organization owner', {
      'GET /user/installations?per_page=100&page=1': { body: { total_count: 1, installations: [installation(456, { id: 900, login: 'acme', type: 'Organization' })] } },
      'GET /user/memberships/orgs/acme': { body: { state: 'pending', role: 'admin' } }
    }, 'owner of the acme organization'],
    ['an organization membership GitHub will not disclose', {
      'GET /user/installations?per_page=100&page=1': { body: { total_count: 1, installations: [installation(456, { id: 900, login: 'acme', type: 'Organization' })] } },
      'GET /user/memberships/orgs/acme': { status: 403, body: { message: 'Resource not accessible by integration' } }
    }, 'Members (read)']
  ])('refuses %s', async (_label, routes, message) => {
    const { authorizer } = github({ ...tokenRoute, ...user, ...routes });
    const failure = authorizer.proveInstallationAdministration(input);
    await expect(failure).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(failure).rejects.toThrow(message);
  });

  it('refuses an expired or replayed code without echoing it', async () => {
    const { authorizer, calls } = github({ 'POST /login/oauth/access_token': { body: { error: 'bad_verification_code' } } });
    const failure = authorizer.proveInstallationAdministration(input);
    await expect(failure).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(failure).rejects.not.toThrow('github-code');
    expect(calls).toHaveLength(1);
  });

  it('reports a Callback URL mismatch and rejected client credentials as unavailable, never with the secret', async () => {
    for (const error of ['redirect_uri_mismatch', 'incorrect_client_credentials']) {
      const { authorizer } = github({ 'POST /login/oauth/access_token': { body: { error } } });
      const failure = authorizer.proveInstallationAdministration(input);
      await expect(failure).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      await expect(failure).rejects.not.toThrow('client-secret-value');
    }
  });
});
