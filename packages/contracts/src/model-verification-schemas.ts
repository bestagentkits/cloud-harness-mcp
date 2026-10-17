import { z } from 'zod';
import { ModelCredentialIdSchema, ModelProfileIdSchema } from './identifiers.js';
import { AgentModelApiModeSchema, ModelProviderKindSchema, ModelVerificationOutcomeSchema } from './model-profile-schemas.js';

export const ModelVerificationCheckNameSchema = z.enum([
  'authentication', 'model_access', 'protocol', 'streaming_inference', 'tool_call'
]);
export type ModelVerificationCheckName = z.infer<typeof ModelVerificationCheckNameSchema>;

export const ModelVerificationErrorCategorySchema = z.enum([
  'auth', 'access', 'not_found', 'rate_limited', 'quota', 'unsupported_protocol',
  'timeout', 'network', 'forbidden_host', 'upstream', 'invalid_response'
]);
export type ModelVerificationErrorCategory = z.infer<typeof ModelVerificationErrorCategorySchema>;

export const ModelVerificationChecksInputSchema = z.object({
  // Defaults to true when a model is known (saved profile, or a draft that names one).
  inference: z.boolean().optional(),
  // Opt-in: a forced call to a harmless synthetic tool.
  tools: z.boolean().optional()
}).strict();
export type ModelVerificationChecksInput = z.infer<typeof ModelVerificationChecksInputSchema>;

export const ModelConnectionVerifyProfileInputSchema = z.object({
  profileId: ModelProfileIdSchema,
  checks: ModelVerificationChecksInputSchema.optional()
}).strict();

// A draft checks unsaved settings against a stored credential. It never
// creates or changes a profile, revision, or credential.
export const ModelConnectionVerifyDraftInputSchema = z.object({
  credentialId: ModelCredentialIdSchema,
  model: z.string().trim().min(1).max(100).optional(),
  apiMode: AgentModelApiModeSchema.optional(),
  customUpstreamUrl: z.string().url().max(1024).optional(),
  checks: ModelVerificationChecksInputSchema.optional()
}).strict();

export const ModelConnectionVerifyInputSchema = z.union([
  ModelConnectionVerifyProfileInputSchema,
  ModelConnectionVerifyDraftInputSchema
]);
export type ModelConnectionVerifyInput = z.infer<typeof ModelConnectionVerifyInputSchema>;

export const ModelVerificationCheckSchema = z.object({
  name: ModelVerificationCheckNameSchema,
  outcome: ModelVerificationOutcomeSchema,
  elapsedMs: z.number().int().nonnegative(),
  errorCategory: ModelVerificationErrorCategorySchema.optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  // Provider text after credential redaction; never request headers.
  message: z.string().max(300).optional()
}).strict();
export type ModelVerificationCheck = z.infer<typeof ModelVerificationCheckSchema>;

export const ModelVerificationUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative()
}).strict();
export type ModelVerificationUsage = z.infer<typeof ModelVerificationUsageSchema>;

export const ModelConnectionVerifyResultSchema = z.object({
  outcome: ModelVerificationOutcomeSchema,
  checkedAt: z.number().int(),
  elapsedMs: z.number().int().nonnegative(),
  provider: ModelProviderKindSchema,
  model: z.string().nullable(),
  apiMode: AgentModelApiModeSchema.nullable(),
  checks: z.array(ModelVerificationCheckSchema).max(5),
  usage: ModelVerificationUsageSchema.optional(),
  // Estimated from usage and the saved revision's pricing; null for drafts.
  estimatedCostMicros: z.number().int().nonnegative().nullable().optional()
}).strict();
export type ModelConnectionVerifyResult = z.infer<typeof ModelConnectionVerifyResultSchema>;
