import { describe, expect, it } from 'vitest';
import {
  applyCatalogEntry,
  applyCustomModel,
  buildProfileRequest,
  catalogOptions,
  deriveProfileSlug,
  draftRouteKey,
  draftVerificationInput,
  draftVerificationRef,
  effectiveUpstream,
  initialWizardState,
  MODEL_ID_MAX,
  normalizeOperations,
  parseStoredWizard,
  permissionDiff,
  permissionPresetFor,
  PERMISSION_PRESETS,
  pricingSaveKind,
  profilePricing,
  providerApiModes,
  resetUntouchedPricing,
  selectProvider,
  setField,
  storableUpstreamUrl,
  storedWizard,
  WIZARD_STEPS,
  type WizardState,
  wizardSaveGate
} from './models-wizard-state';
import type { CatalogEntry, ModelProfile, ModelProvider, ProfileRevision, ProviderCredential, VerifyResult } from './models-types';

// Obviously fake: a placeholder that must never reach a stored draft, a request or a route key.
const FAKE_KEY = 'sk-test-not-real';

const openai: ModelProvider = { id: 'openai', displayName: 'OpenAI', endpoints: { 'chat-completions': {}, responses: {} } };
const anthropic: ModelProvider = { id: 'anthropic', displayName: 'Anthropic', endpoints: { 'chat-completions': {} } };
const custom: ModelProvider = { id: 'custom', displayName: 'Custom', requiresCustomUpstream: true };

const credentialOpenai: ProviderCredential = { id: 'cred-openai', label: 'Work key', provider: 'openai', authMode: 'api-key', status: 'ACTIVE', activeVersion: 1 };
const credentialAnthropic: ProviderCredential = { id: 'cred-anth', label: 'Anthropic key', provider: 'anthropic', authMode: 'api-key', status: 'ACTIVE', activeVersion: 1 };
const credentialCustom: ProviderCredential = { id: 'cred-custom', label: 'Custom key', provider: 'custom', authMode: 'api-key', status: 'ACTIVE', activeVersion: 1 };
const credentials = [credentialOpenai, credentialAnthropic, credentialCustom];

const revision = (patch: Partial<ProfileRevision> = {}): ProfileRevision => ({
  credentialId: 'cred-openai',
  model: 'gpt-4.1',
  apiMode: 'chat-completions',
  pricing: { inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 8_000_000 },
  priceProvenance: { source: 'saved' },
  limits: { maxInputTokens: 200_000, maxOutputTokens: 32_000, maxCostMicros: 5_000_000 },
  maxProxyOperations: ['files_list', 'files_read'],
  ...patch
});

const profile = (patch: Partial<ModelProfile> = {}): ModelProfile => ({
  id: 'gpt-main',
  displayName: 'GPT main',
  status: 'ACTIVE',
  generation: 7,
  credentialId: 'cred-openai',
  activeRevisionId: 'rev-2',
  activeRevision: revision(),
  lastVerification: { revisionId: 'rev-2', outcome: 'verified', checkedAt: 1_700_000_000_000 },
  ...patch
});

const catalogEntry = (patch: Partial<CatalogEntry> = {}): CatalogEntry => ({
  providerModelId: 'gpt-4.1-mini',
  displayName: 'GPT-4.1 mini',
  availability: 'listed_for_credential',
  pricing: {
    inputMicrosPerMillionTokens: 400_000,
    outputMicrosPerMillionTokens: 1_600_000,
    provenance: { source: 'provider', confidence: 'high', retrievedAt: 1_700_000_000_000 }
  },
  ...patch
});

/** A create draft with every required field filled in and valid. */
function draft(patch: Partial<WizardState> = {}): WizardState {
  return {
    ...initialWizardState({ mode: 'create', credentials }),
    displayName: 'GPT mini',
    profileId: 'gpt-mini',
    credentialId: 'cred-openai',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    pricingInput: '0.4',
    pricingOutput: '1.6',
    maxInputTokens: '1000',
    maxOutputTokens: '500',
    maxCost: '2',
    ...patch
  };
}

const verifiedResult = (patch: Partial<VerifyResult> = {}): VerifyResult => ({
  outcome: 'verified', checkedAt: 1, elapsedMs: 10, checks: [], verificationRef: 'vref_test_1', ...patch
});

describe('wizard constants', () => {
  it('has the five steps the wizard shows', () => {
    expect(WIZARD_STEPS).toEqual(['Provider', 'Connect', 'Model', 'Review', 'Verify and save']);
    expect(MODEL_ID_MAX).toBe(100);
  });
});

