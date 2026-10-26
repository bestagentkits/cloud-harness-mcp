import { dollarsFromMicros, microsFromDollars, profileVerification } from './models-pricing';
import { restoreCatalogEntry, restoreProvenance, restoreVerifyResult } from './models-restore-shapes';
import type { ApiMode, CatalogEntry, ModelProfile, ModelProvider, PriceProvenance, ProviderCredential, VerifyResult } from './models-types';

/**
 * The profile wizard's rules, ported from the classic Dashboard's pure helpers: slugs,
 * money, permission presets, the save gate and the exact request bodies. Every function is
 * pure and returns a new state, so the React wizard only moves values between its fields
 * and one state object, and the rules are unit-tested without a browser.
 *
 * A provider key is never part of this state. The wizard keeps a typed key in its own
 * component state and clears it once stored, so this object is safe to restore from
 * `sessionStorage` (see `parseWizardState`).
 */

/** The ten safe proxy operations, in the order the profile schema lists them. */
export const PROXY_OPERATIONS = [
  'files_list', 'files_read', 'files_write', 'files_apply_patch', 'files_delete',
  'files_move', 'files_mkdir', 'grep_search', 'symbols_search', 'symbols_references'
] as const;

/** Operations that change the workspace. None is ever enabled without the operator choosing it. */
export const MUTATING_PROXY_OPERATIONS: readonly string[] = ['files_write', 'files_apply_patch', 'files_delete', 'files_move', 'files_mkdir'];

const READ_ONLY_OPERATIONS = ['files_list', 'files_read', 'grep_search', 'symbols_search', 'symbols_references'];

export const PERMISSION_PRESETS = {
  read: { label: 'Read only', description: 'List, read, and search files. The subagent cannot change the workspace.', operations: READ_ONLY_OPERATIONS },
  code: {
    label: 'Code editing',
    description: 'Read only, plus writing, patching, and moving files and creating folders. Deleting files stays off.',
    operations: [...READ_ONLY_OPERATIONS, 'files_write', 'files_apply_patch', 'files_move', 'files_mkdir']
  }
} as const;

export const WIZARD_STEPS = ['Provider', 'Connect', 'Model', 'Review', 'Verify and save'] as const;

/** Fields kept inside Advanced settings; a validation error there opens the section. */
export const ADVANCED_FIELDS: ReadonlySet<string> = new Set(['profileId', 'apiMode', 'customUpstreamUrl', 'customModel', 'pricingInput', 'pricingOutput', 'maxInputTokens', 'maxOutputTokens', 'maxCost']);

export const MODEL_ID_MAX = 100;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
const DEFAULT_LIMITS = { maxInputTokens: '200000', maxOutputTokens: '32000', maxCost: '5' };

export type WizardMode = 'create' | 'edit' | 'duplicate';

export type WizardState = {
  mode: WizardMode;
  step: number;
  /** The saved profile being edited (edit only); its generation is the update fence. */
  profile: ModelProfile | null;
  takenIds: string[];
  provider: string;
  credentialChoice: 'saved' | 'new';
  credentialId: string;
  newCredentialLabel: string;
  newCredentialAuthMode: string;
  query: string;
  model: string;
  selectedEntry: CatalogEntry | null;
  displayName: string;
  profileId: string;
  apiMode: ApiMode;
  customUpstreamUrl: string;
  pricingInput: string;
  pricingOutput: string;
  pricingProvenance: PriceProvenance | null;
  maxInputTokens: string;
  maxOutputTokens: string;
  maxCost: string;
  operations: string[];
  baseOperations: string[];
  /** Fields the operator typed (or that came from a saved profile), so a later choice never overwrites them. */
  touched: string[];
  verification: { key: string; result?: VerifyResult; error?: string } | null;
  savedRoute: { key: string; outcome: string } | null;
  saveUnverifiedKey: string | null;
  mutatingAckKey: string | null;
  checkTools: boolean;
};

export function normalizeOperations(operations: readonly string[] | null | undefined): string[] {
  const chosen = new Set(Array.isArray(operations) ? operations : []);
  return PROXY_OPERATIONS.filter((operation) => chosen.has(operation));
}

