/**
 * The dynamic-client-registration redirect allowlist inside the `/settings/oauth` view
 * (`redirectUris` of `OAuthGrantSettingsViewSchema`, packages/contracts/src/oauth-grant-settings.ts).
 * The runner validates every URI and the provider read-back is the authority, so the editor
 * only parses lines, applies presets and reports what a save would remove.
 */

export type RedirectUriPreset = { id: string; label: string; uris: string[] };
export type RedirectUrisView = {
  canWrite: boolean;
  dynamicRegistrationEnabled: boolean | null;
  allowAnyOnLocalhost: boolean | null;
  allowAnyOnLoopback: boolean | null;
  uris: string[] | null;
  readOnlyReason: string | null;
  presets: RedirectUriPreset[];
};
export type PresetState = 'on' | 'partial' | 'off';
export type RedirectUrisUpdate = { uris: string[]; expectedRevision: string | null };

const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const strings = (value: unknown, max: number): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, max) : []);
const booleanOrNull = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

/** The known fields of `view.redirectUris`, or `undefined` for a runner that does not report them. */
export function readRedirectUris(raw: unknown): RedirectUrisView | undefined {
  const view = record(raw);
  if (!view) return undefined;
  return {
    canWrite: view.canWrite === true,
    dynamicRegistrationEnabled: booleanOrNull(view.dynamicRegistrationEnabled),
    allowAnyOnLocalhost: booleanOrNull(view.allowAnyOnLocalhost),
    allowAnyOnLoopback: booleanOrNull(view.allowAnyOnLoopback),
    // Never truncated: the editor saves the whole list, so a partial read would silently drop entries.
    uris: Array.isArray(view.uris) ? strings(view.uris, Number.POSITIVE_INFINITY) : null,
    readOnlyReason: typeof view.readOnlyReason === 'string' && view.readOnlyReason ? view.readOnlyReason.slice(0, 400) : null,
    presets: (Array.isArray(view.presets) ? view.presets : []).flatMap((item) => {
      const preset = record(item);
      return preset && typeof preset.id === 'string' && typeof preset.label === 'string'
        ? [{ id: preset.id, label: preset.label, uris: strings(preset.uris, 16) }]
        : [];
    }).slice(0, 16)
  };
}

/** One URI per line; blank lines and repeats are dropped, order is kept. */
export function parseUriLines(text: string): string[] {
  return [...new Set(text.split('\n').map((line) => line.trim()).filter(Boolean))];
}

export function presetState(preset: RedirectUriPreset, uris: readonly string[]): PresetState {
  const present = preset.uris.filter((uri) => uris.includes(uri)).length;
  if (present === 0) return 'off';
  return present === preset.uris.length ? 'on' : 'partial';
}

/** Turning a preset on appends its missing URIs; turning it off removes all of them. */
export function togglePreset(uris: readonly string[], preset: RedirectUriPreset, on: boolean): string[] {
  return on ? [...uris, ...preset.uris.filter((uri) => !uris.includes(uri))] : uris.filter((uri) => !preset.uris.includes(uri));
}

/** URIs the provider holds that the draft drops: clients using them can no longer register or sign in. */
export function removedUris(saved: readonly string[], draft: readonly string[]): string[] {
  return saved.filter((uri) => !draft.includes(uri));
}

/** Equal when both hold the same distinct URIs; repeats in the provider list do not hide an addition. */
export function sameUris(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((uri) => b.has(uri));
}