describe('operations and presets', () => {
  it('keeps only known operations, in the schema order, without duplicates', () => {
    expect(normalizeOperations(['files_move', 'bogus', 'files_list', 'files_list'])).toEqual(['files_list', 'files_move']);
    expect(normalizeOperations(null)).toEqual([]);
  });

  it('names a preset when the operations match it exactly, and custom otherwise', () => {
    expect(permissionPresetFor(PERMISSION_PRESETS.read.operations)).toBe('read');
    expect(permissionPresetFor([...PERMISSION_PRESETS.code.operations].reverse())).toBe('code');
    expect(permissionPresetFor(['files_list'])).toBe('custom');
  });

  it('lists what a save adds, removes and keeps, and calls out the mutating additions', () => {
    expect(permissionDiff(['files_list', 'files_read'], ['files_list', 'files_write', 'files_delete'])).toEqual({
      added: ['files_write', 'files_delete'],
      removed: ['files_read'],
      kept: ['files_list'],
      addedMutating: ['files_write', 'files_delete']
    });
  });
});

describe('deriveProfileSlug', () => {
  it('turns a model ID into a lower-case profile ID', () => {
    expect(deriveProfileSlug('openai/GPT-4.1 mini!')).toBe('openai-gpt-4.1-mini');
  });

  it('adds the first free numeric suffix on a case-insensitive collision', () => {
    expect(deriveProfileSlug('gpt-4.1', ['gpt-4.1'])).toBe('gpt-4.1-2');
    expect(deriveProfileSlug('gpt-4.1', ['GPT-4.1', 'gpt-4.1-2'])).toBe('gpt-4.1-3');
  });

  it('falls back to profile when nothing usable remains', () => {
    expect(deriveProfileSlug('!!!')).toBe('profile');
    expect(deriveProfileSlug('..--..')).toBe('profile');
  });

  it('caps the base at 72 characters before any suffix', () => {
    expect(deriveProfileSlug('m'.repeat(100))).toBe('m'.repeat(72));
  });
});

describe('providerApiModes and draftRouteKey', () => {
  it('offers the modes a provider declares, and both for a custom provider', () => {
    expect(providerApiModes(null)).toEqual([]);
    expect(providerApiModes(anthropic)).toEqual(['chat-completions']);
    expect(providerApiModes(openai)).toEqual(['chat-completions', 'responses']);
    expect(providerApiModes(custom)).toEqual(['chat-completions', 'responses']);
  });

  it('ignores surrounding space in the model and upstream when keying a route', () => {
    expect(draftRouteKey({ credentialId: 'c', model: ' m ', apiMode: 'responses', customUpstreamUrl: ' https://x.example.test ' }))
      .toBe(draftRouteKey({ credentialId: 'c', model: 'm', apiMode: 'responses', customUpstreamUrl: 'https://x.example.test' }));
    expect(draftRouteKey({ credentialId: 'c', model: 'm', apiMode: 'responses' })).toBe('["c","m","responses",""]');
  });

  it('changes the key when the model changes', () => {
    expect(draftRouteKey({ credentialId: 'c', model: 'a' })).not.toBe(draftRouteKey({ credentialId: 'c', model: 'b' }));
  });
});

describe('effectiveUpstream', () => {
  it('is empty for a provider without a custom upstream', () => {
    expect(effectiveUpstream(draft(), openai)).toBe('');
  });

  it('uses the typed upstream for a custom provider', () => {
    expect(effectiveUpstream(draft({ customUpstreamUrl: 'https://llm.example.test/v1' }), custom)).toBe('https://llm.example.test/v1');
  });

  it('keeps the saved upstream of an edit while the key and API mode are unchanged', () => {
    const saved = profile({ activeRevision: revision({ credentialId: 'cred-custom', upstreamUrl: 'https://saved.example.test/v1' }) });
    const edit = initialWizardState({ mode: 'edit', profile: saved, credentials });
    expect(effectiveUpstream(edit, custom)).toBe('https://saved.example.test/v1');
    expect(effectiveUpstream({ ...edit, apiMode: 'responses' }, custom)).toBe('');
  });
});

