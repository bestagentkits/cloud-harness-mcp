import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import './dashboard-test-dom.js';
import {
  MUTATING_PROXY_OPERATIONS, PERMISSION_PRESETS, PROXY_OPERATIONS,
  applyCatalogEntry, applyCustomModel, buildProfileRequest, catalogFreshnessNotice, catalogOptions, createModelCombobox,
  deriveProfileSlug, dollarsFromMicros, draftRouteKey, draftVerificationInput, effectiveUpstream, formatPrice, initialWizardState,
  microsFromDollars, permissionDiff, permissionPresetFor, pricingDrift, priceProvenanceText, profileVerification, providerApiModes,
  renderModelOptions, renderModelsPage, renderPermissionDiff, renderSaveGate, renderVerificationResult, renderWizardStep, renderWizardSteps,
  wizardSaveGate
} from '../dashboard/dashboard-models.js';
import { FakeElement } from './dashboard-test-dom.js';

const credentialId = `cred_${'a'.repeat(24)}`;
const customCredentialId = `cred_${'c'.repeat(24)}`;
const revisionId = `mrev_${'r'.repeat(24)}`;

const providers = [
  {
    id: 'openai', displayName: 'OpenAI', description: 'GPT models.', apiKeyUrl: 'https://platform.openai.com/api-keys', authModes: ['bearer'], defaultAuthMode: 'bearer',
    endpoints: { 'chat-completions': 'https://api.openai.com/v1/chat/completions', responses: 'https://api.openai.com/v1/responses' },
    catalogStrategy: 'provider-models', requiresCustomUpstream: false
  },
  {
    id: 'anthropic', displayName: 'Anthropic Claude', description: 'Claude.', apiKeyUrl: null, authModes: ['bearer', 'x-api-key'], defaultAuthMode: 'bearer',
    endpoints: { 'chat-completions': 'https://api.anthropic.com/v1/chat/completions' }, catalogStrategy: 'provider-models', requiresCustomUpstream: false
  },
  { id: 'custom', displayName: 'Custom (OpenAI-compatible)', description: 'Any HTTPS endpoint.', apiKeyUrl: null, authModes: ['bearer', 'x-api-key'], defaultAuthMode: 'bearer', endpoints: {}, catalogStrategy: 'none', requiresCustomUpstream: true }
];
const openai = providers[0];
const anthropic = providers[1];
const custom = providers[2];

const credentials = [
  { id: credentialId, label: 'Prod OpenAI', provider: 'openai', authMode: 'bearer', activeVersion: 2, status: 'ACTIVE', generation: 1, lastVerification: { outcome: 'verified', checkedAt: 1_760_000_000_000, revisionId: null } },
  { id: customCredentialId, label: 'Lab endpoint', provider: 'custom', authMode: 'bearer', activeVersion: 1, status: 'ACTIVE', generation: 1 }
];

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gpt-5', displayName: 'GPT 5', credentialId, generation: 3, status: 'ACTIVE', activeRevisionId: revisionId, desiredRevisionId: revisionId,
    activeRevision: {
      id: revisionId, profileId: 'gpt-5', credentialId, model: 'gpt-5', apiMode: 'responses', upstreamUrl: 'https://api.openai.com/v1/responses',
      pricing: { inputMicrosPerMillionTokens: 1_250_000, outputMicrosPerMillionTokens: 10_000_000 },
      limits: { maxInputTokens: 150_000, maxOutputTokens: 20_000, maxCostMicros: 2_500_000 },
      maxProxyOperations: ['files_list', 'files_read', 'files_write', 'grep_search'], digest: 'd', createdAt: 1
    },
    lastVerification: { outcome: 'verified', checkedAt: 1_760_000_000_000, revisionId },
    ...overrides
  };
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'openai', providerModelId: 'gpt-5-mini', canonicalModelId: 'openai/gpt-5-mini', displayName: 'GPT-5 mini', contextWindow: 400_000, maxOutputTokens: 128_000,
    capabilities: { tools: 'reported', reasoning: 'reported', vision: 'unknown' },
    pricing: { inputMicrosPerMillionTokens: 250_000, outputMicrosPerMillionTokens: 2_000_000, provenance: { source: 'openrouter', sourceModelId: 'openai/gpt-5-mini', retrievedAt: 1_760_000_000_000, confidence: 'estimate' }, hasConditionalPricing: false },
    availability: 'listed_for_credential', expiresAt: null,
    ...overrides
  };
}

