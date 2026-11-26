import { describe, expect, it } from 'vitest';
import { GEMINI_REDIRECT_URI_PATTERN, oauthDurationLabel, parseRedirectUriLines, redirectPresetState, renderOAuthSettings, renderSettings, toggleRedirectPreset } from '../dashboard/dashboard-render.js';

const capabilities = {
  canReadGrantConfiguration: true,
  canWriteGrantConfiguration: true,
  supportsUnboundedGrant: false,
  maxGrantSeconds: 2_592_000,
  minGrantSeconds: 3_600,
  grantPresetsSeconds: [86_400, 604_800, 1_209_600],
  tokenLifetime: { minSeconds: 60, maxSeconds: 3_600, defaultSeconds: 900 }
};

function view(overrides: Record<string, unknown> = {}) {
  return {
    provider: { id: 'cloudflare-access', label: 'Cloudflare Access Managed OAuth' },
    capabilities,
    effective: { oauthEnabled: true, grantSeconds: 2_592_000, grantIsProviderMaximum: true, tokenLifetimeSeconds: 900 },
    management: { state: 'managed', desired: { grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: 900 }, updatedAt: '2026-10-13T00:00:00.000Z' },
    revision: 'c'.repeat(64),
    lastSync: { at: '2026-10-13T00:00:00.000Z', ok: true, errorCode: null },
    readOnlyReason: null,
    ...overrides
  };
}

