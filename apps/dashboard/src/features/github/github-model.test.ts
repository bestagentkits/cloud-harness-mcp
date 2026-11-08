import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api-client';
import type * as ApiClientModule from '@/lib/api-client';
import { ApiError, ConflictError, ForbiddenError, UnauthorizedError } from '@/lib/api-client';
import { ClientValidationError } from '@/lib/bff-mutation';
import {
  accountOf,
  githubApi,
  githubCallbackErrorText,
  type GitHubInstallation,
  installationsOf,
  safeGitHubUrl,
  userAuthorizationReasonText,
  userAuthorizationState,
  userAuthorizationUnavailable
} from './github-model';
import { classifyGitHubCallback, GITHUB_CODE_PATTERN, GITHUB_INSTALLATION_PATTERN, GITHUB_STATE_PATTERN, hasGitHubCallbackParams } from './github-callback-search';

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClientModule>();
  return { ...actual, apiClient: { request: vi.fn() } };
});

const request = vi.mocked(apiClient.request);
beforeEach(() => request.mockReset());

const STATE_32 = 'a'.repeat(32);

describe('GitHub callback patterns', () => {
  it('exports the same patterns the runner accepts', () => {
    expect(GITHUB_STATE_PATTERN.test(STATE_32)).toBe(true);
    expect(GITHUB_INSTALLATION_PATTERN.test('1')).toBe(true);
    expect(GITHUB_INSTALLATION_PATTERN.test('0')).toBe(false);
    expect(GITHUB_INSTALLATION_PATTERN.test('01')).toBe(false);
    expect(GITHUB_INSTALLATION_PATTERN.test('')).toBe(false);
    expect(GITHUB_CODE_PATTERN.test('a1_.-')).toBe(true);
    expect(GITHUB_CODE_PATTERN.test('a'.repeat(257))).toBe(false);
    expect(GITHUB_CODE_PATTERN.test('a b')).toBe(false);
  });
});

describe('hasGitHubCallbackParams', () => {
  it('spots any callback param, valid or not', () => {
    expect(hasGitHubCallbackParams('?state=short')).toBe(true);
    expect(hasGitHubCallbackParams('?installation_id=12ab')).toBe(true);
    expect(hasGitHubCallbackParams('?setup_action=install')).toBe(true);
    expect(hasGitHubCallbackParams('?code=abc')).toBe(true);
    expect(hasGitHubCallbackParams('?error=access_denied')).toBe(true);
    expect(hasGitHubCallbackParams('?error_description=x')).toBe(true);
    expect(hasGitHubCallbackParams('?error_uri=x')).toBe(true);
    expect(hasGitHubCallbackParams('?tab=other')).toBe(false);
    expect(hasGitHubCallbackParams('')).toBe(false);
  });
});

describe('classifyGitHubCallback', () => {
  const state = 'S'.repeat(43);
  it('treats a code as the OAuth return, ahead of everything else', () => {
    expect(classifyGitHubCallback(`?code=abc.def_1&state=${state}&installation_id=42&error=access_denied`)).toEqual({ kind: 'complete', state, code: 'abc.def_1' });
  });
  it.each([`?code=abc`, `?code=a%20b&state=${state}`, `?code=&state=${state}`, `?code=abc&state=short`, `?code=${'a'.repeat(257)}&state=${state}&installation_id=42`])('flags a malformed OAuth return (%s) and sends nothing', (query) => {
    expect(classifyGitHubCallback(query)).toEqual({ kind: 'malformed' });
  });
  it('maps an OAuth refusal without keeping the raw value', () => {
    expect(classifyGitHubCallback(`?error=access_denied&error_description=evil&state=${state}`)).toEqual({ kind: 'refused', reason: 'access_denied' });
    expect(classifyGitHubCallback('?error=redirect_uri_mismatch')).toEqual({ kind: 'refused', reason: 'redirect_uri_mismatch' });
    expect(classifyGitHubCallback('?error=<script>&installation_id=42')).toEqual({ kind: 'refused', reason: 'other' });
  });
  it('reads values the router re-serialized with JSON quotes', () => {
    expect(classifyGitHubCallback('?installation_id=%224242%22')).toEqual({ kind: 'verify', installationId: '4242' });
    expect(classifyGitHubCallback(`?code=%22123456%22&state=${state}`)).toEqual({ kind: 'complete', state, code: '123456' });
  });
  it('authorizes a fresh install that carries a valid state', () => {
    expect(classifyGitHubCallback(`?installation_id=4242&setup_action=install&state=${state}`)).toEqual({ kind: 'authorize', installationId: '4242', state });
  });
  it('asks to verify an installation whose state is absent or invalid', () => {
    expect(classifyGitHubCallback('?installation_id=4242&setup_action=update')).toEqual({ kind: 'verify', installationId: '4242' });
    expect(classifyGitHubCallback('?installation_id=4242&state=short')).toEqual({ kind: 'verify', installationId: '4242' });
  });
  it.each(['', '?setup_action=update', '?installation_id=0', '?installation_id=12ab', `?state=${'S'.repeat(43)}`])('has nothing to do for %s', (query) => {
    expect(classifyGitHubCallback(query)).toEqual({ kind: 'none' });
  });
});

