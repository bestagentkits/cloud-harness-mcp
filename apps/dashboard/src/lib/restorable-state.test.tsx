import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRestorableState, RESTORE_STORAGE_PREFIX, useRestorableState } from './restorable-state';

const KEY = 'unit-wizard';
const STORAGE_KEY = `ch-dashboard-restore:${KEY}`;

type Draft = { step: number; provider: string };

// The allowlist under test: only these two non-secret fields survive a restore.
function parseDraft(raw: unknown): Draft | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { step, provider } = raw as Record<string, unknown>;
  return typeof step === 'number' && typeof provider === 'string' ? { step, provider } : undefined;
}

const initialDraft = (): Draft => ({ step: 0, provider: '' });

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('useRestorableState', () => {
  it('uses the key prefix the wizard entries are stored under', () => {
    expect(RESTORE_STORAGE_PREFIX).toBe('ch-dashboard-restore:');
  });

  it('restores the parsed state from sessionStorage under the prefixed key', () => {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ step: 2, provider: 'openai' }));
    const { result } = renderHook(() => useRestorableState(KEY, parseDraft, initialDraft));
    expect(result.current[0]).toEqual({ step: 2, provider: 'openai' });
  });

  it('hands the parser undefined when there is no entry', () => {
    const parse = vi.fn(parseDraft);
    const { result } = renderHook(() => useRestorableState(KEY, parse, initialDraft));
    expect(parse).toHaveBeenCalledWith(undefined);
    expect(result.current[0]).toEqual(initialDraft());
  });

  it('returns the initial state when the parser rejects the stored value', () => {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ step: 'two', provider: 'openai' }));
    const { result } = renderHook(() => useRestorableState(KEY, parseDraft, initialDraft));
    expect(result.current[0]).toEqual(initialDraft());
  });

  it('returns the initial state for corrupt JSON instead of throwing', () => {
    window.sessionStorage.setItem(STORAGE_KEY, '{not json');
    const { result } = renderHook(() => useRestorableState(KEY, parseDraft, initialDraft));
    expect(result.current[0]).toEqual(initialDraft());
  });

  it('writes each new state to sessionStorage as JSON', () => {
    const { result } = renderHook(() => useRestorableState(KEY, parseDraft, initialDraft));
    act(() => result.current[1]({ step: 1, provider: 'anthropic' }));
    expect(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({ step: 1, provider: 'anthropic' });
  });

  it('writes the serialized form but keeps the live state as set', () => {
    const serialize = (value: Draft) => ({ ...value, provider: value.provider.startsWith('h') ? '' : value.provider });
    const { result } = renderHook(() => useRestorableState(KEY, parseDraft, initialDraft, serialize));
    act(() => result.current[1]({ step: 1, provider: 'ht' }));
    expect(result.current[0]).toEqual({ step: 1, provider: 'ht' });
    expect(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({ step: 1, provider: '' });
  });

  it('removes the entry on clear and resets to the initial state without writing it back', () => {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ step: 3, provider: 'openai' }));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useRestorableState(KEY, parseDraft, initialDraft));
    setItem.mockClear();
    act(() => result.current[2]());
    expect(result.current[0]).toEqual(initialDraft());
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(setItem).not.toHaveBeenCalledWith(STORAGE_KEY, expect.anything());
  });

  it('persists the next real change after clear', () => {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ step: 3, provider: 'openai' }));
    const { result } = renderHook(() => useRestorableState(KEY, parseDraft, initialDraft));
    act(() => result.current[2]());
    act(() => result.current[1]({ step: 1, provider: 'groq' }));
    expect(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({ step: 1, provider: 'groq' });
  });

  it('persists the next real change after clear() called while already at the initial state', () => {
    const { result } = renderHook(() => useRestorableState<number>('unit-counter', (raw) => (typeof raw === 'number' ? raw : undefined), () => 0));
    act(() => result.current[2]());
    act(() => result.current[1](5));
    expect(window.sessionStorage.getItem('ch-dashboard-restore:unit-counter')).toBe('5');
  });

  it('keeps working when sessionStorage throws on read and write', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    const { result } = renderHook(() => useRestorableState(KEY, parseDraft, initialDraft));
    expect(result.current[0]).toEqual(initialDraft());
    expect(() => act(() => result.current[1]({ step: 4, provider: 'x' }))).not.toThrow();
    expect(result.current[0]).toEqual({ step: 4, provider: 'x' });
  });

  it('keeps working when only removeItem throws during clear', () => {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ step: 3, provider: 'openai' }));
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    const { result } = renderHook(() => useRestorableState(KEY, parseDraft, initialDraft));
    expect(() => act(() => result.current[2]())).not.toThrow();
    expect(result.current[0]).toEqual(initialDraft());
  });
});

describe('clearRestorableState', () => {
  it('drops an entry without a mounted hook', () => {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ step: 1, provider: 'x' }));
    clearRestorableState(KEY);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
