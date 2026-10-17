import { z } from 'zod';
import { ModelCredentialIdSchema, ModelProfileIdSchema, ModelRevisionIdSchema, ModelVerificationRefSchema } from './identifiers.js';
import {
  AgentModelPriceProvenanceSchema,
  ModelPriceTiersSchema,
  PriceMicrosPerMillionSchema,
  addPriceTierIssues
} from './model-pricing.js';
import { AgentProxyOperationSchema } from './runner-api.js';

export const ModelProviderKindSchema = z.enum([
  'openai',
  'anthropic',
  'openrouter',
  'google',
  'deepseek',
  'custom'
]);
export type ModelProviderKind = z.infer<typeof ModelProviderKindSchema>;

// A connection check runs from the runner against the provider the operator
// configured. `limited` means the connection could not be fully proven for a
// transient or account reason (rate limit, quota, timeout, network, provider
// outage, or a model that does not support tool calls); it never means the
// model is unsupported. `failed` is reserved for answers that prove the
// configuration is wrong (bad key, no access, unknown model, wrong protocol).
// The full check contract lives in model-verification-schemas.ts.
export const ModelVerificationOutcomeSchema = z.enum(['verified', 'limited', 'failed', 'not_tested']);
export type ModelVerificationOutcome = z.infer<typeof ModelVerificationOutcomeSchema>;

// The latest stored verification of a credential or saved profile. A profile
// result is tied to the revision it checked, so a new revision reads as not
// verified; a credential result is tied to the key version it checked.
export const ModelLastVerificationSchema = z.object({
  outcome: ModelVerificationOutcomeSchema,
  checkedAt: z.number().int(),
  revisionId: ModelRevisionIdSchema.nullable()
}).strict();
export type ModelLastVerification = z.infer<typeof ModelLastVerificationSchema>;

export const ProviderAuthModeSchema = z.enum(['bearer', 'x-api-key']);
export type ProviderAuthMode = z.infer<typeof ProviderAuthModeSchema>;

export const ProviderCredentialInputSchema = z.object({
  label: z.string().trim().min(1).max(100),
  provider: ModelProviderKindSchema,
  authMode: ProviderAuthModeSchema.optional(),
  apiKey: z.string().min(1).max(4096),
  secretReference: z.string().max(256).optional()
}).strict();
export type ProviderCredentialInput = z.infer<typeof ProviderCredentialInputSchema>;

export const ProviderCredentialRotateInputSchema = z.object({
  apiKey: z.string().min(1).max(4096),
  secretReference: z.string().max(256).optional(),
  expectedGeneration: z.number().int().positive()
}).strict();
export type ProviderCredentialRotateInput = z.infer<typeof ProviderCredentialRotateInputSchema>;

export const ProviderCredentialStatusSchema = z.enum(['ACTIVE', 'DISABLED', 'REVOKED']);
export type ProviderCredentialStatus = z.infer<typeof ProviderCredentialStatusSchema>;

export const ProviderCredentialSyncStatusSchema = z.enum(['SYNCED', 'PENDING', 'FAILED']);
export type ProviderCredentialSyncStatus = z.infer<typeof ProviderCredentialSyncStatusSchema>;

export const ProviderCredentialMetadataSchema = z.object({
  id: ModelCredentialIdSchema,
  principalId: z.string(),
  label: z.string(),
  provider: ModelProviderKindSchema,
  authMode: ProviderAuthModeSchema,
  activeVersion: z.number().int().positive(),
  status: ProviderCredentialStatusSchema,
  syncStatus: ProviderCredentialSyncStatusSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  lastVerification: ModelLastVerificationSchema.optional()
}).strict();
export type ProviderCredentialMetadata = z.infer<typeof ProviderCredentialMetadataSchema>;

export const AgentModelApiModeSchema = z.enum(['chat-completions', 'responses']);
export type AgentModelApiMode = z.infer<typeof AgentModelApiModeSchema>;

