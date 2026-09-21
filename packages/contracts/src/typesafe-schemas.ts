import { z } from 'zod';
import { IntegrationCredentialIdSchema, WorkspaceIdSchema } from './identifiers.js';

/** The hard ceiling the configured payload bound may never exceed. */
export const TYPESAFE_EGRESS_CEILING = 8_192;

const byteLength = (value: string) => new TextEncoder().encode(value).length;

/**
 * A plaintext endpoint would send the prompt in the clear, so HTTPS is a schema rule rather than a
 * runtime courtesy: a configuration that fails it never reaches the client.
 */
export const TypesafeEndpointSchema = z.string().url().max(300)
  .refine((value) => value.startsWith('https://'), 'the typesafe endpoint must use https');

export const TypesafeConfigSchema = z.object({
  endpoint: TypesafeEndpointSchema,
  model: z.string().min(1).max(80),
  maxEgressBytes: z.number().int().min(256).max(TYPESAFE_EGRESS_CEILING),
  enabled: z.boolean()
}).strict();

/**
 * The prompt bound is measured in bytes, not characters: the egress bound exists to bound what leaves
 * the process, and a multi-byte character spends more of it than its length suggests.
 */
export const SkillSuggestInputSchema = z.object({
  prompt: z.string().min(1)
    .refine((value) => byteLength(value) <= TYPESAFE_EGRESS_CEILING, 'the prompt exceeds the egress byte bound'),
  workspaceId: WorkspaceIdSchema.optional()
}).strict();

export const SuggestedSkillSchema = z.object({
  name: z.string().min(1).max(120),
  gate: z.number().min(0).max(1),
  fit: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1)
}).strict();

/** The caller receives a roster-validated name and the numbers behind it, never model prose. */
export const SkillSuggestResultSchema = z.object({
  suggested: SuggestedSkillSchema.nullable(),
  reason: z.string().min(1).max(64).optional(),
  cached: z.boolean(),
  latencyMs: z.number().int().min(0),
  outboundCalls: z.number().int().min(0),
  redactionCount: z.number().int().min(0),
  truncated: z.boolean().optional()
}).strict();

export const TypesafeStatusSchema = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  endpoint: TypesafeEndpointSchema,
  model: z.string().min(1).max(80)
}).strict();

/**
 * Credential metadata. There is no value field and the schema is strict, so a value cannot be smuggled
 * into a response by adding one: the shape itself refuses it.
 */
export const IntegrationCredentialSchema = z.object({
  id: IntegrationCredentialIdSchema,
  integration: z.enum(['typesafe']),
  label: z.string().min(1).max(120),
  status: z.enum(['ACTIVE', 'DISABLED', 'REVOKED']),
  activeVersion: z.number().int().min(1),
  generation: z.number().int().min(1),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0)
}).strict();

export const IntegrationCredentialCreateInputSchema = z.object({
  integration: z.enum(['typesafe']),
  label: z.string().min(1).max(120),
  value: z.string().min(1).max(4_096),
  expectedGeneration: z.literal(0)
}).strict();

export const IntegrationCredentialRotateInputSchema = z.object({
  credentialId: IntegrationCredentialIdSchema,
  value: z.string().min(1).max(4_096),
  expectedGeneration: z.number().int().min(1)
}).strict();

export type TypesafeConfig = z.infer<typeof TypesafeConfigSchema>;
export type SkillSuggestInput = z.infer<typeof SkillSuggestInputSchema>;
export type SkillSuggestResult = z.infer<typeof SkillSuggestResultSchema>;
export type TypesafeStatus = z.infer<typeof TypesafeStatusSchema>;
export type IntegrationCredential = z.infer<typeof IntegrationCredentialSchema>;
