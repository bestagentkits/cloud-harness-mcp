import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api-client';
import type * as ApiClientModule from '@/lib/api-client';
import { ClientValidationError } from '@/lib/bff-mutation';
import {
  accountOf,
  githubApi,
  type GitHubInstallation,
  installationsOf,
  safeSetupUrl
} from './github-model';
import { GITHUB_INSTALLATION_PATTERN, GITHUB_STATE_PATTERN, githubCallbackSearch } from './github-callback-search';

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClientModule>();
  return { ...actual, apiClient: { request: vi.fn() } };
});

const request = vi.mocked(apiClient.request);
beforeEach(() => request.mockReset());

const STATE_32 = 'a'.repeat(32);

describe('githubCallbackSearch', () => {
  it('keeps a well-formed state and installation_id and ignores setup_action and other keys', () => {
    expect(githubCallbackSearch({ state: STATE_32, installation_id: '12345678', setup_action: 'install', extra: 'x' })).toEqual({
      state: STATE_32,
      installation_id: '12345678'
    });
  });

  it('reads a numeric installation_id as text, as the router delivers it', () => {
    expect(githubCallbackSearch({ state: STATE_32, installation_id: 12_345_678 })).toEqual({ state: STATE_32, installation_id: '12345678' });
  });

  it('trims a padded installation_id before checking it', () => {
    expect(githubCallbackSearch({ installation_id: '  42  ' })).toEqual({ installation_id: '42' });
  });

  it('keeps the state at 32 and 128 characters and drops it outside that range', () => {
    expect(githubCallbackSearch({ state: 'b'.repeat(128) })).toEqual({ state: 'b'.repeat(128) });
    expect(githubCallbackSearch({ state: 'b'.repeat(31) })).toEqual({});
    expect(githubCallbackSearch({ state: 'b'.repeat(129) })).toEqual({});
  });

  it('accepts only the base64url alphabet in the state', () => {
    expect(githubCallbackSearch({ state: `${'A'.repeat(30)}_-` })).toEqual({ state: `${'A'.repeat(30)}_-` });
    expect(githubCallbackSearch({ state: `${'A'.repeat(31)}+` })).toEqual({});
    expect(githubCallbackSearch({ state: `${'A'.repeat(31)}/` })).toEqual({});
    expect(githubCallbackSearch({ state: `${'A'.repeat(31)}=` })).toEqual({});
  });

  it('keeps installation_id at 1 to 20 digits and drops anything else', () => {
    expect(githubCallbackSearch({ installation_id: '1' })).toEqual({ installation_id: '1' });
    expect(githubCallbackSearch({ installation_id: '1'.repeat(20) })).toEqual({ installation_id: '1'.repeat(20) });
    expect(githubCallbackSearch({ installation_id: '1'.repeat(21) })).toEqual({});
    expect(githubCallbackSearch({ installation_id: '12ab' })).toEqual({});
    expect(githubCallbackSearch({ installation_id: '' })).toEqual({});
    expect(githubCallbackSearch({ installation_id: 1.5 })).toEqual({});
  });

  it('drops a numeric installation_id longer than 20 digits instead of truncating it', () => {
    expect(githubCallbackSearch({ installation_id: Number('1'.repeat(21)) })).toEqual({});
  });

  it('exports the same patterns the runner accepts', () => {
    expect(GITHUB_STATE_PATTERN.test(STATE_32)).toBe(true);
    expect(GITHUB_INSTALLATION_PATTERN.test('0')).toBe(true);
    expect(GITHUB_INSTALLATION_PATTERN.test('')).toBe(false);
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

  it('names an account by login, then by id, then generically', () => {
    expect(accountOf(one)).toBe('acme');
    expect(accountOf(other)).toBe('99');
    expect(accountOf({ installationId: 3, accountLogin: null, accountId: null })).toBe('Installation');
  });
});

describe('safeSetupUrl', () => {
  it('follows an https URL', () => {
    expect(safeSetupUrl('https://github.com/apps/cloud-harness/installations/new')).toBe('https://github.com/apps/cloud-harness/installations/new');
  });

  it.each(['http://github.com/apps/x', 'javascript:alert(1)', 'not a url', undefined])('refuses %s', (value) => {
    expect(() => safeSetupUrl(value)).toThrow(ClientValidationError);
    expect(() => safeSetupUrl(value)).toThrow('GitHub setup URL was invalid.');
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

  it('completes with the state and installation ID', async () => {
    request.mockResolvedValueOnce(undefined);
    await githubApi.complete(STATE_32, '42');
    expect(request).toHaveBeenCalledWith('/github/complete', { method: 'POST', body: { state: STATE_32, installationId: '42' } });
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