// Prices pinned on a revision, in integer micro-USD per one million tokens. A
// null or absent cache price is unknown, never free: the gateway and the agent
// charge the conservative default from resolveEffectivePricing (model-pricing.ts).
// `tiers` holds long-prompt prices; each tier must not charge less than the level
// below it.
export const AgentModelPricingSchema = z.object({
  inputMicrosPerMillionTokens: PriceMicrosPerMillionSchema,
  outputMicrosPerMillionTokens: PriceMicrosPerMillionSchema,
  cacheReadMicrosPerMillionTokens: PriceMicrosPerMillionSchema.nullable().optional(),
  cacheWriteMicrosPerMillionTokens: PriceMicrosPerMillionSchema.nullable().optional(),
  tiers: ModelPriceTiersSchema.optional()
}).strict().superRefine((pricing, context) => {
  if (pricing.tiers) addPriceTierIssues(pricing, pricing.tiers, context);
});
export type AgentModelPricing = z.infer<typeof AgentModelPricingSchema>;

export const AgentModelLimitsSchema = z.object({
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  maxCostMicros: z.number().int().positive()
}).strict();
export type AgentModelLimits = z.infer<typeof AgentModelLimitsSchema>;

// The catalog model whose price the client offered for this save. The runner
// compares the submitted pricing with its own cached catalog price for that model:
// only an exact match is recorded as catalog-sourced. Provenance and confidence are
// never taken from the client.
export const ModelCatalogPriceRefSchema = z.object({
  sourceModelId: z.string().trim().min(1).max(300)
}).strict();
export type ModelCatalogPriceRef = z.infer<typeof ModelCatalogPriceRefSchema>;

export const AgentModelProfileInputSchema = z.object({
  profileId: ModelProfileIdSchema,
  displayName: z.string().trim().min(1).max(100),
  credentialId: ModelCredentialIdSchema,
  model: z.string().trim().min(1).max(100),
  apiMode: AgentModelApiModeSchema,
  customUpstreamUrl: z.string().url().max(1024).optional(),
  pricing: AgentModelPricingSchema,
  limits: AgentModelLimitsSchema,
  maxProxyOperations: z.array(AgentProxyOperationSchema).min(1).max(10),
  // A draft connection check of this exact route; the runner attaches its stored
  // result to the new revision on a full match and otherwise ignores it.
  verificationRef: ModelVerificationRefSchema.optional(),
  catalogPriceRef: ModelCatalogPriceRefSchema.optional()
}).strict();
export type AgentModelProfileInput = z.infer<typeof AgentModelProfileInputSchema>;

export const AgentModelProfileUpdateInputSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  credentialId: ModelCredentialIdSchema.optional(),
  model: z.string().trim().min(1).max(100).optional(),
  apiMode: AgentModelApiModeSchema.optional(),
  customUpstreamUrl: z.string().url().max(1024).optional(),
  pricing: AgentModelPricingSchema.optional(),
  limits: AgentModelLimitsSchema.optional(),
  maxProxyOperations: z.array(AgentProxyOperationSchema).min(1).max(10).optional(),
  expectedGeneration: z.number().int().positive(),
  verificationRef: ModelVerificationRefSchema.optional(),
  catalogPriceRef: ModelCatalogPriceRefSchema.optional()
}).strict();
export type AgentModelProfileUpdateInput = z.infer<typeof AgentModelProfileUpdateInputSchema>;

export const AgentModelProfileRevisionSchema = z.object({
  id: ModelRevisionIdSchema,
  profileId: ModelProfileIdSchema,
  principalId: z.string(),
  credentialId: ModelCredentialIdSchema,
  model: z.string(),
  apiMode: AgentModelApiModeSchema,
  downstreamPath: z.string(),
  upstreamUrl: z.string(),
  pricing: AgentModelPricingSchema,
  priceProvenance: AgentModelPriceProvenanceSchema,
  limits: AgentModelLimitsSchema,
  maxProxyOperations: z.array(AgentProxyOperationSchema),
  digest: z.string(),
  createdAt: z.number().int()
}).strict();
export type AgentModelProfileRevision = z.infer<typeof AgentModelProfileRevisionSchema>;

// How a saved revision's pinned prices compare with the cached catalog price.
// `repriced`: a price differs by at least REPRICING_WARNING_PERCENT
// (model-catalog-schemas.ts), a pinned zero now has a catalog price, a pinned cache
// price is no longer published (`catalog: null`), or a tier exists on only one side.
// `unknown`: no cached catalog price exists for the model. The state reflects only
// comparable prices, so an edit can always clear it. For an override (`isOverride`) the
// result is informational: the operator chose the price.
export const ModelPricingReviewStateSchema = z.enum(['current', 'repriced', 'unknown']);
export type ModelPricingReviewState = z.infer<typeof ModelPricingReviewStateSchema>;

