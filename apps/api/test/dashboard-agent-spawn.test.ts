import { describe, expect, it } from 'vitest';
import {
  AGENT_PROMPT_MAX_BYTES, BOUNDED_RUN_NOTE, costPreview, createSpawnKeyring, initialSpawnState, presetsFor,
  profileReadiness, renderProfileOptions, renderProfileSummary, renderSpawnForm, renderSpawnPreview, validateSpawn,
  workspaceEligibility
} from '../dashboard/dashboard-agent-spawn.js';

const now = Date.parse('2026-10-17T00:00:00.000Z');
const revisionId = `rev_${'r'.repeat(24)}`;
const workspace = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: `ws_${'a'.repeat(24)}`, repositoryUrl: 'https://github.com/example/project.git', status: 'ACTIVE',
  networkProfile: 'network-none', expiresAt: '2026-10-17T02:00:00.000Z', ...overrides
});
const profile = (overrides: Record<string, unknown> = {}, revision: Record<string, unknown> = {}) => ({
  id: 'coding', displayName: 'Coding', status: 'ACTIVE', activeRevisionId: revisionId,
  lastVerification: { outcome: 'verified', checkedAt: now, revisionId },
  activeRevision: {
    id: revisionId, model: 'openai/gpt-5', apiMode: 'responses',
    pricing: { inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 10_000_000 },
    limits: { maxInputTokens: 100_000, maxOutputTokens: 20_000, maxCostMicros: 2_500_000 },
    maxProxyOperations: ['files_list', 'files_read', 'grep_search', 'symbols_search', 'symbols_references'],
    ...revision
  },
  ...overrides
});

describe('Run Pi agent form rules', () => {
  it('accepts only an active, unexpired network-none workspace and says why otherwise', () => {
    expect(workspaceEligibility(workspace(), now)).toEqual({ eligible: true, reason: '' });
    expect(workspaceEligibility(workspace({ status: 'CLOSED' }), now).reason).toBe('Not active');
    expect(workspaceEligibility(workspace({ expiresAt: '2026-10-16T00:00:00.000Z' }), now).reason).toBe('Lease expired');
    expect(workspaceEligibility(workspace({ networkProfile: 'dependency-access' }), now).reason).toContain('network-none');
    expect(workspaceEligibility(undefined, now).eligible).toBe(false);
  });

  it('spawns only from an ACTIVE profile with a revision and labels every other state', () => {
    expect(profileReadiness(profile())).toMatchObject({ spawnable: true, warnings: [] });
    expect(profileReadiness(profile({ status: 'DISABLED' }))).toMatchObject({ spawnable: false, label: 'Disabled' });
    expect(profileReadiness(profile({ status: 'SYNC_PENDING' }))).toMatchObject({ spawnable: false, label: 'Sync pending' });
    expect(profileReadiness(profile({ status: 'SYNC_FAILED' }))).toMatchObject({ spawnable: false, label: 'Sync failed' });
    expect(profileReadiness(profile({ activeRevision: null }))).toMatchObject({ spawnable: false, label: 'No active revision' });
    // Unverified, failed checks and an unsynced gateway warn but do not block: the runner reconciles first.
    expect(profileReadiness(profile({ lastVerification: null })).warnings[0]).toContain('not been verified');
    expect(profileReadiness(profile({ lastVerification: { outcome: 'failed', checkedAt: now, revisionId } })).warnings[0]).toContain('failed');
    expect(profileReadiness(profile(), { gatewaySynced: false })).toMatchObject({ spawnable: true });
    expect(profileReadiness(profile(), { gatewaySynced: false }).warnings.join(' ')).toContain('not in sync');
    // A check of an older revision does not vouch for the active one.
    expect(profileReadiness(profile({ lastVerification: { outcome: 'verified', checkedAt: now, revisionId: `rev_${'o'.repeat(24)}` } })).warnings).toHaveLength(1);
  });

  it('offers a preset only when the profile ceiling covers it, and starts from its limits', () => {
    const presets = presetsFor(profile());
    expect(presets.find((preset) => preset.id === 'read')).toMatchObject({ allowed: true });
    expect(presets.find((preset) => preset.id === 'code')).toMatchObject({ allowed: false });
    expect(presets.at(-1)).toMatchObject({ id: 'custom', allowed: true });
    const state = initialSpawnState({ workspaceId: 'ws', profile: profile(), prompt: 'keep me' });
    expect(state).toMatchObject({ profileId: 'coding', prompt: 'keep me', maxInputTokens: '100000', maxOutputTokens: '20000', maxCost: '2.50' });
    expect(state.operations).not.toContain('files_write');
  });

  it('builds the exact agent_spawn input and refuses anything past the profile ceilings', () => {
    const state = { ...initialSpawnState({ workspaceId: workspace().workspaceId, profile: profile() }), prompt: 'fix the test' };
    const result = validateSpawn(state, profile(), workspace(), null, now);
    expect(result.ok).toBe(true);
    expect(result.input).toEqual({
      prompt: 'fix the test', profileId: 'coding', proxyOperations: expect.arrayContaining(['files_read']), ttlSeconds: 900,
      maxOutputBytes: 262_144, maxInputTokens: 100_000, maxOutputTokens: 20_000, maxCostMicros: 2_500_000
    });
    // The workspace and idempotency key are the route's and the controller's, never the form's.
    expect(result.input).not.toHaveProperty('workspaceId');
    expect(result.input).not.toHaveProperty('idempotencyKey');

    const over = validateSpawn({ ...state, maxInputTokens: '100001', maxCost: '2.51', ttlSeconds: '10', operations: ['files_write'] }, profile(), workspace(), null, now);
    expect(over.ok).toBe(false);
    expect(Object.keys(over.errors).sort()).toEqual(['maxCost', 'maxInputTokens', 'operations', 'ttlSeconds']);

    const blocked = validateSpawn({ ...state, prompt: ' ' }, profile({ status: 'DISABLED' }), workspace({ networkProfile: 'dependency-access' }), null, now);
    expect(Object.keys(blocked.errors).sort()).toEqual(['profileId', 'prompt', 'workspaceId']);
    const oversized = validateSpawn({ ...state, prompt: 'é'.repeat(AGENT_PROMPT_MAX_BYTES / 2 + 1) }, profile(), workspace(), null, now);
    expect(oversized.errors.prompt).toContain('bytes');
  });

  it('keeps one idempotency key per distinct request so a resend replays instead of duplicating', () => {
    let next = 0;
    const keyring = createSpawnKeyring(() => `k${++next}`);
    const input = { prompt: 'a' };
    expect(keyring.keyFor('ws', input)).toBe('dashboard-k1');
    expect(keyring.keyFor('ws', { prompt: 'a' })).toBe('dashboard-k1');
    expect(keyring.keyFor('ws', { prompt: 'b' })).toBe('dashboard-k2');
    expect(keyring.keyFor('ws2', { prompt: 'b' })).toBe('dashboard-k3');
    keyring.reset();
    expect(keyring.keyFor('ws2', { prompt: 'b' })).toBe('dashboard-k4');
  });

  it('previews cost as the lower of the hard cap and the base-price token worst case', () => {
    expect(costPreview(profile(), { maxInputTokens: 100_000, maxOutputTokens: 20_000, maxCostMicros: 2_500_000 }))
      .toEqual({ capMicros: 2_500_000, tokenWorstMicros: 400_000, effectiveMicros: 400_000, tiered: false });
    expect(costPreview(profile({}, { pricing: {} }), { maxInputTokens: 1, maxOutputTokens: 1, maxCostMicros: 1_000 }))
      .toMatchObject({ tokenWorstMicros: null, effectiveMicros: 1_000 });
    expect(costPreview(profile({}, { pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1, tiers: [{}] } }), { maxCostMicros: 5 }).tiered).toBe(true);
  });
});

