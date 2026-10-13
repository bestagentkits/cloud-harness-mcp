import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HarnessError, OAuthGrantSettingsViewSchema, type RunnerConfig } from '@cloud-harness/contracts';
import { providerError } from '../src/cloudflare-access-oauth-provider.js';
import { executeInternalRunnerOperation } from '../src/internal-runner-operations.js';
import type { OAuthGrantProvider, OAuthGrantProviderSnapshot } from '../src/oauth-grant-provider.js';
import { OAuthGrantSettingsService } from '../src/oauth-grant-settings-service.js';
import { StateStore } from '../src/state-store.js';
import { WorkspaceService } from '../src/workspace-service.js';

const directories: string[] = [];
const stores: StateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function stateStore(): StateStore {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-oauth-grant-'));
  directories.push(directory);
  const store = new StateStore(join(directory, 'state.db'));
  stores.push(store);
  return store;
}

const MAX = 2_592_000;

/** A provider double holding one grant; `fail` makes the next calls throw a provider error. */
class FakeProvider implements OAuthGrantProvider {
  readonly id = 'cloudflare-access' as const;
  readonly label = 'Cloudflare Access Managed OAuth';
  readonly maxGrantSeconds = MAX;
  writes: Array<{ grantSeconds: number; tokenLifetimeSeconds: number; expectedRevision: string | null }> = [];
  fail: string | undefined;
  constructor(public state: { oauthEnabled: boolean; grantSeconds: number | null; tokenLifetimeSeconds: number | null; explicit: boolean }, public readonly canWrite = true) {}
  private snapshot(): OAuthGrantProviderSnapshot {
    return {
      oauthEnabled: this.state.oauthEnabled,
      grantSeconds: this.state.grantSeconds,
      grantExplicitlyConfigured: this.state.explicit,
      tokenLifetimeSeconds: this.state.tokenLifetimeSeconds,
      tokenLifetimeExplicitlyConfigured: this.state.tokenLifetimeSeconds !== null,
      revision: (`${this.state.grantSeconds}-${this.state.tokenLifetimeSeconds}`).padEnd(64, '0').replace(/[^a-f0-9]/g, 'a').slice(0, 64),
      unsupportedReason: null
    };
  }
  async read() {
    if (this.fail) throw providerError(this.fail);
    return this.snapshot();
  }
  async write(next: { grantSeconds: number; tokenLifetimeSeconds: number }, expectedRevision: string | null) {
    this.writes.push({ ...next, expectedRevision });
    if (this.fail) throw providerError(this.fail);
    if (expectedRevision !== this.snapshot().revision) throw providerError('revision_conflict');
    this.state = { ...this.state, grantSeconds: next.grantSeconds, tokenLifetimeSeconds: next.tokenLifetimeSeconds, explicit: true };
    return this.snapshot();
  }
}

function service(provider: OAuthGrantProvider | undefined, store = stateStore()) {
  const audits: Array<{ ownerId: string; action: string; details: Record<string, unknown> }> = [];
  let clock = Date.parse('2026-10-13T00:00:00Z');
  const settings = new OAuthGrantSettingsService(store, provider, (ownerId, action, details) => audits.push({ ownerId, action, details }), () => (clock += 1_000));
  return { settings, store, audits };
}

