import { useSyncExternalStore } from 'react';

/**
 * Display preferences: theme, text size, density and contrast. They are non-secret UI
 * settings; nothing identifying or sensitive is stored here. Text size, density and
 * contrast live in `localStorage` only. The theme's authority is the HTTP-only
 * `ch-dashboard-theme` cookie (set through the BFF preferences endpoint), which the API
 * renders on `<html data-server-theme>` before first paint; `localStorage` mirrors it.
 *
 * `public/preferences-boot.js` applies the same attributes before first paint (a classic
 * blocking script, because the CSP forbids inline script). It duplicates the parsing below
 * on purpose, and `preferences.test.ts` runs both against the same inputs so they cannot
 * drift.
 */
export const PREFERENCES_STORAGE_KEY = 'ch-dashboard-preferences';

export const THEMES = ['system', 'light', 'dark'] as const;
export const FONT_SCALES = ['sm', 'md', 'lg', 'xl'] as const;
export const DENSITIES = ['comfortable', 'compact'] as const;
export const CONTRASTS = ['standard', 'high'] as const;

export type ThemePreference = (typeof THEMES)[number];
export type ResolvedTheme = Exclude<ThemePreference, 'system'>;
export type FontScale = (typeof FONT_SCALES)[number];
export type Density = (typeof DENSITIES)[number];
export type Contrast = (typeof CONTRASTS)[number];

export type Preferences = {
  theme: ThemePreference;
  fontScale: FontScale;
  density: Density;
  contrast: Contrast;
};

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  theme: 'system',
  fontScale: 'md',
  density: 'comfortable',
  contrast: 'standard'
});

const DARK_QUERY = '(prefers-color-scheme: dark)';

function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Parses a stored value, keeping each valid field and defaulting the rest. */
export function parsePreferences(raw: string | null | undefined): Preferences {
  if (!raw) return { ...DEFAULT_PREFERENCES };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { ...DEFAULT_PREFERENCES }; }
  if (!value || typeof value !== 'object') return { ...DEFAULT_PREFERENCES };
  const record = value as Record<string, unknown>;
  return {
    theme: pick(THEMES, record.theme, DEFAULT_PREFERENCES.theme),
    fontScale: pick(FONT_SCALES, record.fontScale, DEFAULT_PREFERENCES.fontScale),
    density: pick(DENSITIES, record.density, DEFAULT_PREFERENCES.density),
    contrast: pick(CONTRASTS, record.contrast, DEFAULT_PREFERENCES.contrast)
  };
}

/** Storage can be unavailable (privacy mode, disabled cookies); preferences then stay in memory. */
function browserStorage(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

/** The theme the API rendered from the cookie, if this document came from the API. */
export function serverTheme(root: HTMLElement | undefined = globalThis.document?.documentElement): ThemePreference | undefined {
  const value = root?.dataset.serverTheme;
  return value !== undefined && (THEMES as readonly string[]).includes(value) ? (value as ThemePreference) : undefined;
}

export function readPreferences(storage: Storage | undefined = browserStorage(), root?: HTMLElement): Preferences {
  let stored: Preferences;
  try { stored = parsePreferences(storage?.getItem(PREFERENCES_STORAGE_KEY)); } catch { stored = { ...DEFAULT_PREFERENCES }; }
  const theme = serverTheme(root);
  if (theme === undefined || theme === stored.theme) return stored;
  const mirrored = { ...stored, theme };
  writePreferences(mirrored, storage);
  return mirrored;
}

export function writePreferences(preferences: Preferences, storage: Storage | undefined = browserStorage()): void {
  try { storage?.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences)); } catch { /* quota or disabled storage */ }
}

export function resolveTheme(theme: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (theme === 'system') return prefersDark ? 'dark' : 'light';
  return theme;
}

function systemPrefersDark(): boolean {
  return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia(DARK_QUERY).matches;
}

/** Reflects preferences as `data-*` attributes on `<html>`; `styles/tokens.css` keys off them. */
export function applyPreferences(preferences: Preferences, root: HTMLElement = document.documentElement, prefersDark = systemPrefersDark()): void {
  const resolved = resolveTheme(preferences.theme, prefersDark);
  root.dataset.theme = resolved;
  root.dataset.themePreference = preferences.theme;
  root.dataset.fontScale = preferences.fontScale;
  root.dataset.density = preferences.density;
  root.dataset.contrast = preferences.contrast;
  root.style.colorScheme = resolved;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let current: Preferences | undefined;

function snapshot(): Preferences {
  current ??= readPreferences();
  return current;
}

function emit(next: Preferences): void {
  current = next;
  applyPreferences(next);
  for (const listener of listeners) listener();
}

export function updatePreferences(patch: Partial<Preferences>): Preferences {
  const next = { ...snapshot(), ...patch };
  writePreferences(next);
  emit(next);
  return next;
}

let detach: (() => void) | undefined;

/** Follows other tabs and, for the `system` theme, the operating-system colour scheme. */
function attach(): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === PREFERENCES_STORAGE_KEY) emit(parsePreferences(event.newValue));
  };
  const media = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(DARK_QUERY) : undefined;
  const onScheme = () => { if (snapshot().theme === 'system') emit(snapshot()); };
  globalThis.addEventListener('storage', onStorage);
  media?.addEventListener('change', onScheme);
  return () => {
    globalThis.removeEventListener('storage', onStorage);
    media?.removeEventListener('change', onScheme);
  };
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) detach = attach();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) { detach?.(); detach = undefined; }
  };
}

export function usePreferences(): [Preferences, (patch: Partial<Preferences>) => void] {
  const preferences = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_PREFERENCES);
  return [preferences, updatePreferences];
}

/** Test seam: forget the cached snapshot so the next read comes from storage. */
export function resetPreferencesForTests(): void {
  current = undefined;
}
