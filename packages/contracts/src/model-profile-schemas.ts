import { z } from 'zod';
import { ModelCredentialIdSchema, ModelProfileIdSchema, ModelRevisionIdSchema } from './identifiers.js';
import { AgentProxyOperationSchema } from './runner-api.js';

export const ModelProviderKindSchema = z.enum([
  'openai',
  'anthropic',
  'openrouter',
  'google',
  'custom'
]);
export type ModelProviderKind = z.infer<typeof ModelProviderKindSchema>;

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
  updatedAt: z.number().int()
}).strict();
export type ProviderCredentialMetadata = z.infer<typeof ProviderCredentialMetadataSchema>;

export const AgentModelApiModeSchema = z.enum(['chat-completions', 'responses']);
export type AgentModelApiMode = z.infer<typeof AgentModelApiModeSchema>;

export const AgentModelPricingSchema = z.object({
  inputMicrosPerMillionTokens: z.number().int().nonnegative(),
  outputMicrosPerMillionTokens: z.number().int().nonnegative()
}).strict();
export type AgentModelPricing = z.infer<typeof AgentModelPricingSchema>;

export const AgentModelLimitsSchema = z.object({
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  maxCostMicros: z.number().int().positive()
}).strict();
export type AgentModelLimits = z.infer<typeof AgentModelLimitsSchema>;

export const AgentModelProfileInputSchema = z.object({
  profileId: ModelProfileIdSchema,
  displayName: z.string().trim().min(1).max(100),
  credentialId: ModelCredentialIdSchema,
  model: z.string().trim().min(1).max(100),
  apiMode: AgentModelApiModeSchema,
  customUpstreamUrl: z.string().url().max(1024).optional(),
  pricing: AgentModelPricingSchema,
  limits: AgentModelLimitsSchema,
  maxProxyOperations: z.array(AgentProxyOperationSchema).min(1).max(10)
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
  expectedGeneration: z.number().int().positive()
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
  limits: AgentModelLimitsSchema,
  maxProxyOperations: z.array(AgentProxyOperationSchema),
  digest: z.string(),
  createdAt: z.number().int()
}).strict();
export type AgentModelProfileRevision = z.infer<typeof AgentModelProfileRevisionSchema>;

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
  updatedAt: z.number().int()
}).strict();
export type AgentModelProfileMetadata = z.infer<typeof AgentModelProfileMetadataSchema>;

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