describe('initialWizardState', () => {
  it('starts a create draft read-only and empty, with the taken IDs from the live profiles', () => {
    const state = initialWizardState({ mode: 'create', profiles: [profile()], credentials });
    expect(state).toMatchObject({ mode: 'create', step: 0, profile: null, takenIds: ['gpt-main'], provider: '', displayName: '', profileId: '', maxCost: '5', maxInputTokens: '200000', maxOutputTokens: '32000' });
    expect(state.operations).toEqual(PERMISSION_PRESETS.read.operations);
    expect(state.savedRoute).toBeNull();
    expect(state.touched).toEqual([]);
  });

  it('opens an edit at the review step, keeps the profile ID, and records the saved route', () => {
    const state = initialWizardState({ mode: 'edit', profile: profile(), profiles: [profile()], credentials });
    expect(state.step).toBe(3);
    expect(state.profile?.generation).toBe(7);
    expect(state.profileId).toBe('gpt-main');
    expect(state.displayName).toBe('GPT main');
    expect(state.provider).toBe('openai');
    expect(state.credentialId).toBe('cred-openai');
    expect(state.model).toBe('gpt-4.1');
    expect(state.pricingInput).toBe('2.00');
    expect(state.pricingOutput).toBe('8.00');
    expect(state.maxCost).toBe('5.00');
    expect(state.touched).toEqual(['displayName', 'profileId']);
    expect(state.pricingProvenance).toEqual({ source: 'saved' });
    expect(state.operations).toEqual(['files_list', 'files_read']);
    expect(state.baseOperations).toEqual(['files_list', 'files_read']);
    expect(state.savedRoute).toEqual({
      key: draftRouteKey({ credentialId: 'cred-openai', model: 'gpt-4.1', apiMode: 'chat-completions', customUpstreamUrl: '' }),
      outcome: 'verified'
    });
  });

  it('records a saved route as not verified when the last check was for an earlier revision', () => {
    const stale = profile({ lastVerification: { revisionId: 'rev-1', outcome: 'verified', checkedAt: 1 } });
    expect(initialWizardState({ mode: 'edit', profile: stale, credentials }).savedRoute?.outcome).toBe('not_tested');
  });

  it('duplicates under a fresh unique ID and a copy name, with no profile snapshot and no saved route', () => {
    const state = initialWizardState({ mode: 'duplicate', profile: profile(), profiles: [profile(), profile({ id: 'gpt-main-copy' })], credentials });
    expect(state.step).toBe(3);
    expect(state.profile).toBeNull();
    expect(state.profileId).toBe('gpt-main-copy-2');
    expect(state.displayName).toBe('GPT main (copy)');
    expect(state.baseOperations).toEqual([]);
    expect(state.savedRoute).toBeNull();
    expect(state.touched).toEqual(['displayName', 'profileId']);
  });

  it('gives a duplicate the plain copy ID when nothing is taken', () => {
    expect(initialWizardState({ mode: 'duplicate', profile: profile(), profiles: [profile()], credentials }).profileId).toBe('gpt-main-copy');
  });

  it('carries a custom upstream into a duplicate of a custom profile', () => {
    const customProfile = profile({ credentialId: 'cred-custom', activeRevision: revision({ credentialId: 'cred-custom', upstreamUrl: 'https://saved.example.test/v1' }) });
    expect(initialWizardState({ mode: 'duplicate', profile: customProfile, credentials }).customUpstreamUrl).toBe('https://saved.example.test/v1');
    expect(initialWizardState({ mode: 'edit', profile: customProfile, credentials }).customUpstreamUrl).toBe('');
  });
});

describe('selectProvider', () => {
  it('resets the model and picks the active saved credential for the new provider', () => {
    const state = { ...draft(), selectedEntry: catalogEntry(), query: 'gpt-4.1-mini' };
    const next = selectProvider(state, 'anthropic', anthropic, credentials);
    expect(next).toMatchObject({ provider: 'anthropic', credentialId: 'cred-anth', credentialChoice: 'saved', model: '', query: '', selectedEntry: null });
    expect(next.apiMode).toBe('chat-completions');
  });

  it('keeps a typed price and clears an untouched one', () => {
    const state = { ...draft(), touched: ['pricingInput'], pricingInput: '3.00', pricingOutput: '9.00' };
    const next = selectProvider(state, 'anthropic', anthropic, credentials);
    expect(next.pricingInput).toBe('3.00');
    expect(next.pricingOutput).toBe('');
  });

  it('falls back to a new credential when the provider has no active one', () => {
    const next = selectProvider(draft(), 'groq', { id: 'groq', displayName: 'Groq', endpoints: { 'chat-completions': {} } }, credentials);
    expect(next).toMatchObject({ credentialId: '', credentialChoice: 'new' });
  });

  it('returns the same state when the provider does not change', () => {
    const state = draft();
    expect(selectProvider(state, 'openai', openai, credentials)).toBe(state);
  });
});