/**
 * Operations a saved profile allows that this wizard does not offer: the policy-gated coding
 * operations, granted only through the MCP profile tools. An edit keeps them rather than
 * silently dropping them; the runner validates the saved set either way. They are read from
 * the live saved profile, never from restored wizard state.
 */
export function retainedOperations(state: Pick<WizardState, 'mode' | 'profile'>): string[] {
  if (state.mode !== 'edit') return [];
  const offered = new Set<string>(PROXY_OPERATIONS);
  const saved = state.profile?.activeRevision?.maxProxyOperations;
  return [...new Set(Array.isArray(saved) ? saved : [])]
    .filter((operation) => typeof operation === 'string' && /^[a-z_]{1,40}$/.test(operation) && !offered.has(operation));
}

export function permissionPresetFor(operations: readonly string[]): 'read' | 'code' | 'custom' {
  const key = normalizeOperations(operations).join(',');
  for (const [id, preset] of Object.entries(PERMISSION_PRESETS)) if (normalizeOperations(preset.operations).join(',') === key) return id as 'read' | 'code';
  return 'custom';
}

/** What a save changes in the operation ceiling, with the mutating additions called out. */
export function permissionDiff(before: readonly string[], after: readonly string[]) {
  const previous = new Set(normalizeOperations(before));
  const next = new Set(normalizeOperations(after));
  const added = PROXY_OPERATIONS.filter((operation) => next.has(operation) && !previous.has(operation));
  return {
    added: added as string[],
    removed: PROXY_OPERATIONS.filter((operation) => previous.has(operation) && !next.has(operation)) as string[],
    kept: PROXY_OPERATIONS.filter((operation) => previous.has(operation) && next.has(operation)) as string[],
    addedMutating: added.filter((operation) => MUTATING_PROXY_OPERATIONS.includes(operation)) as string[]
  };
}

