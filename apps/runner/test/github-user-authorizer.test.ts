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

describe('GitHub user repository listing', () => {
  const listingRoutes = (overrides: Record<string, Route> = {}) => ({
    'GET /user/installations?per_page=100&page=1': { body: { total_count: 3, installations: [
      { ...installation(456, { id: 789, login: 'alice', type: 'User' }), permissions: { contents: 'write' } },
      { ...installation(900, { id: 901, login: 'acme', type: 'Organization' }), permissions: { contents: 'read' } },
      { ...installation(999, { id: 902, login: 'other-app', type: 'Organization' }, 555), permissions: { contents: 'write' } }
    ] } },
    'GET /user/installations/456/repositories?per_page=100&page=1': { body: { total_count: 3, repositories: [
      { name: 'notes', owner: { login: 'alice' }, private: true, archived: false, default_branch: 'main', permissions: { push: true, pull: true } },
      { name: 'old', owner: { login: 'alice' }, archived: true, permissions: { push: true, pull: true } },
      { name: 'hidden', owner: { login: 'alice' }, permissions: { push: false, pull: false } }
    ] } },
    'GET /user/installations/900/repositories?per_page=100&page=1': { body: { total_count: 1, repositories: [
      { name: 'service', owner: { login: 'acme' }, private: false, permissions: { push: true, pull: true } }
    ] } },
    'GET /users/alice/orgs?per_page=100&page=1': { body: [{ login: 'acme' }, { login: 'globex' }] },
    ...overrides
  });

  it('lists this App\'s installations, capping access at the installation Contents level and archived state', async () => {
    const listing = await github(listingRoutes()).authorizer.userRepositoryListing(TOKEN, 'alice');
    expect(listing.complete).toBe(true);
    expect(listing.organizations).toEqual(['acme', 'globex']);
    expect(listing.installations.map((entry) => entry.installationId)).toEqual(['456', '900']);
    expect(listing.installations[0]!.repositories).toEqual([
      { owner: 'alice', name: 'notes', access: 'write', private: true, archived: false, defaultBranch: 'main' },
      { owner: 'alice', name: 'old', access: 'read', archived: true }
    ]);
    // The user may push, but the installation grants Contents: read, so git can only read.
    expect(listing.installations[1]!.repositories).toEqual([{ owner: 'acme', name: 'service', access: 'read', private: false }]);
  });

  it('keeps every page already read when a later request fails, and marks the listing incomplete', async () => {
    const listing = await github(listingRoutes({
      'GET /user/installations/900/repositories?per_page=100&page=1': { status: 503, body: {} },
      'GET /users/alice/orgs?per_page=100&page=1': { status: 503, body: {} }
    })).authorizer.userRepositoryListing(TOKEN, 'alice');
    expect(listing.installations[0]!.repositories).toHaveLength(2);
    expect(listing.installations[1]).toMatchObject({ accountLogin: 'acme', repositories: [], complete: false });
    expect(listing.complete).toBe(false);
    expect(listing.organizations).toBeUndefined();
  });

  it('reports a SAML refusal per organization and stops requesting after a rate limit', async () => {
    const saml = await github(listingRoutes({
      'GET /user/installations/456/repositories?per_page=100&page=1': { status: 403, body: { message: 'Resource protected by organization SAML enforcement' } }
    })).authorizer.userRepositoryListing(TOKEN, 'alice');
    expect(saml.installations[0]!.failure).toContain('https://github.com/orgs/alice/sso');
    expect(saml.installations[1]!.repositories).toHaveLength(1);

    const { authorizer, calls } = github(listingRoutes({
      'GET /user/installations/456/repositories?per_page=100&page=1': { status: 403, body: {}, headers: { 'x-ratelimit-remaining': '0' } }
    }));
    const limited = await authorizer.userRepositoryListing(TOKEN, 'alice');
    expect(limited.complete).toBe(false);
    expect(limited.installations[1]!.failure).toContain('not listed');
    expect(calls.some((call) => call.key.includes('/installations/900/'))).toBe(false);
  });

  it('reports a rejected token so the caller can renew it', async () => {
    await expect(github(listingRoutes({ 'GET /user/installations?per_page=100&page=1': { status: 401, body: {} } })).authorizer.userRepositoryListing(TOKEN, 'alice'))
      .rejects.toMatchObject({ name: 'GitHubUserTokenRejectedError' });
  });

  it('reads one installation past 5,000 repositories, stopping only at the shared 10,000 budget', async () => {
    const pages = (count: number) => Object.fromEntries(Array.from({ length: Math.ceil(count / 100) }, (_, index) => [
      `GET /user/installations/456/repositories?per_page=100&page=${index + 1}`,
      { body: { total_count: count, repositories: Array.from({ length: Math.min(100, count - index * 100) }, (_, offset) => (
        { name: `r${index * 100 + offset}`, owner: { login: 'alice' }, permissions: { push: false, pull: true } }
      )) } }
    ]));
    const single = { 'GET /user/installations?per_page=100&page=1': { body: { total_count: 1, installations: [
      { ...installation(456, { id: 789, login: 'alice', type: 'User' }), permissions: { contents: 'read' } }
    ] } }, 'GET /users/alice/orgs?per_page=100&page=1': { body: [] } };

    const above = await github({ ...single, ...pages(5_001) }).authorizer.userRepositoryListing(TOKEN, 'alice');
    expect(above.installations[0]!.repositories).toHaveLength(5_001);
    expect(above.complete).toBe(true);

    const beyond = await github({ ...single, ...pages(10_050) }).authorizer.userRepositoryListing(TOKEN, 'alice');
    expect(beyond.installations[0]!.repositories).toHaveLength(10_000);
    expect(beyond.complete).toBe(false);
  });

  it('keeps installations already discovered when a later discovery page fails, and gives no completeness claim', async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({ ...installation(1_000 + index, { id: 2_000 + index, login: `org${index}`, type: 'Organization' }), permissions: { contents: 'none' } }));
    const listing = await github({
      'GET /user/installations?per_page=100&page=1': { body: { total_count: 150, installations: first } },
      'GET /user/installations?per_page=100&page=2': { status: 502, body: {} },
      'GET /users/alice/orgs?per_page=100&page=1': { body: [] }
    }).authorizer.userRepositoryListing(TOKEN, 'alice');
    expect(listing.installations).toHaveLength(100);
    expect(listing).toMatchObject({ installationsComplete: false, complete: false });
  });

  it('stops every further request when a later discovery page is rate-limited', async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({ ...installation(1_000 + index, { id: 2_000 + index, login: `org${index}`, type: 'Organization' }), permissions: { contents: 'read' } }));
    for (const limited of [
      { status: 429, body: {} },
      { status: 403, body: { message: 'You have exceeded a secondary rate limit.' } }
    ]) {
      const { authorizer, calls } = github({
        'GET /user/installations?per_page=100&page=1': { body: { total_count: 150, installations: first } },
        'GET /user/installations?per_page=100&page=2': limited
      });
      const listing = await authorizer.userRepositoryListing(TOKEN, 'alice');
      expect(listing.installations).toHaveLength(100);
      expect(listing.installations.every((entry) => entry.failure?.startsWith('not listed'))).toBe(true);
      expect(listing).toMatchObject({ installationsComplete: false, complete: false, organizations: undefined });
      expect(calls.map((call) => call.key)).toEqual(['GET /user/installations?per_page=100&page=1', 'GET /user/installations?per_page=100&page=2']);
    }
  });

  it('keeps membership pages already read when a later page is rate-limited, and says the list is partial', async () => {
    const orgs = Array.from({ length: 100 }, (_, index) => ({ login: `org${index}` }));
    const listing = await github(listingRoutes({
      'GET /users/alice/orgs?per_page=100&page=1': { body: orgs },
      'GET /users/alice/orgs?per_page=100&page=2': { status: 429, body: {} }
    })).authorizer.userRepositoryListing(TOKEN, 'alice');
    expect(listing.organizations).toHaveLength(100);
    expect(listing.organizationsComplete).toBe(false);
    expect(listing.installations[0]!.repositories).toHaveLength(2);
  });

  it('treats a secondary rate limit as a rate limit and stops requesting', async () => {
    const { authorizer, calls } = github(listingRoutes({
      'GET /user/installations/456/repositories?per_page=100&page=1': { status: 403, body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' } }
    }));
    const listing = await authorizer.userRepositoryListing(TOKEN, 'alice');
    expect(listing.installations[0]!.failure).not.toContain('sso');
    expect(listing.installations[1]!.failure).toContain('not listed');
    expect(calls.some((call) => call.key.includes('/installations/900/'))).toBe(false);
  });
});