describe('Run Pi agent form markup', () => {
  it('lists every profile, ranks spawnable ones first, and disables the rest with their state', () => {
    const options = renderProfileOptions([profile({ id: 'off', displayName: 'Off', status: 'DISABLED' }), profile()], { profileId: 'coding' });
    expect(options.indexOf('value="coding"')).toBeLessThan(options.indexOf('value="off"'));
    expect(options).toContain('<option value="off" disabled>');
    expect(options).toContain('Off · openai/gpt-5 — Disabled');
    expect(renderProfileOptions([profile()], { profileId: '' }, 'gpt-5')).toContain('value="coding"');
    expect(renderProfileOptions([profile()], { profileId: '' }, 'claude')).toContain('No profile matches');
  });

  it('states the model, API mode and the revision that will be pinned', () => {
    const summary = renderProfileSummary(profile());
    for (const fact of ['openai/gpt-5', 'Responses', revisionId, 'Pinned revision', '$2.50']) expect(summary).toContain(fact);
    expect(renderProfileSummary(profile({ status: 'DISABLED' }))).toContain('Activate it in Models &amp; Budgets');
  });

  it('previews isolation, permissions, cost and the bounded lifecycle before the spawn', () => {
    const state = initialSpawnState({ profile: profile() });
    const preview = renderSpawnPreview(profile(), state);
    expect(preview).toContain('read only');
    expect(preview).toContain('hard cap $2.50');
    expect(preview).toContain('at most $0.40');
    expect(preview).toContain('not a provider bill');
    expect(preview).toContain('It is not a persistent terminal session');
    expect(BOUNDED_RUN_NOTE).toContain('only while it is running');
    const writing = renderSpawnPreview(profile({}, { maxProxyOperations: ['files_read', 'files_write'] }), { ...state, operations: ['files_read', 'files_write'] });
    expect(writing).toContain('can change files');
  });

  it('escapes owner-controlled text and disables ineligible workspaces', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const markup = renderSpawnForm({
      workspaces: [workspace(), workspace({ workspaceId: `ws_${'b'.repeat(24)}`, networkProfile: 'dependency-access' })],
      profiles: [profile({ displayName: hostile })],
      state: { ...initialSpawnState({ workspaceId: workspace().workspaceId, profile: profile() }), prompt: hostile },
      now
    });
    expect(markup).not.toContain('<img src=x');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).toContain(`<option value="ws_${'b'.repeat(24)}" disabled>`);
    expect(markup).toContain('id="agent-spawn-prompt"');
    const empty = renderSpawnForm({ workspaces: [], profiles: [], state: initialSpawnState(), now });
    expect(empty).toContain('No open workspace can run agents');
    // A locked workspace is not re-chosen in the form.
    expect(renderSpawnForm({ profiles: [], state: initialSpawnState({ workspaceId: 'ws_x' }), lockedWorkspace: true, now })).toContain('type="hidden" name="workspaceId"');
  });
});
