import { describe, expect, it } from 'vitest';
import { canAdoptDefault, grantFact, maximumLabel, oauthAdoptInput, oauthDefaults, oauthDurationLabel, oauthSchema, oauthUpdateInput, readOAuthView } from './oauth-model';

const capabilities = {
  canReadGrantConfiguration: true, canWriteGrantConfiguration: true, supportsUnboundedGrant: false,
  maxGrantSeconds: 2_592_000, minGrantSeconds: 3_600, grantPresetsSeconds: [86_400, 604_800, 1_209_600],
  tokenLifetime: { minSeconds: 60, maxSeconds: 3_600, defaultSeconds: 900 }
};
const revision = 'c'.repeat(64);
function view(overrides: Record<string, unknown> = {}) {
  return readOAuthView({
    provider: { id: 'cloudflare-access', label: 'Cloudflare Access Managed OAuth' },
    capabilities,
    effective: { oauthEnabled: true, grantSeconds: 2_592_000, grantExplicitlyConfigured: true, grantIsProviderMaximum: true, tokenLifetimeSeconds: 900 },
    management: { state: 'managed', desired: { grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: 900 }, updatedAt: '2026-10-13T00:00:00.000Z', updatedBy: 'dashboard' },
    revision, lastSync: { at: '2026-10-13T00:00:00.000Z', ok: true, errorCode: null }, readOnlyReason: null,
    ...overrides
  })!;
}

describe('MCP OAuth session settings', () => {
  it('labels lifetimes in plain units', () => {
    expect(oauthDurationLabel(2_592_000)).toBe('30 days');
    expect(oauthDurationLabel(86_400)).toBe('1 day');
    expect(oauthDurationLabel(7_200)).toBe('2 hours');
    expect(oauthDurationLabel(900)).toBe('15 minutes');
    expect(oauthDurationLabel(null)).toBe('Unknown');
  });

  it('reads only a settings view, keeping known fields', () => {
    expect(readOAuthView(undefined)).toBeUndefined();
    expect(readOAuthView({ provider: {} })).toBeUndefined();
    const read = view({ extra: 'x', revision: 'not-a-fingerprint' });
    expect(read).not.toHaveProperty('extra');
    expect(read.revision).toBeNull();
  });

  it('defaults to stay signed in at the provider maximum and never claims forever for a bounded provider', () => {
    const current = view();
    expect(oauthDefaults(current)).toEqual({ persistent: true, grant: '86400', customHours: '24', tokenMinutes: '15' });
    expect(maximumLabel(current)).toBe('30 days');
    expect(grantFact(current)).toBe('30 days — provider maximum');
    expect(canAdoptDefault(current)).toBe(false);
    expect(maximumLabel(view({ capabilities: { ...capabilities, supportsUnboundedGrant: true } }))).toBe('until revoked');
  });

  it('selects a matching preset or custom duration for a custom grant', () => {
    const preset = view({
      effective: { grantSeconds: 604_800, grantIsProviderMaximum: false, tokenLifetimeSeconds: 600 },
      management: { state: 'managed', desired: { grant: { mode: 'custom', seconds: 604_800 }, tokenLifetimeSeconds: 600 }, updatedAt: null }
    });
    expect(oauthDefaults(preset)).toEqual({ persistent: false, grant: '604800', customHours: '24', tokenMinutes: '10' });
    const custom = view({ management: { state: 'managed', desired: { grant: { mode: 'custom', seconds: 172_800 }, tokenLifetimeSeconds: 900 }, updatedAt: null } });
    expect(oauthDefaults(custom)).toMatchObject({ persistent: false, grant: 'custom', customHours: '48' });
  });

  it('builds the save from a preset, a custom duration, or the provider maximum', () => {
    const current = view();
    expect(oauthUpdateInput(current, { persistent: false, grant: '604800', customHours: '24', tokenMinutes: '15' }).body)
      .toEqual({ grant: { mode: 'custom', seconds: 604_800 }, tokenLifetimeSeconds: 900, expectedRevision: revision });
    expect(oauthUpdateInput(current, { persistent: false, grant: 'custom', customHours: '48', tokenMinutes: '10' }).body)
      .toEqual({ grant: { mode: 'custom', seconds: 172_800 }, tokenLifetimeSeconds: 600, expectedRevision: revision });
    // A disabled select submits nothing; with "stay signed in" it is not needed.
    expect(oauthUpdateInput(current, { persistent: true, tokenMinutes: '15' }).body)
      .toEqual({ grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: 900, expectedRevision: revision });
    expect(oauthAdoptInput(current)).toEqual({ grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: 900, expectedRevision: revision });
  });

  it('rejects out-of-range lifetimes on the field that holds them', () => {
    const current = view();
    expect(oauthUpdateInput(current, { persistent: true, tokenMinutes: '61' }).errors.tokenMinutes).toBe('The access-token lifetime must be between 1 and 60 minutes.');
    expect(oauthUpdateInput(current, { persistent: true, tokenMinutes: '' }).errors.tokenMinutes).toBeDefined();
    expect(oauthUpdateInput(current, { persistent: false, grant: 'custom', customHours: '721', tokenMinutes: '15' }).errors.customHours)
      .toBe('The grant duration must be between 1 hour(s) and 720 hours.');
    expect(oauthUpdateInput(current, { persistent: false, grant: 'custom', customHours: '0.2', tokenMinutes: '15' }).body).toBeUndefined();
    const schema = oauthSchema(current);
    expect(schema.safeParse({ persistent: false, grant: 'custom', customHours: '721', tokenMinutes: '15' }).error?.issues[0]?.path).toEqual(['customHours']);
  });

  it('offers adopting the default only for unmanaged or drifted values', () => {
    expect(canAdoptDefault(view({ management: { state: 'unmanaged', desired: null, updatedAt: null } }))).toBe(true);
    expect(canAdoptDefault(view({ management: { state: 'drifted', desired: null, updatedAt: null } }))).toBe(true);
  });

  it('describes an unconfigured provider without effective values', () => {
    const unconfigured = view({ provider: { id: 'none', label: 'Not configured' }, effective: null, management: { state: 'unconfigured', desired: null, updatedAt: null } });
    expect(grantFact(unconfigured)).toBe('Not available');
    expect(unconfigured.provider.id).toBe('none');
  });
});