describe('installation helpers', () => {
  const one: GitHubInstallation = { installationId: 1, accountLogin: 'acme' };
  const other: GitHubInstallation = { installationId: 2, accountId: 99 };

  it('prefers the installations list and falls back to the single installation', () => {
    expect(installationsOf({ configured: true, installation: one, installations: [other] })).toEqual([other]);
    expect(installationsOf({ configured: true, installation: one, installations: [] })).toEqual([one]);
    expect(installationsOf({ configured: false, installation: null })).toEqual([]);
  });

  it('treats user authorization as unavailable only when the status says so', () => {
    expect(userAuthorizationUnavailable({ configured: true, userAuthorizationConfigured: false, installation: null })).toBe(true);
    expect(userAuthorizationUnavailable({ configured: true, userAuthorizationConfigured: true, installation: null })).toBe(false);
    expect(userAuthorizationUnavailable({ configured: true, installation: null })).toBe(false);
  });

  it('names an account by login, then by id, then generically', () => {
    expect(accountOf(one)).toBe('acme');
    expect(accountOf(other)).toBe('99');
    expect(accountOf({ installationId: 3, accountLogin: null, accountId: null })).toBe('Installation');
  });
});

describe('safeGitHubUrl', () => {
  it('follows an https URL on github.com', () => {
    expect(safeGitHubUrl('https://github.com/apps/cloud-harness/installations/new')).toBe('https://github.com/apps/cloud-harness/installations/new');
  });

  it.each([
    'http://github.com/apps/x', 'javascript:alert(1)', 'not a url', undefined,
    'https://evil.example/login/oauth/authorize', 'https://github.com.evil.example/x', 'https://api.github.com/x',
    'https://github.com@evil.example/x', 'https://user:pw@github.com/x', 'https://github.com:8443/x'
  ])('refuses %s', (value) => {
    expect(() => safeGitHubUrl(value)).toThrow(ClientValidationError);
    expect(() => safeGitHubUrl(value)).toThrow('GitHub setup URL was invalid.');
  });
});

describe('user authorization helpers', () => {
  const base = { configured: true, installation: null };
  const authorization = { login: 'octo', githubUserId: '1', refreshExpiresAt: null, reasonCode: null } as const;

  it('shows Connect for no authorization and for a disconnected one', () => {
    expect(userAuthorizationState(base)).toBe('none');
    expect(userAuthorizationState({ ...base, userAuthorization: null })).toBe('none');
    expect(userAuthorizationState({ ...base, userAuthorization: { ...authorization, status: 'disconnected' } })).toBe('none');
  });

  it('tells connected from revoked', () => {
    expect(userAuthorizationState({ ...base, userAuthorization: { ...authorization, status: 'connected', refreshExpiresAt: 1_900_000_000_000 } })).toBe('connected');
    expect(userAuthorizationState({ ...base, userAuthorization: { ...authorization, status: 'revoked', reasonCode: 'bad_refresh_token' } })).toBe('revoked');
  });

  it('gives a human reason per reason code', () => {
    expect(userAuthorizationReasonText('refresh_token_expired')).toContain('expired');
    expect(userAuthorizationReasonText('bad_refresh_token')).toContain('rejected');
    expect(userAuthorizationReasonText(null)).toContain('no longer valid');
  });
});

