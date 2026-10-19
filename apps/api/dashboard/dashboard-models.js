import { escapeHtml as escape, renderCopyChip } from './dashboard-render.js';

/**
 * Models & Budgets: the profile list and the provider-first profile wizard.
 *
 * The pure helpers at the top own every rule the wizard enforces (slugs, money,
 * permission presets, the save gate), so the DOM controller below only moves
 * values between the form and one state object and the rules are unit-tested
 * without a browser. Provider keys never enter this state: a new key is read from
 * its write-only field at submission and the field is cleared once it is stored.
 */

/** The ten safe proxy operations, in the order the profile schema lists them. */
export const PROXY_OPERATIONS = Object.freeze([
  'files_list', 'files_read', 'files_write', 'files_apply_patch', 'files_delete',
  'files_move', 'files_mkdir', 'grep_search', 'symbols_search', 'symbols_references'
]);

/** Operations that change the workspace. None is ever enabled without the operator choosing it. */
export const MUTATING_PROXY_OPERATIONS = Object.freeze(['files_write', 'files_apply_patch', 'files_delete', 'files_move', 'files_mkdir']);

const READ_ONLY_OPERATIONS = Object.freeze(['files_list', 'files_read', 'grep_search', 'symbols_search', 'symbols_references']);

export const PERMISSION_PRESETS = Object.freeze({
  read: { label: 'Read only', description: 'List, read, and search files. The subagent cannot change the workspace.', operations: READ_ONLY_OPERATIONS },
  code: {
    label: 'Code editing',
    description: 'Read only, plus writing, patching, and moving files and creating folders. Deleting files stays off.',
    operations: Object.freeze([...READ_ONLY_OPERATIONS, 'files_write', 'files_apply_patch', 'files_move', 'files_mkdir'])
  }
});

export const WIZARD_STEPS = Object.freeze([
  { id: 'provider', label: 'Provider' },
  { id: 'connect', label: 'Connect' },
  { id: 'model', label: 'Model' },
  { id: 'review', label: 'Review' },
  { id: 'verify', label: 'Verify and save' }
]);

/** Fields the wizard keeps inside Advanced settings; a validation error there opens the section. */
const ADVANCED_FIELDS = new Set(['profileId', 'apiMode', 'customUpstreamUrl', 'customModel', 'pricingInput', 'pricingOutput', 'maxInputTokens', 'maxOutputTokens', 'maxCost']);

const DEFAULT_LIMITS = Object.freeze({ maxInputTokens: '200000', maxOutputTokens: '32000', maxCost: '5' });
const PROFILE_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
const MODEL_ID_MAX = 100;

/** Keeps only known operations, in canonical order, without duplicates. */
export function normalizeOperations(operations) {
  const chosen = new Set(Array.isArray(operations) ? operations : []);
  return PROXY_OPERATIONS.filter((operation) => chosen.has(operation));
}

/**
 * Operations a saved profile allows that this wizard does not offer: the policy-gated coding operations,
 * which are granted only through the MCP profile tools. An edit keeps them rather than silently dropping
 * them; the runner validates the saved set either way.
 */
export function retainedOperations(operations) {
  const offered = new Set(PROXY_OPERATIONS);
  return [...new Set(Array.isArray(operations) ? operations : [])]
    .filter((operation) => typeof operation === 'string' && /^[a-z_]{1,40}$/.test(operation) && !offered.has(operation));
}

/** The preset an operation set matches exactly, or `custom`. */
export function permissionPresetFor(operations) {
  const key = normalizeOperations(operations).join(',');
  for (const [id, preset] of Object.entries(PERMISSION_PRESETS)) if (normalizeOperations(preset.operations).join(',') === key) return id;
  return 'custom';
}

/** What a save changes in the operation ceiling, with the mutating additions called out. */
export function permissionDiff(before, after) {
  const previous = new Set(normalizeOperations(before));
  const next = new Set(normalizeOperations(after));
  const added = PROXY_OPERATIONS.filter((operation) => next.has(operation) && !previous.has(operation));
  return {
    added,
    removed: PROXY_OPERATIONS.filter((operation) => previous.has(operation) && !next.has(operation)),
    kept: PROXY_OPERATIONS.filter((operation) => previous.has(operation) && next.has(operation)),
    addedMutating: added.filter((operation) => MUTATING_PROXY_OPERATIONS.includes(operation))
  };
}

/**
 * A profile ID derived from a model ID. Vendor prefixes and dots survive as
 * readable separators; a collision with an existing profile (compared without
 * case, so two IDs never differ only by case) gets the first free numeric suffix.
 */
