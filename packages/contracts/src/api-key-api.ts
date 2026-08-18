import { z } from 'zod';
import { RunnerPrincipalSelectorSchema } from './runner-api.js';

export const ApiKeyIdSchema = z.string().regex(/^apk_[A-Za-z0-9_-]{24}$/);
export const ApiKeyValueSchema = z.string().regex(/^chm_key_apk_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/).max(96);

const name = z.string().trim().min(1).max(100);
const generation = z.number().int().positive();

export const ApiKeyManagementOperationSchema = z.enum(['api_key_list', 'api_key_create', 'api_key_revoke']);

const managementBase = {
  version: z.literal(1),
  principal: RunnerPrincipalSelectorSchema
};

export const ApiKeyManagementRequestSchema = z.discriminatedUnion('operation', [
  z.object({ ...managementBase, operation: z.literal('api_key_list'), input: z.object({}).strict() }).strict(),
  z.object({
    ...managementBase,
    operation: z.literal('api_key_create'),
    input: z.object({ name, expiresInDays: z.number().int().min(1).max(365) }).strict()
  }).strict(),
  z.object({
    ...managementBase,
    operation: z.literal('api_key_revoke'),
    input: z.object({ keyId: ApiKeyIdSchema, expectedGeneration: generation }).strict()
  }).strict()
]);

export const ApiKeyMetadataSchema = z.object({
  id: ApiKeyIdSchema,
  name,
  displayPrefix: z.string().min(8).max(40),
  state: z.enum(['ACTIVE', 'EXPIRED', 'REVOKED']),
  generation,
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  lastUsedAt: z.number().int().nonnegative().nullable(),
  revokedAt: z.number().int().nonnegative().nullable()
}).strict();

const successBase = { ok: z.literal(true), truncated: z.literal(false) };
const errorResponse = z.object({
  ok: z.literal(false),
  message: z.string(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).strict(),
  truncated: z.literal(false)
}).strict();

export const ApiKeyManagementResponseSchema = z.union([
  z.object({ ...successBase, operation: z.literal('api_key_list'), data: z.object({ keys: z.array(ApiKeyMetadataSchema) }).strict() }).strict(),
  z.object({
    ...successBase,
    operation: z.literal('api_key_create'),
    data: z.object({ key: ApiKeyMetadataSchema, apiKey: ApiKeyValueSchema }).strict()
  }).strict(),
  z.object({ ...successBase, operation: z.literal('api_key_revoke'), data: z.object({ key: ApiKeyMetadataSchema }).strict() }).strict(),
  errorResponse
]);

export const ApiKeyAuthenticationRequestSchema = z.object({
  version: z.literal(1),
  apiKey: ApiKeyValueSchema
}).strict();

export const ApiKeyAuthenticationResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    data: z.object({ principal: RunnerPrincipalSelectorSchema, keyId: ApiKeyIdSchema }).strict()
  }).strict(),
  z.object({ ok: z.literal(false), error: z.literal('authentication_failed') }).strict()
]);

export type ApiKeyManagementOperation = z.infer<typeof ApiKeyManagementOperationSchema>;
export type ApiKeyManagementRequest = z.infer<typeof ApiKeyManagementRequestSchema>;
export type ApiKeyManagementResponse = z.infer<typeof ApiKeyManagementResponseSchema>;
export type ApiKeyAuthenticationResponse = z.infer<typeof ApiKeyAuthenticationResponseSchema>;
export type ApiKeyMetadata = z.infer<typeof ApiKeyMetadataSchema>;