describe('inbound OAuth grant settings', () => {
  it('reports an unconfigured provider as read-only with nothing to write', async () => {
    const { settings } = service(undefined);
    const view = OAuthGrantSettingsViewSchema.parse(await settings.view());
    expect(view).toMatchObject({ provider: { id: 'none' }, effective: null, management: { state: 'unconfigured' } });
    expect(view.capabilities).toMatchObject({ canReadGrantConfiguration: false, canWriteGrantConfiguration: false, supportsUnboundedGrant: false });
    expect(view.readOnlyReason).toMatch(/No OAuth provider integration/);
    await expect(settings.update('owner', { grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: 900, expectedRevision: null })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await settings.reconcileDefault()).toBe('not-configured');
  });

  it('applies the provider maximum on a new install whose grant was never set', async () => {
    const provider = new FakeProvider({ oauthEnabled: true, grantSeconds: null, tokenLifetimeSeconds: null, explicit: false });
    const { settings } = service(provider);
    expect(await settings.reconcileDefault()).toBe('applied-provider-maximum');
    expect(provider.state).toMatchObject({ grantSeconds: MAX, tokenLifetimeSeconds: 900 });
    const view = OAuthGrantSettingsViewSchema.parse(await settings.view());
    expect(view.effective).toEqual({ oauthEnabled: true, grantSeconds: MAX, grantExplicitlyConfigured: true, grantIsProviderMaximum: true, tokenLifetimeSeconds: 900 });
    expect(view.management).toMatchObject({ state: 'managed', updatedBy: 'startup-default', desired: { grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: 900 } });
    expect(view.capabilities).toMatchObject({ canWriteGrantConfiguration: true, maxGrantSeconds: MAX, supportsUnboundedGrant: false });
    expect(view.capabilities.grantPresetsSeconds).toEqual([86_400, 604_800, 1_209_600]);
    // A second start does nothing: the value is already managed.
    expect(await settings.reconcileDefault()).toBe('already-managed');
    expect(provider.writes).toHaveLength(1);
  });

  it('keeps a short token lifetime the operator already set when applying the default', async () => {
    const provider = new FakeProvider({ oauthEnabled: true, grantSeconds: null, tokenLifetimeSeconds: 300, explicit: false });
    const { settings } = service(provider);
    await settings.reconcileDefault();
    expect(provider.state.tokenLifetimeSeconds).toBe(300);
  });

  it('leaves an explicit token lifetime outside the panel bounds unmanaged instead of replacing it', async () => {
    const provider = new FakeProvider({ oauthEnabled: true, grantSeconds: null, tokenLifetimeSeconds: 7_200, explicit: false });
    const { settings } = service(provider);
    expect(await settings.reconcileDefault()).toBe('left-unmanaged');
    expect(provider.writes).toEqual([]);
    expect(provider.state.tokenLifetimeSeconds).toBe(7_200);
  });

  it('runs writes one at a time so the startup default never replaces a concurrent Dashboard save', async () => {
    const provider = new FakeProvider({ oauthEnabled: true, grantSeconds: null, tokenLifetimeSeconds: null, explicit: false });
    const { settings, store } = service(provider);
    const { revision } = await settings.view();
    const [saved, outcome] = await Promise.all([
      settings.update('owner-1', { grant: { mode: 'custom', seconds: 86_400 }, tokenLifetimeSeconds: 900, expectedRevision: revision }),
      settings.reconcileDefault()
    ]);
    expect(saved.effective).toMatchObject({ grantSeconds: 86_400 });
    expect(outcome).toBe('already-managed');
    expect(provider.writes).toHaveLength(1);
    expect(provider.state.grantSeconds).toBe(86_400);
    expect(store.getOAuthGrantSettings().desired).toMatchObject({ grantMode: 'custom', grantSeconds: 86_400, managedBy: 'dashboard' });

    // Two overlapping saves against the same revision: the second is refused, not applied over the first.
    const current = (await settings.view()).revision;
    const results = await Promise.allSettled([
      settings.update('owner-1', { grant: { mode: 'custom', seconds: 172_800 }, tokenLifetimeSeconds: 900, expectedRevision: current }),
      settings.update('owner-1', { grant: { mode: 'custom', seconds: 259_200 }, tokenLifetimeSeconds: 900, expectedRevision: current })
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(provider.state.grantSeconds).toBe(172_800);
  });

  it('records only provider availability failures as a failed sync', async () => {
    const provider = new FakeProvider({ oauthEnabled: true, grantSeconds: 604_800, tokenLifetimeSeconds: 900, explicit: true });
    const { settings, store } = service(provider);
    await settings.view();
    await expect(settings.update('owner', { grant: { mode: 'custom', seconds: 86_400 }, tokenLifetimeSeconds: 900, expectedRevision: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(store.getOAuthGrantSettings().lastSync).toMatchObject({ ok: true });
  });

  it('never overwrites an explicitly customised grant on upgrade', async () => {
    const provider = new FakeProvider({ oauthEnabled: true, grantSeconds: 604_800, tokenLifetimeSeconds: 900, explicit: true });
    const { settings } = service(provider);
    expect(await settings.reconcileDefault()).toBe('left-unmanaged');
    expect(provider.writes).toEqual([]);
    const view = await settings.view();
    expect(view.management.state).toBe('unmanaged');
    expect(view.effective).toMatchObject({ grantSeconds: 604_800, grantIsProviderMaximum: false });
  });

  it('leaves a read-only integration and a failing provider alone at startup', async () => {
    const readOnly = new FakeProvider({ oauthEnabled: true, grantSeconds: null, tokenLifetimeSeconds: null, explicit: false }, false);
    expect(await service(readOnly).settings.reconcileDefault()).toBe('read-only');
    expect(readOnly.writes).toEqual([]);
    const failing = new FakeProvider({ oauthEnabled: true, grantSeconds: null, tokenLifetimeSeconds: null, explicit: false });
    failing.fail = 'provider_unreachable';
    const { settings, store } = service(failing);
    expect(await settings.reconcileDefault()).toBe('failed');
    expect(store.getOAuthGrantSettings()).toMatchObject({ desired: undefined, lastSync: { ok: false, errorCode: 'provider_unreachable' } });
  });

  it('saves a custom grant, records an audit row, and returns the provider read-back', async () => {
    const provider = new FakeProvider({ oauthEnabled: true, grantSeconds: 604_800, tokenLifetimeSeconds: 900, explicit: true });
    const { settings, audits } = service(provider);
    const before = await settings.view();
    const saved = OAuthGrantSettingsViewSchema.parse(await settings.update('owner-1', { grant: { mode: 'custom', seconds: 1_209_600 }, tokenLifetimeSeconds: 600, expectedRevision: before.revision }));
    expect(saved.effective).toMatchObject({ grantSeconds: 1_209_600, tokenLifetimeSeconds: 600, grantIsProviderMaximum: false });
    expect(saved.management).toMatchObject({ state: 'managed', desired: { grant: { mode: 'custom', seconds: 1_209_600 }, tokenLifetimeSeconds: 600 } });
    expect(saved.lastSync).toMatchObject({ ok: true, errorCode: null });
    expect(audits).toEqual([{ ownerId: 'owner-1', action: 'settings.oauth_grant.changed', details: { provider: 'cloudflare-access', grantMode: 'custom', grantSeconds: 1_209_600, tokenLifetimeSeconds: 600 } }]);
  });

  it('rejects values outside the provider capability without calling the provider', async () => {
    const provider = new FakeProvider({ oauthEnabled: true, grantSeconds: MAX, tokenLifetimeSeconds: 900, explicit: true });
    const { settings } = service(provider);
    const { revision } = await settings.view();
    await expect(settings.update('owner', { grant: { mode: 'custom', seconds: MAX + 3_600 }, tokenLifetimeSeconds: 900, expectedRevision: revision }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // The contract itself bounds the access-token lifetime, so a value outside it fails schema validation.
    for (const tokenLifetimeSeconds of [59, 3_601]) {
      await expect(settings.update('owner', { grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds, expectedRevision: revision })).rejects.toThrow();
    }
    expect(provider.writes).toEqual([]);
  });

  it('keeps the previous managed value and reports the failure when a save fails', async () => {
    const provider = new FakeProvider({ oauthEnabled: true, grantSeconds: null, tokenLifetimeSeconds: null, explicit: false });
    const { settings, store, audits } = service(provider);
    await settings.reconcileDefault();
    const managedBefore = store.getOAuthGrantSettings().desired;
    const { revision } = await settings.view();
    provider.fail = 'readback_mismatch';
    await expect(settings.update('owner', { grant: { mode: 'custom', seconds: 86_400 }, tokenLifetimeSeconds: 900, expectedRevision: revision }))
      .rejects.toBeInstanceOf(HarnessError);
    expect(store.getOAuthGrantSettings()).toMatchObject({ desired: managedBefore, lastSync: { ok: false, errorCode: 'readback_mismatch' } });
    expect(audits).toEqual([]);
    provider.fail = 'provider_unreachable';
    const view = await settings.view();
    expect(view.effective).toBeNull();
    expect(view.capabilities.canWriteGrantConfiguration).toBe(false);
    expect(view.readOnlyReason).toMatch(/could not reach Cloudflare/);
  });

  it('detects a concurrent provider-side change and a drift from the managed value', async () => {
    const provider = new FakeProvider({ oauthEnabled: true, grantSeconds: null, tokenLifetimeSeconds: null, explicit: false });
    const { settings } = service(provider);
    await settings.reconcileDefault();
    const { revision } = await settings.view();
    provider.state = { ...provider.state, grantSeconds: 86_400 };
    await expect(settings.update('owner', { grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: 900, expectedRevision: revision })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await settings.view()).management.state).toBe('drifted');
  });

  it('is reachable as an internal dashboard operation and never echoes the provider credential', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-oauth-op-'));
    directories.push(directory);
    const config = { jobsRoot: join(directory, 'jobs'), stateDb: join(directory, 'state.db'), networkProfile: 'dependency-access' } as RunnerConfig;
    const store = new StateStore(config.stateDb);
    stores.push(store);
    const provider = new FakeProvider({ oauthEnabled: true, grantSeconds: MAX, tokenLifetimeSeconds: 900, explicit: true });
    const { settings, audits } = service(provider, store);
    const workspaces = new WorkspaceService(config, store);
    const principal = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'owner' };
    const oauth = { settings, resolvePrincipal: (selector: typeof principal) => store.resolvePrincipal(selector) };
    const read = await executeInternalRunnerOperation(workspaces, { version: 2, principal, operation: 'oauth_settings_get', input: {} }, undefined, oauth);
    expect(read).toMatchObject({ ok: true, data: { provider: { id: 'cloudflare-access' }, management: { state: 'unmanaged' } } });
    const revision = (read.data as { revision: string }).revision;
    const saved = await executeInternalRunnerOperation(workspaces, {
      version: 2, principal, operation: 'oauth_settings_update',
      input: { grant: { mode: 'custom', seconds: 604_800 }, tokenLifetimeSeconds: 900, expectedRevision: revision }
    }, undefined, oauth);
    expect(saved).toMatchObject({ ok: true, data: { effective: { grantSeconds: 604_800 } } });
    expect(audits[0]?.ownerId).toBe(store.resolvePrincipal(principal));
    expect(JSON.stringify([read, saved])).not.toMatch(/token-|Bearer|apiToken/);
    await expect(executeInternalRunnerOperation(workspaces, { version: 2, principal, operation: 'oauth_settings_get', input: {} })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});