describe('Dashboard MCP OAuth session settings', () => {
  it('labels lifetimes in plain units', () => {
    expect(oauthDurationLabel(2_592_000)).toBe('30 days');
    expect(oauthDurationLabel(86_400)).toBe('1 day');
    expect(oauthDurationLabel(7_200)).toBe('2 hours');
    expect(oauthDurationLabel(900)).toBe('15 minutes');
    expect(oauthDurationLabel(null)).toBe('Unknown');
  });

  it('defaults to stay signed in at the provider maximum and never claims forever for a bounded provider', () => {
    const html = renderOAuthSettings(view());
    expect(html).toContain('id="settings-oauth-persistent" type="checkbox" checked');
    expect(html).toContain('provider maximum (30 days)');
    expect(html).toContain('30 days — provider maximum');
    expect(html).not.toMatch(/forever|never expires/i);
    expect(html).toContain('<select id="settings-oauth-grant" disabled>');
    expect(html).toContain('value="15"');
    expect(html).not.toContain('id="adopt-settings-oauth"');
  });

  it('selects a matching preset or custom duration for a custom grant', () => {
    const preset = renderOAuthSettings(view({
      effective: { oauthEnabled: true, grantSeconds: 604_800, grantIsProviderMaximum: false, tokenLifetimeSeconds: 600 },
      management: { state: 'managed', desired: { grant: { mode: 'custom', seconds: 604_800 }, tokenLifetimeSeconds: 600 }, updatedAt: null }
    }));
    expect(preset).toContain('<option value="604800" selected>7 days</option>');
    expect(preset).not.toContain('type="checkbox" checked');
    expect(preset).toContain('value="10"');
    const custom = renderOAuthSettings(view({
      effective: { oauthEnabled: true, grantSeconds: 172_800, grantIsProviderMaximum: false, tokenLifetimeSeconds: 900 },
      management: { state: 'managed', desired: { grant: { mode: 'custom', seconds: 172_800 }, tokenLifetimeSeconds: 900 }, updatedAt: null }
    }));
    expect(custom).toContain('<option value="custom" selected>Custom</option>');
    expect(custom).toContain('value="48"');
  });

  it('offers adopting the default only for unmanaged or drifted values', () => {
    expect(renderOAuthSettings(view({ management: { state: 'unmanaged', desired: null, updatedAt: null } }))).toContain('id="adopt-settings-oauth"');
    expect(renderOAuthSettings(view({ management: { state: 'drifted', desired: { grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: 900 }, updatedAt: null } }))).toContain('Changed outside Cloud Harness');
  });

  it('renders a read-only provider as facts with the reason and no save controls', () => {
    const html = renderOAuthSettings(view({
      capabilities: { ...capabilities, canWriteGrantConfiguration: false },
      readOnlyReason: 'The Cloudflare API token cannot update this Access application.'
    }));
    expect(html).not.toContain('id="settings-oauth-form"');
    expect(html).toContain('id="reload-settings-oauth"');
    expect(html).toContain('cannot update this Access application');
  });

  it('renders an unconfigured provider and a load failure without breaking Settings', () => {
    const unconfigured = renderOAuthSettings(view({
      provider: { id: 'none', label: 'Not configured' }, effective: null,
      capabilities: { ...capabilities, canReadGrantConfiguration: false, canWriteGrantConfiguration: false, maxGrantSeconds: null, grantPresetsSeconds: [] },
      management: { state: 'unconfigured', desired: null, updatedAt: null }, lastSync: null,
      readOnlyReason: 'No OAuth provider integration is configured.'
    }));
    expect(unconfigured).not.toContain('id="reload-settings-oauth"');
    expect(unconfigured).toContain('Not available');
    const failed = renderOAuthSettings(undefined, '<script>bad</script>');
    expect(failed).toContain('&lt;script&gt;');
    const page = renderSettings({ defaultNetworkProfile: { value: 'dependency-access', source: 'environment' } }, undefined, { view: undefined, error: 'down' });
    expect(page).toContain('id="settings-network-profile"');
    expect(page).toContain('id="settings-oauth-heading"');
  });

  const gemini = { id: 'gemini', label: 'Gemini custom apps', uris: ['https://oauth-redirect.googleusercontent.com/r/*'] };
  const redirectUris = (overrides: Record<string, unknown> = {}) => ({
    canWrite: true, dynamicRegistrationEnabled: true, allowAnyOnLocalhost: null, allowAnyOnLoopback: false,
    uris: ['https://claude.ai/api/mcp/auth_callback', 'https://x.example/cb?a=<b>'], presets: [gemini], ...overrides
  });

  it('renders the redirect allowlist editor with presets and escaped URIs when the provider is writable', () => {
    const html = renderOAuthSettings(view({ redirectUris: redirectUris() }));
    expect(html).toContain('id="settings-oauth-redirects-form"');
    expect(html).toContain('data-preset="gemini"');
    expect(html).toContain('https://oauth-redirect.googleusercontent.com/r/*');
    expect(html).toContain('https://claude.ai/api/mcp/auth_callback\nhttps://x.example/cb?a=&lt;b&gt;</textarea>');
    expect(html).toContain('<dt>Any 127.0.0.1 callback</dt><dd>Not allowed</dd>');
    expect(html).not.toContain('<b>');
  });

  it('shows a read-only allowlist as a list without save controls, and nothing without a provider', () => {
    const readOnly = renderOAuthSettings(view({ redirectUris: redirectUris({ canWrite: false }) }));
    expect(readOnly).toContain('<li class="mono">https://claude.ai/api/mcp/auth_callback</li>');
    expect(readOnly).not.toContain('id="save-settings-oauth-redirects"');
    expect(renderOAuthSettings(view({ provider: { id: 'none', label: 'Not configured' }, redirectUris: redirectUris() }))).not.toContain('Allowed redirect URIs');
  });

  it('applies presets to the one-per-line list the way the controller does', () => {
    const uris = parseRedirectUriLines(' https://a.example/cb\n\nhttps://a.example/cb\n');
    expect(uris).toEqual(['https://a.example/cb']);
    const withGemini = toggleRedirectPreset(uris, gemini, true);
    expect(withGemini).toEqual(['https://a.example/cb', 'https://oauth-redirect.googleusercontent.com/r/*']);
    expect(redirectPresetState(gemini, withGemini)).toBe('on');
    expect(toggleRedirectPreset(withGemini, gemini, false)).toEqual(['https://a.example/cb']);
  });

  it('renders the Connect Gemini form with an empty, hidden result area', () => {
    const html = renderOAuthSettings(view());
    expect(html).toContain('id="settings-oauth-gemini-form"');
    expect(html).toMatch(/<div id="settings-oauth-gemini-result" hidden>/);
    expect(html).toMatch(/id="settings-oauth-gemini-secret" class="mono" type="text" readonly autocomplete="off" spellcheck="false">/);
    expect(GEMINI_REDIRECT_URI_PATTERN.test('https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-abc')).toBe(true);
    expect(GEMINI_REDIRECT_URI_PATTERN.test('https://oauth-redirect.googleusercontent.com/r/x?y=1')).toBe(false);
  });
});