describe('applyCatalogEntry', () => {
  it('fills the untouched fields from the catalog entry', () => {
    const next = applyCatalogEntry(initialWizardState({ mode: 'create', credentials }), catalogEntry());
    expect(next).toMatchObject({ model: 'gpt-4.1-mini', query: 'gpt-4.1-mini', displayName: 'GPT-4.1 mini', profileId: 'gpt-4.1-mini', pricingInput: '0.40', pricingOutput: '1.60' });
    expect(next.selectedEntry?.providerModelId).toBe('gpt-4.1-mini');
  });

  it('never overwrites a field the operator touched', () => {
    const state = {
      ...initialWizardState({ mode: 'create', credentials }),
      touched: ['displayName', 'profileId', 'pricingInput', 'pricingOutput'],
      displayName: 'My label',
      profileId: 'my-id',
      pricingInput: '9.99',
      pricingOutput: '8.88'
    };
    const next = applyCatalogEntry(state, catalogEntry());
    expect(next).toMatchObject({ displayName: 'My label', profileId: 'my-id', pricingInput: '9.99', pricingOutput: '8.88', model: 'gpt-4.1-mini' });
    expect(next.pricingProvenance).toEqual(state.pricingProvenance);
  });

  it('keeps the saved profile ID of an edit', () => {
    const edit = initialWizardState({ mode: 'edit', profile: profile(), profiles: [profile()], credentials });
    expect(applyCatalogEntry({ ...edit, touched: [] }, catalogEntry()).profileId).toBe('gpt-main');
  });

  it('leaves an unknown price empty rather than zero', () => {
    const next = applyCatalogEntry(initialWizardState({ mode: 'create', credentials }), catalogEntry({ pricing: null }));
    expect(next.pricingInput).toBe('');
    expect(next.pricingOutput).toBe('');
    expect(next.pricingProvenance).toBeNull();
  });

  it('derives a profile ID that does not collide with a taken one', () => {
    const state = { ...initialWizardState({ mode: 'create', profiles: [profile({ id: 'gpt-4.1-mini' })], credentials }) };
    expect(applyCatalogEntry(state, catalogEntry()).profileId).toBe('gpt-4.1-mini-2');
  });
});

describe('applyCustomModel and resetUntouchedPricing', () => {
  it('resets untouched pricing and keeps a typed price', () => {
    const state = { ...draft(), touched: ['pricingInput'], pricingInput: '3.00', pricingOutput: '1.6', selectedEntry: catalogEntry() };
    const next = applyCustomModel(state, 'my-custom-model');
    expect(next).toMatchObject({ model: 'my-custom-model', query: 'my-custom-model', selectedEntry: null, pricingInput: '3.00', pricingOutput: '' });
  });

  it('returns the same state when the model ID is unchanged', () => {
    const state = draft();
    expect(applyCustomModel(state, 'gpt-4.1-mini')).toBe(state);
  });

  it('trims and caps the typed model ID at 100 characters', () => {
    expect(applyCustomModel(draft(), `  ${'z'.repeat(150)}  `).model).toBe('z'.repeat(MODEL_ID_MAX));
  });

  it('names an untouched display name after the model and derives an untaken profile ID', () => {
    const next = applyCustomModel(initialWizardState({ mode: 'create', profiles: [profile({ id: 'my-model' })], credentials }), 'my-model');
    expect(next.displayName).toBe('my-model');
    expect(next.profileId).toBe('my-model-2');
  });

  it('clears every untouched price without touching typed ones', () => {
    const next = resetUntouchedPricing({ ...draft(), touched: ['pricingOutput'], pricingInput: '1.00', pricingOutput: '2.00' });
    expect(next).toMatchObject({ pricingInput: '', pricingOutput: '2.00' });
  });
});

describe('setField and catalogOptions', () => {
  it('records a typed field once and marks a typed price as the operator\'s own', () => {
    const once = setField(draft(), 'pricingInput', '1.25');
    const twice = setField(once, 'pricingInput', '1.30');
    expect(twice.touched.filter((field) => field === 'pricingInput')).toHaveLength(1);
    expect(twice.pricingProvenance).toEqual({ source: 'user' });
    expect(twice.pricingInput).toBe('1.30');
  });

  it('offers the catalog entries, then the typed text as a custom ID when no entry matches it exactly', () => {
    const entries = [catalogEntry()];
    expect(catalogOptions(entries, 'gpt-4.1-mini')).toEqual([{ kind: 'entry', entry: entries[0] }]);
    expect(catalogOptions(entries, 'gpt-5-preview')).toEqual([{ kind: 'entry', entry: entries[0] }, { kind: 'custom', value: 'gpt-5-preview' }]);
    expect(catalogOptions(null, '')).toEqual([]);
    expect(catalogOptions(null, 'x'.repeat(MODEL_ID_MAX + 1))).toEqual([]);
  });
});