/** A profile ID derived from a model ID; a case-insensitive collision gets the first free numeric suffix. */
export function deriveProfileSlug(model: string, takenIds: readonly string[] = []): string {
  const taken = new Set([...takenIds].map((id) => String(id).toLowerCase()));
  const trim = (value: string) => value.replace(/^[-._]+|[-._]+$/g, '');
  const base = trim(trim(String(model ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-')).slice(0, 72)) || 'profile';
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** API modes a provider offers. A custom provider accepts either. */
export function providerApiModes(provider: ModelProvider | null | undefined): ApiMode[] {
  if (!provider) return [];
  if (provider.requiresCustomUpstream) return ['chat-completions', 'responses'];
  return (['chat-completions', 'responses'] as const).filter((mode) => provider.endpoints?.[mode]);
}

/** The provider settings a connection depends on; a verification applies only while this is unchanged. */
export function draftRouteKey({ credentialId, model, apiMode, customUpstreamUrl }: { credentialId?: string | null; model?: string | null; apiMode?: string | null; customUpstreamUrl?: string | null }): string {
  return JSON.stringify([credentialId ?? '', String(model ?? '').trim(), apiMode ?? '', String(customUpstreamUrl ?? '').trim()]);
}

/** The custom upstream a draft uses. An edit keeps the saved URL while the key and API mode are unchanged. */
export function effectiveUpstream(state: WizardState, provider: ModelProvider | null | undefined): string {
  if (!provider?.requiresCustomUpstream) return '';
  const typed = state.customUpstreamUrl.trim();
  if (typed) return typed;
  const revision = state.profile?.activeRevision;
  if (state.mode === 'edit' && revision && revision.credentialId === state.credentialId && revision.apiMode === state.apiMode) return revision.upstreamUrl ?? '';
  return '';
}

/**
 * Pricing for a save. A catalog price accepted unedited is sent whole with a reference to
 * its catalog model (unknown cache prices as null, flat pricing as no tiers), so the save
 * replaces every saved price. A typed price is sent as typed, with no reference.
 */
export function profilePricing(state: WizardState, inputMicros: number | null, outputMicros: number | null) {
  const typed = { inputMicrosPerMillionTokens: inputMicros, outputMicrosPerMillionTokens: outputMicros };
  const price = state.selectedEntry?.pricing;
  const sourceModelId = price?.provenance?.source === 'openrouter' ? price.provenance.sourceModelId : null;
  const edited = state.touched.includes('pricingInput') || state.touched.includes('pricingOutput');
  if (!price || !sourceModelId || edited || price.inputMicrosPerMillionTokens !== inputMicros || price.outputMicrosPerMillionTokens !== outputMicros) {
    return { pricing: typed };
  }
  const known = (micros: number | null | undefined) => (Number.isSafeInteger(micros) ? micros as number : null);
  return {
    pricing: {
      ...typed,
      cacheReadMicrosPerMillionTokens: known(price.cacheReadMicrosPerMillionTokens),
      cacheWriteMicrosPerMillionTokens: known(price.cacheWriteMicrosPerMillionTokens),
      tiers: Array.isArray(price.tiers) ? price.tiers : []
    },
    catalogPriceRef: { sourceModelId }
  };
}

export type PriceSaveKind = 'catalog' | 'kept' | 'override';

/** How a save will record its prices, or null while a price is not a valid amount yet. */
export function pricingSaveKind(state: WizardState): PriceSaveKind | null {
  const input = microsFromDollars(state.pricingInput);
  const output = microsFromDollars(state.pricingOutput);
  if (input === null || output === null) return null;
  if ('catalogPriceRef' in profilePricing(state, input, output)) return 'catalog';
  const revision = state.mode === 'edit' ? state.profile?.activeRevision : null;
  if (revision && revision.pricing.inputMicrosPerMillionTokens === input && revision.pricing.outputMicrosPerMillionTokens === output
    && revision.model === state.model.trim() && revision.credentialId === state.credentialId) return 'kept';
  return 'override';
}

/** Whether the wizard may save; `fields[i]` names the gate checkbox that lifts `reasons[i]`. */
export function wizardSaveGate(state: WizardState, provider: ModelProvider | null | undefined) {
  const routeKey = draftRouteKey({ ...state, customUpstreamUrl: effectiveUpstream(state, provider) });
  const verified = (state.verification?.key === routeKey && state.verification.result?.outcome === 'verified')
    || (state.savedRoute?.key === routeKey && state.savedRoute.outcome === 'verified');
  const diff = permissionDiff(state.baseOperations, state.operations);
  const reasons: string[] = [];
  const fields: Array<'saveUnverified' | 'acknowledgeMutating'> = [];
  if (!verified && state.saveUnverifiedKey !== routeKey) {
    reasons.push(state.selectedEntry?.availability === 'public_catalog'
      ? 'This model ID comes from public metadata only, so nothing has confirmed your key can call it. Verify the connection, or choose to save it unverified.'
      : 'Verify the connection, or choose to save it unverified.');
    fields.push('saveUnverified');
  }
  const operationsKey = normalizeOperations(state.operations).join(',');
  if (diff.addedMutating.length && state.mutatingAckKey !== operationsKey) {
    reasons.push(`Confirm that the subagent may change files (${diff.addedMutating.join(', ')}).`);
    fields.push('acknowledgeMutating');
  }
  return { routeKey, operationsKey, verified, allowed: reasons.length === 0, reasons, fields, diff };
}

const positiveInteger = (text: string) => (/^\d{1,15}$/.test(text.trim()) && Number(text) > 0 ? Number(text) : null);

export type ProfileRequest =
  | { kind: 'create'; body: Record<string, unknown> }
  | { kind: 'update'; profileId: string; body: Record<string, unknown> };

/** Validates the draft and builds the create or update request; errors are keyed by field. */
export function buildProfileRequest(state: WizardState, provider: ModelProvider | null | undefined): { errors: Record<string, string>; request?: ProfileRequest } {
  const errors: Record<string, string> = {};
  const model = state.model.trim();
  const displayName = state.displayName.trim();
  const profileId = state.profileId.trim();
  const upstream = effectiveUpstream(state, provider);
  const typedUpstream = state.customUpstreamUrl.trim();
  if (state.mode !== 'edit') {
    if (!PROFILE_ID_PATTERN.test(profileId)) errors.profileId = 'Use 1 to 80 letters, digits, dots, dashes, or underscores.';
    else if (state.takenIds.some((id) => id.toLowerCase() === profileId.toLowerCase())) errors.profileId = `A profile named ${profileId} already exists.`;
  }
  if (!displayName) errors.displayName = 'Enter a display name.';
  else if (displayName.length > 100) errors.displayName = 'Keep the display name to 100 characters.';
  if (!state.credentialId) errors.credentialId = 'Choose a key.';
  if (!model) errors.customModel = 'Choose a model or enter its ID.';
  else if (model.length > MODEL_ID_MAX) errors.customModel = `Model IDs are at most ${MODEL_ID_MAX} characters.`;
  if (!providerApiModes(provider).includes(state.apiMode)) errors.apiMode = 'Choose an API mode this provider offers.';
  if (provider?.requiresCustomUpstream) {
    if (!upstream) errors.customUpstreamUrl = 'Enter the HTTPS URL of your provider endpoint.';
    else if (typedUpstream && !/^https:\/\/[^\s/]+/i.test(typedUpstream)) errors.customUpstreamUrl = 'Use an https:// URL.';
  }
  const unknownPrice = 'The catalog has no price for this model. Enter the price your provider bills; enter 0 only if the model is free.';
  const inputMicros = microsFromDollars(state.pricingInput);
  const outputMicros = microsFromDollars(state.pricingOutput);
  if (inputMicros === null) errors.pricingInput = state.pricingInput.trim() ? 'Enter a dollar amount with at most six decimals.' : unknownPrice;
  if (outputMicros === null) errors.pricingOutput = state.pricingOutput.trim() ? 'Enter a dollar amount with at most six decimals.' : unknownPrice;
  const maxInputTokens = positiveInteger(state.maxInputTokens);
  const maxOutputTokens = positiveInteger(state.maxOutputTokens);
  const maxCostMicros = microsFromDollars(state.maxCost);
  if (maxInputTokens === null) errors.maxInputTokens = 'Enter a whole number of tokens above zero.';
  if (maxOutputTokens === null) errors.maxOutputTokens = 'Enter a whole number of tokens above zero.';
  if (maxCostMicros === null || maxCostMicros <= 0) errors.maxCost = 'Enter a cost limit above zero.';
  const offeredOperations = normalizeOperations(state.operations);
  if (!offeredOperations.length) errors.operations = 'Allow at least one operation.';
  const maxProxyOperations = [...offeredOperations, ...retainedOperations(state)];
  if (Object.keys(errors).length) return { errors };
  const body = {
    displayName,
    credentialId: state.credentialId,
    model,
    apiMode: state.apiMode,
    ...(provider?.requiresCustomUpstream && typedUpstream ? { customUpstreamUrl: typedUpstream } : {}),
    ...profilePricing(state, inputMicros, outputMicros),
    limits: { maxInputTokens, maxOutputTokens, maxCostMicros },
    maxProxyOperations
  };
  if (state.mode === 'edit' && state.profile) return { errors: {}, request: { kind: 'update', profileId: state.profile.id, body: { ...body, expectedGeneration: state.profile.generation } } };
  return { errors: {}, request: { kind: 'create', body: { profileId, ...body } } };
}

/** The verification input for the current draft. The key is never part of it. */
export function draftVerificationInput(state: WizardState, provider: ModelProvider | null | undefined, { tools = false } = {}) {
  const upstream = effectiveUpstream(state, provider);
  return {
    credentialId: state.credentialId,
    model: state.model.trim(),
    apiMode: state.apiMode,
    ...(upstream ? { customUpstreamUrl: upstream } : {}),
    ...(tools ? { checks: { tools: true } } : {})
  };
}

/** The reference of the last check of exactly the route being saved, if it returned one. */
export function draftVerificationRef(state: WizardState, routeKey: string): string | undefined {
  return state.verification?.key === routeKey ? state.verification.result?.verificationRef : undefined;
}

/** The starting state: edit keeps every saved value, duplicate copies them under a fresh ID, create starts read-only. */
export function initialWizardState({ mode = 'create', profile = null, profiles = [], credentials = [] }: { mode?: WizardMode; profile?: ModelProfile | null; profiles?: readonly ModelProfile[]; credentials?: readonly ProviderCredential[] } = {}): WizardState {
  const takenIds = profiles.map((entry) => entry.id);
  const revision = profile?.activeRevision ?? null;
  const credential = credentials.find((entry) => entry.id === (revision?.credentialId ?? profile?.credentialId));
  const state: WizardState = {
    mode, step: 0, profile: mode === 'edit' ? profile : null, takenIds,
    provider: '', credentialChoice: 'saved', credentialId: '', newCredentialLabel: '', newCredentialAuthMode: '',
    query: '', model: '', selectedEntry: null,
    displayName: '', profileId: '', apiMode: 'chat-completions', customUpstreamUrl: '',
    pricingInput: '', pricingOutput: '', pricingProvenance: null,
    ...DEFAULT_LIMITS,
    operations: [...PERMISSION_PRESETS.read.operations], baseOperations: [],
    touched: [], verification: null, savedRoute: null, saveUnverifiedKey: null, mutatingAckKey: null, checkTools: false
  };
  if (!profile) return state;
  Object.assign(state, {
    step: 3,
    provider: credential?.provider ?? '',
    credentialId: revision?.credentialId ?? profile.credentialId ?? '',
    displayName: mode === 'duplicate' ? `${profile.displayName} (copy)`.slice(0, 100) : profile.displayName,
    profileId: mode === 'duplicate' ? deriveProfileSlug(`${profile.id}-copy`, takenIds) : profile.id,
    touched: ['displayName', 'profileId']
  });
  if (revision) {
    Object.assign(state, {
      model: revision.model, query: revision.model, apiMode: revision.apiMode,
      // Duplicating a custom profile cannot keep the URL implicitly: a new profile always states its upstream.
      customUpstreamUrl: mode === 'duplicate' && credential?.provider === 'custom' ? revision.upstreamUrl ?? '' : '',
      pricingInput: dollarsFromMicros(revision.pricing.inputMicrosPerMillionTokens),
      pricingOutput: dollarsFromMicros(revision.pricing.outputMicrosPerMillionTokens),
      pricingProvenance: { source: 'saved' },
      maxInputTokens: String(revision.limits.maxInputTokens),
      maxOutputTokens: String(revision.limits.maxOutputTokens),
      maxCost: dollarsFromMicros(revision.limits.maxCostMicros),
      operations: normalizeOperations(revision.maxProxyOperations),
      baseOperations: mode === 'edit' ? normalizeOperations(revision.maxProxyOperations) : []
    });
    if (mode === 'edit') {
      state.savedRoute = {
        key: draftRouteKey({ credentialId: revision.credentialId, model: revision.model, apiMode: revision.apiMode, customUpstreamUrl: credential?.provider === 'custom' ? revision.upstreamUrl ?? '' : '' }),
        outcome: profileVerification(profile).outcome
      };
    }
  }
  return state;
}

const touch = (state: WizardState, field: string) => (state.touched.includes(field) ? state.touched : [...state.touched, field]);

/** Records a typed field value; a typed price is the operator's own. */
export function setField(state: WizardState, field: keyof WizardState & string, value: string): WizardState {
  const next = { ...state, [field]: value, touched: touch(state, field) };
  if (field === 'pricingInput' || field === 'pricingOutput') next.pricingProvenance = { source: 'user' };
  return next;
}

/** Changing provider resets everything chosen for the previous one; prices the operator typed stay. */
export function selectProvider(state: WizardState, providerId: string, provider: ModelProvider | null | undefined, credentials: readonly ProviderCredential[]): WizardState {
  if (providerId === state.provider) return state;
  const saved = credentials.find((entry) => entry.provider === providerId && entry.status === 'ACTIVE');
  const modes = providerApiModes(provider);
  return {
    ...state,
    provider: providerId,
    credentialId: saved?.id ?? '',
    credentialChoice: saved ? 'saved' : 'new',
    newCredentialAuthMode: '',
    selectedEntry: null,
    model: '',
    query: '',
    pricingInput: state.touched.includes('pricingInput') ? state.pricingInput : '',
    pricingOutput: state.touched.includes('pricingOutput') ? state.pricingOutput : '',
    apiMode: modes.includes(state.apiMode) ? state.apiMode : modes[0] ?? 'chat-completions'
  };
}

/** Applies a chosen catalog entry; values the operator typed are kept, an unknown price stays empty. */
export function applyCatalogEntry(state: WizardState, entry: CatalogEntry): WizardState {
  const has = (field: string) => state.touched.includes(field);
  return {
    ...state,
    selectedEntry: entry,
    model: entry.providerModelId,
    query: entry.providerModelId,
    displayName: has('displayName') ? state.displayName : entry.displayName.slice(0, 100),
    profileId: state.mode !== 'edit' && !has('profileId') ? deriveProfileSlug(entry.providerModelId, state.takenIds) : state.profileId,
    pricingInput: has('pricingInput') ? state.pricingInput : dollarsFromMicros(entry.pricing?.inputMicrosPerMillionTokens),
    pricingOutput: has('pricingOutput') ? state.pricingOutput : dollarsFromMicros(entry.pricing?.outputMicrosPerMillionTokens),
    pricingProvenance: !has('pricingInput') || !has('pricingOutput') ? entry.pricing?.provenance ?? null : state.pricingProvenance
  };
}

/** Forgets prices that came with the previous model, so another model never inherits a price. */
export function resetUntouchedPricing(state: WizardState): WizardState {
  return {
    ...state,
    pricingInput: state.touched.includes('pricingInput') ? state.pricingInput : '',
    pricingOutput: state.touched.includes('pricingOutput') ? state.pricingOutput : '',
    pricingProvenance: { source: 'none' }
  };
}

/** Applies a typed model ID; re-applying the current model ID changes nothing. */
export function applyCustomModel(state: WizardState, modelId: string): WizardState {
  const model = String(modelId ?? '').trim().slice(0, MODEL_ID_MAX);
  if (model === state.model) return state;
  const has = (field: string) => state.touched.includes(field);
  return resetUntouchedPricing({
    ...state,
    selectedEntry: null,
    model,
    query: model,
    displayName: !has('displayName') && model ? model.slice(0, 100) : state.displayName,
    profileId: state.mode !== 'edit' && !has('profileId') && model ? deriveProfileSlug(model, state.takenIds) : state.profileId
  });
}

export type CatalogOption = { kind: 'entry'; entry: CatalogEntry } | { kind: 'custom'; value: string };

/** Catalog entries, then the typed text as a custom ID when no entry matches it exactly. */
export function catalogOptions(entries: readonly CatalogEntry[] | null | undefined, query: string): CatalogOption[] {
  const options: CatalogOption[] = (entries ?? []).map((entry) => ({ kind: 'entry', entry }));
  const typed = query.trim();
  if (typed && typed.length <= MODEL_ID_MAX && !options.some((option) => option.kind === 'entry' && option.entry.providerModelId === typed)) options.push({ kind: 'custom', value: typed });
  return options;
}

/* ───────────── Restore across reload ───────────── */

const STRING_FIELDS = [
  'provider', 'credentialId', 'newCredentialLabel', 'newCredentialAuthMode', 'query', 'model', 'displayName', 'profileId',
  'customUpstreamUrl', 'pricingInput', 'pricingOutput', 'maxInputTokens', 'maxOutputTokens', 'maxCost'
] as const;

/** What the wizard writes to `sessionStorage`: the step and the non-secret choices. */
export type StoredWizard = { open: true; mode: WizardMode; sourceProfileId: string | null; state: Omit<WizardState, 'profile' | 'takenIds'> };

/** The draft without the saved profile and the taken IDs, which always come from the live reads. */
function withoutContext(state: WizardState): StoredWizard['state'] {
  const rest: Partial<WizardState> = { ...state };
  delete rest.profile;
  delete rest.takenIds;
  return rest as StoredWizard['state'];
}

/**
 * The custom upstream URL as it may be stored: an endpoint URL that parses and carries no
 * user info, query or fragment (where a pasted credential or token would sit), else empty.
 */
export function storableUpstreamUrl(value: string): string {
  const typed = value.trim();
  if (!typed) return '';
  try {
    const url = new URL(typed);
    return url.username || url.password || url.search || url.hash || typed.includes('?') || typed.includes('#') ? '' : typed;
  } catch {
    return '';
  }
}

export function storedWizard(state: WizardState, sourceProfileId: string | null): StoredWizard {
  return { open: true, mode: state.mode, sourceProfileId, state: withoutContext(state) };
}

/**
 * The form written to `sessionStorage`. The live wizard keeps whatever the operator types,
 * so a partial or invalid upstream URL stays editable and its validation message shows;
 * only the stored copy drops one that does not pass `storableUpstreamUrl`.
 */
export function wizardForStorage(stored: StoredWizard | null): StoredWizard | null {
  return stored ? { ...stored, state: { ...stored.state, customUpstreamUrl: storableUpstreamUrl(stored.state.customUpstreamUrl) } } : null;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const strings = (value: unknown) => (Array.isArray(value) ? value.filter(isString) : []);

/**
 * The restore allowlist: it rebuilds a wizard entry from known non-secret fields only and
 * returns undefined for anything malformed, so an injected `apiKey` (or any other field) is
 * never read back. Nested catalog data, prices and the last check result are rebuilt from
 * their own allowlists (`models-restore-shapes.ts`).
 */
export function parseStoredWizard(raw: unknown): StoredWizard | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const entry = raw as Record<string, unknown>;
  const input = entry.state as Record<string, unknown> | undefined;
  const mode = entry.mode;
  if (entry.open !== true || (mode !== 'create' && mode !== 'edit' && mode !== 'duplicate') || !input || typeof input !== 'object') return undefined;
  const state = withoutContext(initialWizardState({ mode }));
  for (const field of STRING_FIELDS) if (isString(input[field])) state[field] = input[field] as string;
  state.customUpstreamUrl = storableUpstreamUrl(state.customUpstreamUrl);
  const step = Number(input.step);
  state.step = Number.isInteger(step) && step >= 0 && step < WIZARD_STEPS.length ? step : 0;
  state.credentialChoice = input.credentialChoice === 'new' ? 'new' : 'saved';
  state.apiMode = input.apiMode === 'responses' ? 'responses' : 'chat-completions';
  state.operations = normalizeOperations(strings(input.operations));
  state.baseOperations = normalizeOperations(strings(input.baseOperations));
  state.touched = strings(input.touched);
  state.checkTools = input.checkTools === true;
  state.saveUnverifiedKey = isString(input.saveUnverifiedKey) ? input.saveUnverifiedKey : null;
  state.mutatingAckKey = isString(input.mutatingAckKey) ? input.mutatingAckKey : null;
  state.selectedEntry = restoreCatalogEntry(input.selectedEntry);
  state.pricingProvenance = restoreProvenance(input.pricingProvenance);
  const verification = input.verification as { key?: unknown; result?: unknown } | null | undefined;
  const result = verification && isString(verification.key) ? restoreVerifyResult(verification.result) : null;
  state.verification = verification && isString(verification.key) && result ? { key: verification.key, result } : null;
  const savedRoute = input.savedRoute as { key?: unknown; outcome?: unknown } | null | undefined;
  state.savedRoute = savedRoute && isString(savedRoute.key) && isString(savedRoute.outcome) ? { key: savedRoute.key, outcome: savedRoute.outcome } : null;
  return { open: true, mode, sourceProfileId: isString(entry.sourceProfileId) ? entry.sourceProfileId : null, state };
}