describe('githubCallbackErrorText', () => {
  it('shows the operator message of a 403, a 409 or any other API answer', () => {
    expect(githubCallbackErrorText(new ForbiddenError(403, 'Finish the GitHub authorization in the browser that started it.', 'forbidden'))).toBe('Finish the GitHub authorization in the browser that started it.');
    expect(githubCallbackErrorText(new ConflictError(409, 'This GitHub installation is already connected to another Cloud Harness identity.', 'conflict'))).toContain('already connected');
    expect(githubCallbackErrorText(new ApiError(400, 'Your GitHub account cannot access installation 456.'))).toContain('installation 456');
  });
  it('keeps the session copy for an ended session and fixed copy for other failures', () => {
    expect(githubCallbackErrorText(new UnauthorizedError(401, 'x', 'session_ended'))).toContain('session ended');
    expect(githubCallbackErrorText(new ClientValidationError('GitHub authorization URL was invalid.'))).toBe('GitHub authorization URL was invalid.');
    expect(githubCallbackErrorText(new Error('boom'))).toBe('The request could not be completed.');
  });
});

describe('githubApi', () => {
  it('starts setup with the trimmed expected account, or an empty body when none is given', async () => {
    request.mockResolvedValueOnce({ data: { url: 'https://github.com/apps/cloud-harness/installations/new' } });
    await expect(githubApi.setup('  acct-7  ')).resolves.toBe('https://github.com/apps/cloud-harness/installations/new');
    expect(request).toHaveBeenLastCalledWith('/github/setup', { method: 'POST', body: { expectedAccountId: 'acct-7' } });

    request.mockResolvedValueOnce({ data: { url: 'https://github.com/apps/cloud-harness/installations/new' } });
    await githubApi.setup('   ');
    expect(request).toHaveBeenLastCalledWith('/github/setup', { method: 'POST', body: {} });
  });

  it('refuses a setup response whose URL is not https', async () => {
    request.mockResolvedValueOnce({ data: { url: 'http://github.example.test/install' } });
    await expect(githubApi.setup('')).rejects.toBeInstanceOf(ClientValidationError);
  });

  it('completes with exactly the state and the OAuth code', async () => {
    request.mockResolvedValueOnce(undefined);
    await githubApi.complete(STATE_32, 'code-1');
    expect(request).toHaveBeenCalledWith('/github/complete', { method: 'POST', body: { state: STATE_32, code: 'code-1' } });
  });

  it('authorizes with the installation ID and the setup state only when there is one', async () => {
    request.mockResolvedValue({ data: { url: 'https://github.com/login/oauth/authorize?x=1' } });
    await expect(githubApi.authorize('42', STATE_32)).resolves.toBe('https://github.com/login/oauth/authorize?x=1');
    expect(request).toHaveBeenLastCalledWith('/github/authorize', { method: 'POST', body: { installationId: '42', state: STATE_32 } });
    await githubApi.authorize('42');
    expect(request).toHaveBeenLastCalledWith('/github/authorize', { method: 'POST', body: { installationId: '42' } });
  });

  it('starts a user authorization with exactly the user purpose', async () => {
    request.mockResolvedValueOnce({ data: { url: 'https://github.com/login/oauth/authorize?x=1' } });
    await expect(githubApi.authorizeUser()).resolves.toBe('https://github.com/login/oauth/authorize?x=1');
    expect(request).toHaveBeenCalledWith('/github/authorize', { method: 'POST', body: { purpose: 'user' } });
  });

  it('refuses a user authorization URL that is not on github.com', async () => {
    request.mockResolvedValueOnce({ data: { url: 'https://evil.example/login/oauth/authorize' } });
    await expect(githubApi.authorizeUser()).rejects.toThrow('GitHub authorization URL was invalid.');
  });

  it('disconnects the user authorization with an empty body', async () => {
    request.mockResolvedValueOnce(undefined);
    await githubApi.disconnectUser();
    expect(request).toHaveBeenCalledWith('/github/user/disconnect', { method: 'POST', body: {} });
  });

  it('refuses an authorization URL that is not https', async () => {
    request.mockResolvedValueOnce({ data: { url: 'javascript:alert(1)' } });
    await expect(githubApi.authorize('42')).rejects.toThrow('GitHub authorization URL was invalid.');
  });

  it('reconciles all installations without an ID, or one installation with it', async () => {
    request.mockResolvedValue(undefined);
    await githubApi.reconcile();
    await githubApi.reconcile('42');
    expect(request).toHaveBeenNthCalledWith(1, '/github/reconcile', { method: 'POST', body: {} });
    expect(request).toHaveBeenNthCalledWith(2, '/github/reconcile', { method: 'POST', body: { installationId: '42' } });
  });

  it('disconnects one installation by ID', async () => {
    request.mockResolvedValueOnce(undefined);
    await githubApi.disconnect('42');
    expect(request).toHaveBeenCalledWith('/github/disconnect', { method: 'POST', body: { installationId: '42' } });
  });
});
