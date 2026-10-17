import {
  ModelProfileEscalationSchema,
  resolveEffectivePricing,
  type AgentModelLimits,
  type AgentModelPriceProvenance,
  type AgentModelPricing,
  type AgentModelProfileMetadata,
  type AgentProxyOperation,
  type EffectiveModelPricing,
  type EffectivePriceLevel,
  type ModelProfileEscalation,
  type ModelProviderKind
} from '@cloud-harness/contracts';

/** The parts of a revision that decide spend capacity, agent permissions, and where a key is sent. */
export interface GuardedRevision {
  credentialId: string;
  model: string;
  upstreamUrl: string;
  pricing: AgentModelPricing;
  priceProvenance: AgentModelPriceProvenance;
  limits: AgentModelLimits;
  maxProxyOperations: readonly AgentProxyOperation[];
}

export interface ProfileEscalationInput {
  action: 'create' | 'update';
  // The revision the change replaces; null for a create, and for an update of a
  // profile whose active revision cannot be read.
  current: GuardedRevision | null;
  next: GuardedRevision;
  // The provider of the next revision's credential.
  provider: ModelProviderKind;
  // The provider of the current revision's credential, when the change moves to
  // another credential. Defaults to `provider`.
  currentProvider?: ModelProviderKind;
  // Upstream URLs the principal's existing revisions on the next credential use.
  boundCustomUrls: Iterable<string>;
}

const PRICE_KEYS = [
  'inputMicrosPerMillionTokens',
  'outputMicrosPerMillionTokens',
  'cacheReadMicrosPerMillionTokens',
  'cacheWriteMicrosPerMillionTokens'
] as const satisfies ReadonlyArray<keyof EffectivePriceLevel>;

const LIMIT_KEYS = ['maxInputTokens', 'maxOutputTokens', 'maxCostMicros'] as const satisfies ReadonlyArray<keyof AgentModelLimits>;

/** The level that prices a prompt of `promptTokens`: the highest tier it reaches, else the base. */
function levelAt(pricing: EffectiveModelPricing, promptTokens: number): EffectivePriceLevel {
  let level: EffectivePriceLevel = pricing;
  let reached = -1;
  for (const tier of pricing.tiers ?? []) {
    if (tier.minPromptTokens <= promptTokens && tier.minPromptTokens > reached) {
      level = tier;
      reached = tier.minPromptTokens;
    }
  }
  return level;
}

/**
 * True when some prompt size would be charged less by `next` than by `current`.
 * Prices are compared as the gateway charges them, with unknown cache prices
 * resolved, at every tier threshold of either side; prices are constant between
 * thresholds, so this covers every prompt size. A dropped tier lowers the price
 * at its threshold to the level below it.
 */
function anyPriceLowered(current: EffectiveModelPricing, next: EffectiveModelPricing): boolean {
  const thresholds = new Set<number>([0]);
  for (const tier of current.tiers ?? []) thresholds.add(tier.minPromptTokens);
  for (const tier of next.tiers ?? []) thresholds.add(tier.minPromptTokens);
  for (const promptTokens of thresholds) {
    const before = levelAt(current, promptTokens);
    const after = levelAt(next, promptTokens);
    if (PRICE_KEYS.some((key) => after[key] < before[key])) return true;
  }
  return false;
}

/** Prices the runner itself matched against a provider or OpenRouter catalog, not typed by a caller. */
function catalogVerified(provenance: AgentModelPriceProvenance): boolean {
  return !provenance.isOverride && (provenance.source === 'provider' || provenance.source === 'openrouter');
}

/**
 * The changes in a profile save that need the owner's approval when they do not
 * come from the Dashboard. Pure: it reads nothing and writes nothing. The result
 * is sorted and has no duplicates. A create has no current revision, so only an
 * unbound custom upstream applies to it. An update with no readable current
 * revision fails closed: nothing is treated as approved, so every escalation the
 * next revision can carry is reported.
 */
export function profileEscalations(input: ProfileEscalationInput): ModelProfileEscalation[] {
  const { current, next, provider } = input;
  const found = new Set<ModelProfileEscalation>();

  if (provider === 'custom' && !customUpstreamBound(next.upstreamUrl, input.boundCustomUrls)) {
    found.add('custom_upstream_unbound');
  }

  if (input.action === 'update' && !current) {
    // Limits are positive and a revision allows at least one proxy operation, so
    // both exceed an approved baseline of nothing.
    found.add('limits_raised');
    found.add('proxy_operations_widened');
    if (!catalogVerified(next.priceProvenance)) found.add('price_lowered');
    if (next.priceProvenance.isOverride) found.add('price_unverified_for_new_route');
  } else if (current) {
    if (LIMIT_KEYS.some((key) => next.limits[key] > current.limits[key])) found.add('limits_raised');

    if (!catalogVerified(next.priceProvenance)) {
      const before = resolveEffectivePricing(current.pricing, input.currentProvider ?? provider);
      const after = resolveEffectivePricing(next.pricing, provider);
      if (anyPriceLowered(before, after)) found.add('price_lowered');
    }

    const newRoute = next.credentialId !== current.credentialId || next.model !== current.model;
    if (newRoute && next.priceProvenance.isOverride) found.add('price_unverified_for_new_route');

    const allowed = new Set(current.maxProxyOperations);
    if (next.maxProxyOperations.some((operation) => !allowed.has(operation))) found.add('proxy_operations_widened');
  }

  // The enum order is alphabetical, so filtering it sorts the result.
  return ModelProfileEscalationSchema.options.filter((escalation) => found.has(escalation));
}

/** True when `upstreamUrl` is one the principal's revisions on that credential already use. */
export function customUpstreamBound(upstreamUrl: string, boundCustomUrls: Iterable<string>): boolean {
  return new Set(boundCustomUrls).has(upstreamUrl);
}

/** The channel a model change or check came from: the owner's Dashboard, or an MCP client. */
export type ModelChangeActor = 'dashboard' | 'mcp';

export type ProfileAuditDetails = Record<string, string | number | boolean>;

/**
 * Audit details of a saved profile: who changed it and the route, limits, and price
 * source of its active revision. Prices, URL paths, and keys are never recorded;
 * a custom upstream is named by its host only.
 */
export function profileAuditDetails(
  profile: Pick<AgentModelProfileMetadata, 'credentialId' | 'status' | 'activeRevision'>,
  provider: ModelProviderKind | undefined,
  actor: ModelChangeActor
): ProfileAuditDetails {
  const revision = profile.activeRevision;
  const details: ProfileAuditDetails = { actor, status: profile.status, credentialId: profile.credentialId };
  if (provider) details.provider = provider;
  if (!revision) return details;
  Object.assign(details, {
    revisionId: revision.id,
    model: revision.model,
    apiMode: revision.apiMode,
    maxInputTokens: revision.limits.maxInputTokens,
    maxOutputTokens: revision.limits.maxOutputTokens,
    maxCostMicros: revision.limits.maxCostMicros,
    priceSource: revision.priceProvenance.source,
    isOverride: revision.priceProvenance.isOverride
  });
  if (provider === 'custom') {
    try {
      details.upstreamHost = new URL(revision.upstreamUrl).hostname;
    } catch {
      // A saved custom URL always parses; an unreadable one is simply not named.
    }
  }
  return details;
}

/** Audit details of a change the guard refused. Audit details are flat, so the escalations are joined. */
export function profileChangeRefusedDetails(
  actor: ModelChangeActor,
  attempted: 'create' | 'update',
  escalations: readonly ModelProfileEscalation[]
): ProfileAuditDetails {
  return { actor, attempted, escalations: escalations.join(',') };
}