function createDraft() {
  const state = initialWizardState({ mode: 'create', profiles: [profile()], credentials });
  Object.assign(state, { provider: 'openai', credentialId, step: 3 });
  return state;
}

describe('model profile wizard rules', () => {
  it('derives a collision-safe profile ID from the model', () => {
    expect(deriveProfileSlug('anthropic/claude-sonnet-4.5', [])).toBe('anthropic-claude-sonnet-4.5');
    expect(deriveProfileSlug('GPT 5 Mini', ['gpt-5-mini'])).toBe('gpt-5-mini-2');
    // Collisions are case-insensitive, so two profiles can never differ only by case.
    expect(deriveProfileSlug('gpt-5', ['GPT-5', 'gpt-5-2'])).toBe('gpt-5-3');
    expect(deriveProfileSlug('///', [])).toBe('profile');
    const long = deriveProfileSlug('x'.repeat(200), ['x'.repeat(72)]);
    expect(long).toBe(`${'x'.repeat(72)}-2`);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('converts prices without float drift and never reads an unknown price as zero', () => {
    expect(microsFromDollars('1.75')).toBe(1_750_000);
    expect(microsFromDollars('0.000001')).toBe(1);
    expect(microsFromDollars('0')).toBe(0);
    expect(microsFromDollars('0.1234567')).toBeNull();
    expect(microsFromDollars('')).toBeNull();
    expect(microsFromDollars('-1')).toBeNull();
    expect(microsFromDollars('1e3')).toBeNull();
    expect(dollarsFromMicros(1_750_000)).toBe('1.75');
    expect(dollarsFromMicros(1)).toBe('0.000001');
    expect(dollarsFromMicros(null)).toBe('');
    expect(formatPrice(null)).toBe('Unknown');
    expect(formatPrice(0)).toBe('$0.00');
    expect(formatPrice(10_000_000)).toBe('$10.00');
  });

  it('offers read-only and code-editing presets without silently enabling deletion', () => {
    expect(PROXY_OPERATIONS).toHaveLength(10);
    expect(PERMISSION_PRESETS.read.operations.some((operation: string) => MUTATING_PROXY_OPERATIONS.includes(operation))).toBe(false);
    expect(PERMISSION_PRESETS.code.operations).not.toContain('files_delete');
    expect(permissionPresetFor([...PERMISSION_PRESETS.read.operations].reverse())).toBe('read');
    expect(permissionPresetFor(PERMISSION_PRESETS.code.operations)).toBe('code');
    expect(permissionPresetFor(['files_list'])).toBe('custom');
    // A new profile starts read-only.
    expect(permissionPresetFor(initialWizardState().operations)).toBe('read');

    const diff = permissionDiff(['files_list', 'files_read', 'files_write'], ['files_list', 'files_read', 'files_delete', 'grep_search']);
    expect(diff).toEqual({ added: ['files_delete', 'grep_search'], removed: ['files_write'], kept: ['files_list', 'files_read'], addedMutating: ['files_delete'] });
    const markup = renderPermissionDiff({ baseOperations: ['files_list'], operations: ['files_list', 'files_write'] });
    expect(markup).toContain('1 added, 0 removed, 1 unchanged');
    expect(markup).toContain('permission-added permission-mutating');
    expect(markup).toContain('<span class="sr-only">Allowed: </span>');
    expect(markup).toContain('changes files');
  });

  it('opens an edit with every saved value and a duplicate under a fresh ID', () => {
    const saved = profile();
    const edit = initialWizardState({ mode: 'edit', profile: saved, profiles: [saved], credentials });
    expect(edit).toMatchObject({
      step: 3, provider: 'openai', credentialId, model: 'gpt-5', apiMode: 'responses', displayName: 'GPT 5', profileId: 'gpt-5',
      pricingInput: '1.25', pricingOutput: '10.00', maxInputTokens: '150000', maxOutputTokens: '20000', maxCost: '2.50',
      operations: ['files_list', 'files_read', 'files_write', 'grep_search'], baseOperations: ['files_list', 'files_read', 'files_write', 'grep_search']
    });
    expect(edit.savedRoute).toEqual({ key: draftRouteKey({ credentialId, model: 'gpt-5', apiMode: 'responses', customUpstreamUrl: '' }), outcome: 'verified' });
    // An unchanged edit is verified by the saved revision and needs no new choice.
    expect(wizardSaveGate(edit, openai).allowed).toBe(true);

    const duplicate = initialWizardState({ mode: 'duplicate', profile: saved, profiles: [saved, { id: 'gpt-5-copy' }], credentials });
    expect(duplicate.profileId).toBe('gpt-5-copy-2');
    expect(duplicate.displayName).toBe('GPT 5 (copy)');
    expect(duplicate.profile).toBeNull();
    // A copy is a new profile: every operation counts as newly allowed, so file changes need confirmation.
    expect(duplicate.baseOperations).toEqual([]);
    expect(wizardSaveGate(duplicate, openai).diff.addedMutating).toEqual(['files_write']);
  });

  it('fills catalog fields without erasing values the operator typed', () => {
    const state = createDraft();
    applyCatalogEntry(state, entry());
    expect(state).toMatchObject({ model: 'gpt-5-mini', displayName: 'GPT-5 mini', profileId: 'gpt-5-mini', pricingInput: '0.25', pricingOutput: '2.00' });
    expect(priceProvenanceText(state.pricingProvenance)).toContain('Source: OpenRouter · confidence: estimate · retrieved');

    state.displayName = 'My mini';
    state.pricingInput = '0.30';
    state.touched.add('displayName');
    state.touched.add('pricingInput');
    applyCatalogEntry(state, entry({ providerModelId: 'gpt-5', displayName: 'GPT-5', pricing: { ...entry().pricing, inputMicrosPerMillionTokens: 1_250_000, outputMicrosPerMillionTokens: null } }));
    expect(state.displayName).toBe('My mini');
    expect(state.pricingInput).toBe('0.30');
    // The taken ID is skipped, and the unknown output price stays empty rather than becoming 0.
    expect(state.profileId).toBe('gpt-5-2');
    expect(state.pricingOutput).toBe('');
    const { errors } = buildProfileRequest(state, openai);
    expect(errors.pricingOutput).toContain('enter 0 only if the model is free');

    applyCustomModel(state, '  ft:gpt-5:org  ');
    expect(state.selectedEntry).toBeNull();
    expect(state.model).toBe('ft:gpt-5:org');
  });

  it('lists the typed text as a custom ID only when no catalog entry matches it', () => {
    expect(catalogOptions([entry()], 'gpt-5-mini').map((option: { kind: string }) => option.kind)).toEqual(['entry']);
    expect(catalogOptions([entry()], 'my-model').map((option: { kind: string }) => option.kind)).toEqual(['entry', 'custom']);
    expect(catalogOptions([], '  ')).toEqual([]);
    expect(catalogOptions([], 'x'.repeat(101))).toEqual([]);
  });

  it('gates saving on a verified route, an explicit unverified choice, and confirmed file changes', () => {
    const state = createDraft();
    applyCatalogEntry(state, entry({ availability: 'public_catalog' }));
    let gate = wizardSaveGate(state, openai);
    expect(gate.allowed).toBe(false);
    expect(gate.reasons[0]).toContain('public metadata only');

    state.verification = { key: gate.routeKey, result: { outcome: 'limited' } };
    expect(wizardSaveGate(state, openai).allowed).toBe(false);
    state.verification = { key: gate.routeKey, result: { outcome: 'verified' } };
    expect(wizardSaveGate(state, openai)).toMatchObject({ allowed: true, verified: true });

    // Changing the route after the check makes the check stale.
    state.apiMode = 'responses';
    gate = wizardSaveGate(state, openai);
    expect(gate.verified).toBe(false);
    state.saveUnverifiedKey = gate.routeKey;
    expect(wizardSaveGate(state, openai).allowed).toBe(true);
    // The unverified choice belongs to the route it was made for.
    state.model = 'gpt-5';
    expect(wizardSaveGate(state, openai).allowed).toBe(false);
    state.saveUnverifiedKey = wizardSaveGate(state, openai).routeKey;

    state.operations = [...PERMISSION_PRESETS.code.operations];
    gate = wizardSaveGate(state, openai);
    expect(gate.allowed).toBe(false);
    expect(gate.reasons.at(-1)).toContain('files_write, files_apply_patch, files_move, files_mkdir');
    state.mutatingAckKey = gate.operationsKey;
    expect(wizardSaveGate(state, openai).allowed).toBe(true);

    const markup = renderSaveGate(state, openai);
    expect(markup).toContain('name="saveUnverified" checked');
    expect(markup).toContain('name="acknowledgeMutating" checked');
  });

  it('builds create and update requests that match the profile contract', () => {
    const state = createDraft();
    applyCatalogEntry(state, entry());
    const created = buildProfileRequest(state, openai);
    expect(created.errors).toEqual({});
    expect(created.request).toEqual({
      kind: 'create',
      body: {
        profileId: 'gpt-5-mini', displayName: 'GPT-5 mini', credentialId, model: 'gpt-5-mini', apiMode: 'chat-completions',
        pricing: { inputMicrosPerMillionTokens: 250_000, outputMicrosPerMillionTokens: 2_000_000 },
        limits: { maxInputTokens: 200_000, maxOutputTokens: 32_000, maxCostMicros: 5_000_000 },
        maxProxyOperations: [...PERMISSION_PRESETS.read.operations].sort((a, b) => PROXY_OPERATIONS.indexOf(a) - PROXY_OPERATIONS.indexOf(b))
      }
    });

    state.profileId = 'GPT-5';
    state.apiMode = 'responses';
    expect(buildProfileRequest(state, anthropic).errors).toMatchObject({ profileId: 'A profile named GPT-5 already exists.', apiMode: 'Choose an API mode this provider offers.' });
    state.operations = [];
    expect(buildProfileRequest(state, openai).errors.operations).toBe('Allow at least one operation.');

    const saved = profile();
    const edit = initialWizardState({ mode: 'edit', profile: saved, profiles: [saved], credentials });
    edit.displayName = 'Renamed';
    const updated = buildProfileRequest(edit, openai);
    expect(updated.request.kind).toBe('update');
    expect(updated.request.profileId).toBe('gpt-5');
    expect(updated.request.body).toMatchObject({ displayName: 'Renamed', expectedGeneration: 3 });
    expect(updated.request.body).not.toHaveProperty('profileId');
    expect(updated.request.body).not.toHaveProperty('customUpstreamUrl');
  });

  it('keeps a custom upstream on edit only while the key and API mode are unchanged', () => {
    const saved = profile({
      credentialId: customCredentialId,
      activeRevision: { ...profile().activeRevision, credentialId: customCredentialId, apiMode: 'chat-completions', upstreamUrl: 'https://llm.example.com/v1/chat/completions' }
    });
    const edit = initialWizardState({ mode: 'edit', profile: saved, profiles: [saved], credentials });
    expect(edit.provider).toBe('custom');
    expect(edit.customUpstreamUrl).toBe('');
    expect(effectiveUpstream(edit, custom)).toBe('https://llm.example.com/v1/chat/completions');
    expect(draftVerificationInput(edit, custom)).toEqual({ credentialId: customCredentialId, model: 'gpt-5', apiMode: 'chat-completions', customUpstreamUrl: 'https://llm.example.com/v1/chat/completions' });
    expect(buildProfileRequest(edit, custom).errors).toEqual({});
    edit.apiMode = 'responses';
    expect(buildProfileRequest(edit, custom).errors.customUpstreamUrl).toBe('Enter the HTTPS URL of your provider endpoint.');
    edit.customUpstreamUrl = 'http://llm.example.com/v1/responses';
    expect(buildProfileRequest(edit, custom).errors.customUpstreamUrl).toBe('Use an https:// URL.');
    expect(providerApiModes(custom)).toEqual(['chat-completions', 'responses']);
    expect(providerApiModes(anthropic)).toEqual(['chat-completions']);
  });

  it('sends a draft check without any key material', () => {
    const state = createDraft();
    applyCatalogEntry(state, entry());
    const input = draftVerificationInput(state, openai, { tools: true });
    expect(input).toEqual({ credentialId, model: 'gpt-5-mini', apiMode: 'chat-completions', checks: { tools: true } });
    expect(JSON.stringify(state)).not.toMatch(/apiKey/);
  });

  it('reads a profile check as current only for the revision it checked', () => {
    expect(profileVerification(profile())).toMatchObject({ outcome: 'verified', current: true });
    expect(profileVerification(profile({ activeRevisionId: `mrev_${'n'.repeat(24)}` }))).toMatchObject({ outcome: 'not_tested', current: false, previousOutcome: 'verified' });
    expect(profileVerification(profile({ lastVerification: undefined }))).toEqual({ outcome: 'not_tested', checkedAt: null, current: false });
  });

  it('describes catalog freshness and price drift in plain language', () => {
    expect(catalogFreshnessNotice({ state: 'fresh', fetchedAt: 1_760_000_000_000, sources: [] })?.level).toBe('fresh');
    const stale = catalogFreshnessNotice({ state: 'stale', fetchedAt: 1_760_000_000_000, sources: [{ source: 'provider', state: 'stale', fetchedAt: 1, error: 'rate_limited' }] });
    expect(stale?.text).toContain('(provider: rate limited)');
    expect(catalogFreshnessNotice({ state: 'unavailable', fetchedAt: null, sources: [] })?.text).toContain('Enter the model ID yourself');
    const revision = profile().activeRevision;
    expect(pricingDrift(revision, entry({ providerModelId: 'gpt-5', pricing: { ...entry().pricing, inputMicrosPerMillionTokens: 1_250_000, outputMicrosPerMillionTokens: 10_000_000 } }), { state: 'fresh' })).toEqual({ state: 'current' });
    expect(pricingDrift(revision, entry(), { state: 'fresh' })).toMatchObject({ state: 'changed', text: 'Catalog price is now $0.25 / $2.00' });
    expect(pricingDrift(revision, entry({ pricing: { ...entry().pricing, inputMicrosPerMillionTokens: null } }), null)).toEqual({ state: 'unknown' });
    expect(pricingDrift(revision, undefined, null)).toEqual({ state: 'unknown' });
  });
});

describe('model search combobox', () => {
  function setup() {
    const input = new FakeElement();
    const listbox = Object.assign(new FakeElement(), { id: 'model-wizard-options' });
    const render = (element: FakeElement, markup: string) => { element.innerHTML = markup; };
    const onQuery = vi.fn();
    const onCommit = vi.fn();
    const timers = { setTimeout: vi.fn((callback: () => void) => { callback(); return 1; }), clearTimeout: vi.fn() };
    const combobox = createModelCombobox({ input, listbox, render, onQuery, onCommit, timers });
    const options = catalogOptions([entry(), entry({ providerModelId: 'gpt-5', displayName: 'GPT-5' })], 'gpt-5-nano');
    const key = (name: string) => ({ key: name, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    return { input, listbox, combobox, options, onQuery, onCommit, timers, key };
  }

  it('moves the active option with the arrow keys while focus stays in the input', () => {
    const { input, listbox, combobox, options, key } = setup();
    combobox.setOptions(options, { open: false });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(listbox.hidden).toBe(true);

    const down = key('ArrowDown');
    input.dispatch('keydown', down);
    expect(down.preventDefault).toHaveBeenCalled();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe('model-wizard-options-opt-0');
    expect(listbox.innerHTML).toContain('id="model-wizard-options-opt-0" class="model-option selected" role="option" aria-selected="true"');

    input.dispatch('keydown', key('ArrowDown'));
    input.dispatch('keydown', key('ArrowDown'));
    expect(input.getAttribute('aria-activedescendant')).toBe('model-wizard-options-opt-2');
    input.dispatch('keydown', key('ArrowDown'));
    expect(input.getAttribute('aria-activedescendant')).toBe('model-wizard-options-opt-0');
    input.dispatch('keydown', key('ArrowUp'));
    expect(input.getAttribute('aria-activedescendant')).toBe('model-wizard-options-opt-2');
    expect(listbox.innerHTML).toContain('Use “gpt-5-nano” as a custom model ID');
  });

  it('commits with Enter, closes with Escape without closing the dialog, and closes on Tab', () => {
    const { input, combobox, options, onCommit, key } = setup();
    combobox.setOptions(options);
    // Enter with no active option is left to the form, which moves the wizard on.
    const idleEnter = key('Enter');
    input.dispatch('keydown', idleEnter);
    expect(idleEnter.preventDefault).not.toHaveBeenCalled();

    input.dispatch('keydown', key('ArrowDown'));
    input.dispatch('keydown', key('ArrowDown'));
    const enter = key('Enter');
    input.dispatch('keydown', enter);
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'entry', entry: expect.objectContaining({ providerModelId: 'gpt-5' }) }));
    expect(combobox.expanded).toBe(false);
    expect(input.getAttribute('aria-activedescendant')).toBeUndefined();

    combobox.setOptions(options);
    const escape = key('Escape');
    input.dispatch('keydown', escape);
    expect(escape.preventDefault).toHaveBeenCalled();
    expect(escape.stopPropagation).toHaveBeenCalled();
    expect(combobox.expanded).toBe(false);
    // With the list closed, Escape belongs to the dialog.
    const closedEscape = key('Escape');
    input.dispatch('keydown', closedEscape);
    expect(closedEscape.stopPropagation).not.toHaveBeenCalled();

    combobox.setOptions(options);
    input.dispatch('keydown', key('Tab'));
    expect(combobox.expanded).toBe(false);
  });

  it('debounces searches and commits a clicked option', () => {
    const { input, listbox, combobox, options, onQuery, onCommit, timers } = setup();
    input.value = 'mini';
    input.dispatch('input', {});
    expect(timers.clearTimeout).toHaveBeenCalled();
    expect(onQuery).toHaveBeenCalledWith('mini');
    combobox.setOptions(options);
    const mousedown = { preventDefault: vi.fn() };
    listbox.dispatch('mousedown', mousedown);
    expect(mousedown.preventDefault).toHaveBeenCalled();
    listbox.dispatch('click', { target: { closest: () => ({ dataset: { index: '2' } }) } });
    expect(onCommit).toHaveBeenCalledWith({ kind: 'custom', value: 'gpt-5-nano' });
    combobox.dispose();
  });
});

describe('model wizard markup', () => {
  const context = { providers, credentials, providersStatus: 'ready', catalog: { status: 'idle', entries: [] } };

  it('marks the current step and gives each step a focusable heading', () => {
    expect(renderWizardSteps(2)).toMatch(/<li class="done">.*Provider.*<li class="done">.*Connect.*<li class="" aria-current="step">.*Model/s);
    const state = createDraft();
    state.step = 0;
    const markup = renderWizardStep(state, { ...context, provider: undefined });
    expect(markup).toContain('id="model-wizard-step-heading" class="wizard-step-heading" tabindex="-1"><span class="sr-only">Step 1 of 5: </span>Choose a provider');
    expect(markup).toContain('<legend class="sr-only">Provider</legend>');
    expect(markup).toContain('1 saved key');
    expect(renderWizardStep(state, { ...context, providersStatus: 'loading' })).toContain('Loading providers…');
    const failed = renderWizardStep(state, { ...context, providersStatus: 'error', providersError: 'Runner unavailable.' });
    expect(failed).toContain('role="alert">Runner unavailable.');
    expect(failed).toContain('data-wizard-action="retry-providers"');
  });

  it('collects a new key only through a write-only field', () => {
    const state = createDraft();
    Object.assign(state, { step: 1, provider: 'anthropic', credentialChoice: 'new' });
    const markup = renderWizardStep(state, { ...context, provider: anthropic });
    expect(markup).toContain('id="model-wizard-api-key" name="apiKey" type="password" autocomplete="new-password"');
    expect(markup).not.toMatch(/name="apiKey"[^>]*value=/);
    // Anthropic accepts two auth headers; the choice is offered only when there is one to make.
    expect(markup).toContain('name="newCredentialAuthMode"');
    expect(markup).toContain('none saved for this provider');
    expect(renderWizardStep({ ...state, provider: 'openai' }, { ...context, provider: openai })).not.toContain('name="newCredentialAuthMode"');
  });

  it('renders the model search as an ARIA combobox with freshness and a custom ID fallback', () => {
    const state = createDraft();
    state.step = 2;
    const markup = renderWizardStep(state, { ...context, provider: openai, catalog: { status: 'ready', entries: [entry()], freshness: { state: 'stale', fetchedAt: 1_760_000_000_000, sources: [{ source: 'openrouter', state: 'stale', fetchedAt: 1, error: 'timeout' }] } } });
    expect(markup).toContain('role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="model-wizard-options"');
    expect(markup).toContain('id="model-wizard-options" class="model-options" role="listbox" aria-label="Matching models" hidden');
    expect(markup).toContain('aria-describedby="model-wizard-search-help"');
    expect(markup).toContain('class="warning">Showing the last good catalog');
    expect(markup).toContain('data-wizard-action="refresh-catalog"');
    expect(renderWizardStep(state, { ...context, provider: openai, catalog: { status: 'error', entries: [], error: 'Provider credential not found.' } })).toContain('data-wizard-action="retry-catalog"');
    const customStep = renderWizardStep({ ...state, provider: 'custom' }, { ...context, provider: custom });
    expect(customStep).toContain('has no catalog');
    expect(customStep).not.toContain('role="combobox"');
    expect(renderModelOptions(catalogOptions([entry({ pricing: { ...entry().pricing, inputMicrosPerMillionTokens: null } })], ''), -1)).toContain('Unknown in / $2.00 out per 1M');
  });

  it('shows unknown prices as unknown and opens Advanced settings on an error there', () => {
    const state = createDraft();
    applyCatalogEntry(state, entry({ pricing: { ...entry().pricing, inputMicrosPerMillionTokens: null, outputMicrosPerMillionTokens: null, provenance: { source: 'none', sourceModelId: null, retrievedAt: null, confidence: 'unknown' } } }));
    const markup = renderWizardStep(state, { ...context, provider: openai });
    expect(markup).toContain('<span class="status stale">Unknown</span>');
    expect(markup).not.toContain('$0.00 ');
    expect(markup).toContain('Source: no source · confidence: unknown');
    expect(markup).toMatch(/<details id="model-wizard-advanced" class="row-edit wizard-advanced">/);
    const { errors } = buildProfileRequest(state, openai);
    const withErrors = renderWizardStep(state, { ...context, provider: openai, errors });
    expect(withErrors).toMatch(/<details id="model-wizard-advanced" class="row-edit wizard-advanced" open>/);
    expect(withErrors).toContain('name="pricingInput" inputmode="decimal" type="text" value="" aria-invalid="true" aria-describedby="model-wizard-pricingInput-error"');
    expect(withErrors).toContain('id="model-wizard-pricingInput-error" class="field-error" role="alert"');
    // Only the modes the provider offers can be chosen.
    expect(renderWizardStep(state, { ...context, provider: anthropic })).not.toContain('value="responses"');
  });

  it('shows the permission diff, the check result, and the save gate before saving', () => {
    const saved = profile();
    const state = initialWizardState({ mode: 'edit', profile: saved, profiles: [saved], credentials });
    state.step = 4;
    state.operations = [...state.operations, 'files_delete'];
    const markup = renderWizardStep(state, { ...context, provider: openai });
    expect(markup).toContain('Permission changes');
    expect(markup).toContain('1 added, 0 removed, 4 unchanged');
    expect(markup).toContain('Allow the subagent to change files: <span class="mono">files_delete</span>');
    expect(markup).toContain('This route is verified.');
    expect(markup).toContain('data-wizard-action="verify"');

    const result = renderVerificationResult({
      outcome: 'failed', checkedAt: 1_760_000_000_000, elapsedMs: 412, provider: 'openai', model: 'gpt-5', apiMode: 'responses',
      checks: [{ name: 'authentication', outcome: 'failed', elapsedMs: 200, errorCategory: 'auth', httpStatus: 401, message: '<b>Incorrect key</b>' }],
      usage: { inputTokens: 12, outputTokens: 1 }
    });
    expect(result).toContain('<span class="status failed">Failed</span>');
    expect(result).toContain('auth · HTTP 401 · &lt;b&gt;Incorrect key&lt;/b&gt;');
    expect(result).toContain('Used 12 input and 1 output tokens.');
  });
});

describe('models page list', () => {
  it('shows provider, verification, key, pricing, limits, and actions in both table and cards', () => {
    const stale = profile({ id: 'old-route', displayName: 'Old route', status: 'DISABLED', activeRevisionId: `mrev_${'n'.repeat(24)}` });
    const markup = renderModelsPage({ profiles: [profile(), stale], credentials, providers, status: { gatewaySynced: true } });
    expect(markup).toContain('<div class="desktop-table">');
    expect(markup).toContain('<ul class="mobile-list">');
    for (const action of ['verify', 'edit', 'duplicate', 'disable', 'activate', 'delete']) {
      // Each control renders once per rendering of the row, so the visible list is always a working one.
      expect(markup.match(new RegExp(`data-model-action="${action}"`, 'g'))?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
    expect(markup).toContain('OpenAI<br><span class="mono wrap">gpt-5 · responses</span>');
    expect(markup).toContain('<span class="status active">Verified</span>');
    expect(markup).toContain('earlier revision · <time');
    expect(markup).toContain('Prod OpenAI');
    expect(markup).toContain('$1.25 / $10.00');
    expect(markup).toContain('$2.50 · 150,000 in / 20,000 out');
    expect(markup).toContain('data-pricing-drift="gpt-5" hidden');
    expect(markup).toContain('Gateway synchronized');
    expect(markup).toContain('<span class="status">Disabled</span>');
    expect(markup).not.toMatch(/apiKey|secret"/);
  });

  it('states empty lists and missing status rather than showing blanks', () => {
    const markup = renderModelsPage({});
    expect(markup).toContain('No model profiles yet.');
    expect(markup).toContain('data-model-action="add"');
    expect(markup).not.toContain('accent-btn');
    expect(markup).toContain('No provider keys yet.');
    expect(markup).toContain('Gateway status unavailable');
  });
});

describe('models page shell and small viewports', () => {
  const html = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../dashboard/dashboard.css', import.meta.url), 'utf8');
  const mobile = css.slice(css.indexOf('@media (max-width: 47.9375rem) {'), css.indexOf('@media (max-width: 47.9375rem) {', css.indexOf('@media (max-width: 47.9375rem) {') + 1));

  it('hosts the wizard in one labelled dialog with a live status line', () => {
    expect(html).toMatch(/<dialog id="model-profile-dialog" aria-labelledby="model-profile-title" aria-describedby="model-profile-description">/);
    expect(html).toContain('<ol id="model-wizard-steps" class="wizard-steps" aria-label="Profile setup steps"></ol>');
    expect(html).toContain('<p id="model-wizard-status" class="form-status" aria-live="polite"></p>');
    expect(html).toContain('<button type="button" id="model-wizard-back" hidden>Back</button>');
    // The credential dialog reports failures inside the dialog, not behind its backdrop.
    expect(html).toContain('<p id="model-credential-status" class="form-status" aria-live="polite"></p>');
  });

  it('collapses the wizard and the profile list to one column on a phone', () => {
    expect(mobile).toContain('.wizard-choices { grid-template-columns: minmax(0, 1fr); }');
    expect(mobile).toContain('.wizard-subfields { padding-inline-start: 0; }');
    expect(mobile).toContain('.wizard-actions > button { flex: 1 1 0; }');
    expect(mobile).toContain('.desktop-table { display: none; }');
    expect(mobile).toContain('.mobile-list { display: grid; }');
    expect(mobile).toContain('dialog { padding: var(--space-4); }');
    // Hidden wizard parts stay hidden even where a component rule sets a display value.
    for (const rule of ['.wizard-subfields[hidden] { display: none; }', '.model-options[hidden] { display: none; }', '.wizard-actions #model-wizard-back[hidden] { display: none; }', '.pricing-drift[hidden] { display: none; }']) expect(css).toContain(rule);
  });
});
