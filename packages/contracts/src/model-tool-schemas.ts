import { z } from 'zod';
import { IdempotencyKeySchema, ModelProfileIdSchema } from './identifiers.js';
import { ModelCatalogSearchResultSchema } from './model-catalog-schemas.js';
import {
  AgentModelProfileInputSchema,
  AgentModelProfileMetadataSchema,
  AgentModelProfileUpdateInputSchema,
  ModelProfileValidateInputSchema,
  ModelProfileValidateResultSchema,
  ModelProviderKindSchema,
  ProviderAuthModeSchema,
  ProviderCredentialMetadataSchema
} from './model-profile-schemas.js';
import { ModelSpendPeriodSchema, ModelSpendPolicySchema, ModelSpendSummarySchema } from './model-spend-schemas.js';
import {
  ModelConnectionVerifyDraftInputSchema,
  ModelConnectionVerifyInputSchema,
  ModelConnectionVerifyResultSchema
} from './model-verification-schemas.js';
import type { RunnerOperation } from './runner-api.js';

/**
 * Public MCP tools for choosing a model, checking a connection, saving agent model
 * profiles, and reading estimated spend. They run in the runner on the same
 * control service as the Dashboard, scoped to the calling principal. Nothing here
 * creates, reads, or rotates a provider key, activates, disables, or deletes a
 * profile, or changes a spend policy: those stay owner actions on the Dashboard.
 */
export const MODEL_TOOL_OPERATIONS = [
  'model_provider_list',
  'model_catalog_search',
  'model_connection_verify',
  'model_profile_list',
  'model_profile_validate',
  'model_profile_create',
  'model_profile_update',
  'model_spend_summary'
] as const satisfies readonly RunnerOperation[];
export type ModelToolOperation = typeof MODEL_TOOL_OPERATIONS[number];

const modelToolOperations = new Set<string>(MODEL_TOOL_OPERATIONS);
export function isModelToolOperation(operation: string): operation is ModelToolOperation {
  return modelToolOperations.has(operation);
}

/* Inputs. Every input is strict. MCP clients expect a tool's input schema to be one
 * object, so the two union inputs are offered as one flat object and then checked
 * against the union the Dashboard route uses. */

/** Re-checks a flat input against the exact schema the Dashboard route uses, keeping its issues. */
function checkedAgainst<Output>(schema: z.ZodType<Output>) {
  return (value: unknown, context: z.RefinementCtx): Output => {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    for (const issue of result.error.issues) context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    return z.NEVER;
  };
}

export const ModelProviderListToolInputSchema = z.object({
  // Narrows both lists to one provider.
  provider: ModelProviderKindSchema.optional()
}).strict();

export const ModelConnectionVerifyToolInputSchema = ModelConnectionVerifyDraftInputSchema.partial()
  .extend({ profileId: ModelProfileIdSchema.optional() })
  .strict()
  .superRefine((input, context) => {
    if ((input.profileId === undefined) === (input.credentialId === undefined)) {
      context.addIssue({ code: 'custom', path: ['profileId'], message: 'send exactly one of profileId (a saved profile) or credentialId (a draft route)' });
    } else if (input.profileId !== undefined && (input.model !== undefined || input.apiMode !== undefined || input.customUpstreamUrl !== undefined)) {
      context.addIssue({ code: 'custom', path: ['profileId'], message: 'model, apiMode, and customUpstreamUrl describe a draft route; a saved profile is checked as saved' });
    }
  })
  .transform(checkedAgainst(ModelConnectionVerifyInputSchema));

export const ModelProfileListToolInputSchema = z.object({
  // Narrows the list to one profile.
  profileId: ModelProfileIdSchema.optional()
}).strict();

export const ModelProfileValidateToolInputSchema = AgentModelProfileInputSchema.partial()
  .extend({
    action: z.enum(['create', 'update']),
    expectedGeneration: z.number().int().positive().optional()
  })
  .strict()
  .transform(checkedAgainst(ModelProfileValidateInputSchema));

