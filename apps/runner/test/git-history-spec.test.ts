import { describe, expect, it } from 'vitest';
import { cloneHistorySpec, fetchHistorySpec } from '../src/git-history-spec.js';

describe('git history specs passed to the clone and transfer helpers', () => {
  it('keeps the single-commit clone default when no history option is set', () => {
    expect(cloneHistorySpec()).toBe('');
  });

  it('maps fetchDepth 0 to full history and positive depths to depth specs', () => {
    expect(cloneHistorySpec(0)).toBe('full');
    expect(cloneHistorySpec(200)).toBe('depth:200');
  });

  it('prefers a shallow-since date for clones', () => {
    expect(cloneHistorySpec(undefined, '2026-08-24')).toBe('since:2026-08-24');
  });

  it('maps git_fetch options to unshallow, date, and depth specs', () => {
    expect(fetchHistorySpec()).toBe('');
    expect(fetchHistorySpec(undefined, true)).toBe('full');
    expect(fetchHistorySpec(undefined, undefined, '2026-09-01T00:00:00Z')).toBe('since:2026-09-01T00:00:00Z');
    expect(fetchHistorySpec(50)).toBe('depth:50');
  });
});