describe('profilePricing and pricingSaveKind', () => {
  const openrouterEntry = catalogEntry({
    pricing: {
      inputMicrosPerMillionTokens: 400_000,
      outputMicrosPerMillionTokens: 1_600_000,
      cacheReadMicrosPerMillionTokens: null,
      provenance: { source: 'openrouter', sourceModelId: 'openai/gpt-4.1-mini', confidence: 'high' }
    }
  });

  it('sends an unedited catalog price whole with a reference to its catalog model', () => {
    const state = { ...draft(), selectedEntry: openrouterEntry };
    expect(profilePricing(state, 400_000, 1_600_000)).toEqual({
      pricing: { inputMicrosPerMillionTokens: 400_000, outputMicrosPerMillionTokens: 1_600_000, cacheReadMicrosPerMillionTokens: null, cacheWriteMicrosPerMillionTokens: null, tiers: [] },
      catalogPriceRef: { sourceModelId: 'openai/gpt-4.1-mini' }
    });
    expect(pricingSaveKind(state)).toBe('catalog');
  });

  it('sends an edited catalog price as typed, with no reference', () => {
    const state = { ...draft({ selectedEntry: openrouterEntry }), touched: ['pricingInput'] };
    expect(profilePricing(state, 500_000, 1_600_000)).toEqual({ pricing: { inputMicrosPerMillionTokens: 500_000, outputMicrosPerMillionTokens: 1_600_000 } });
    expect(pricingSaveKind(state)).toBe('override');
  });

  it('records an edit that keeps the saved price as kept', () => {
    const edit = initialWizardState({ mode: 'edit', profile: profile(), profiles: [profile()], credentials });
    expect(pricingSaveKind(edit)).toBe('kept');
    expect(pricingSaveKind({ ...edit, pricingInput: '3.00' })).toBe('override');
  });

  it('has no save kind while a price is not a valid amount', () => {
    expect(pricingSaveKind(draft({ pricingInput: 'abc' }))).toBeNull();
  });
});

describe('wizardSaveGate', () => {
  it('lets a save through once the connection is verified for the current route', () => {
    const state = draft();
    const routeKey = wizardSaveGate(state, openai).routeKey;
    const gate = wizardSaveGate({ ...state, verification: { key: routeKey, result: verifiedResult() } }, openai);
    expect(gate).toMatchObject({ verified: true, allowed: true, reasons: [], fields: [] });
  });

  it('accepts a route verified by the saved profile', () => {
    const edit = initialWizardState({ mode: 'edit', profile: profile(), profiles: [profile()], credentials });
    expect(wizardSaveGate(edit, openai).allowed).toBe(true);
  });

  it('blocks an unverified save and offers the unverified choice', () => {
    const gate = wizardSaveGate(draft(), openai);
    expect(gate.allowed).toBe(false);
    expect(gate.fields).toEqual(['saveUnverified']);
    expect(gate.reasons).toEqual(['Verify the connection, or choose to save it unverified.']);
  });

  it('explains public-metadata models separately', () => {
    const gate = wizardSaveGate(draft({ selectedEntry: catalogEntry({ availability: 'public_catalog' }) }), openai);
    expect(gate.reasons[0]).toMatch(/^This model ID comes from public metadata only/);
  });

  it('accepts the unverified choice only for the exact route it was given for', () => {
    const state = draft();
    const routeKey = wizardSaveGate(state, openai).routeKey;
    expect(wizardSaveGate({ ...state, saveUnverifiedKey: routeKey }, openai).allowed).toBe(true);
    const changed = wizardSaveGate({ ...state, saveUnverifiedKey: routeKey, model: 'gpt-4.1' }, openai);
    expect(changed.allowed).toBe(false);
    expect(changed.fields).toEqual(['saveUnverified']);
  });

  it('does not treat a check of another route as verifying this one', () => {
    const state = draft({ verification: { key: 'other-route', result: verifiedResult() } });
    expect(wizardSaveGate(state, openai).verified).toBe(false);
  });

  it('asks for a mutating acknowledgement when a save adds a workspace-changing operation', () => {
    const state = draft({ operations: [...PERMISSION_PRESETS.code.operations], verification: null });
    const routeKey = wizardSaveGate(state, openai).routeKey;
    const verified = { ...state, verification: { key: routeKey, result: verifiedResult() } };
    const gate = wizardSaveGate(verified, openai);
    expect(gate.allowed).toBe(false);
    expect(gate.fields).toEqual(['acknowledgeMutating']);
    expect(gate.reasons[0]).toContain('files_write');
    expect(gate.diff.addedMutating).toEqual(['files_write', 'files_apply_patch', 'files_move', 'files_mkdir']);
  });

  it('accepts the mutating acknowledgement for the exact operation set, and requires it again after a change', () => {
    const state = draft({ operations: [...PERMISSION_PRESETS.code.operations] });
    const routeKey = wizardSaveGate(state, openai).routeKey;
    const operationsKey = wizardSaveGate(state, openai).operationsKey;
    const base = { ...state, verification: { key: routeKey, result: verifiedResult() } };
    expect(wizardSaveGate({ ...base, mutatingAckKey: operationsKey }, openai).allowed).toBe(true);
    const more = { ...base, mutatingAckKey: operationsKey, operations: [...PERMISSION_PRESETS.code.operations, 'files_delete'] };
    expect(wizardSaveGate(more, openai).fields).toEqual(['acknowledgeMutating']);
  });

  it('needs no acknowledgement for mutating operations the saved profile already allowed', () => {
    const edit = initialWizardState({ mode: 'edit', profile: profile({ activeRevision: revision({ maxProxyOperations: ['files_write'] }) }), profiles: [profile()], credentials });
    expect(wizardSaveGate({ ...edit, operations: ['files_write'] }, openai).diff.addedMutating).toEqual([]);
  });
});

