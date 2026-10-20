import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPreferences,
  DEFAULT_PREFERENCES,
  parsePreferences,
  PREFERENCES_STORAGE_KEY,
  readPreferences,
  resetPreferencesForTests,
  usePreferences
} from './preferences';

// jsdom replaces the global URL, so build the path with node:path instead of `new URL()`.
const bootScript = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../public/preferences-boot.js'), 'utf8');

function stubColorScheme(dark: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: dark && query.includes('dark'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  }));
}

const ATTRIBUTES = ['data-theme', 'data-theme-preference', 'data-font-scale', 'data-density', 'data-contrast'];

function snapshotRoot(root: HTMLElement) {
  return { ...Object.fromEntries(ATTRIBUTES.map((name) => [name, root.getAttribute(name)])), colorScheme: root.style.colorScheme };
}

function clearRoot(root: HTMLElement) {
  for (const name of ATTRIBUTES) root.removeAttribute(name);
  root.style.colorScheme = '';
}

beforeEach(() => {
  resetPreferencesForTests();
  clearRoot(document.documentElement);
  vi.unstubAllGlobals();
});

describe('parsePreferences', () => {
  it('defaults missing, malformed or unknown values field by field', () => {
    expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences('{not json')).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences('"dark"')).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences(JSON.stringify({ theme: 'dark', fontScale: 'huge', density: 'compact' }))).toEqual({
      ...DEFAULT_PREFERENCES,
      theme: 'dark',
      density: 'compact'
    });
  });
});

describe('preferences-boot.js', () => {
  const cases: Array<[string, string | null, boolean]> = [
    ['nothing stored, light OS', null, false],
    ['nothing stored, dark OS', null, true],
    ['explicit dark', JSON.stringify({ theme: 'dark', fontScale: 'xl', density: 'compact', contrast: 'high' }), false],
    ['explicit light on dark OS', JSON.stringify({ theme: 'light' }), true],
    ['invalid values', JSON.stringify({ theme: 'neon', fontScale: 3, contrast: 'max' }), true],
    ['corrupt JSON', '{', false]
  ];

  it.each(cases)('matches applyPreferences for %s', (_label, stored, dark) => {
    stubColorScheme(dark);
    if (stored === null) localStorage.removeItem(PREFERENCES_STORAGE_KEY);
    else localStorage.setItem(PREFERENCES_STORAGE_KEY, stored);
    const root = document.documentElement;

    new Function(bootScript)();
    const fromBoot = snapshotRoot(root);
    clearRoot(root);
    applyPreferences(readPreferences(), root, dark);

    expect(fromBoot).toEqual(snapshotRoot(root));
  });
});

describe('usePreferences', () => {
  it('persists updates and reflects them on <html>', () => {
    stubColorScheme(false);
    const { result } = renderHook(() => usePreferences());
    act(() => result.current[1]({ theme: 'dark', density: 'compact' }));
    expect(result.current[0]).toMatchObject({ theme: 'dark', density: 'compact' });
    expect(JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? '{}')).toMatchObject({ theme: 'dark', density: 'compact' });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.density).toBe('compact');
  });

  it('follows changes made in another tab', () => {
    stubColorScheme(false);
    const { result } = renderHook(() => usePreferences());
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: PREFERENCES_STORAGE_KEY, newValue: JSON.stringify({ theme: 'dark' }) }));
    });
    expect(result.current[0].theme).toBe('dark');
  });
});