export const ModelProfileCreateToolInputSchema = AgentModelProfileInputSchema.extend({
  idempotencyKey: IdempotencyKeySchema
}).strict();
export type ModelProfileCreateToolInput = z.infer<typeof ModelProfileCreateToolInputSchema>;

export const ModelProfileUpdateToolInputSchema = AgentModelProfileUpdateInputSchema.extend({
  profileId: ModelProfileIdSchema,
  idempotencyKey: IdempotencyKeySchema
}).strict();
export type ModelProfileUpdateToolInput = z.infer<typeof ModelProfileUpdateToolInputSchema>;

export const ModelSpendSummaryToolInputSchema = z.object({
  // Narrows the windows and policies to one UTC period.
  period: ModelSpendPeriodSchema.optional()
}).strict();

/* Outputs. The runner parses every result against these before it returns, so a
 * field that is not listed here, such as key material, can never reach a caller. */

export const ModelProviderDefinitionSchema = z.object({
  id: ModelProviderKindSchema,
  displayName: z.string(),
  description: z.string(),
  docsUrl: z.string().nullable(),
  // The provider's page where the owner creates a key; never a key.
  apiKeyUrl: z.string().nullable(),
  authModes: z.array(ProviderAuthModeSchema),
  defaultAuthMode: ProviderAuthModeSchema,
  endpoints: z.object({
    'chat-completions': z.string().optional(),
    responses: z.string().optional()
  }).strict(),
  modelsEndpoint: z.object({
    url: z.string(),
    auth: z.enum(['bearer', 'anthropic', 'none'])
  }).strict().nullable(),
  catalogStrategy: z.enum(['provider-models', 'openrouter', 'none']),
  openRouterVendor: z.string().nullable(),
  requiresCustomUpstream: z.boolean(),
  billsCacheWrites: z.boolean()
}).strict();

export const ModelProviderListToolResultSchema = z.object({
  providers: z.array(ModelProviderDefinitionSchema),
  credentials: z.array(ProviderCredentialMetadataSchema)
}).strict();
export type ModelProviderListToolResult = z.infer<typeof ModelProviderListToolResultSchema>;

export const ModelProfileListToolResultSchema = z.object({
  profiles: z.array(AgentModelProfileMetadataSchema)
}).strict();
export type ModelProfileListToolResult = z.infer<typeof ModelProfileListToolResultSchema>;

export const ModelProfileCreateToolResultSchema = z.object({
  profile: AgentModelProfileMetadataSchema.extend({ status: z.literal('DISABLED') }).strict(),
  replayed: z.boolean(),
  // A profile created over MCP is disabled until the owner activates it on the Dashboard.
  activation: z.literal('dashboard_required')
}).strict();
export type ModelProfileCreateToolResult = z.infer<typeof ModelProfileCreateToolResultSchema>;

export const ModelProfileUpdateToolResultSchema = z.object({
  profile: AgentModelProfileMetadataSchema,
  replayed: z.boolean()
}).strict();
export type ModelProfileUpdateToolResult = z.infer<typeof ModelProfileUpdateToolResultSchema>;

// The same body as the Dashboard's spend route, built from the spend schemas so the
// two cannot drift.
export const ModelSpendSummaryToolResultSchema = z.object({
  summary: ModelSpendSummarySchema,
  policies: z.array(ModelSpendPolicySchema)
}).strict();
export type ModelSpendSummaryToolResult = z.infer<typeof ModelSpendSummaryToolResultSchema>;

export const MODEL_TOOL_RESULT_SCHEMAS = {
  model_provider_list: ModelProviderListToolResultSchema,
  model_catalog_search: ModelCatalogSearchResultSchema,
  model_connection_verify: ModelConnectionVerifyResultSchema,
  model_profile_list: ModelProfileListToolResultSchema,
  model_profile_validate: ModelProfileValidateResultSchema,
  model_profile_create: ModelProfileCreateToolResultSchema,
  model_profile_update: ModelProfileUpdateToolResultSchema,
  model_spend_summary: ModelSpendSummaryToolResultSchema
} as const satisfies Record<ModelToolOperation, z.ZodType>;