export function deriveProfileSlug(model, takenIds = []) {
  const taken = new Set([...takenIds].map((id) => String(id).toLowerCase()));
  const trim = (value) => value.replace(/^[-._]+|[-._]+$/g, '');
  const base = trim(trim(String(model ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-')).slice(0, 72)) || 'profile';
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Decimal-safe dollars to integer micro-USD. Returns null for anything that is
 * not a non-negative amount with at most six decimals, so an empty or garbled
 * price is never read as zero.
 */
export function microsFromDollars(text) {
  const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(String(text ?? '').trim());
  if (!match) return null;
  // BigInt keeps every digit exact; an amount past the safe-integer range is refused rather than rounded.
  const micros = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null;
}

/** Integer micro-USD to a dollar string; null (unknown) becomes an empty field, never `0`. */
export function dollarsFromMicros(micros) {
  if (micros === null || micros === undefined || !Number.isSafeInteger(micros) || micros < 0) return '';
  const fraction = String(micros % 1_000_000).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${Math.floor(micros / 1_000_000)}.${fraction}`;
}

/** A price for display. An unknown price says so; it is never shown as $0. */
export function formatPrice(micros) {
  const dollars = dollarsFromMicros(micros);
  return dollars ? `$${dollars}` : 'Unknown';
}

const positiveInteger = (text) => (/^\d{1,15}$/.test(String(text ?? '').trim()) && Number(text) > 0 ? Number(text) : null);

const PRICE_SOURCE_LABELS = { provider: 'provider', openrouter: 'OpenRouter', user: 'entered by you', saved: 'saved on this profile' };

/**
 * Plain-language provenance for a price: where it came from, how sure, and when.
 * No provenance means no source published a price, so the operator is asked for
 * one; a saved profile's own price carries the `saved` source instead.
 */
export function priceProvenanceText(provenance) {
  if (!provenance || provenance.source === 'none') return 'No published price. Enter the price your provider bills.';
  const source = PRICE_SOURCE_LABELS[provenance.source] ?? 'unknown source';
  const parts = [`Source: ${source}`];
  if (provenance.confidence && provenance.source !== 'user' && provenance.source !== 'saved') parts.push(`confidence: ${provenance.confidence}`);
  if (Number.isFinite(provenance.retrievedAt)) parts.push(`retrieved ${new Date(provenance.retrievedAt).toLocaleString()}`);
  return parts.join(' · ');
}

const VERIFICATION_LABELS = { verified: 'Verified', limited: 'Limited', failed: 'Failed', not_tested: 'Not verified' };
const VERIFICATION_CLASSES = { verified: 'active', limited: 'stale', failed: 'failed', not_tested: '' };

export function verificationLabel(outcome) { return VERIFICATION_LABELS[outcome] ?? 'Not verified'; }
const statusClass = (modifier) => (modifier ? `status ${escape(modifier)}` : 'status');
function verificationPill(outcome) { return `<span class="${statusClass(VERIFICATION_CLASSES[outcome])}">${escape(verificationLabel(outcome))}</span>`; }

/**
 * A profile's stored check applies only to the revision it checked. A newer
 * revision reads as not verified, with the earlier result kept for context.
 */
export function profileVerification(profile) {
  const last = profile?.lastVerification;
  if (!last) return { outcome: 'not_tested', checkedAt: null, current: false };
  const current = last.revisionId !== null && last.revisionId === profile.activeRevisionId;
  return { outcome: current ? last.outcome : 'not_tested', checkedAt: last.checkedAt, current, previousOutcome: current ? undefined : last.outcome };
}

/** One summary of catalog freshness: quiet when fresh, a warning when stale, an error when unavailable. */
export function catalogFreshnessNotice(freshness) {
  if (!freshness) return null;
  const failing = (freshness.sources ?? []).filter((source) => source.error).map((source) => `${source.source === 'openrouter' ? 'OpenRouter' : 'provider'}: ${String(source.error).replace(/_/g, ' ')}`);
  const reason = failing.length ? ` (${failing.join('; ')})` : '';
  const when = Number.isFinite(freshness.fetchedAt) ? new Date(freshness.fetchedAt).toLocaleString() : null;
  if (freshness.state === 'fresh') return { level: 'fresh', text: when ? `Catalog updated ${when}.` : 'Catalog is up to date.' };
  if (freshness.state === 'stale') return { level: 'stale', text: `Showing the last good catalog${when ? ` from ${when}` : ''}${reason}. Prices and availability may be out of date.` };
  return { level: 'unavailable', text: `The catalog is unavailable right now${reason}. Enter the model ID yourself, or refresh.` };
}

/** A saved price the revision leaves unknown is charged at a conservative default, never as free. */
export const UNKNOWN_SAVED_PRICE = 'Unknown (charged conservatively)';

/** A price pinned on a saved revision. Unknown is said in words, never shown as $0. */
export function formatSavedPrice(micros) {
  const dollars = dollarsFromMicros(micros);
  return dollars ? `$${dollars}` : UNKNOWN_SAVED_PRICE;
}

export const CUSTOM_PRICE_LABEL = 'Custom price (override)';
export const CATALOG_PRICE_LABEL = 'Catalog price';
export const KEPT_PRICE_LABEL = 'Saved price (unchanged)';

/**
 * Where a saved revision's prices came from, as the runner recorded it. A
 * revision without provenance reads as an override of unknown confidence, the
 * same way the runner reads revisions saved before provenance existed.
 */
export function savedPriceProvenance(provenance) {
  const recorded = provenance ?? { source: 'user', sourceModelId: null, retrievedAt: null, confidence: 'unknown', isOverride: true };
  const parts = [`Source: ${PRICE_SOURCE_LABELS[recorded.source] ?? 'unknown source'}`, `confidence: ${recorded.confidence ?? 'unknown'}`];
  return {
    isOverride: recorded.isOverride !== false,
    badge: recorded.isOverride !== false ? CUSTOM_PRICE_LABEL : CATALOG_PRICE_LABEL,
    text: parts.join(' · '),
    retrievedAt: Number.isFinite(recorded.retrievedAt) ? recorded.retrievedAt : null
  };
}

/**
 * The warning a repriced revision shows, or null when there is nothing to act
 * on. The percentage is the largest change the review measured; changes that
 * have no percentage (a pinned zero, an unpublished price, a tier on one side)
 * still raise the warning. For an override the difference is the operator's
 * choice, so it reads as a difference rather than a change.
 */
export function pricingReviewNotice(review) {
  if (review?.state !== 'repriced') return null;
  if (review.isOverride) return { isOverride: true, text: 'Differs from catalog' };
  const percents = (review.changes ?? []).map((change) => change.percent).filter((percent) => Number.isFinite(percent)).map(Math.abs);
  if (!percents.length) return { isOverride: false, text: 'Catalog price changed since saved' };
  const largest = Math.max(...percents);
  return { isOverride: false, text: `Catalog price changed by ${Number(largest.toFixed(1))}% since saved` };
}

export const PRICING_UNKNOWN_TEXT = 'No catalog price to compare with';
export const CONDITIONAL_PRICING_TEXT = 'The catalog also prices this model by conditions a saved price cannot express, so the charge can differ from this estimate.';

/**
 * What the list says beside the repricing warning: whether the catalog has no
 * price to compare with, when the catalog behind a repriced or unknown review was
 * retrieved (null when unknown or not shown), and whether the catalog prices the
 * model by conditions no saved price can express. A provider without a catalog
 * never has a price to compare with, so `hasCatalog: false` drops that note.
 */
export function pricingReviewContext(review, { hasCatalog = true } = {}) {
  const state = review?.state;
  const showsAge = state === 'repriced' || state === 'unknown';
  return {
    unknown: state === 'unknown' && hasCatalog,
    comparedAt: showsAge && Number.isFinite(review.catalogRetrievedAt) ? review.catalogRetrievedAt : null,
    conditional: review?.catalogHasConditionalPricing === true
  };
}

/**
 * How a wizard save will record its prices: `catalog` when the catalog price is
 * sent unedited with its reference, `kept` when an edit restates the saved input
 * and output prices for the same model and key (the runner keeps the saved prices
 * and their provenance), and `override` for anything else. Null while a price is
 * not a valid amount yet.
 */
export function pricingSaveKind(state) {
  const input = microsFromDollars(state.pricingInput);
  const output = microsFromDollars(state.pricingOutput);
  if (input === null || output === null) return null;
  if (profilePricing(state, input, output).catalogPriceRef) return 'catalog';
  const revision = state.mode === 'edit' ? state.profile?.activeRevision : null;
  if (revision && revision.pricing.inputMicrosPerMillionTokens === input && revision.pricing.outputMicrosPerMillionTokens === output
    && revision.model === String(state.model ?? '').trim() && revision.credentialId === state.credentialId) return 'kept';
  return 'override';
}

const PRICE_SAVE_LABELS = { catalog: CATALOG_PRICE_LABEL, kept: KEPT_PRICE_LABEL, override: CUSTOM_PRICE_LABEL };
export function pricingSaveLabel(state) { return PRICE_SAVE_LABELS[pricingSaveKind(state)] ?? 'Not set'; }

/** The provider settings a connection depends on; a verification applies only while this is unchanged. */
export function draftRouteKey({ credentialId, model, apiMode, customUpstreamUrl }) {
  return JSON.stringify([credentialId ?? '', String(model ?? '').trim(), apiMode ?? '', String(customUpstreamUrl ?? '').trim()]);
}

/** API modes a provider offers. A custom provider accepts either. */
export function providerApiModes(provider) {
  if (!provider) return [];
  if (provider.requiresCustomUpstream) return ['chat-completions', 'responses'];
  return ['chat-completions', 'responses'].filter((mode) => provider.endpoints?.[mode]);
}

/**
 * The custom upstream a draft uses. Editing a custom profile keeps its URL while
 * the credential and API mode are unchanged, matching the runner's update rule.
 */
export function effectiveUpstream(state, provider) {
  if (!provider?.requiresCustomUpstream) return '';
  const typed = String(state.customUpstreamUrl ?? '').trim();
  if (typed) return typed;
  const revision = state.profile?.activeRevision;
  if (state.mode === 'edit' && revision && revision.credentialId === state.credentialId && revision.apiMode === state.apiMode) return revision.upstreamUrl ?? '';
  return '';
}

/**
 * Whether the wizard may save. A route counts as verified when a check of this
 * exact route said `verified`, or when an edit keeps the saved route and the
 * saved revision is verified. Anything else needs the explicit unverified choice,
 * and any newly allowed mutating operation needs its own acknowledgement.
 */
export function wizardSaveGate(state, provider) {
  const routeKey = draftRouteKey({ ...state, customUpstreamUrl: effectiveUpstream(state, provider) });
  const verified = (state.verification?.key === routeKey && state.verification.result?.outcome === 'verified')
    || (state.savedRoute?.key === routeKey && state.savedRoute.outcome === 'verified');
  const diff = permissionDiff(state.baseOperations, state.operations);
  // `fields[i]` names the gate checkbox that lifts `reasons[i]`, so the form can focus it.
  const reasons = [];
  const fields = [];
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

/**
 * Validates the draft and builds the create or update request. Errors are keyed
 * by field so the form can mark and focus the first one.
 */
export function buildProfileRequest(state, provider) {
  const errors = {};
  const model = String(state.model ?? '').trim();
  const displayName = String(state.displayName ?? '').trim();
  const profileId = String(state.profileId ?? '').trim();
  const upstream = effectiveUpstream(state, provider);
  const typedUpstream = String(state.customUpstreamUrl ?? '').trim();
  if (state.mode !== 'edit') {
    if (!PROFILE_ID_PATTERN.test(profileId)) errors.profileId = 'Use 1 to 80 letters, digits, dots, dashes, or underscores.';
    else if ([...(state.takenIds ?? [])].some((id) => String(id).toLowerCase() === profileId.toLowerCase())) errors.profileId = `A profile named ${profileId} already exists.`;
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
  if (inputMicros === null) errors.pricingInput = String(state.pricingInput ?? '').trim() ? 'Enter a dollar amount with at most six decimals.' : unknownPrice;
  if (outputMicros === null) errors.pricingOutput = String(state.pricingOutput ?? '').trim() ? 'Enter a dollar amount with at most six decimals.' : unknownPrice;
  const maxInputTokens = positiveInteger(state.maxInputTokens);
  const maxOutputTokens = positiveInteger(state.maxOutputTokens);
  const maxCostMicros = microsFromDollars(state.maxCost);
  if (maxInputTokens === null) errors.maxInputTokens = 'Enter a whole number of tokens above zero.';
  if (maxOutputTokens === null) errors.maxOutputTokens = 'Enter a whole number of tokens above zero.';
  if (maxCostMicros === null || maxCostMicros <= 0) errors.maxCost = 'Enter a cost limit above zero.';
  const offeredOperations = normalizeOperations(state.operations);
  if (!offeredOperations.length) errors.operations = 'Allow at least one operation.';
  const maxProxyOperations = [...offeredOperations, ...(state.mode === 'edit' ? state.retainedOperations ?? [] : [])];
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
  if (state.mode === 'edit') return { errors: {}, request: { kind: 'update', profileId: state.profile.id, body: { ...body, expectedGeneration: state.profile.generation } } };
  return { errors: {}, request: { kind: 'create', body: { profileId, ...body } } };
}

/**
 * Pricing for a save. A catalog price the operator accepted unedited is sent
 * whole, with a reference to its catalog model; the runner records it as the
 * catalog's only when it matches the runner's own cached price. Cache prices the
 * catalog does not publish are sent as null and flat pricing as no tiers, so the
 * save replaces every saved price instead of restating input and output only,
 * which would keep a saved cache price or tier. A typed price is sent as typed,
 * with no reference: the runner keeps the saved prices when it repeats the saved
 * input and output, and records an override otherwise.
 */
export function profilePricing(state, inputMicros, outputMicros) {
  const typed = { inputMicrosPerMillionTokens: inputMicros, outputMicrosPerMillionTokens: outputMicros };
  const price = state.selectedEntry?.pricing;
  const sourceModelId = price?.provenance?.source === 'openrouter' ? price.provenance.sourceModelId : null;
  const edited = state.touched.has('pricingInput') || state.touched.has('pricingOutput');
  if (!sourceModelId || edited || price.inputMicrosPerMillionTokens !== inputMicros || price.outputMicrosPerMillionTokens !== outputMicros) {
    return { pricing: typed };
  }
  const known = (micros) => (Number.isSafeInteger(micros) ? micros : null);
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

/** The verification input for the current draft. The key is never part of it. */
export function draftVerificationInput(state, provider, { tools = false } = {}) {
  const upstream = effectiveUpstream(state, provider);
  return {
    credentialId: state.credentialId,
    model: String(state.model ?? '').trim(),
    apiMode: state.apiMode,
    ...(upstream ? { customUpstreamUrl: upstream } : {}),
    ...(tools ? { checks: { tools: true } } : {})
  };
}

/**
 * The reference of the last check of exactly the route being saved, if it
 * returned one. The runner keeps that check's result for the new revision only
 * when it matches the route it saves; the browser never sends the result itself.
 */
export function draftVerificationRef(state, routeKey) {
  return state.verification?.key === routeKey ? state.verification.result?.verificationRef : undefined;
}

/**
 * The starting state of a wizard run. Edit keeps every saved value; duplicate
 * copies them under a fresh, collision-safe ID; create starts read-only.
 */
export function initialWizardState({ mode = 'create', profile = null, profiles = [], credentials = [] } = {}) {
  const takenIds = profiles.map((entry) => entry.id);
  const revision = profile?.activeRevision ?? null;
  const credential = credentials.find((entry) => entry.id === (revision?.credentialId ?? profile?.credentialId));
  const state = {
    mode, step: 0, profile: mode === 'edit' ? profile : null, takenIds,
    provider: '', credentialChoice: 'saved', credentialId: '', newCredentialLabel: '', newCredentialAuthMode: '',
    query: '', model: '', selectedEntry: null,
    displayName: '', profileId: '', apiMode: 'chat-completions', customUpstreamUrl: '',
    pricingInput: '', pricingOutput: '', pricingProvenance: null,
    ...DEFAULT_LIMITS,
    operations: [...PERMISSION_PRESETS.read.operations], baseOperations: [], retainedOperations: [],
    touched: new Set(), verification: null, savedRoute: null, saveUnverifiedKey: null, mutatingAckKey: null, checkTools: false
  };
  if (!profile) return state;
  Object.assign(state, {
    step: 3,
    provider: credential?.provider ?? '',
    credentialId: revision?.credentialId ?? profile.credentialId ?? '',
    displayName: mode === 'duplicate' ? `${profile.displayName} (copy)`.slice(0, 100) : profile.displayName,
    profileId: mode === 'duplicate' ? deriveProfileSlug(`${profile.id}-copy`, takenIds) : profile.id,
    // Values carried from a saved profile count as chosen, so picking another model does not overwrite them.
    touched: new Set(['displayName', 'profileId'])
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
      baseOperations: mode === 'edit' ? normalizeOperations(revision.maxProxyOperations) : [],
      retainedOperations: mode === 'edit' ? retainedOperations(revision.maxProxyOperations) : []
    });
    if (mode === 'edit') {
      const verification = profileVerification(profile);
      state.savedRoute = { key: draftRouteKey({ credentialId: revision.credentialId, model: revision.model, apiMode: revision.apiMode, customUpstreamUrl: credential?.provider === 'custom' ? revision.upstreamUrl : '' }), outcome: verification.outcome };
    }
  }
  return state;
}

/**
 * Applies a chosen catalog entry. Model ID, display name, slug, and prices are
 * filled only where the operator has not typed a value of their own, so a
 * second choice or a retry never erases an edit. An unknown price stays empty.
 */
export function applyCatalogEntry(state, entry) {
  state.selectedEntry = entry;
  state.model = entry.providerModelId;
  state.query = entry.providerModelId;
  if (!state.touched.has('displayName')) state.displayName = entry.displayName.slice(0, 100);
  if (state.mode !== 'edit' && !state.touched.has('profileId')) state.profileId = deriveProfileSlug(entry.providerModelId, state.takenIds);
  if (!state.touched.has('pricingInput')) state.pricingInput = dollarsFromMicros(entry.pricing?.inputMicrosPerMillionTokens);
  if (!state.touched.has('pricingOutput')) state.pricingOutput = dollarsFromMicros(entry.pricing?.outputMicrosPerMillionTokens);
  if (!state.touched.has('pricingInput') || !state.touched.has('pricingOutput')) state.pricingProvenance = entry.pricing?.provenance ?? null;
  return state;
}

/**
 * Forgets prices that came with the previous model. A price the operator typed
 * stays; anything else becomes unknown, so another model never inherits a price.
 */
export function resetUntouchedPricing(state) {
  if (!state.touched.has('pricingInput')) state.pricingInput = '';
  if (!state.touched.has('pricingOutput')) state.pricingOutput = '';
  state.pricingProvenance = { source: 'none' };
  return state;
}

/**
 * Applies a model ID the operator typed. Nothing is filled from the catalog, and
 * a price that belonged to the previous model is cleared unless the operator
 * typed it. Re-applying the current model ID changes nothing.
 */
export function applyCustomModel(state, modelId) {
  const model = String(modelId ?? '').trim().slice(0, MODEL_ID_MAX);
  if (model === state.model) return state;
  state.selectedEntry = null;
  state.model = model;
  state.query = model;
  if (!state.touched.has('displayName') && model) state.displayName = model.slice(0, 100);
  if (state.mode !== 'edit' && !state.touched.has('profileId') && model) state.profileId = deriveProfileSlug(model, state.takenIds);
  return resetUntouchedPricing(state);
}

/** Combobox options: catalog entries, then the typed text as a custom ID when no entry matches it exactly. */
export function catalogOptions(entries, query) {
  const options = (Array.isArray(entries) ? entries : []).map((entry) => ({ kind: 'entry', entry }));
  const typed = String(query ?? '').trim();
  if (typed && typed.length <= MODEL_ID_MAX && !options.some((option) => option.entry.providerModelId === typed)) options.push({ kind: 'custom', value: typed });
  return options;
}

const AVAILABILITY_LABELS = {
  listed_for_credential: 'Listed for your key',
  public_catalog: 'Public catalog, unverified for your key',
  unknown: 'Availability unknown'
};

export function availabilityLabel(availability) { return AVAILABILITY_LABELS[availability] ?? AVAILABILITY_LABELS.unknown; }

export const optionId = (listboxId, index) => `${listboxId}-opt-${index}`;

export function renderModelOptions(options, activeIndex, listboxId = 'model-wizard-options') {
  return (Array.isArray(options) ? options : []).map((option, index) => {
    const selected = index === activeIndex;
    const attributes = `id="${escape(optionId(listboxId, index))}" class="model-option${selected ? ' selected' : ''}" role="option" aria-selected="${selected}" data-index="${index}"`;
    if (option.kind === 'custom') {
      return `<li ${attributes}><span class="model-option-name">Use “${escape(option.value)}” as a custom model ID</span><span class="model-option-meta">Not in the catalog: no price or availability is known.</span></li>`;
    }
    const { entry } = option;
    const price = `${formatPrice(entry.pricing?.inputMicrosPerMillionTokens)} in / ${formatPrice(entry.pricing?.outputMicrosPerMillionTokens)} out per 1M`;
    return `<li ${attributes}><span class="model-option-name">${escape(entry.displayName)}</span><span class="model-option-id mono">${escape(entry.providerModelId)}</span><span class="model-option-meta">${escape(price)} · ${escape(availabilityLabel(entry.availability))}</span></li>`;
  }).join('');
}

/**
 * The model search combobox (ARIA 1.2 list autocomplete). Focus stays in the
 * input; the active option is announced through `aria-activedescendant`.
 * Escape closes an open list without closing the dialog around it.
 */
export function createModelCombobox({ input, listbox, render, onQuery, onCommit, debounceMs = 250, timers = globalThis }) {
  let options = [];
  let active = -1;
  let expanded = false;
  let timer;
  function paint() {
    render(listbox, renderModelOptions(options, active, listbox.id));
    listbox.hidden = !expanded;
    input.setAttribute('aria-expanded', String(expanded));
    if (expanded && active >= 0) input.setAttribute('aria-activedescendant', optionId(listbox.id, active));
    else input.removeAttribute('aria-activedescendant');
  }
  function close() { expanded = false; active = -1; paint(); }
  function commit(index) {
    const option = options[index];
    if (!option) return;
    // A search still waiting on the debounce must not replace the committed choice.
    timers.clearTimeout(timer);
    close();
    onCommit(option);
  }
  function setOptions(next, { open = true } = {}) {
    options = Array.isArray(next) ? next : [];
    active = -1;
    expanded = open && options.length > 0;
    paint();
  }
  const keydown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!options.length) return;
      const down = event.key === 'ArrowDown';
      if (!expanded) { expanded = true; active = down ? 0 : options.length - 1; }
      else active = down ? (active + 1) % options.length : (active <= 0 ? options.length - 1 : active - 1);
      paint();
    } else if (event.key === 'Enter') {
      if (expanded && active >= 0) { event.preventDefault(); commit(active); }
    } else if (event.key === 'Escape') {
      if (expanded) { event.preventDefault(); event.stopPropagation(); close(); }
    } else if (event.key === 'Tab') {
      if (expanded) close();
    }
  };
  const inputListener = () => {
    timers.clearTimeout(timer);
    const query = input.value;
    timer = timers.setTimeout(() => onQuery(query), debounceMs);
  };
  // Pressing an option must not move focus out of the input first.
  const mousedown = (event) => event.preventDefault();
  const click = (event) => {
    const option = event.target?.closest?.('[role="option"]');
    if (option) commit(Number(option.dataset.index));
  };
  const blur = () => { if (expanded) close(); };
  input.addEventListener('keydown', keydown);
  input.addEventListener('input', inputListener);
  input.addEventListener('blur', blur);
  listbox.addEventListener('mousedown', mousedown);
  listbox.addEventListener('click', click);
  return {
    setOptions,
    close,
    get expanded() { return expanded; },
    get active() { return active; },
    dispose() {
      timers.clearTimeout(timer);
      input.removeEventListener('keydown', keydown);
      input.removeEventListener('input', inputListener);
      input.removeEventListener('blur', blur);
      listbox.removeEventListener('mousedown', mousedown);
      listbox.removeEventListener('click', click);
    }
  };
}

/* ───────────────────────── Rendering ───────────────────────── */

const timeText = (value) => (Number.isFinite(value) ? `<time datetime="${escape(new Date(value).toISOString())}">${escape(new Date(value).toLocaleString())}</time>` : '');
const fieldError = (errors, field) => (errors?.[field] ? `<p id="model-wizard-${escape(field)}-error" class="field-error" role="alert">${escape(errors[field])}</p>` : '');
const invalid = (errors, field) => (errors?.[field] ? ` aria-invalid="true" aria-describedby="model-wizard-${escape(field)}-error"` : '');
// Connect-step errors are written in place (re-rendering would clear the key), so their containers always exist; `.field-error:empty` hides them.
const slotError = (errors, field) => `<p id="model-wizard-${escape(field)}-error" class="field-error" role="alert">${escape(errors?.[field] ?? '')}</p>`;
const providerName = (providers, id) => providers.find((provider) => provider.id === id)?.displayName ?? String(id ?? 'Unknown provider');
const profileStatusClass = { ACTIVE: 'active', DISABLED: '', SYNC_PENDING: 'pending', SYNC_FAILED: 'failed' };
const profileStatusLabel = { ACTIVE: 'Active', DISABLED: 'Disabled', SYNC_PENDING: 'Sync pending', SYNC_FAILED: 'Sync failed' };

export function renderWizardSteps(step) {
  return WIZARD_STEPS.map((entry, index) => `<li class="${index < step ? 'done' : ''}"${index === step ? ' aria-current="step"' : ''}><span class="wizard-step-index" aria-hidden="true">${index + 1}</span>${escape(entry.label)}</li>`).join('');
}

function stepHeading(state, title) {
  return `<h3 id="model-wizard-step-heading" class="wizard-step-heading" tabindex="-1"><span class="sr-only">Step ${state.step + 1} of ${WIZARD_STEPS.length}: </span>${escape(title)}</h3>`;
}

function renderProviderStep(state, context) {
  if (context.providersStatus === 'loading') return `${stepHeading(state, 'Choose a provider')}<p class="empty-note" role="status">Loading providers…</p>`;
  if (context.providersStatus === 'error') {
    return `${stepHeading(state, 'Choose a provider')}<p class="field-error" role="alert">${escape(context.providersError ?? 'Providers could not be loaded.')}</p><div class="form-row-actions"><button type="button" data-wizard-action="retry-providers">Try again</button></div>`;
  }
  const choices = context.providers.map((provider) => {
    const keys = context.credentials.filter((credential) => credential.provider === provider.id && credential.status === 'ACTIVE').length;
    return `<label class="wizard-choice"><input type="radio" name="provider" value="${escape(provider.id)}"${state.provider === provider.id ? ' checked' : ''}><span class="wizard-choice-title">${escape(provider.displayName)}</span><span class="wizard-choice-note">${escape(provider.description)}</span><span class="wizard-choice-meta">${keys ? `${keys} saved key${keys === 1 ? '' : 's'}` : 'No saved key yet'}</span></label>`;
  }).join('');
  return `${stepHeading(state, 'Choose a provider')}<fieldset class="wizard-choices"${invalid(context.errors, 'provider')}><legend class="sr-only">Provider</legend>${choices}</fieldset>${fieldError(context.errors, 'provider')}`;
}

function renderConnectStep(state, context) {
  const provider = context.provider;
  const saved = context.credentials.filter((credential) => credential.provider === state.provider && credential.status === 'ACTIVE');
  const choice = saved.length ? state.credentialChoice : 'new';
  const options = saved.map((credential) => {
    const check = credential.lastVerification ? ` · key ${verificationLabel(credential.lastVerification.outcome).toLowerCase()}` : '';
    return `<option value="${escape(credential.id)}"${credential.id === state.credentialId ? ' selected' : ''}>${escape(credential.label)} · v${escape(credential.activeVersion)}${escape(check)}</option>`;
  }).join('');
  const authModes = provider?.authModes ?? ['bearer'];
  const authMode = authModes.length > 1
    ? `<label for="model-wizard-auth-mode">Auth header</label><select id="model-wizard-auth-mode" name="newCredentialAuthMode">${authModes.map((mode) => `<option value="${escape(mode)}"${(state.newCredentialAuthMode || provider?.defaultAuthMode) === mode ? ' selected' : ''}>${mode === 'bearer' ? 'Authorization: Bearer' : 'X-API-Key'}</option>`).join('')}</select>`
    : '';
  const keyLink = provider?.apiKeyUrl ? `<p class="field-help">Create a key in the <a href="${escape(provider.apiKeyUrl)}" target="_blank" rel="noopener noreferrer">${escape(provider.displayName)} console</a>.</p>` : '';
  return `${stepHeading(state, `Connect ${provider?.displayName ?? 'the provider'}`)}
    <fieldset class="wizard-connect"><legend class="sr-only">Key to use</legend>
      <label class="checkbox-label"><input type="radio" name="credentialChoice" value="saved"${choice === 'saved' ? ' checked' : ''}${saved.length ? '' : ' disabled'}> Use a saved key${saved.length ? '' : ' (none saved for this provider)'}</label>
      <div class="wizard-subfields" data-wizard-section="saved"${choice === 'saved' ? '' : ' hidden'}>
        <label for="model-wizard-credential">Saved key</label>
        <select id="model-wizard-credential" name="credentialId"${invalid(context.errors, 'credentialId')}>${options}</select>${fieldError(context.errors, 'credentialId')}
      </div>
      <label class="checkbox-label"><input type="radio" name="credentialChoice" value="new"${choice === 'new' ? ' checked' : ''}> Add a new key</label>
      <div class="wizard-subfields" data-wizard-section="new"${choice === 'new' ? '' : ' hidden'}>
        <label for="model-wizard-credential-label">Label</label>
        <input id="model-wizard-credential-label" name="newCredentialLabel" maxlength="100" value="${escape(state.newCredentialLabel)}" placeholder="e.g. ${escape(provider?.displayName ?? 'Provider')} production"${invalid(context.errors, 'newCredentialLabel')}>${slotError(context.errors, 'newCredentialLabel')}
        ${authMode}
        <label for="model-wizard-api-key">API key (write-only)</label>
        <input id="model-wizard-api-key" name="apiKey" type="password" autocomplete="new-password" spellcheck="false" aria-describedby="model-wizard-api-key-help${context.errors?.apiKey ? ' model-wizard-apiKey-error' : ''}"${context.errors?.apiKey ? ' aria-invalid="true"' : ''}>${slotError(context.errors, 'apiKey')}
        <p id="model-wizard-api-key-help" class="field-help">The key is encrypted on the server when you continue and is never shown again.</p>
        ${keyLink}
      </div>
    </fieldset>`;
}

function renderSelectedModel(state) {
  const entry = state.selectedEntry;
  if (!state.model) return '<p class="field-help">No model chosen yet.</p>';
  if (!entry) return `<dl class="facts wizard-facts"><dt>Model ID</dt><dd class="mono wrap">${escape(state.model)}</dd><dt>Source</dt><dd>${state.mode === 'edit' && state.model === state.profile?.activeRevision?.model ? 'Saved on this profile' : 'Entered by you; not in the catalog'}</dd></dl>`;
  const capabilities = Object.entries(entry.capabilities ?? {}).filter(([, value]) => value === 'reported').map(([name]) => name);
  return `<dl class="facts wizard-facts"><dt>Model</dt><dd>${escape(entry.displayName)} <span class="mono wrap">${escape(entry.providerModelId)}</span></dd><dt>Availability</dt><dd>${escape(availabilityLabel(entry.availability))}</dd><dt>Price per 1M</dt><dd>${escape(formatPrice(entry.pricing?.inputMicrosPerMillionTokens))} in / ${escape(formatPrice(entry.pricing?.outputMicrosPerMillionTokens))} out<br><small>${escape(priceProvenanceText(entry.pricing?.provenance))}</small></dd>${entry.contextWindow ? `<dt>Context window</dt><dd>${escape(entry.contextWindow.toLocaleString())} tokens</dd>` : ''}${capabilities.length ? `<dt>Reported</dt><dd>${escape(capabilities.join(', '))}</dd>` : ''}</dl>${entry.pricing?.hasConditionalPricing ? '<p class="field-help">The price also changes under conditions a saved profile cannot express, so some requests can cost more than shown.</p>' : ''}`;
}

export function renderCatalogFreshness(catalog) {
  const refresh = '<button type="button" data-wizard-action="refresh-catalog">Refresh catalog</button>';
  if (catalog.status === 'loading') return `<p class="field-help" role="status">Searching the catalog…</p>`;
  if (catalog.status === 'error') return `<p class="field-error" role="alert">${escape(catalog.error ?? 'The catalog search failed.')}</p><div class="form-row-actions"><button type="button" data-wizard-action="retry-catalog">Try again</button>${refresh}</div>`;
  const notice = catalogFreshnessNotice(catalog.freshness);
  if (!notice) return '';
  const tone = notice.level === 'fresh' ? 'field-help' : notice.level === 'stale' ? 'warning' : 'field-error';
  return `<div class="catalog-freshness"><p class="${tone}">${escape(notice.text)}</p>${refresh}</div>${catalog.nextCursor ? '<p class="field-help">More models match. Type more of the name to narrow the list.</p>' : ''}`;
}

function renderModelStep(state, context) {
  const provider = context.provider;
  if (provider?.catalogStrategy === 'none') {
    return `${stepHeading(state, 'Enter the model ID')}<p class="field-help">${escape(provider.displayName)} has no catalog. Enter the exact model ID your endpoint serves.</p><label for="model-wizard-model">Model ID</label><input id="model-wizard-model" name="customModel" maxlength="${MODEL_ID_MAX}" autocomplete="off" spellcheck="false" value="${escape(state.model)}"${invalid(context.errors, 'customModel')}>${fieldError(context.errors, 'customModel')}`;
  }
  return `${stepHeading(state, 'Choose a model')}
    <label for="model-wizard-search">Search models</label>
    <div class="model-combobox">
      <input id="model-wizard-search" name="modelQuery" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="model-wizard-options" aria-describedby="model-wizard-search-help${context.errors?.customModel ? ' model-wizard-customModel-error' : ''}" autocomplete="off" spellcheck="false" maxlength="200" value="${escape(state.query)}"${context.errors?.customModel ? ' aria-invalid="true"' : ''}>
      <ul id="model-wizard-options" class="model-options" role="listbox" aria-label="Matching models" hidden></ul>
    </div>${fieldError(context.errors, 'customModel')}
    <p id="model-wizard-search-help" class="field-help">Type a name or ID. Use the arrow keys to move through matches, Enter to choose, and Escape to close the list. A model that is not listed can be used as a custom ID.</p>
    <p id="model-wizard-catalog-status" class="sr-only" aria-live="polite"></p>
    <div id="model-wizard-freshness">${renderCatalogFreshness(context.catalog)}</div>
    <div id="model-wizard-selection">${renderSelectedModel(state)}</div>`;
}

export function renderPermissionDiff(state) {
  const diff = permissionDiff(state.baseOperations, state.operations);
  const line = (operation, kind) => {
    const mutating = MUTATING_PROXY_OPERATIONS.includes(operation);
    const marker = { added: '+', removed: '−', kept: '=' }[kind];
    const label = { added: 'Allowed', removed: 'Removed', kept: 'Unchanged' }[kind];
    return `<li class="permission-${kind}${mutating ? ' permission-mutating' : ''}"><span aria-hidden="true">${marker}</span><span class="sr-only">${label}: </span><span class="mono">${escape(operation)}</span>${mutating ? ' <span class="permission-flag">changes files</span>' : ''}</li>`;
  };
  const rows = [...diff.added.map((operation) => line(operation, 'added')), ...diff.removed.map((operation) => line(operation, 'removed')), ...diff.kept.map((operation) => line(operation, 'kept'))];
  const summary = state.baseOperations.length
    ? `${diff.added.length} added, ${diff.removed.length} removed, ${diff.kept.length} unchanged`
    : `${diff.added.length} operation${diff.added.length === 1 ? '' : 's'} allowed`;
  return `<p class="field-help">${escape(summary)}${diff.addedMutating.length ? `; <strong>${escape(diff.addedMutating.length)} can change files</strong>` : ''}.</p><ul class="permission-diff">${rows.join('')}</ul>`;
}

function renderPermissions(state, context) {
  const preset = permissionPresetFor(state.operations);
  const presets = [...Object.entries(PERMISSION_PRESETS), ['custom', { label: 'Custom', description: 'Choose operations one by one.' }]]
    .map(([id, entry]) => `<label class="wizard-choice wizard-choice-compact"><input type="radio" name="permissionPreset" value="${escape(id)}"${preset === id ? ' checked' : ''}><span class="wizard-choice-title">${escape(entry.label)}</span><span class="wizard-choice-note">${escape(entry.description)}</span></label>`).join('');
  const boxes = PROXY_OPERATIONS.map((operation) => {
    const mutating = MUTATING_PROXY_OPERATIONS.includes(operation);
    return `<label><input type="checkbox" name="proxyOps" value="${escape(operation)}"${state.operations.includes(operation) ? ' checked' : ''}> ${escape(operation)}${mutating ? ' <span class="permission-flag">changes files</span>' : ''}</label>`;
  }).join('');
  return `<fieldset class="wizard-permissions"${invalid(context.errors, 'operations')}><legend>Allowed proxy operations</legend><div class="wizard-choices wizard-choices-compact">${presets}</div><div class="tools-checkbox-grid">${boxes}</div>${fieldError(context.errors, 'operations')}<div id="model-wizard-permission-diff">${renderPermissionDiff(state)}</div>${state.retainedOperations?.length ? `<p class="field-help">Also kept from the saved profile (granted through the MCP profile tools and decided by execution policy): <span class="mono">${escape(state.retainedOperations.join(', '))}</span>.</p>` : ''}</fieldset>`;
}

function renderAdvanced(state, context) {
  const provider = context.provider;
  const modes = providerApiModes(provider);
  const modeLabel = { 'chat-completions': 'Chat Completions', responses: 'Responses' };
  const open = context.advancedOpen || Object.keys(context.errors ?? {}).some((field) => ADVANCED_FIELDS.has(field));
  const keptUrl = state.mode === 'edit' && provider?.requiresCustomUpstream && effectiveUpstream({ ...state, customUpstreamUrl: '' }, provider);
  const upstream = provider?.requiresCustomUpstream
    ? `<label for="model-wizard-upstream">Custom upstream URL</label><input id="model-wizard-upstream" name="customUpstreamUrl" type="url" inputmode="url" maxlength="1024" placeholder="https://api.example.com/v1/chat/completions" value="${escape(state.customUpstreamUrl)}"${invalid(context.errors, 'customUpstreamUrl')}>${fieldError(context.errors, 'customUpstreamUrl')}<p class="field-help">${keptUrl ? 'Leave empty to keep the saved URL. Changing the key or API mode needs the URL again.' : 'HTTPS on port 443. The key is sent to this URL.'}</p>`
    : '';
  const number = (field, label, attributes) => `<div><label for="model-wizard-${field}">${label}</label><input id="model-wizard-${field}" name="${field}" inputmode="decimal" ${attributes} value="${escape(state[field])}"${invalid(context.errors, field)}>${fieldError(context.errors, field)}</div>`;
  return `<details id="model-wizard-advanced" class="row-edit wizard-advanced"${open ? ' open' : ''}><summary>Advanced settings</summary>
    <div class="wizard-advanced-body">
      <label for="model-wizard-profile-id">Profile ID</label>
      <input id="model-wizard-profile-id" name="profileId" maxlength="80" pattern="[A-Za-z0-9._-]+" autocomplete="off" spellcheck="false" value="${escape(state.profileId)}"${state.mode === 'edit' ? ' disabled aria-describedby="model-wizard-profile-id-help"' : invalid(context.errors, 'profileId')}>${fieldError(context.errors, 'profileId')}
      ${state.mode === 'edit' ? '<p id="model-wizard-profile-id-help" class="field-help">A saved profile keeps its ID.</p>' : '<p class="field-help">Derived from the model and unique among your profiles. Agents select the profile by this ID.</p>'}
      <label for="model-wizard-api-mode">API mode</label>
      <select id="model-wizard-api-mode" name="apiMode"${invalid(context.errors, 'apiMode')}>${modes.map((mode) => `<option value="${escape(mode)}"${state.apiMode === mode ? ' selected' : ''}>${escape(modeLabel[mode])}</option>`).join('')}</select>${fieldError(context.errors, 'apiMode')}
      ${modes.length === 1 ? `<p class="field-help">${escape(provider?.displayName ?? 'This provider')} offers only ${escape(modeLabel[modes[0]])}.</p>` : ''}
      ${upstream}
      <label for="model-wizard-custom-model">Model ID</label>
      <input id="model-wizard-custom-model" name="customModel" maxlength="${MODEL_ID_MAX}" autocomplete="off" spellcheck="false" value="${escape(state.model)}"${invalid(context.errors, 'customModel')}>${fieldError(context.errors, 'customModel')}
      <p class="field-help">Overrides the model chosen from the catalog. A typed ID has no catalog price or availability.</p>
      <div class="form-row">${number('pricingInput', 'Input $ per 1M tokens', 'type="text"')}${number('pricingOutput', 'Output $ per 1M tokens', 'type="text"')}</div>
      <p class="field-help">Per-run limits are hard caps for one agent run.</p>
      <div class="form-row">${number('maxInputTokens', 'Max input tokens', 'type="text" inputmode="numeric"')}${number('maxOutputTokens', 'Max output tokens', 'type="text" inputmode="numeric"')}${number('maxCost', 'Max cost per run ($)', 'type="text"')}</div>
    </div></details>`;
}

function priceFact(state, field) {
  const micros = microsFromDollars(state[field]);
  return micros === null ? '<span class="status stale">Unknown</span> <small>Enter it under Advanced settings.</small>' : `${escape(formatPrice(micros))}`;
}

/** What the save records for the prices; an override is marked so a typed price is never mistaken for the catalog's. */
function renderPriceSaveBadge(state) {
  const kind = pricingSaveKind(state);
  return `<span class="${statusClass(kind === 'override' ? 'info' : '')}" data-price-save="${escape(kind ?? 'unset')}">${escape(pricingSaveLabel(state))}</span>`;
}

function renderReviewFacts(state, context) {
  const credential = context.credentials.find((entry) => entry.id === state.credentialId);
  const provenance = state.touched.has('pricingInput') || state.touched.has('pricingOutput') ? { source: 'user' } : state.pricingProvenance;
  return `<dl class="facts wizard-facts">
      <dt>Provider</dt><dd>${escape(context.provider?.displayName ?? state.provider)}</dd>
      <dt>Key</dt><dd>${escape(credential?.label ?? 'Not chosen')}</dd>
      <dt>Model</dt><dd class="mono wrap">${escape(state.model || 'Not chosen')}</dd>
      ${state.selectedEntry ? `<dt>Availability</dt><dd>${escape(availabilityLabel(state.selectedEntry.availability))}</dd>` : ''}
      <dt>Input price per 1M</dt><dd>${priceFact(state, 'pricingInput')}</dd>
      <dt>Output price per 1M</dt><dd>${priceFact(state, 'pricingOutput')}</dd>
      <dt>Price source</dt><dd>${escape(priceProvenanceText(provenance))}</dd>
      <dt>Saved as</dt><dd>${renderPriceSaveBadge(state)}</dd>
      <dt>Per-run limit</dt><dd>${escape(formatPrice(microsFromDollars(state.maxCost)))} · ${escape(state.maxInputTokens)} in / ${escape(state.maxOutputTokens)} out tokens</dd>
    </dl>`;
}

function renderReviewStep(state, context) {
  return `${stepHeading(state, 'Review the profile')}
    <div id="model-wizard-review-facts">${renderReviewFacts(state, context)}</div>
    <label for="model-wizard-display-name">Display name</label>
    <input id="model-wizard-display-name" name="displayName" maxlength="100" value="${escape(state.displayName)}"${invalid(context.errors, 'displayName')}>${fieldError(context.errors, 'displayName')}
    ${renderPermissions(state, context)}
    ${renderAdvanced(state, context)}`;
}

export function renderVerificationResult(result) {
  if (!result) return '';
  const rows = (result.checks ?? []).map((check) => {
    const detail = [check.errorCategory ? check.errorCategory.replace(/_/g, ' ') : '', check.httpStatus ? `HTTP ${check.httpStatus}` : '', check.message ?? ''].filter(Boolean).join(' · ');
    return `<li><span class="mono">${escape(check.name.replace(/_/g, ' '))}</span> ${verificationPill(check.outcome)}${detail ? ` <small class="wrap">${escape(detail)}</small>` : ''}</li>`;
  }).join('');
  const usage = result.usage ? ` Used ${escape(result.usage.inputTokens)} input and ${escape(result.usage.outputTokens)} output tokens.` : '';
  return `<div class="verification-result"><p>${verificationPill(result.outcome)} <span>Checked ${timeText(result.checkedAt)} in ${escape(result.elapsedMs)} ms.${usage}</span></p>${rows ? `<ul class="verification-checks">${rows}</ul>` : ''}</div>`;
}

/** The save step's gate area: what still blocks saving, and the explicit choices that lift it. */
export function renderSaveGate(state, provider) {
  const gate = wizardSaveGate(state, provider);
  const unverified = gate.verified
    ? '<p class="field-help">This route is verified.</p>'
    : `<label class="checkbox-label"><input type="checkbox" name="saveUnverified"${state.saveUnverifiedKey === gate.routeKey ? ' checked' : ''}> Save without a verified connection</label>`;
  const mutating = gate.diff.addedMutating.length
    ? `<label class="checkbox-label"><input type="checkbox" name="acknowledgeMutating"${state.mutatingAckKey === gate.operationsKey ? ' checked' : ''}> Allow the subagent to change files: <span class="mono">${escape(gate.diff.addedMutating.join(', '))}</span></label>`
    : '';
  const reasons = gate.reasons.length ? `<ul class="gate-reasons">${gate.reasons.map((reason) => `<li>${escape(reason)}</li>`).join('')}</ul>` : '<p class="field-help">Ready to save.</p>';
  return `${unverified}${mutating}${reasons}`;
}

function renderVerifyStep(state, context) {
  const verification = state.verification;
  const gate = wizardSaveGate(state, context.provider);
  const stale = verification && verification.key !== gate.routeKey;
  const saved = !verification && state.savedRoute?.key === gate.routeKey
    ? `<p class="field-help">The saved route was last checked as ${escape(verificationLabel(state.savedRoute.outcome).toLowerCase())}.</p>` : '';
  return `${stepHeading(state, 'Verify and save')}
    <dl class="facts wizard-facts"><dt>Profile</dt><dd>${escape(state.displayName)} <span class="mono">${escape(state.profileId)}</span></dd><dt>Route</dt><dd class="mono wrap">${escape(state.model)} · ${escape(state.apiMode)}</dd><dt>Price</dt><dd>${renderPriceSaveBadge(state)}</dd></dl>
    <section class="wizard-section" aria-labelledby="model-wizard-permission-heading"><h4 id="model-wizard-permission-heading">Permission changes</h4>${renderPermissionDiff(state)}</section>
    <section class="wizard-section" aria-labelledby="model-wizard-verify-heading"><h4 id="model-wizard-verify-heading">Connection check</h4>
      <p class="field-help">Sends a tiny request from the server with the stored key. It spends a few tokens on your provider account.</p>
      <label class="checkbox-label"><input type="checkbox" name="checkTools"${state.checkTools ? ' checked' : ''}> Also check tool calls</label>
      <div class="form-row-actions"><button type="button" data-wizard-action="verify">${verification ? 'Verify again' : 'Verify connection'}</button></div>
      <div id="model-wizard-verification" aria-live="polite">${stale ? '<p class="warning">The settings changed after the last check. Verify again.</p>' : ''}${verification?.result ? renderVerificationResult(verification.result) : ''}${verification?.error ? `<p class="field-error" role="alert">${escape(verification.error)}</p>` : ''}${saved}</div>
    </section>
    <div id="model-wizard-gate" class="wizard-gate">${renderSaveGate(state, context.provider)}</div>`;
}

const STEP_RENDERERS = [renderProviderStep, renderConnectStep, renderModelStep, renderReviewStep, renderVerifyStep];

export function renderWizardStep(state, context) {
  return STEP_RENDERERS[state.step](state, { errors: {}, ...context });
}

/* ───────────────────────── Profile list ───────────────────────── */

function profileFacts(profile, context) {
  const revision = profile.activeRevision;
  const credential = context.credentials.find((entry) => entry.id === (revision?.credentialId ?? profile.credentialId));
  const verification = profileVerification(profile);
  const verificationCell = `${verificationPill(verification.outcome)}${verification.checkedAt ? ` <small>${verification.current ? '' : 'earlier revision · '}${timeText(verification.checkedAt)}</small>` : ''}`;
  return {
    provider: credential ? providerName(context.providers, credential.provider) : 'Unknown provider',
    model: revision ? `${revision.model} · ${revision.apiMode}` : 'No active revision',
    credential: credential?.label ?? 'Missing key',
    pricingCell: revision ? renderSavedPricing(profile, { hasCatalog: context.providers.find((entry) => entry.id === credential?.provider)?.catalogStrategy !== 'none' }) : '-',
    limit: revision ? `${formatPrice(revision.limits.maxCostMicros)} · ${revision.limits.maxInputTokens.toLocaleString()} in / ${revision.limits.maxOutputTokens.toLocaleString()} out` : '-',
    verificationCell
  };
}

const priceLevel = (level) => `${formatSavedPrice(level.inputMicrosPerMillionTokens)} / ${formatSavedPrice(level.outputMicrosPerMillionTokens)}`;
const cachePrices = (level) => `cache read ${formatSavedPrice(level.cacheReadMicrosPerMillionTokens)} · cache write ${formatSavedPrice(level.cacheWriteMicrosPerMillionTokens)}`;

/**
 * A saved revision's prices as pinned: input and output, both cache prices, any
 * long-prompt tiers, where the prices came from, and the repricing warning with
 * its review action. `hasCatalog` is false for a provider whose registry entry has
 * no catalog. Every value is escaped here; the result is markup.
 */
export function renderSavedPricing(profile, { hasCatalog = true } = {}) {
  const revision = profile.activeRevision;
  const provenance = savedPriceProvenance(revision.priceProvenance);
  const tiers = (revision.pricing.tiers ?? []).map((tier) => `<small class="price-line">From ${escape(tier.minPromptTokens.toLocaleString())} prompt tokens: <span class="mono">${escape(priceLevel(tier))}</span>, ${escape(cachePrices(tier))}</small>`).join('');
  const notice = pricingReviewNotice(profile.pricingReview);
  const review = notice
    ? `<span class="pricing-review" data-pricing-review="${notice.isOverride ? 'override' : 'repriced'}"><span>${escape(notice.text)}</span> <button type="button" data-model-action="review-price" data-profile-id="${escape(profile.id)}" aria-label="${escape(`Review catalog price for ${profile.displayName}`)}">Review catalog price</button></span>`
    : '';
  const context = pricingReviewContext(profile.pricingReview, { hasCatalog });
  const unknown = context.unknown ? `<small class="price-line" data-pricing-note="unknown">${escape(PRICING_UNKNOWN_TEXT)}</small>` : '';
  const compared = context.comparedAt === null ? '' : `<small class="price-line" data-catalog-compared>Compared with the catalog from ${timeText(context.comparedAt)}</small>`;
  const conditional = context.conditional ? `<small class="price-line" data-conditional-pricing>${escape(CONDITIONAL_PRICING_TEXT)}</small>` : '';
  return `<span class="mono">${escape(priceLevel(revision.pricing))}</span>`
    + `<small class="price-line">${escape(cachePrices(revision.pricing))}</small>${tiers}`
    + `<span class="price-provenance"><span class="${statusClass(provenance.isOverride ? 'info' : '')}" data-price-provenance="${provenance.isOverride ? 'override' : 'catalog'}">${escape(provenance.badge)}</span> <small>${escape(provenance.text)}${provenance.retrievedAt ? ` · retrieved ${timeText(provenance.retrievedAt)}` : ''}</small></span>`
    + review + unknown + compared + conditional;
}

function profileActions(profile) {
  const id = escape(profile.id);
  const toggle = profile.status === 'DISABLED'
    ? `<button type="button" data-model-action="activate" data-profile-id="${id}">Activate</button>`
    : `<button type="button" data-model-action="disable" data-profile-id="${id}">Disable</button>`;
  return `<div class="row-actions"><button type="button" data-model-action="verify" data-profile-id="${id}"${profile.activeRevision ? '' : ' disabled'}>Verify</button><button type="button" data-model-action="edit" data-profile-id="${id}">Edit</button><button type="button" data-model-action="duplicate" data-profile-id="${id}">Duplicate</button>${toggle}<button type="button" class="danger" data-model-action="delete" data-profile-id="${id}">Delete</button></div>`;
}

const profileStatus = (profile) => `<span class="${statusClass(profileStatusClass[profile.status])}">${escape(profileStatusLabel[profile.status] ?? profile.status)}</span>`;

export function renderModelProfiles(profiles, context) {
  if (!profiles.length) {
    return '<div class="empty-note"><p>No model profiles yet. Add one to let subagents call a model through the gateway.</p><button type="button" data-model-action="add">Add profile</button></div>';
  }
  const rows = profiles.map((profile) => {
    const facts = profileFacts(profile, context);
    return `<tr><th scope="row"><strong>${escape(profile.displayName)}</strong> ${renderCopyChip({ value: profile.id, label: 'Profile ID' })}</th><td>${profileStatus(profile)}</td><td>${escape(facts.provider)}<br><span class="mono wrap">${escape(facts.model)}</span></td><td>${facts.verificationCell}</td><td>${escape(facts.credential)}</td><td>${facts.pricingCell}</td><td class="mono">${escape(facts.limit)}</td><td>${profileActions(profile)}</td></tr>`;
  }).join('');
  const cards = profiles.map((profile) => {
    const facts = profileFacts(profile, context);
    return `<li><h3>${escape(profile.displayName)}</h3><p>${renderCopyChip({ value: profile.id, label: 'Profile ID' })}</p><dl><dt>Status</dt><dd>${profileStatus(profile)}</dd><dt>Provider</dt><dd>${escape(facts.provider)}</dd><dt>Model</dt><dd class="mono wrap">${escape(facts.model)}</dd><dt>Verification</dt><dd>${facts.verificationCell}</dd><dt>Key</dt><dd>${escape(facts.credential)}</dd><dt>Price per 1M (in / out)</dt><dd>${facts.pricingCell}</dd><dt>Per-run limit</dt><dd class="mono">${escape(facts.limit)}</dd></dl>${profileActions(profile)}</li>`;
  }).join('');
  return `<div class="desktop-table"><table><caption>${escape(profiles.length)} model profile(s)</caption><thead><tr><th>Profile</th><th>Status</th><th>Provider / model</th><th>Verification</th><th>Key</th><th>Price per 1M (in / out)</th><th>Per-run limit</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div><ul class="mobile-list">${cards}</ul>`;
}

export function renderModelCredentials(credentials, context) {
  if (!credentials.length) return '<p class="empty-note">No provider keys yet. The profile wizard adds one, or use Add credential.</p>';
  const facts = (credential) => ({
    provider: providerName(context.providers, credential.provider),
    check: credential.lastVerification ? `${verificationPill(credential.lastVerification.outcome)} <small>${timeText(credential.lastVerification.checkedAt)}</small>` : verificationPill('not_tested'),
    status: `<span class="status ${escape(credential.status === 'ACTIVE' ? 'active' : 'failed')}">${escape(credential.status.toLowerCase())}</span>`
  });
  const actions = (credential) => `<div class="row-actions"><button type="button" data-model-action="rotate-credential" data-credential-id="${escape(credential.id)}">Rotate</button><button type="button" class="danger" data-model-action="delete-credential" data-credential-id="${escape(credential.id)}">Delete</button></div>`;
  const rows = credentials.map((credential) => {
    const fact = facts(credential);
    return `<tr><th scope="row"><strong>${escape(credential.label)}</strong> ${renderCopyChip({ value: credential.id, label: 'Credential ID' })}</th><td>${escape(fact.provider)}</td><td class="mono">Stored · v${escape(credential.activeVersion)}</td><td>${fact.check}</td><td>${fact.status}</td><td>${actions(credential)}</td></tr>`;
  }).join('');
  const cards = credentials.map((credential) => {
    const fact = facts(credential);
    return `<li><h3>${escape(credential.label)}</h3><p>${renderCopyChip({ value: credential.id, label: 'Credential ID' })}</p><dl><dt>Provider</dt><dd>${escape(fact.provider)}</dd><dt>Key</dt><dd class="mono">Stored · v${escape(credential.activeVersion)}</dd><dt>Key check</dt><dd>${fact.check}</dd><dt>Status</dt><dd>${fact.status}</dd></dl>${actions(credential)}</li>`;
  }).join('');
  return `<div class="desktop-table"><table><caption>${escape(credentials.length)} provider key(s)</caption><thead><tr><th>Key</th><th>Provider</th><th>Secret</th><th>Key check</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div><ul class="mobile-list">${cards}</ul>`;
}

/** The gateway badge, when the runner last pushed a snapshot successfully since it started, and why the last push failed. */
function renderGatewaySync(status) {
  if (!status) return '<span class="status">Gateway status unavailable</span>';
  const badge = `<span class="status ${status.gatewaySynced ? 'active' : 'pending'}">${status.gatewaySynced ? 'Gateway synchronized' : 'Gateway sync pending'}</span>`;
  const last = Number.isFinite(status.lastSyncTime) ? timeText(status.lastSyncTime) : 'Never since the runner started';
  const error = typeof status.error === 'string' && status.error ? `<br>${escape(status.error)}` : '';
  return `<div>${badge}<p class="field-help">Last successful sync: ${last}${error}</p></div>`;
}

/* ───────────────────────── Spend and limits ───────────────────────── */

/** The largest limit a spend policy accepts, in micro-USD ($1,000,000). */
export const SPEND_LIMIT_MAX_MICROS = 1_000_000_000_000;
export const SPEND_DEFAULT_WARN_PERCENT = 80;
export const SPEND_HELP_TEXT = 'Every figure is an estimate, not provider billing. A run\'s cap is reserved until the run ends; it then counts at the cost the model gateway charged. Unreconciled runs lost their gateway accounting and stay at their full cap. Days and months are UTC, and a run counts in the day and month it started.';

const SPEND_PERIOD_LABELS = { day: 'Today (UTC)', month: 'This month (UTC)' };
const SPEND_POLICY_PERIOD_LABELS = { day: 'Daily', month: 'Monthly' };
const THRESHOLD_LABELS = { ok: 'OK', warning: 'Warning', exceeded: 'Exceeded' };
// Success, warning, and danger pills, as the status grammar in docs/design-guidelines.md assigns them.
const THRESHOLD_CLASSES = { ok: 'active', warning: 'stale', exceeded: 'failed' };

/**
 * US dollars typed by the operator to integer micro-USD, using integer maths
 * only: the digits are split at the decimal point and scaled as BigInt, so no
 * binary fraction ever rounds a limit. Returns `{ micros }` or `{ error }`.
 */
export function parseSpendLimit(text) {
  const raw = String(text ?? '').trim().replace(/^\$\s*/, '');
  if (!raw) return { error: 'Enter a limit in US dollars.' };
  if (raw.startsWith('-')) return { error: 'Enter an amount above $0.' };
  // Digits on either side of the point: 25, 12.50, 25. and .5 are all amounts.
  const match = /^(\d*)(?:\.(\d*))?$/.exec(raw);
  const whole = match?.[1] ?? '';
  const fraction = match?.[2] ?? '';
  if (!match || (!whole && !fraction)) return { error: 'Enter a dollar amount such as 25 or 12.50.' };
  if (fraction.length > 6) return { error: 'Use at most six decimal places.' };
  const micros = BigInt(whole || '0') * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (micros <= 0n) return { error: 'Enter an amount above $0.' };
  if (micros > BigInt(SPEND_LIMIT_MAX_MICROS)) return { error: 'Keep the limit at or below $1,000,000.' };
  return { micros: Number(micros) };
}

/** A warning threshold typed as a whole percentage from 1 to 100. */
export function parseWarnPercent(text) {
  const raw = String(text ?? '').trim();
  if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 100) return { error: 'Enter a whole percentage from 1 to 100.' };
  return { percent: Number(raw) };
}

/** An estimated amount in dollars; never blank, so a zero reads as $0.00 rather than missing. */
const spendAmount = (micros) => `$${dollarsFromMicros(Number.isSafeInteger(micros) && micros >= 0 ? micros : 0)}`;
const estimateFigure = (micros) => `<span class="mono">${escape(spendAmount(micros))}</span> <span class="estimate-tag">Estimate</span>`;

function spendScopeLabel(window, profiles) {
  if (window.scope === 'principal') return 'All runs';
  const profile = profiles.find((entry) => entry.id === window.profileId);
  return profile ? `${profile.displayName} (${profile.id})` : `${window.profileId} (profile deleted)`;
}

function thresholdBadge(state) {
  if (!state) return '<span class="status" data-threshold="none">No limit</span>';
  return `<span class="${statusClass(THRESHOLD_CLASSES[state])}" data-threshold="${escape(state)}">${escape(THRESHOLD_LABELS[state] ?? state)}</span>`;
}

function spendRowActions(window, scope, profiles) {
  const period = SPEND_POLICY_PERIOD_LABELS[window.period].toLowerCase();
  if (window.policy) {
    const id = escape(window.policy.id);
    return `<div class="row-actions"><button type="button" data-spend-action="edit" data-policy-id="${id}" aria-label="${escape(`Edit the ${period} limit for ${scope}`)}">Edit limit</button><button type="button" class="danger" data-spend-action="delete" data-policy-id="${id}" aria-label="${escape(`Delete the ${period} limit for ${scope}`)}">Delete limit</button></div>`;
  }
  // A new profile policy must name a saved profile, so a deleted profile's row offers no limit.
  if (window.scope === 'profile' && !profiles.some((entry) => entry.id === window.profileId)) return '';
  return `<div class="row-actions"><button type="button" data-spend-action="add" data-profile-id="${escape(window.profileId ?? '')}" data-period="${escape(window.period)}" aria-label="${escape(`Set a ${period} limit for ${scope}`)}">Set limit</button></div>`;
}

function spendFacts(window, profiles) {
  const total = window.estimatedSettledMicros + window.estimatedReservedMicros + window.estimatedUnreconciledMicros;
  const scope = spendScopeLabel(window, profiles);
  return {
    scope,
    period: SPEND_PERIOD_LABELS[window.period] ?? window.period,
    settled: estimateFigure(window.estimatedSettledMicros),
    reserved: estimateFigure(window.estimatedReservedMicros),
    unreconciled: estimateFigure(window.estimatedUnreconciledMicros),
    total: estimateFigure(total),
    limit: window.policy ? `<span class="mono">${escape(spendAmount(window.policy.limitMicros))}</span> <small>warn at ${escape(window.policy.warnPercent)}%</small>` : '<span>None</span>',
    state: thresholdBadge(window.thresholdState),
    actions: spendRowActions(window, scope, profiles)
  };
}

export function renderSpendTable(summary, profiles = []) {
  const windows = Array.isArray(summary?.windows) ? summary.windows : [];
  if (!windows.length) return '<p class="empty-note">No spend recorded yet.</p>';
  const facts = windows.map((window) => spendFacts(window, profiles));
  const rows = facts.map((fact) => `<tr><th scope="row">${escape(fact.scope)}</th><td>${escape(fact.period)}</td><td>${fact.settled}</td><td>${fact.reserved}</td><td>${fact.unreconciled}</td><td>${fact.total}</td><td>${fact.limit}</td><td>${fact.state}</td><td>${fact.actions}</td></tr>`).join('');
  const cards = facts.map((fact) => `<li><h3>${escape(fact.scope)}</h3><p>${escape(fact.period)}</p><dl><dt>Settled</dt><dd>${fact.settled}</dd><dt>Reserved</dt><dd>${fact.reserved}</dd><dt>Unreconciled</dt><dd>${fact.unreconciled}</dd><dt>Total</dt><dd>${fact.total}</dd><dt>Limit</dt><dd>${fact.limit}</dd><dt>State</dt><dd>${fact.state}</dd></dl>${fact.actions}</li>`).join('');
  return `<div class="desktop-table"><table><caption>Estimated spend for the current UTC day and month</caption><thead><tr><th>Applies to</th><th>Period</th><th>Settled</th><th>Reserved</th><th>Unreconciled</th><th>Total</th><th>Limit</th><th>State</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div><ul class="mobile-list">${cards}</ul>`;
}

const spendFieldError = (errors, field) => (errors?.[field] ? `<p id="spend-policy-${field}-error" class="field-error" role="alert">${escape(errors[field])}</p>` : '');
const spendDescribedBy = (errors, field, help) => {
  const ids = [help, errors?.[field] ? `spend-policy-${field}-error` : ''].filter(Boolean).join(' ');
  return `${ids ? ` aria-describedby="${ids}"` : ''}${errors?.[field] ? ' aria-invalid="true"' : ''}`;
};

/** The create or edit form. An edit keeps the policy's scope and period, which a policy can never change. */
export function renderSpendPolicyForm(editor, profiles = []) {
  const editing = editor.mode === 'edit';
  const errors = editor.errors ?? {};
  const lock = editing ? ' disabled' : '';
  const scopes = [['', 'All runs (account)'], ...profiles.map((profile) => [profile.id, `${profile.displayName} (${profile.id})`])];
  // A policy whose profile was deleted still names it, so an edit can show its scope.
  if (editor.profileId && !scopes.some(([id]) => id === editor.profileId)) scopes.push([editor.profileId, `${editor.profileId} (profile deleted)`]);
  const scopeOptions = scopes.map(([id, label]) => `<option value="${escape(id)}"${(editor.profileId ?? '') === id ? ' selected' : ''}>${escape(label)}</option>`).join('');
  const periodOptions = Object.entries(SPEND_POLICY_PERIOD_LABELS).map(([id, label]) => `<option value="${id}"${editor.period === id ? ' selected' : ''}>${label} (UTC ${id})</option>`).join('');
  return `<form id="spend-policy-form" class="spend-policy-form" novalidate aria-labelledby="spend-policy-heading"${editor.busy ? ' aria-busy="true"' : ''}>
    <h3 id="spend-policy-heading">${editing ? 'Edit spend limit' : 'Add a spend limit'}</h3>
    <div class="form-row">
      <div><label for="spend-policy-scope">Applies to</label><select id="spend-policy-scope" name="profileId"${lock}>${scopeOptions}</select></div>
      <div><label for="spend-policy-period">Period</label><select id="spend-policy-period" name="period"${lock}>${periodOptions}</select></div>
    </div>
    ${editing ? '<p class="field-help">A limit keeps its scope and period. To change them, delete it and add a new one.</p>' : ''}
    <div class="form-row">
      <div><label for="spend-policy-limit">Limit (USD)</label><input id="spend-policy-limit" name="limit" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${escape(editor.limit ?? '')}"${spendDescribedBy(errors, 'limit', 'spend-policy-limit-help')}>${spendFieldError(errors, 'limit')}<p id="spend-policy-limit-help" class="field-help">US dollars, up to six decimal places, at most $1,000,000.</p></div>
      <div><label for="spend-policy-warn">Warn at (% of limit)</label><input id="spend-policy-warn" name="warnPercent" type="text" inputmode="numeric" autocomplete="off" value="${escape(editor.warnPercent ?? '')}"${spendDescribedBy(errors, 'warnPercent', '')}>${spendFieldError(errors, 'warnPercent')}</div>
    </div>
    <div class="form-row-actions"><button type="submit"${editor.busy ? ' disabled' : ''}>${editing ? 'Save limit' : 'Add limit'}</button>${editing ? `<button type="button" data-spend-action="cancel-edit"${editor.busy ? ' disabled' : ''}>Cancel</button>` : ''}</div>
  </form>`;
}

/** The whole panel body: help, status line, the spend table, and the policy editor. */
export function renderSpendPanel(view) {
  const message = view.message
    ? `<p id="model-spend-status" class="form-status${view.message.tone === 'error' ? ' field-error' : ''}" role="${view.message.tone === 'error' ? 'alert' : 'status'}">${escape(view.message.text)}</p>`
    : '<p id="model-spend-status" class="form-status" role="status"></p>';
  let body;
  if (view.status === 'loading') body = '<p class="empty-note" role="status">Loading spend…</p>';
  else if (view.status === 'error') body = `<p class="field-error" role="alert">${escape(view.error ?? 'Spend could not be loaded.')}</p><div class="form-row-actions"><button type="button" data-spend-action="retry">Try again</button></div>`;
  else body = `${renderSpendTable(view.summary, view.profiles)}${renderSpendPolicyForm(view.editor, view.profiles)}`;
  return `<div class="record-heading"><h2 id="model-spend-heading">Spend and limits</h2><span class="estimate-tag">Estimate</span></div>
    <p id="model-spend-help" class="field-help">${escape(SPEND_HELP_TEXT)}</p>${message}${body}`;
}

const blankSpendEditor = () => ({ mode: 'create', policyId: null, generation: null, profileId: '', period: 'day', limit: '', warnPercent: String(SPEND_DEFAULT_WARN_PERCENT), errors: {}, busy: false });
const editorForPolicy = (policy) => ({
  mode: 'edit', policyId: policy.id, generation: policy.generation, profileId: policy.profileId ?? '', period: policy.period,
  limit: dollarsFromMicros(policy.limitMicros), warnPercent: String(policy.warnPercent), errors: {}, busy: false
});

/** A refusal that means the panel's copy is out of date: re-read it before trying again. */
const isStaleRefusal = (error) => error?.status === 409 || error?.status === 404 || error?.code === 'conflict' || error?.code === 'not_found';

/**
 * The spend panel and its policy editor. One delegated listener set on the
 * section drives every control, so re-rendering never stacks listeners. A save
 * or delete that the API refuses as stale re-reads the summary; the API's own
 * refusal text is what the operator sees.
 */
export function createSpendPanel({ section, insert, api, announce, confirm, profiles = [] }) {
  const view = { status: 'loading', summary: null, error: null, message: null, profiles, editor: blankSpendEditor() };
  let loadSequence = 0;
  let busy = false;

  const policies = () => (view.summary?.windows ?? []).flatMap((window) => (window.policy ? [window.policy] : []));
  const render = () => insert(section, renderSpendPanel(view));
  const field = (name) => section.querySelector(`#spend-policy-form [name="${name}"]`);

  async function load() {
    const sequence = ++loadSequence;
    try {
      const result = await api.getSpend();
      if (sequence !== loadSequence) return;
      const summary = result?.data?.summary;
      if (!summary || !Array.isArray(summary.windows)) throw new Error('The spend summary could not be read.');
      Object.assign(view, { status: 'ready', summary, error: null });
    } catch (error) {
      if (sequence !== loadSequence || error?.name === 'AbortError') return;
      Object.assign(view, { status: 'error', error: errorMessage(error, 'Spend could not be loaded.') });
    }
  }

  async function refresh() {
    await load();
    render();
  }

  /** Keeps what the operator typed, so a refused save or a re-render never loses it. */
  function readEditor() {
    for (const name of ['limit', 'warnPercent', ...(view.editor.mode === 'edit' ? [] : ['profileId', 'period'])]) {
      const input = field(name);
      const value = String(input?.value ?? '');
      if (!input || (name === 'period' && !SPEND_POLICY_PERIOD_LABELS[value])) continue;
      view.editor[name] = value;
    }
  }

  function startEdit(policy) {
    view.editor = editorForPolicy(policy);
    view.message = null;
    render();
    field('limit')?.focus?.();
  }

  function startCreate({ profileId = '', period = 'day' } = {}) {
    view.editor = { ...blankSpendEditor(), profileId, period };
    view.message = null;
    render();
    field('limit')?.focus?.();
  }

  async function save() {
    readEditor();
    const editor = view.editor;
    const limit = parseSpendLimit(editor.limit);
    const warn = parseWarnPercent(editor.warnPercent);
    const errors = { ...(limit.error ? { limit: limit.error } : {}), ...(warn.error ? { warnPercent: warn.error } : {}) };
    if (Object.keys(errors).length) {
      editor.errors = errors;
      view.message = { tone: 'error', text: `Check the highlighted field: ${Object.values(errors)[0]}` };
      render();
      section.querySelector('[aria-invalid="true"]')?.focus?.();
      return;
    }
    const scope = editor.profileId ? { profileId: editor.profileId } : {};
    const payload = editor.mode === 'edit'
      ? { policyId: editor.policyId, ...scope, period: editor.period, limitMicros: limit.micros, warnPercent: warn.percent, expectedGeneration: editor.generation }
      : { ...scope, period: editor.period, limitMicros: limit.micros, warnPercent: warn.percent };
    editor.errors = {};
    editor.busy = true;
    view.message = { tone: '', text: 'Saving…' };
    render();
    try {
      await api.setPolicy(payload);
      view.editor = blankSpendEditor();
      view.message = { tone: '', text: editor.mode === 'edit' ? 'Spend limit updated.' : 'Spend limit added.' };
      announce(view.message.text);
      await refresh();
    } catch (error) {
      editor.busy = false;
      const text = errorMessage(error, 'The spend limit could not be saved.');
      if (isStaleRefusal(error)) {
        await load();
        // An edit follows the policy's current values, including a policy that was
        // deleted and recreated for the same scope and period under a new id; a create
        // keeps what was typed.
        if (editor.mode === 'edit') {
          const scopeProfileId = editor.profileId || null;
          const latest = policies().find((policy) => policy.id === editor.policyId)
            ?? policies().find((policy) => (policy.profileId ?? null) === scopeProfileId && policy.period === editor.period);
          view.editor = latest ? editorForPolicy(latest) : { ...editor, mode: 'create', policyId: null, generation: null };
        }
      }
      view.message = { tone: 'error', text };
      render();
    }
  }

  async function remove(policy) {
    try {
      await api.deletePolicy(policy.id, policy.generation);
      if (view.editor.policyId === policy.id) view.editor = blankSpendEditor();
      view.message = { tone: '', text: 'Spend limit deleted.' };
      announce(view.message.text);
    } catch (error) {
      if (isStaleRefusal(error)) await load();
      view.message = { tone: 'error', text: errorMessage(error, 'The spend limit could not be deleted.') };
      render();
      return;
    }
    await refresh();
  }

  /** A change confirmed while another is still saving is refused out loud, never dropped. */
  function refuseWhileBusy() {
    view.message = { tone: 'error', text: 'Another spend limit change is still saving. Delete the limit again once it finishes.' };
    render();
  }

  async function run(task) {
    if (busy) return;
    busy = true;
    try { await task(); } finally { busy = false; }
  }

  section.addEventListener('submit', (event) => {
    if (event.target?.id !== 'spend-policy-form') return;
    event.preventDefault();
    void run(save);
  });
  section.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-spend-action]');
    if (!button || busy) return;
    const action = button.dataset.spendAction;
    const policy = policies().find((entry) => entry.id === button.dataset.policyId);
    if (action === 'retry') { view.status = 'loading'; render(); void run(refresh); }
    else if (action === 'add') startCreate({ profileId: button.dataset.profileId ?? '', period: button.dataset.period ?? 'day' });
    else if (action === 'cancel-edit') startCreate();
    else if (action === 'edit' && policy) startEdit(policy);
    else if (action === 'delete' && policy) {
      const scope = spendScopeLabel({ scope: policy.profileId ? 'profile' : 'principal', profileId: policy.profileId }, view.profiles);
      confirm({
        title: 'Delete spend limit?', label: 'Delete limit', pendingLabel: 'Deleting…', target: `${SPEND_POLICY_PERIOD_LABELS[policy.period]} limit · ${scope}`,
        description: 'Runs in this scope are no longer stopped by this limit. Recorded spend is kept.',
        action: () => (busy ? refuseWhileBusy() : run(() => remove(policy)))
      }, button);
    }
  });

  return {
    async load() { render(); await refresh(); },
    get view() { return view; }
  };
}

export function renderModelsPage({ profiles = [], credentials = [], status = null, providers = [] } = {}) {
  const context = { profiles, credentials, providers };
  const sync = renderGatewaySync(status);
  return `<div id="models-page" class="models-page">
    <p class="page-note"><strong>Subagent models.</strong> Each profile routes Pi subagents to one provider model with a price, per-run limits, and a ceiling on the file tools they may call. Provider keys are write-only: they are encrypted on the server and never sent back to the browser.</p>
    <section class="panel" aria-labelledby="model-profiles-heading"><div class="record-heading"><h2 id="model-profiles-heading">Model profiles</h2>${sync}</div>${renderModelProfiles(profiles, context)}</section>
    <section class="panel" aria-labelledby="model-credentials-heading"><h2 id="model-credentials-heading">Provider keys</h2>${renderModelCredentials(credentials, context)}</section>
    <section id="model-spend" class="panel model-spend" aria-labelledby="model-spend-heading">${renderSpendPanel({ status: 'loading', editor: blankSpendEditor(), profiles })}</section>
  </div>`;
}

/* ───────────────────────── Wizard controller ───────────────────────── */

const errorMessage = (error, fallback) => (error && typeof error.message === 'string' && error.message ? error.message : fallback);

/**
 * Binds the wizard dialog once. Each `open` starts a fresh state from the given
 * page data; every handler is delegated on the form, so re-rendering a step
 * never stacks listeners. Each open is a session: a request that finishes after
 * its session closed never writes into a later one.
 */
export function createModelWizard({ dialog, insert, api, announce, onSaved }) {
  const form = dialog.querySelector('#model-profile-form');
  const body = dialog.querySelector('#model-wizard-body');
  const steps = dialog.querySelector('#model-wizard-steps');
  const status = dialog.querySelector('#model-wizard-status');
  const back = dialog.querySelector('#model-wizard-back');
  const submit = dialog.querySelector('#submit-model-profile');
  const cancel = dialog.querySelector('#cancel-model-profile');
  const title = dialog.querySelector('#model-profile-title');
  let state;
  let context;
  let combobox;
  let catalogSequence = 0;
  let session = 0;
  let busy = false;
  let invoker;

  const provider = () => context.providers.find((entry) => entry.id === state.provider);
  const isCurrent = (token) => token === session;
  const setStatus = (message, tone = '') => { status.textContent = message; if (tone) status.dataset.saveState = tone; else delete status.dataset.saveState; };

  function setBusy(flag) {
    busy = flag;
    if (flag) form.setAttribute('aria-busy', 'true');
    else form.removeAttribute('aria-busy');
    submit.disabled = flag;
    back.disabled = flag;
    if (cancel) cancel.disabled = flag;
  }

  function renderStep({ focus = true } = {}) {
    combobox?.dispose();
    combobox = undefined;
    insert(steps, renderWizardSteps(state.step));
    insert(body, renderWizardStep(state, { ...context, provider: provider() }));
    back.hidden = state.step === 0;
    submit.textContent = state.step === WIZARD_STEPS.length - 1 ? (state.mode === 'edit' ? 'Save changes' : 'Save profile') : 'Continue';
    if (WIZARD_STEPS[state.step].id === 'model' && provider()?.catalogStrategy !== 'none') bindCombobox();
    if (focus) {
      const firstInvalid = body.querySelector('[aria-invalid="true"]');
      (firstInvalid ?? body.querySelector('#model-wizard-step-heading'))?.focus?.();
    }
  }

  function renderSelection() {
    const selection = body.querySelector('#model-wizard-selection');
    if (selection) insert(selection, renderSelectedModel(state));
  }

  function bindCombobox() {
    const input = body.querySelector('#model-wizard-search');
    const listbox = body.querySelector('#model-wizard-options');
    combobox = createModelCombobox({
      input, listbox, render: insert,
      onQuery: (query) => { state.query = query; void searchCatalog(query, { open: true }); },
      onCommit: (option) => {
        if (option.kind === 'entry') applyCatalogEntry(state, option.entry);
        else applyCustomModel(state, option.value);
        input.value = state.query;
        renderSelection();
        announce(`Selected ${state.model}.`);
      }
    });
    if (context.catalog.status === 'ready' && context.catalog.key === catalogKey()) combobox.setOptions(catalogOptions(context.catalog.entries, state.query), { open: false });
    else void searchCatalog(state.query, { open: false });
  }

  const catalogKey = () => `${state.provider}|${state.credentialId}`;

  async function searchCatalog(query, { open }) {
    const token = session;
    const sequence = ++catalogSequence;
    const key = catalogKey();
    context.catalog = { ...context.catalog, status: 'loading', key };
    const freshness = body.querySelector('#model-wizard-freshness');
    if (freshness) insert(freshness, renderCatalogFreshness(context.catalog));
    try {
      const result = await api.searchCatalog({ provider: state.provider, credentialId: state.credentialId, q: String(query ?? '').trim(), limit: 25 });
      if (!isCurrent(token) || sequence !== catalogSequence) return;
      const data = result?.data ?? {};
      context.catalog = { status: 'ready', key, entries: Array.isArray(data.entries) ? data.entries : [], freshness: data.freshness ?? null, nextCursor: data.nextCursor ?? null };
    } catch (error) {
      if (!isCurrent(token) || sequence !== catalogSequence || error?.name === 'AbortError') return;
      context.catalog = { status: 'error', key, entries: [], error: errorMessage(error, 'The catalog search failed.') };
    }
    const region = body.querySelector('#model-wizard-freshness');
    if (region) insert(region, renderCatalogFreshness(context.catalog));
    const options = catalogOptions(context.catalog.entries, query);
    combobox?.setOptions(options, { open });
    const live = body.querySelector('#model-wizard-catalog-status');
    if (live) live.textContent = context.catalog.status === 'error' ? 'The catalog search failed.' : `${context.catalog.entries.length} model${context.catalog.entries.length === 1 ? '' : 's'} found.`;
  }

  async function refreshCatalog(button) {
    const token = session;
    button.disabled = true;
    try {
      await api.refreshCatalog({ provider: state.provider, credentialId: state.credentialId });
      if (isCurrent(token)) announce('Catalog refreshed.');
    } catch (error) {
      if (isCurrent(token)) setStatus(errorMessage(error, 'The catalog could not be refreshed.'), 'error');
    } finally {
      button.disabled = false;
    }
    if (isCurrent(token)) await searchCatalog(state.query, { open: false });
  }

  /** The catalog buttons live in the region a search re-renders; put focus back on the one that was pressed. */
  function restoreCatalogFocus(action, token) {
    if (!isCurrent(token) || WIZARD_STEPS[state.step].id !== 'model') return;
    (body.querySelector(`[data-wizard-action="${action}"]`)
      ?? body.querySelector('[data-wizard-action="refresh-catalog"]')
      ?? body.querySelector('#model-wizard-search'))?.focus?.();
  }

  async function loadProviders() {
    const token = session;
    context.providersStatus = 'loading';
    renderStep({ focus: false });
    try {
      const result = await api.listProviders();
      if (!isCurrent(token)) return;
      context.providers = Array.isArray(result?.data?.providers) ? result.data.providers : [];
      context.providersStatus = 'ready';
    } catch (error) {
      if (!isCurrent(token)) return;
      context.providersStatus = 'error';
      context.providersError = errorMessage(error, 'Providers could not be loaded.');
    }
    renderStep();
  }

  function refreshPermissions() {
    const diff = body.querySelector('#model-wizard-permission-diff');
    if (diff) insert(diff, renderPermissionDiff(state));
    const preset = permissionPresetFor(state.operations);
    for (const radio of body.querySelectorAll('input[name="permissionPreset"]')) radio.checked = radio.value === preset;
  }

  /** Re-renders the gate. The checkbox that was toggled is replaced, so focus moves to its replacement. */
  function refreshGate(focusName) {
    const gate = body.querySelector('#model-wizard-gate');
    if (!gate) return;
    insert(gate, renderSaveGate(state, provider()));
    if (focusName) gate.querySelector(`input[name="${focusName}"]`)?.focus?.();
  }

  /** Keeps the review facts and derived inputs in step with the state after a field changes another. */
  function refreshReview(source) {
    for (const field of ['displayName', 'profileId', 'pricingInput', 'pricingOutput']) {
      const input = body.querySelector(`[name="${field}"]`);
      if (input && input !== source) input.value = state[field];
    }
    const facts = body.querySelector('#model-wizard-review-facts');
    if (facts) insert(facts, renderReviewFacts(state, { ...context, provider: provider() }));
  }

  function onField(event) {
    const target = event.target;
    const name = target?.name;
    if (!name || name === 'apiKey') return;
    if (name === 'modelQuery') {
      // Text typed after a choice no longer names that model; Continue then asks for a new choice.
      state.query = target.value;
      if (state.model && String(target.value ?? '').trim() !== state.model) {
        state.model = '';
        state.selectedEntry = null;
        renderSelection();
      }
      return;
    }
    if (name === 'provider') {
      if (state.provider !== target.value) {
        // Choosing another provider is a deliberate restart of the route; the profile's own fields stay.
        state.provider = target.value;
        const saved = context.credentials.find((credential) => credential.provider === state.provider && credential.status === 'ACTIVE');
        state.credentialId = saved?.id ?? '';
        state.credentialChoice = saved ? 'saved' : 'new';
        state.newCredentialAuthMode = '';
        state.selectedEntry = null;
        state.model = '';
        state.query = '';
        resetUntouchedPricing(state);
        const modes = providerApiModes(provider());
        if (!modes.includes(state.apiMode)) state.apiMode = modes[0] ?? 'chat-completions';
        context.catalog = { status: 'idle', entries: [] };
      }
      return;
    }
    if (name === 'credentialChoice') {
      state.credentialChoice = target.value;
      for (const section of body.querySelectorAll('[data-wizard-section]')) section.hidden = section.dataset.wizardSection !== target.value;
      return;
    }
    if (name === 'credentialId') { state.credentialId = target.value; context.catalog = { status: 'idle', entries: [] }; return; }
    if (name === 'permissionPreset') {
      if (target.value !== 'custom') {
        state.operations = [...PERMISSION_PRESETS[target.value].operations];
        for (const box of body.querySelectorAll('input[name="proxyOps"]')) box.checked = state.operations.includes(box.value);
      }
      refreshPermissions();
      return;
    }
    if (name === 'proxyOps') {
      state.operations = normalizeOperations([...body.querySelectorAll('input[name="proxyOps"]')].filter((box) => box.checked).map((box) => box.value));
      refreshPermissions();
      return;
    }
    if (name === 'checkTools') { state.checkTools = target.checked; return; }
    if (name === 'saveUnverified') { state.saveUnverifiedKey = target.checked ? wizardSaveGate(state, provider()).routeKey : null; refreshGate(name); return; }
    if (name === 'acknowledgeMutating') { state.mutatingAckKey = target.checked ? wizardSaveGate(state, provider()).operationsKey : null; refreshGate(name); return; }
    if (name === 'customModel') {
      applyCustomModel(state, target.value);
      state.touched.add('model');
      refreshReview(target);
      return;
    }
    if (name in state) {
      state[name] = target.value;
      state.touched.add(name);
      if (name === 'pricingInput' || name === 'pricingOutput') state.pricingProvenance = { source: 'user' };
      refreshReview(target);
    }
  }

  function showErrors(errors) {
    const message = Object.values(errors)[0];
    renderStep();
    setStatus(message ? `Check the highlighted field: ${message}` : '', 'error');
  }

  /** Marks or clears one connect-step field in place, so the write-only key field keeps its value. */
  function markConnectField(field, input, message) {
    const help = field === 'apiKey' ? 'model-wizard-api-key-help' : '';
    const error = body.querySelector(`#model-wizard-${field}-error`);
    if (error) error.textContent = message ?? '';
    if (!input) return;
    const describedBy = [help, message ? `model-wizard-${field}-error` : ''].filter(Boolean).join(' ');
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    if (describedBy) input.setAttribute('aria-describedby', describedBy);
    else input.removeAttribute('aria-describedby');
  }

  async function connect(token) {
    if (state.credentialChoice === 'saved' && context.credentials.some((credential) => credential.id === state.credentialId && credential.provider === state.provider)) return true;
    const keyField = body.querySelector('#model-wizard-api-key');
    const labelField = body.querySelector('#model-wizard-credential-label');
    const apiKey = String(keyField?.value ?? '');
    const errors = {};
    if (!state.newCredentialLabel.trim()) errors.newCredentialLabel = 'Enter a label for the key.';
    if (!apiKey.trim()) errors.apiKey = 'Paste the API key.';
    markConnectField('newCredentialLabel', labelField, errors.newCredentialLabel);
    markConnectField('apiKey', keyField, errors.apiKey);
    if (Object.keys(errors).length) {
      setStatus(Object.values(errors)[0], 'error');
      (errors.newCredentialLabel ? labelField : keyField)?.focus?.();
      return false;
    }
    setStatus('Saving the key…', 'saving');
    try {
      const definition = provider();
      const result = await api.createCredential({ label: state.newCredentialLabel.trim(), provider: state.provider, authMode: state.newCredentialAuthMode || definition?.defaultAuthMode || 'bearer', apiKey: apiKey.trim() });
      if (keyField) keyField.value = '';
      // The key exists now even if its dialog closed meanwhile, so the page list still needs it.
      if (!isCurrent(token)) { void onSaved(); return false; }
      const created = result?.data;
      if (!created?.id) throw new Error('The key was saved but no ID came back. Reload the page and choose it as a saved key.');
      context.credentials = [...context.credentials, created];
      state.credentialId = created.id;
      state.credentialChoice = 'saved';
      state.newCredentialLabel = '';
      context.credentialsChanged = true;
      announce('Provider key saved.');
      return true;
    } catch (error) {
      if (isCurrent(token)) setStatus(errorMessage(error, 'The key could not be saved.'), 'error');
      return false;
    }
  }

  async function advance(token) {
    const current = WIZARD_STEPS[state.step].id;
    if (current === 'provider' && !provider()) { showErrors({ provider: 'Choose a provider.' }); return; }
    if (current === 'connect' && !(await connect(token))) return;
    if (current === 'model') {
      if (!state.model) {
        context.errors = { customModel: state.query.trim() ? 'Choose a match from the list, or pick the custom ID option.' : 'Choose a model.' };
        showErrors(context.errors);
        context.errors = {};
        return;
      }
    }
    if (current === 'review') {
      const { errors } = buildProfileRequest(state, provider());
      if (Object.keys(errors).length) { context.errors = errors; showErrors(errors); context.errors = {}; return; }
    }
    setStatus('');
    state.step += 1;
    renderStep();
  }

  async function verify(button, token) {
    const definition = provider();
    const key = wizardSaveGate(state, definition).routeKey;
    button.disabled = true;
    button.textContent = 'Verifying…';
    const region = body.querySelector('#model-wizard-verification');
    if (region) insert(region, '<p class="field-help" role="status">Checking the connection…</p>');
    try {
      const result = await api.verify(draftVerificationInput(state, definition, { tools: state.checkTools }));
      if (!isCurrent(token)) return;
      state.verification = { key, result: result?.data ?? null };
      announce(`Connection ${verificationLabel(result?.data?.outcome).toLowerCase()}.`);
    } catch (error) {
      if (!isCurrent(token)) return;
      // A failed request leaves every field as it was; only the check result is replaced.
      state.verification = { key, error: errorMessage(error, 'The connection could not be checked.') };
    }
    renderStep({ focus: false });
    body.querySelector('[data-wizard-action="verify"]')?.focus?.();
  }

  async function save(token) {
    const definition = provider();
    const { errors, request } = buildProfileRequest(state, definition);
    if (Object.keys(errors).length) {
      // Fields live on the review step; take the operator there with the fields marked.
      state.step = 3;
      context.errors = errors;
      showErrors(errors);
      context.errors = {};
      return;
    }
    const gate = wizardSaveGate(state, definition);
    if (!gate.allowed) {
      refreshGate(gate.fields[0]);
      setStatus(gate.reasons[0], 'error');
      return;
    }
    setStatus('Saving…', 'saving');
    const verificationRef = draftVerificationRef(state, gate.routeKey);
    const requestBody = verificationRef ? { ...request.body, verificationRef } : request.body;
    try {
      if (request.kind === 'update') await api.updateProfile(request.profileId, requestBody);
      else await api.createProfile(requestBody);
    } catch (error) {
      if (isCurrent(token)) setStatus(errorMessage(error, 'The profile could not be saved.'), 'error');
      return;
    }
    // The profile is saved whatever happened to the dialog meanwhile, so the list reloads from here.
    void onSaved();
    if (!isCurrent(token)) return;
    setStatus('');
    context.saved = true;
    dialog.close();
    announce(request.kind === 'update' ? 'Model profile updated.' : `Model profile ${request.body.profileId} created.`);
  }

  async function run(task) {
    if (busy) return;
    const token = session;
    setBusy(true);
    try { await task(token); } finally {
      if (isCurrent(token)) setBusy(false);
    }
  }

  form.addEventListener('input', onField);
  form.addEventListener('change', onField);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void run((token) => (state.step === WIZARD_STEPS.length - 1 ? save(token) : advance(token)));
  });
  form.addEventListener('click', (event) => {
    const action = event.target?.closest?.('[data-wizard-action]');
    if (!action) return;
    const name = action.dataset.wizardAction;
    const token = session;
    if (name === 'retry-providers') void loadProviders();
    else if (name === 'retry-catalog') void searchCatalog(state.query, { open: false }).then(() => restoreCatalogFocus(name, token));
    else if (name === 'refresh-catalog') void refreshCatalog(action).then(() => restoreCatalogFocus(name, token));
    else if (name === 'verify') void run((runToken) => verify(action, runToken));
  });
  back.addEventListener('click', () => {
    if (busy || state.step === 0) return;
    setStatus('');
    state.step -= 1;
    renderStep();
  });
  // A request in flight keeps the dialog open: closing it would orphan the result.
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  cancel?.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('close', () => {
    session += 1;
    setBusy(false);
    combobox?.dispose();
    combobox = undefined;
    // An unsent key is kept only for an immediate retry; closing the dialog drops it.
    const keyField = body.querySelector('#model-wizard-api-key');
    if (keyField) keyField.value = '';
    insert(body, '');
    invoker?.focus?.({ preventScroll: true });
    if (context?.credentialsChanged && !context.saved) void onSaved();
  });

  /**
   * Fills an edit with the catalog's current price for the saved model, so the
   * operator reviews it before anything is saved. The entry is applied whole, so
   * an unedited save sends it with its catalog reference. When no catalog price
   * can be found the saved price stays and the status says so.
   */
  async function prefillCatalogPrice(token) {
    const model = state.profile?.activeRevision?.model;
    setStatus('Loading the current catalog price…', 'saving');
    let entry;
    try {
      const result = await api.searchCatalog({ provider: state.provider, credentialId: state.credentialId, q: model, limit: 10 });
      if (!isCurrent(token)) return;
      entry = (Array.isArray(result?.data?.entries) ? result.data.entries : []).find((candidate) => candidate.providerModelId === model);
    } catch (error) {
      // A failed lookup leaves the saved price in place.
      if (!isCurrent(token)) return;
      setStatus(`${errorMessage(error, 'The catalog could not be loaded.')} The saved price is unchanged.`, 'error');
      return;
    }
    if (!entry || !Number.isSafeInteger(entry.pricing?.inputMicrosPerMillionTokens) || !Number.isSafeInteger(entry.pricing?.outputMicrosPerMillionTokens)) {
      setStatus('The catalog has no current price for this model. The saved price is unchanged; edit it under Advanced settings if needed.', 'error');
      return;
    }
    applyCatalogEntry(state, entry);
    renderStep({ focus: false });
    setStatus('Filled in the current catalog price. Review it, then save.');
  }

  return {
    open({ mode = 'create', profile = null, profiles = [], credentials = [], providers = [], trigger, useCatalogPrice = false } = {}) {
      session += 1;
      setBusy(false);
      invoker = trigger;
      state = initialWizardState({ mode, profile, profiles, credentials });
      context = { providers, credentials: [...credentials], providersStatus: providers.length ? 'ready' : 'loading', catalog: { status: 'idle', entries: [] }, errors: {} };
      title.textContent = mode === 'edit' ? `Edit profile (${profile.displayName})` : mode === 'duplicate' ? `Duplicate profile (${profile.displayName})` : 'Add model profile';
      setStatus('');
      if (!dialog.open) dialog.showModal();
      if (providers.length) renderStep();
      else void loadProviders();
      if (useCatalogPrice && mode === 'edit' && profile?.activeRevision) void run(prefillCatalogPrice);
    },
    get state() { return state; }
  };
}