describe('buildProfileRequest', () => {
  it('builds a create body with the profile ID and the exact fields the API takes', () => {
    const { errors, request } = buildProfileRequest(draft({ selectedEntry: null }), openai);
    expect(errors).toEqual({});
    expect(request).toEqual({
      kind: 'create',
      body: {
        profileId: 'gpt-mini',
        displayName: 'GPT mini',
        credentialId: 'cred-openai',
        model: 'gpt-4.1-mini',
        apiMode: 'chat-completions',
        pricing: { inputMicrosPerMillionTokens: 400_000, outputMicrosPerMillionTokens: 1_600_000 },
        limits: { maxInputTokens: 1000, maxOutputTokens: 500, maxCostMicros: 2_000_000 },
        maxProxyOperations: ['files_list', 'files_read', 'grep_search', 'symbols_search', 'symbols_references']
      }
    });
  });

  it('builds an update body from the profile generation and leaves the profile ID out', () => {
    const edit = initialWizardState({ mode: 'edit', profile: profile(), profiles: [profile()], credentials });
    const { errors, request } = buildProfileRequest(edit, openai);
    expect(errors).toEqual({});
    expect(request?.kind).toBe('update');
    expect(request?.kind === 'update' ? request.profileId : undefined).toBe('gpt-main');
    expect(request?.body).toMatchObject({ expectedGeneration: 7, model: 'gpt-4.1', displayName: 'GPT main' });
    expect(request?.body).not.toHaveProperty('profileId');
  });

  it('keys each validation error to the field that caused it and returns no request', () => {
    const { errors, request } = buildProfileRequest(draft({
      displayName: '  ', credentialId: '', model: '', maxInputTokens: '0', maxOutputTokens: 'abc', maxCost: '0', operations: []
    }), openai);
    expect(request).toBeUndefined();
    expect(Object.keys(errors).sort()).toEqual(['credentialId', 'customModel', 'displayName', 'maxCost', 'maxInputTokens', 'maxOutputTokens', 'operations']);
    expect(errors.displayName).toBe('Enter a display name.');
    expect(errors.customModel).toBe('Choose a model or enter its ID.');
  });

  it('checks a create profile ID, including a case-insensitive clash with a taken one', () => {
    expect(buildProfileRequest(draft({ profileId: 'bad id!' }), openai).errors.profileId).toMatch(/Use 1 to 80/);
    const clash = buildProfileRequest(draft({ profileId: 'GPT-MINI', takenIds: ['gpt-mini'] }), openai);
    expect(clash.errors.profileId).toBe('A profile named GPT-MINI already exists.');
  });

  it('refuses a price that is not an amount, and asks for one when it is empty', () => {
    expect(buildProfileRequest(draft({ pricingInput: 'abc' }), openai).errors.pricingInput).toBe('Enter a dollar amount with at most six decimals.');
    expect(buildProfileRequest(draft({ pricingOutput: '' }), openai).errors.pricingOutput).toMatch(/enter 0 only if the model is free/);
  });

  it('refuses an API mode the provider does not offer', () => {
    expect(buildProfileRequest(draft({ apiMode: 'responses' }), anthropic).errors.apiMode).toBe('Choose an API mode this provider offers.');
  });

  it('requires an https upstream for a custom provider and sends the typed one', () => {
    expect(buildProfileRequest(draft({ provider: 'custom', credentialId: 'cred-custom' }), custom).errors.customUpstreamUrl).toBe('Enter the HTTPS URL of your provider endpoint.');
    expect(buildProfileRequest(draft({ provider: 'custom', credentialId: 'cred-custom', customUpstreamUrl: 'http://llm.example.test' }), custom).errors.customUpstreamUrl).toBe('Use an https:// URL.');
    const ok = buildProfileRequest(draft({ provider: 'custom', credentialId: 'cred-custom', customUpstreamUrl: 'https://llm.example.test/v1' }), custom);
    expect(ok.request?.body).toMatchObject({ customUpstreamUrl: 'https://llm.example.test/v1' });
  });

  it('rejects a model ID over the length limit', () => {
    expect(buildProfileRequest(draft({ model: 'm'.repeat(MODEL_ID_MAX + 1) }), openai).errors.customModel).toBe('Model IDs are at most 100 characters.');
  });

  it('adds the catalog price reference only when the entry price is saved unedited', () => {
    const entry = catalogEntry({ pricing: { inputMicrosPerMillionTokens: 400_000, outputMicrosPerMillionTokens: 1_600_000, provenance: { source: 'openrouter', sourceModelId: 'openai/gpt-4.1-mini' } } });
    const { request } = buildProfileRequest(draft({ selectedEntry: entry }), openai);
    expect(request?.body).toHaveProperty('catalogPriceRef', { sourceModelId: 'openai/gpt-4.1-mini' });
  });
});