// `tier`: a tier exists on one side only, `pinned` and `catalog` hold that tier's
// input price. Price fields of a tier carry its `minPromptTokens`.
export const ModelPricingReviewFieldSchema = z.enum(['input', 'output', 'cacheRead', 'cacheWrite', 'tier']);
export type ModelPricingReviewField = z.infer<typeof ModelPricingReviewFieldSchema>;

export const ModelPricingReviewChangeSchema = z.object({
  field: ModelPricingReviewFieldSchema,
  minPromptTokens: z.number().int().positive().nullable(),
  pinned: PriceMicrosPerMillionSchema.nullable(),
  catalog: PriceMicrosPerMillionSchema.nullable(),
  // Signed change from the pinned price to the catalog price, one decimal; null
  // when no percentage exists (a pinned zero, an unpublished price, or a tier on one side).
  percent: z.number().nullable()
}).strict();
export type ModelPricingReviewChange = z.infer<typeof ModelPricingReviewChangeSchema>;

export const ModelPricingReviewSchema = z.object({
  state: ModelPricingReviewStateSchema,
  changes: z.array(ModelPricingReviewChangeSchema).max(32),
  catalogRetrievedAt: z.number().int().nonnegative().nullable(),
  isOverride: z.boolean(),
  // Informational: the catalog price also changes under a condition no revision can
  // express, so the charged price may be lower or higher than the pinned estimate.
  // It never affects `state`, because no edit could clear it.
  catalogHasConditionalPricing: z.boolean()
}).strict();
export type ModelPricingReview = z.infer<typeof ModelPricingReviewSchema>;

export const AgentModelProfileStatusSchema = z.enum(['ACTIVE', 'DISABLED', 'SYNC_PENDING', 'SYNC_FAILED']);
export type AgentModelProfileStatus = z.infer<typeof AgentModelProfileStatusSchema>;

export const AgentModelProfileMetadataSchema = z.object({
  id: ModelProfileIdSchema,
  principalId: z.string(),
  displayName: z.string(),
  credentialId: ModelCredentialIdSchema,
  desiredRevisionId: ModelRevisionIdSchema.nullable(),
  activeRevisionId: ModelRevisionIdSchema.nullable(),
  generation: z.number().int().positive(),
  status: AgentModelProfileStatusSchema,
  activeRevision: AgentModelProfileRevisionSchema.nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  lastVerification: ModelLastVerificationSchema.optional(),
  // Computed when profiles are listed and never stored, so a catalog refresh can
  // change the warning but never the pinned prices or limits.
  pricingReview: ModelPricingReviewSchema.optional()
}).strict();
export type AgentModelProfileMetadata = z.infer<typeof AgentModelProfileMetadataSchema>;

// A change a profile save would make that only the owner may approve when it does not
// come from the Dashboard, because it raises spend capacity, widens what an agent may
// do, or sends a key to a new host:
// - `limits_raised`: a token or cost limit is higher than the current revision's;
// - `price_lowered`: an effective price (cache prices and tiers resolved for the
//   provider) is lower than the current one and is not a catalog-verified price;
// - `price_unverified_for_new_route`: the credential or model changes and the
//   prices are an override rather than the catalog's;
// - `proxy_operations_widened`: an operation the current revision does not allow;
// - `custom_upstream_unbound`: a custom upstream URL none of the principal's
//   revisions on that credential already uses.
export const ModelProfileEscalationSchema = z.enum([
  'custom_upstream_unbound',
  'limits_raised',
  'price_lowered',
  'price_unverified_for_new_route',
  'proxy_operations_widened'
]);
export type ModelProfileEscalation = z.infer<typeof ModelProfileEscalationSchema>;

// A dry run of a profile create or update. It takes exactly the save input plus the
// action, so a client can validate the body it is about to send.
export const ModelProfileValidateInputSchema = z.discriminatedUnion('action', [
  AgentModelProfileInputSchema.extend({ action: z.literal('create') }).strict(),
  AgentModelProfileUpdateInputSchema.extend({ action: z.literal('update'), profileId: ModelProfileIdSchema }).strict()
]);
export type ModelProfileValidateInput = z.infer<typeof ModelProfileValidateInputSchema>;

