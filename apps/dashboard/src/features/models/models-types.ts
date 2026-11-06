/**
 * Browser-side shapes of the Models & Budgets BFF reads. They mirror the runner's
 * `model_*` responses (passed through unmapped by the BFF) as far as this page reads them;
 * fields the page never renders (`principalId`, timestamps it does not show) are left out
 * on purpose so nothing here depends on them.
 */

export type VerificationOutcome = 'verified' | 'limited' | 'failed' | 'not_tested';
export type ApiMode = 'chat-completions' | 'responses';

export type ProviderCredential = {
  id: string;
  label: string;
  provider: string;
  authMode: string;
  status: string;
  activeVersion: number;
  /** Absent from the runner's list and rotate responses today; the fence falls back to 1 as legacy does. */
  generation?: number;
  lastVerification?: { outcome: VerificationOutcome; checkedAt: number } | null;
};

export type ModelProvider = {
  id: string;
  displayName: string;
  description?: string;
  apiKeyUrl?: string | null;
  authModes?: string[];
  defaultAuthMode?: string;
  endpoints?: Partial<Record<ApiMode, unknown>>;
  catalogStrategy?: string;
  requiresCustomUpstream?: boolean;
};

export type PriceProvenance = {
  source: 'provider' | 'openrouter' | 'user' | 'none' | 'saved' | string;
  sourceModelId?: string | null;
  retrievedAt?: number | null;
  confidence?: string;
  isOverride?: boolean;
};

export type PriceLevel = {
  inputMicrosPerMillionTokens: number | null;
  outputMicrosPerMillionTokens: number | null;
  cacheReadMicrosPerMillionTokens?: number | null;
  cacheWriteMicrosPerMillionTokens?: number | null;
};

export type PriceTier = PriceLevel & { minPromptTokens: number };
export type SavedPricing = PriceLevel & { tiers?: PriceTier[] };

export type ProfileRevision = {
  credentialId: string;
  model: string;
  apiMode: ApiMode;
  upstreamUrl?: string | null;
  pricing: SavedPricing;
  priceProvenance?: PriceProvenance | null;
  limits: { maxInputTokens: number; maxOutputTokens: number; maxCostMicros: number };
  maxProxyOperations: string[];
};

export type PricingReview = {
  state: 'current' | 'repriced' | 'unknown';
  changes?: Array<{ percent: number | null }>;
  catalogRetrievedAt?: number | null;
  isOverride?: boolean;
  catalogHasConditionalPricing?: boolean;
};

export type ProfileStatus = 'ACTIVE' | 'DISABLED' | 'SYNC_PENDING' | 'SYNC_FAILED';

export type ModelProfile = {
  id: string;
  displayName: string;
  status: ProfileStatus | string;
  generation: number;
  credentialId?: string;
  activeRevisionId?: string | null;
  activeRevision?: ProfileRevision | null;
  lastVerification?: { revisionId: string | null; outcome: VerificationOutcome; checkedAt: number } | null;
  pricingReview?: PricingReview | null;
};

export type CatalogPrice = PriceLevel & { provenance?: PriceProvenance | null; tiers?: PriceTier[]; hasConditionalPricing?: boolean };

export type CatalogEntry = {
  providerModelId: string;
  displayName: string;
  contextWindow?: number | null;
  capabilities?: Partial<Record<'tools' | 'reasoning' | 'vision', 'reported' | 'unknown' | 'unsupported'>>;
  pricing?: CatalogPrice | null;
  availability?: 'listed_for_credential' | 'public_catalog' | 'unknown';
};

export type CatalogFreshness = {
  state: 'fresh' | 'stale' | 'unavailable';
  fetchedAt?: number | null;
  sources?: Array<{ source: string; error?: string | null }>;
};

export type CatalogSearchResult = { entries: CatalogEntry[]; nextCursor: string | null; freshness?: CatalogFreshness | null };

export type VerificationCheck = { name: string; outcome: VerificationOutcome; elapsedMs: number; errorCategory?: string; httpStatus?: number; message?: string };

export type VerifyResult = {
  outcome: VerificationOutcome;
  checkedAt: number;
  elapsedMs: number;
  checks: VerificationCheck[];
  usage?: { inputTokens: number; outputTokens: number };
  /** An opaque `vref_…` reference: sent back on save only for the route it checked. */
  verificationRef?: string;
};

export type GatewayStatus = { gatewaySynced: boolean; lastSyncTime?: number | null; error?: string | null };

export type SpendPolicy = { id: string; profileId: string | null; period: 'day' | 'month'; limitMicros: number; warnPercent: number; generation: number };

export type SpendWindow = {
  scope: 'principal' | 'profile';
  profileId: string | null;
  period: 'day' | 'month';
  estimatedSettledMicros: number;
  estimatedReservedMicros: number;
  estimatedUnreconciledMicros: number;
  policy: SpendPolicy | null;
  thresholdState: 'ok' | 'warning' | 'exceeded' | null;
};

export type SpendSummary = { isEstimate?: boolean; windows: SpendWindow[] };