describe('verification input and reference', () => {
  it('builds the verification input without any key field', () => {
    const state = { ...draft(), apiKey: FAKE_KEY } as WizardState;
    const input = draftVerificationInput(state, openai, { tools: true });
    expect(input).toEqual({ credentialId: 'cred-openai', model: 'gpt-4.1-mini', apiMode: 'chat-completions', checks: { tools: true } });
    expect(JSON.stringify(input)).not.toContain(FAKE_KEY);
  });

  it('adds the upstream to the verification input only when there is one', () => {
    const input = draftVerificationInput(draft({ provider: 'custom', credentialId: 'cred-custom', customUpstreamUrl: 'https://llm.example.test/v1' }), custom);
    expect(input).toEqual({ credentialId: 'cred-custom', model: 'gpt-4.1-mini', apiMode: 'chat-completions', customUpstreamUrl: 'https://llm.example.test/v1' });
  });

  it('returns a verification reference only for the route it checked', () => {
    const state = draft({ verification: { key: 'route-a', result: verifiedResult({ verificationRef: 'vref_route_a' }) } });
    expect(draftVerificationRef(state, 'route-a')).toBe('vref_route_a');
    expect(draftVerificationRef(state, 'route-b')).toBeUndefined();
    expect(draftVerificationRef(draft(), 'route-a')).toBeUndefined();
  });
});

describe('storedWizard', () => {
  it('stores the step and choices, but never the saved profile or the taken IDs', () => {
    const edit = initialWizardState({ mode: 'edit', profile: profile(), profiles: [profile()], credentials });
    const stored = storedWizard(edit, 'gpt-main');
    expect(stored.open).toBe(true);
    expect(stored.sourceProfileId).toBe('gpt-main');
    expect(stored.state).not.toHaveProperty('profile');
    expect(stored.state).not.toHaveProperty('takenIds');
    const json = JSON.stringify(stored);
    expect(json).not.toContain('"profile":');
    expect(json).not.toContain('"takenIds"');
  });

  it('round-trips through parseStoredWizard', () => {
    const state = draft({ step: 2, touched: ['displayName'], maxCost: '3.50' });
    const restored = parseStoredWizard(JSON.parse(JSON.stringify(storedWizard(state, null))));
    expect(restored?.state).toMatchObject({ step: 2, provider: 'openai', displayName: 'GPT mini', maxCost: '3.50', touched: ['displayName'] });
    expect(restored?.mode).toBe('create');
  });
});

describe('storableUpstreamUrl', () => {
  it('keeps a plain endpoint URL', () => {
    expect(storableUpstreamUrl('  https://llm.example.test/v1  ')).toBe('https://llm.example.test/v1');
    expect(storableUpstreamUrl('')).toBe('');
  });

  it.each([
    'https://user:pass@llm.example.test/v1',
    'https://token@llm.example.test/v1',
    'https://llm.example.test/v1?api_key=not-real',
    'https://llm.example.test/v1?',
    'https://llm.example.test/v1#token',
    'not a url'
  ])('drops %s', (value) => {
    expect(storableUpstreamUrl(value)).toBe('');
  });
});