// A refusal the save would answer with. Messages are registry or repository text:
// they name supported values and never echo a credential.
export const ModelProfileValidationIssueSchema = z.object({
  code: z.enum(['INVALID_INPUT', 'NOT_FOUND', 'CONFLICT']),
  message: z.string().max(1000)
}).strict();
export type ModelProfileValidationIssue = z.infer<typeof ModelProfileValidationIssueSchema>;

// The route and prices a save would write right now. Identifiers, digest, and
// timestamps are assigned only by the real save.
export const ModelProfileValidatedRevisionSchema = z.object({
  credentialId: ModelCredentialIdSchema,
  provider: ModelProviderKindSchema,
  model: z.string(),
  apiMode: AgentModelApiModeSchema,
  upstreamUrl: z.string(),
  pricing: AgentModelPricingSchema,
  priceProvenance: AgentModelPriceProvenanceSchema,
  limits: AgentModelLimitsSchema,
  maxProxyOperations: z.array(AgentProxyOperationSchema)
}).strict();
export type ModelProfileValidatedRevision = z.infer<typeof ModelProfileValidatedRevisionSchema>;

export const ModelProfileValidateResultSchema = z.object({
  valid: z.boolean(),
  action: z.enum(['create', 'update']),
  profileId: ModelProfileIdSchema,
  issues: z.array(ModelProfileValidationIssueSchema).max(16),
  revision: ModelProfileValidatedRevisionSchema.nullable(),
  // Compared with the cached catalog price only; validation never fetches a catalog.
  pricingReview: ModelPricingReviewSchema.nullable(),
  // Whether `verificationRef` would attach to the saved revision. Validation only
  // looks; the reference stays available for the save.
  verificationAttachable: z.boolean(),
  escalations: z.array(ModelProfileEscalationSchema),
  // Escalations are reported to every caller, but only refused for callers outside
  // the Dashboard, which is the owner's input channel.
  ownerApprovalRequiredOverMcp: z.boolean(),
  statusAfterSaveOverMcp: z.enum(['DISABLED', 'unchanged']),
  currentGeneration: z.number().int().positive().nullable()
}).strict();
export type ModelProfileValidateResult = z.infer<typeof ModelProfileValidateResultSchema>;

export const GatewayControlApplySnapshotSchema = z.object({
  type: z.literal('apply_snapshot'),
  sequence: z.number().int().positive(),
  generation: z.number().int().positive(),
  credentials: z.record(z.string(), z.object({
    provider: ModelProviderKindSchema,
    authMode: ProviderAuthModeSchema,
    secret: z.string()
  }).strict()),
  profiles: z.record(z.string(), AgentModelProfileRevisionSchema)
}).strict();
export type GatewayControlApplySnapshot = z.infer<typeof GatewayControlApplySnapshotSchema>;

export const GatewayControlAckSchema = z.object({
  type: z.literal('ack'),
  sequence: z.number().int().positive(),
  generation: z.number().int().positive(),
  gatewayBootId: z.string(),
  snapshotDigest: z.string(),
  activeProfileCount: z.number().int().nonnegative(),
  activeCredentialCount: z.number().int().nonnegative()
}).strict();
export type GatewayControlAck = z.infer<typeof GatewayControlAckSchema>;

export const GatewayControlDigestSchema = z.object({
  type: z.literal('digest'),
  gatewayBootId: z.string(),
  snapshotDigest: z.string(),
  activeLeaseCount: z.number().int().nonnegative()
}).strict();
export type GatewayControlDigest = z.infer<typeof GatewayControlDigestSchema>;

export const ModelConfigStatusSchema = z.object({
  gatewaySynced: z.boolean(),
  gatewayBootId: z.string().nullable(),
  lastSyncTime: z.number().int().nullable(),
  activeProfileCount: z.number().int().nonnegative(),
  activeCredentialCount: z.number().int().nonnegative(),
  error: z.string().nullable()
}).strict();
export type ModelConfigStatus = z.infer<typeof ModelConfigStatusSchema>;
