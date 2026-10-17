import { z } from 'zod';
import { ModelCredentialIdSchema } from './identifiers.js';
import { ModelProviderKindSchema } from './model-profile-schemas.js';

// A price is integer micro-USD per one million tokens. `null` means the price is
// unknown, which is never the same as free: only an explicit zero is free.
const MicrosPerMillionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();

// `none`: no source published a price for the model, so the price fields are null.
export const ModelCatalogPriceSourceSchema = z.enum(['provider', 'openrouter', 'user', 'none']);
export type ModelCatalogPriceSource = z.infer<typeof ModelCatalogPriceSourceSchema>;

// `exact` is the price the selected route bills, `estimate` is a price observed on
// another route (OpenRouter metadata applied to a direct vendor), `unknown` means
// no price evidence exists.
export const ModelCatalogPriceConfidenceSchema = z.enum(['exact', 'estimate', 'unknown']);
export type ModelCatalogPriceConfidence = z.infer<typeof ModelCatalogPriceConfidenceSchema>;

export const ModelCatalogPriceProvenanceSchema = z.object({
  source: ModelCatalogPriceSourceSchema,
  sourceModelId: z.string().max(300).nullable(),
  retrievedAt: z.number().int().nonnegative().nullable(),
  confidence: ModelCatalogPriceConfidenceSchema
}).strict();
export type ModelCatalogPriceProvenance = z.infer<typeof ModelCatalogPriceProvenanceSchema>;

export const ModelCatalogPriceSchema = z.object({
  inputMicrosPerMillionTokens: MicrosPerMillionSchema,
  outputMicrosPerMillionTokens: MicrosPerMillionSchema,
  cacheReadMicrosPerMillionTokens: MicrosPerMillionSchema.optional(),
  cacheWriteMicrosPerMillionTokens: MicrosPerMillionSchema.optional(),
  provenance: ModelCatalogPriceProvenanceSchema,
  // OpenRouter `overrides`: the price changes under conditions such as a long
  // prompt, so the listed price is the base tier only.
  hasConditionalPricing: z.boolean()
}).strict();
export type ModelCatalogPrice = z.infer<typeof ModelCatalogPriceSchema>;

// `reported` is backed by provider or OpenRouter metadata, `unsupported` by
// metadata that lists the model's parameters or modalities without it, and
// `unknown` by the absence of evidence.
export const ModelCatalogCapabilityStateSchema = z.enum(['reported', 'unknown', 'unsupported']);
export type ModelCatalogCapabilityState = z.infer<typeof ModelCatalogCapabilityStateSchema>;

export const ModelCatalogCapabilitySchema = z.enum(['tools', 'reasoning', 'vision']);
export type ModelCatalogCapability = z.infer<typeof ModelCatalogCapabilitySchema>;

export const ModelCatalogCapabilitiesSchema = z.object({
  tools: ModelCatalogCapabilityStateSchema,
  reasoning: ModelCatalogCapabilityStateSchema,
  vision: ModelCatalogCapabilityStateSchema
}).strict();
export type ModelCatalogCapabilities = z.infer<typeof ModelCatalogCapabilitiesSchema>;

// `listed_for_credential`: the provider's models endpoint returned the model for
// the selected credential. `public_catalog`: only public metadata lists it, so the
// credential's access and the exact provider model ID are unverified.
export const ModelCatalogAvailabilitySchema = z.enum(['listed_for_credential', 'public_catalog', 'unknown']);
export type ModelCatalogAvailability = z.infer<typeof ModelCatalogAvailabilitySchema>;

export const ModelCatalogEntrySchema = z.object({
  provider: ModelProviderKindSchema,
  // The ID sent to the provider. For direct vendors it never carries an
  // OpenRouter vendor prefix.
  providerModelId: z.string().min(1).max(300),
  // OpenRouter-style `vendor/model` ID the metadata was matched to.
  canonicalModelId: z.string().max(300).nullable(),
  displayName: z.string().min(1).max(300),
  contextWindow: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  capabilities: ModelCatalogCapabilitiesSchema,
  pricing: ModelCatalogPriceSchema,
  availability: ModelCatalogAvailabilitySchema,
  // When the provider retires the model, if it published a date.
  expiresAt: z.number().int().nullable()
}).strict();
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;

export const ModelCatalogFreshnessStateSchema = z.enum(['fresh', 'stale', 'unavailable']);
export type ModelCatalogFreshnessState = z.infer<typeof ModelCatalogFreshnessStateSchema>;

export const ModelCatalogSourceKindSchema = z.enum(['provider', 'openrouter']);
export type ModelCatalogSourceKind = z.infer<typeof ModelCatalogSourceKindSchema>;

// Error categories only: provider response text never reaches a catalog result.
export const ModelCatalogSourceErrorSchema = z.enum([
  'timeout', 'network', 'forbidden_host', 'authentication', 'rate_limited',
  'upstream_error', 'invalid_response', 'credential_unavailable'
]);
export type ModelCatalogSourceError = z.infer<typeof ModelCatalogSourceErrorSchema>;

export const ModelCatalogSourceStatusSchema = z.object({
  source: ModelCatalogSourceKindSchema,
  state: ModelCatalogFreshnessStateSchema,
  fetchedAt: z.number().int().nullable(),
  error: ModelCatalogSourceErrorSchema.nullable()
}).strict();
export type ModelCatalogSourceStatus = z.infer<typeof ModelCatalogSourceStatusSchema>;

export const ModelCatalogFreshnessSchema = z.object({
  state: ModelCatalogFreshnessStateSchema,
  // The oldest fetch time among the sources that contributed entries.
  fetchedAt: z.number().int().nullable(),
  sources: z.array(ModelCatalogSourceStatusSchema).max(4)
}).strict();
export type ModelCatalogFreshness = z.infer<typeof ModelCatalogFreshnessSchema>;

export const ModelCatalogSearchInputSchema = z.object({
  provider: ModelProviderKindSchema,
  credentialId: ModelCredentialIdSchema.optional(),
  query: z.string().trim().max(200).optional(),
  cursor: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(100).default(25),
  capability: ModelCatalogCapabilitySchema.optional()
}).strict();
export type ModelCatalogSearchInput = z.infer<typeof ModelCatalogSearchInputSchema>;

export const ModelCatalogSearchResultSchema = z.object({
  entries: z.array(ModelCatalogEntrySchema).max(100),
  nextCursor: z.string().max(256).nullable(),
  freshness: ModelCatalogFreshnessSchema
}).strict();
export type ModelCatalogSearchResult = z.infer<typeof ModelCatalogSearchResultSchema>;

export const ModelCatalogRefreshInputSchema = z.object({
  provider: ModelProviderKindSchema,
  credentialId: ModelCredentialIdSchema.optional()
}).strict();
export type ModelCatalogRefreshInput = z.infer<typeof ModelCatalogRefreshInputSchema>;

export const ModelCatalogRefreshResultSchema = z.object({
  entryCount: z.number().int().nonnegative(),
  freshness: ModelCatalogFreshnessSchema
}).strict();
export type ModelCatalogRefreshResult = z.infer<typeof ModelCatalogRefreshResultSchema>;
