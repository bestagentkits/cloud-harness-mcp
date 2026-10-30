// Realistic Settings projections: `/settings` and `/settings/oauth` are unmapped runner
// passthroughs (shapes from apps/runner/src/workspace-service.ts and
// packages/contracts/src/oauth-grant-settings.ts); TypeSafe uses the BFF projections.

const setting = (value: number, runnerValue: number, min: number, max: number, source = 'environment') => ({ value, source, runnerValue, min, max });

export function lifecycle(overrides: Record<string, unknown> = {}) {
  return {
    revision: 7,
    updatedAt: '2026-10-18T09:30:00.000Z',
    settings: {
      maxActiveWorkspacesPerOwner: setting(3, 3, 1, 64),
      idleTtlSeconds: setting(300, 300, 60, 43_200),
      wallTtlSeconds: setting(900, 900, 60, 86_400),
      recoverableGraceSeconds: setting(3_600, 3_600, 0, 86_400, 'default')
    },
    reaperIntervalSeconds: 60,
    usage: { counted: 1, limit: 3, recoverable: 0, autoCloseDeferred: 0 },
    executorCeilings: { memoryBytes: 1_073_741_824, cpus: 1, pids: 256 },
    ...overrides
  };
}

export function settingsBody({ profile = 'dependency-access', source = 'environment', workspaceLifecycle = lifecycle() as unknown } = {}) {
  return { data: { defaultNetworkProfile: { value: profile, source }, workspaceLifecycle }, truncated: false };
}

export const OAUTH_REVISION = 'c'.repeat(64);
export const OAUTH_CAPABILITIES = {
  canReadGrantConfiguration: true,
  canWriteGrantConfiguration: true,
  supportsUnboundedGrant: false,
  maxGrantSeconds: 2_592_000,
  minGrantSeconds: 3_600,
  grantPresetsSeconds: [86_400, 604_800, 1_209_600],
  tokenLifetime: { minSeconds: 60, maxSeconds: 3_600, defaultSeconds: 900 }
};

export function oauthBody(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      provider: { id: 'cloudflare-access', label: 'Cloudflare Access Managed OAuth' },
      capabilities: OAUTH_CAPABILITIES,
      effective: { oauthEnabled: true, grantSeconds: 2_592_000, grantExplicitlyConfigured: true, grantIsProviderMaximum: true, tokenLifetimeSeconds: 900 },
      management: { state: 'managed', desired: { grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: 900 }, updatedAt: '2026-10-13T00:00:00.000Z', updatedBy: 'startup-default' },
      revision: OAUTH_REVISION,
      lastSync: { at: '2026-10-13T00:00:00.000Z', ok: true, errorCode: null },
      readOnlyReason: null,
      ...overrides
    },
    truncated: false
  };
}

/** The provider read-back after saving a seven-day grant. */
export const OAUTH_SEVEN_DAYS = oauthBody({
  effective: { oauthEnabled: true, grantSeconds: 604_800, grantExplicitlyConfigured: true, grantIsProviderMaximum: false, tokenLifetimeSeconds: 900 },
  management: { state: 'managed', desired: { grant: { mode: 'custom', seconds: 604_800 }, tokenLifetimeSeconds: 900 }, updatedAt: '2026-10-20T10:00:00.000Z', updatedBy: 'dashboard' },
  revision: 'd'.repeat(64)
});

export const TYPESAFE_STATUS = { data: { configured: true, enabled: false, endpoint: 'https://api.typesafe.example/v1', model: 'typesafe-small' } };
export const TYPESAFE_CREDENTIALS = {
  data: { credentials: [{ id: 'icred_0123456789abcdef', integration: 'typesafe', label: 'TypeSafe', status: 'ACTIVE', activeVersion: 2, generation: 3, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' }] },
  truncated: false
};
