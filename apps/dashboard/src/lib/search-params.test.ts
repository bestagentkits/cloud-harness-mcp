import { describe, expect, it } from 'vitest';
import { compact, cursor, flag, matching, oauthOutcome, oneOf, text } from './search-params';

describe('search param validators', () => {
  it('keeps bounded text and drops blanks, objects and oversize values', () => {
    expect(text({ q: '  api  ' }, 'q')).toBe('api');
    expect(text({ q: '' }, 'q')).toBeUndefined();
    expect(text({ q: { $ne: 1 } }, 'q')).toBeUndefined();
    expect(text({ q: 'x'.repeat(201) }, 'q')).toBeUndefined();
    expect(text({ q: 42 }, 'q')).toBe('42');
  });

  it('accepts only listed values and matching patterns', () => {
    expect(oneOf({ tab: 'sets' }, 'tab', ['library', 'sets'] as const)).toBe('sets');
    expect(oneOf({ tab: 'admin' }, 'tab', ['library', 'sets'] as const)).toBeUndefined();
    expect(matching({ id: 'ws_<script>' }, 'id', /^ws_[a-z]+$/)).toBeUndefined();
    expect(matching({ installation_id: 4242 }, 'installation_id', /^[0-9]{1,20}$/)).toBe('4242');
    expect(matching({ id: Number.NaN }, 'id', /^.*$/)).toBeUndefined();
    expect(cursor({ cursor: 'abc:123=' })).toBe('abc:123=');
    expect(cursor({ cursor: 'a b' })).toBeUndefined();
  });

  it('parses flags and compacts unset members', () => {
    expect(flag({ expiring: 'true' }, 'expiring')).toBe(true);
    expect(flag({ expiring: 'no' }, 'expiring')).toBeUndefined();
    expect(compact({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it('names every OAuth outcome member, so an invalid raw value cannot survive the router merge', () => {
    expect(oauthOutcome({ oauth: 'connected', reason: 'access_denied' })).toEqual({ oauth: 'connected', reason: 'access_denied' });
    const invalid = oauthOutcome({ oauth: 'pwned', reason: '<script>' });
    expect(Object.keys(invalid).sort()).toEqual(['oauth', 'reason']);
    expect(invalid).toEqual({ oauth: undefined, reason: undefined });
  });
});
