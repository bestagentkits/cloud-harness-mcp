import { vi } from 'vitest';
import type { GitHubUserAuthorizer, GitHubUserTokenExchange, GitHubUserTokenRefresh } from '../src/github-user-authorizer.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** What `exchangeUserCode` returns for one authorization, with GitHub's documented lifetimes (8 hours, 6 months). */
export function exchange(suffix: string, now: number, overrides: Partial<GitHubUserTokenExchange> = {}): GitHubUserTokenExchange {
  return {
    accessToken: `ghu_access_${suffix}`,
    refreshToken: `ghr_refresh_${suffix}`,
    accessExpiresAt: now + 8 * HOUR,
    refreshExpiresAt: now + 180 * DAY,
    userId: '789',
    login: 'alice',
    ...overrides
  };
}

/** A rotated pair as `refresh` returns it. */
export function refreshed(suffix: string, now: number): Extract<GitHubUserTokenRefresh, { status: 'refreshed' }> {
  return {
    status: 'refreshed',
    accessToken: `ghu_access_${suffix}`,
    refreshToken: `ghr_refresh_${suffix}`,
    accessExpiresAt: now + 8 * HOUR,
    refreshExpiresAt: now + 180 * DAY
  };
}

/** The token pair columns a store write takes. */
export function pair(now: number, suffix: string, overrides: { accessExpiresAt?: number; refreshExpiresAt?: number } = {}) {
  return {
    tokens: { accessToken: `ghu_access_${suffix}`, refreshToken: `ghr_refresh_${suffix}` },
    accessExpiresAt: overrides.accessExpiresAt ?? now + 8 * HOUR,
    refreshExpiresAt: overrides.refreshExpiresAt ?? now + 180 * DAY
  };
}

/** A GitHub stand-in that implements every authorizer method; tests override the ones they exercise. */
export function fakeAuthorizer(overrides: Partial<GitHubUserAuthorizer> = {}) {
  return {
    authorizeUrl: vi.fn(({ state }: { state: string }) => `https://github.com/login/oauth/authorize?state=${state}`),
    authorizeUserUrl: vi.fn(({ state }: { state: string }) => `https://github.com/login/oauth/authorize?state=${state}&scope=offline_access`),
    proveInstallationAdministration: vi.fn(),
    exchangeUserCode: vi.fn(),
    refresh: vi.fn(),
    revoke: vi.fn(async () => undefined),
    userInstallationOwners: vi.fn(async () => new Set<string>(['acme'])),
    ...overrides
  };
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