describe('parseStoredWizard', () => {
  const stored = (state: Record<string, unknown>, patch: Record<string, unknown> = {}) => ({ open: true, mode: 'create', sourceProfileId: null, state, ...patch });

  it('never stores or restores a custom upstream URL with user info, a query or a fragment', () => {
    const state = draft({ customUpstreamUrl: 'https://user:pass@llm.example.test/v1?key=not-real' });
    expect(JSON.stringify(storedWizard(state, null))).not.toContain('llm.example.test');
    expect(parseStoredWizard(stored({ customUpstreamUrl: 'https://llm.example.test/v1#t' }))?.state.customUpstreamUrl).toBe('');
    expect(parseStoredWizard(stored({ customUpstreamUrl: 'https://llm.example.test/v1' }))?.state.customUpstreamUrl).toBe('https://llm.example.test/v1');
  });

  it('refuses anything that is not an open wizard entry of a known mode', () => {
    expect(parseStoredWizard(null)).toBeUndefined();
    expect(parseStoredWizard('wizard')).toBeUndefined();
    expect(parseStoredWizard(stored({ step: 1 }, { open: false }))).toBeUndefined();
    expect(parseStoredWizard(stored({ step: 1 }, { mode: 'admin' }))).toBeUndefined();
    expect(parseStoredWizard({ open: true, mode: 'create' })).toBeUndefined();
    expect(parseStoredWizard(stored(null as unknown as Record<string, unknown>))).toBeUndefined();
  });

  it('keeps the known non-secret fields and their types', () => {
    const restored = parseStoredWizard(stored({ step: 2, provider: 'openai', displayName: 'GPT mini', maxCost: '3', operations: ['files_list', 'bogus'], touched: ['displayName', 7], checkTools: true, credentialChoice: 'new', apiMode: 'responses' }));
    expect(restored?.state).toMatchObject({ step: 2, provider: 'openai', displayName: 'GPT mini', maxCost: '3', operations: ['files_list'], touched: ['displayName'], checkTools: true, credentialChoice: 'new', apiMode: 'responses' });
  });

  it('resets an out-of-range or non-integer step to the first step', () => {
    expect(parseStoredWizard(stored({ step: 99 }))?.state.step).toBe(0);
    expect(parseStoredWizard(stored({ step: -1 }))?.state.step).toBe(0);
    expect(parseStoredWizard(stored({ step: 2.5 }))?.state.step).toBe(0);
    expect(parseStoredWizard(stored({ step: 'soon' }))?.state.step).toBe(0);
  });

  it('defaults a missing or unknown choice to the safe value', () => {
    const restored = parseStoredWizard(stored({ credentialChoice: 'admin', apiMode: 'legacy' }));
    expect(restored?.state.credentialChoice).toBe('saved');
    expect(restored?.state.apiMode).toBe('chat-completions');
  });

  it('drops an injected apiKey, secret or unknown field at the top level', () => {
    const restored = parseStoredWizard({ ...stored({ step: 1, provider: 'openai' }), apiKey: FAKE_KEY, secret: FAKE_KEY });
    expect(restored).not.toHaveProperty('apiKey');
    expect(restored).not.toHaveProperty('secret');
    expect(JSON.stringify(restored)).not.toContain(FAKE_KEY);
  });

  it('drops an injected apiKey, secret or unknown field inside state', () => {
    const restored = parseStoredWizard(stored({ step: 1, provider: 'openai', apiKey: FAKE_KEY, secret: FAKE_KEY, unknownField: 'x', profile: { id: 'injected' }, takenIds: ['injected'] }));
    expect(restored?.state).not.toHaveProperty('apiKey');
    expect(restored?.state).not.toHaveProperty('secret');
    expect(restored?.state).not.toHaveProperty('unknownField');
    expect(restored?.state).not.toHaveProperty('profile');
    expect(restored?.state).not.toHaveProperty('takenIds');
    expect(JSON.stringify(restored)).not.toContain(FAKE_KEY);
  });

  it('does not restore a string field whose value is not a string', () => {
    const restored = parseStoredWizard(stored({ provider: { id: 'openai' }, displayName: 42 }));
    expect(restored?.state.provider).toBe('');
    expect(restored?.state.displayName).toBe('');
  });

  it('drops an injected secret nested inside a restored catalog entry, provenance or saved route', () => {
    const restored = parseStoredWizard(stored({
      selectedEntry: { providerModelId: 'gpt-4.1-mini', apiKey: FAKE_KEY },
      pricingProvenance: { source: 'provider', apiKey: FAKE_KEY },
      savedRoute: { key: 'route', outcome: 'verified', apiKey: FAKE_KEY },
      verification: { key: 'route', result: { outcome: 'verified', apiKey: FAKE_KEY } }
    }));
    expect(JSON.stringify(restored)).not.toContain(FAKE_KEY);
  });

  it('restores a saved route and a verification only when they carry the expected keys', () => {
    const restored = parseStoredWizard(stored({ savedRoute: { key: 'route', outcome: 'verified' }, verification: { key: 'route', result: verifiedResult() } }));
    expect(restored?.state.savedRoute).toEqual({ key: 'route', outcome: 'verified' });
    expect(restored?.state.verification?.key).toBe('route');
    const malformed = parseStoredWizard(stored({ savedRoute: { key: 1 }, verification: { key: 'route' } }));
    expect(malformed?.state.savedRoute).toBeNull();
    expect(malformed?.state.verification).toBeNull();
  });

  it('keeps a selected catalog entry only when it has a model ID', () => {
    expect(parseStoredWizard(stored({ selectedEntry: { providerModelId: 7 } }))?.state.selectedEntry).toBeNull();
    expect(parseStoredWizard(stored({ selectedEntry: catalogEntry() }))?.state.selectedEntry?.providerModelId).toBe('gpt-4.1-mini');
  });

  it('keeps the mutating acknowledgement and the unverified choice as strings', () => {
    const restored = parseStoredWizard(stored({ saveUnverifiedKey: 'route', mutatingAckKey: 9 }));
    expect(restored?.state.saveUnverifiedKey).toBe('route');
    expect(restored?.state.mutatingAckKey).toBeNull();
  });

  it('keeps the source profile ID only when it is a string', () => {
    expect(parseStoredWizard({ ...stored({ step: 0 }), mode: 'edit', sourceProfileId: 'gpt-main' })?.sourceProfileId).toBe('gpt-main');
    expect(parseStoredWizard({ ...stored({ step: 0 }), sourceProfileId: 3 })?.sourceProfileId).toBeNull();
  });
});
