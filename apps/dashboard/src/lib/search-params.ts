/**
 * Hand-written `validateSearch` helpers. Deep-link params from the parity matrix arrive as
 * untrusted URL input: each validator keeps only its known keys, bounds string length and
 * drops anything malformed, so a crafted link can never put arbitrary values into a page,
 * a query key or an API call.
 */

type Raw = Record<string, unknown>;
const MAX_TEXT = 200;

export function text(raw: Raw, key: string, max = MAX_TEXT): string | undefined {
  const value = raw[key];
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, max);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

export function oneOf<T extends string>(raw: Raw, key: string, allowed: readonly T[]): T | undefined {
  const value = raw[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export function matching(raw: Raw, key: string, pattern: RegExp): string | undefined {
  // The router JSON-parses search values, so `?id=4242` arrives as the number 4242.
  const value = typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? String(raw[key]) : raw[key];
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

export function flag(raw: Raw, key: string): true | undefined {
  const value = raw[key];
  return value === true || value === 'true' || value === '1' || value === 1 ? true : undefined;
}

/** Opaque pagination cursor from the BFF. */
export function cursor(raw: Raw): string | undefined {
  return matching(raw, 'cursor', /^[A-Za-z0-9_.:=-]{1,256}$/);
}

export type Compact<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/**
 * The return value of a `validateSearch`: every known key, with `undefined` for a value that
 * failed validation. TanStack Router merges `{ ...rawSearch, ...validated }`, so a key the
 * validator omits keeps its raw, unvalidated value; an explicit `undefined` overrides it.
 * Never `compact` a validator's result (compact only what a page passes to `navigate`).
 */
export function exact<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: T[K] | undefined } {
  return value;
}

/** Drops undefined members so the URL carries only the params that are set (and every param is optional). */
export function compact<T extends Record<string, unknown>>(value: T): Compact<T> {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)) as Compact<T>;
}

/** For pages without deep-link params: every search key is dropped. */
export function noSearch(): Record<string, never> {
  return {};
}

/** The MCP OAuth callback outcome (`apps/api/src/dashboard-gateway-router.ts` redirects with it). */
export function oauthOutcome(raw: Raw) {
  return compact({ oauth: oneOf(raw, 'oauth', ['connected', 'error'] as const), reason: matching(raw, 'reason', /^[a-z_]{1,80}$/) });
}
