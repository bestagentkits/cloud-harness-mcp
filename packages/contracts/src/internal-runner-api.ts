import { z } from 'zod';
import { ExecutorNetworkProfileSchema, ModelCredentialIdSchema, ModelProfileIdSchema, WorkspaceIdSchema } from './identifiers.js';
import { ToolResultSchema } from './mcp-results.js';
import {
  AgentModelProfileInputSchema,
  AgentModelProfileUpdateInputSchema,
  ProviderCredentialInputSchema
} from './model-profile-schemas.js';
import { RunnerPrincipalSelectorSchema } from './runner-api.js';
import { SecretDescriptionSchema, SecretNameSchema, SecretPurposeSchema, SecretValueSchema } from './secret-policy.js';
import { ToolkitSelectionSchema } from './tool-schemas.js';
import {
  JournalTypeSchema,
  KnowledgeItemIdSchema,
  KnowledgeKindSchema,
  KnowledgeLinkIdSchema,
  KnowledgeRelationSchema,
  KnowledgeScopeSchema,
  KnowledgeTagSchema
} from './knowledge-schemas.js';
import {
  McpGatewayCatalogFilterSchema,
  McpGatewayCreateInputSchema,
  McpGatewayCredentialPurposeSchema,
  McpGatewayServerNameSchema,
  McpGatewayServerStatusSchema,
  McpGatewaySetPermissionsInputSchema,
  McpGatewayToolAnnotationsSchema,
  McpGatewayToolAvailabilitySchema,
  McpGatewayToolNameSchema,
  McpGatewayTraceStatusSchema,
  McpGatewayUpdateInputSchema
} from './mcp-gateway-schemas.js';

export const InternalRunnerOperationSchema = z.enum([
  'workspace_detail',
  'workspace_close_fenced',
  'toolkits_list',
  'toolkits_preview',
  'settings_get',
  'settings_update',
  'settings_network_check'
]);

const workspaceDetailRequest = z.object({
  version: z.literal(2),
  principal: RunnerPrincipalSelectorSchema,
  operation: z.literal('workspace_detail'),
  input: z.object({ workspaceId: WorkspaceIdSchema }).strict()
}).strict();

const workspaceCloseFencedRequest = z.object({
  version: z.literal(2),
  principal: RunnerPrincipalSelectorSchema,
  operation: z.literal('workspace_close_fenced'),
  input: z.object({
    workspaceId: WorkspaceIdSchema,
    expectedGeneration: z.number().int().positive()
  }).strict()
}).strict();
const toolkitsListRequest = z.object({
  version: z.literal(2),
  principal: RunnerPrincipalSelectorSchema,
  operation: z.literal('toolkits_list'),
  input: z.object({}).strict()
}).strict();

const toolkitsPreviewRequest = z.object({
  version: z.literal(2),
  principal: RunnerPrincipalSelectorSchema,
  operation: z.literal('toolkits_preview'),
  input: z.object({
    toolkits: z.array(ToolkitSelectionSchema).max(8)
  }).strict()
}).strict();

const settingsGetRequest = z.object({
  version: z.literal(2),
  principal: RunnerPrincipalSelectorSchema,
  operation: z.literal('settings_get'),
  input: z.object({}).strict()
}).strict();

const settingsUpdateRequest = z.object({
  version: z.literal(2),
  principal: RunnerPrincipalSelectorSchema,
  operation: z.literal('settings_update'),
  input: z.object({
    defaultNetworkProfile: z.union([ExecutorNetworkProfileSchema, z.null()])
  }).strict()
}).strict();

const settingsNetworkCheckRequest = z.object({
  version: z.literal(2),
  principal: RunnerPrincipalSelectorSchema,
  operation: z.literal('settings_network_check'),
  input: z.object({}).strict()
}).strict();

export const InternalRunnerRequestSchema = z.discriminatedUnion('operation', [
  workspaceDetailRequest,
  workspaceCloseFencedRequest,
  toolkitsListRequest,
  toolkitsPreviewRequest,
  settingsGetRequest,
  settingsUpdateRequest,
  settingsNetworkCheckRequest
]);

export const InternalRunnerResponseSchema = ToolResultSchema;

const internalId = (prefix: string) => z.string()
  .regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{20,80}$`), `invalid ${prefix} identifier`);
const generation = z.number().int().positive();
const name = z.string().trim().min(1).max(100);

export const MetadataRunnerOperationSchema = z.enum([
  'project_list', 'project_create', 'project_update', 'project_delete',
  'environment_list', 'environment_create', 'environment_update', 'environment_delete',
  'secret_list', 'secret_create', 'secret_rotate', 'secret_update', 'secret_delete', 'secret_bulk_apply',
  'global_secret_list', 'global_secret_create', 'global_secret_rotate', 'global_secret_update', 'global_secret_delete', 'global_secret_bulk_apply',
  'audit_list',
  'artifact_list', 'artifact_snapshot', 'artifact_read', 'artifact_restore', 'artifact_delete',
  'github_status', 'github_setup_begin', 'github_setup_complete', 'github_reconcile', 'github_disconnect',
  'privilege_grant_list', 'privilege_grant_approve', 'privilege_grant_reject',
  'model_credential_list', 'model_credential_create', 'model_credential_rotate', 'model_credential_delete',
  'model_profile_list', 'model_profile_create', 'model_profile_update', 'model_profile_activate', 'model_profile_disable', 'model_profile_delete',
  'model_config_status',
  'knowledge_dashboard_list', 'knowledge_dashboard_get', 'knowledge_dashboard_create', 'knowledge_dashboard_update',
  'knowledge_dashboard_delete', 'knowledge_dashboard_search', 'knowledge_dashboard_graph',
  'knowledge_dashboard_link_create', 'knowledge_dashboard_link_delete',
  'mcp_server_list', 'mcp_server_get', 'mcp_server_create', 'mcp_server_update', 'mcp_server_delete',
  'mcp_server_set_enabled', 'mcp_server_set_permissions', 'mcp_server_replace_tools', 'mcp_server_connection_result',
  'mcp_server_get_credentials', 'mcp_gateway_catalog', 'mcp_gateway_trace_append', 'mcp_gateway_trace_list'
]);

const metadataInputs = {
  project_list: z.object({}).strict(),
  project_create: z.object({ name, expectedGeneration: z.literal(0) }).strict(),
  project_update: z.object({ projectId: internalId('prj'), name, expectedGeneration: generation }).strict(),
  project_delete: z.object({ projectId: internalId('prj'), expectedGeneration: generation }).strict(),
  environment_list: z.object({ projectId: internalId('prj') }).strict(),
  environment_create: z.object({ projectId: internalId('prj'), name, expectedGeneration: z.literal(0) }).strict(),
  environment_update: z.object({ environmentId: internalId('env'), name, expectedGeneration: generation }).strict(),
  environment_delete: z.object({ environmentId: internalId('env'), expectedGeneration: generation }).strict(),
  secret_list: z.object({ environmentId: internalId('env') }).strict(),
  secret_create: z.object({ environmentId: internalId('env'), name: SecretNameSchema, value: SecretValueSchema, description: SecretDescriptionSchema.optional(), purpose: SecretPurposeSchema.optional(), expectedGeneration: z.literal(0) }).strict(),
  secret_rotate: z.object({ environmentId: internalId('env'), name: SecretNameSchema, value: SecretValueSchema, description: SecretDescriptionSchema.optional(), purpose: SecretPurposeSchema.optional(), expectedGeneration: generation }).strict(),
  secret_update: z.object({ environmentId: internalId('env'), name: SecretNameSchema, description: SecretDescriptionSchema.optional(), expectedGeneration: generation }).strict(),
  secret_delete: z.object({ environmentId: internalId('env'), name: SecretNameSchema, expectedGeneration: generation }).strict(),
  secret_bulk_apply: z.object({
    environmentId: internalId('env'),
    items: z.array(z.object({
      name: SecretNameSchema,
      value: SecretValueSchema,
      description: SecretDescriptionSchema.optional(),
      purpose: SecretPurposeSchema.optional(),
      action: z.enum(['create', 'rotate']),
      expectedGeneration: z.number().int().min(0)
    })).min(1).max(200)
  }).strict(),
  global_secret_list: z.object({}).strict(),
  global_secret_create: z.object({ name: SecretNameSchema, value: SecretValueSchema, description: SecretDescriptionSchema.optional(), purpose: SecretPurposeSchema.optional(), expectedGeneration: z.literal(0) }).strict(),
  global_secret_rotate: z.object({ name: SecretNameSchema, value: SecretValueSchema, description: SecretDescriptionSchema.optional(), purpose: SecretPurposeSchema.optional(), expectedGeneration: generation }).strict(),
  global_secret_update: z.object({ name: SecretNameSchema, description: SecretDescriptionSchema.optional(), expectedGeneration: generation }).strict(),
  global_secret_delete: z.object({ name: SecretNameSchema, expectedGeneration: generation }).strict(),
  global_secret_bulk_apply: z.object({
    items: z.array(z.object({
      name: SecretNameSchema,
      value: SecretValueSchema,
      description: SecretDescriptionSchema.optional(),
      purpose: SecretPurposeSchema.optional(),
      action: z.enum(['create', 'rotate']),
      expectedGeneration: z.number().int().min(0)
    })).min(1).max(200)
  }).strict(),
  audit_list: z.object({ cursor: internalId('aud').optional(), limit: z.number().int().min(1).max(100).default(50) }).strict(),
  artifact_list: z.object({ cursor: z.string().max(256).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict(),
  artifact_snapshot: z.object({
    workspaceId: WorkspaceIdSchema, path: z.string().min(1).max(1_024), logicalName: z.string().min(1).max(128),
    projectId: internalId('prj').optional(), environmentId: internalId('env').optional(),
    retentionSeconds: z.number().int().min(60).max(2_592_000).optional(), expectedGeneration: z.literal(0)
  }).strict(),
  artifact_read: z.object({
    artifactId: internalId('art'),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(1_048_576).default(65_536)
  }).strict(),
  artifact_restore: z.object({
    artifactId: internalId('art'),
    workspaceId: WorkspaceIdSchema,
    path: z.string().min(1).max(1_024),
    overwrite: z.boolean().default(false),
    expectedSha256: z.string().length(64).optional()
  }).strict(),
  artifact_delete: z.object({ artifactId: internalId('art'), expectedGeneration: generation }).strict(),
  github_status: z.object({}).strict(),
  github_setup_begin: z.object({ expectedAccountId: z.string().min(1).max(100).optional() }).strict(),
  github_setup_complete: z.object({
    state: z.string().min(32).max(128), installationId: z.string().min(1).max(100)
  }).strict(),
  github_reconcile: z.object({ installationId: z.string().min(1).max(100).optional() }).strict(),
  github_disconnect: z.object({ installationId: z.string().min(1).max(100) }).strict(),
  privilege_grant_list: z.object({ workspaceId: WorkspaceIdSchema.optional() }).strict(),
  privilege_grant_approve: z.object({ grantId: z.string().min(1).max(128) }).strict(),
  privilege_grant_reject: z.object({ grantId: z.string().min(1).max(128) }).strict(),
  model_credential_list: z.object({}).strict(),
  model_credential_create: ProviderCredentialInputSchema,
  model_credential_rotate: z.object({
    credentialId: ModelCredentialIdSchema,
    apiKey: z.string().min(1).max(4096),
    secretReference: z.string().max(256).optional(),
    expectedGeneration: generation
  }).strict(),
  model_credential_delete: z.object({ credentialId: ModelCredentialIdSchema, expectedGeneration: generation }).strict(),
  model_profile_list: z.object({}).strict(),
  model_profile_create: AgentModelProfileInputSchema,
  model_profile_update: AgentModelProfileUpdateInputSchema.extend({ profileId: ModelProfileIdSchema }).strict(),
  model_profile_activate: z.object({ profileId: ModelProfileIdSchema, expectedGeneration: generation }).strict(),
  model_profile_disable: z.object({ profileId: ModelProfileIdSchema, expectedGeneration: generation }).strict(),
  model_profile_delete: z.object({ profileId: ModelProfileIdSchema, expectedGeneration: generation }).strict(),
  model_config_status: z.object({}).strict(),
  knowledge_dashboard_list: z.object({
    kind: KnowledgeKindSchema.optional(),
    scope: KnowledgeScopeSchema.optional(),
    projectId: internalId('prj').optional(),
    journalType: JournalTypeSchema.optional(),
    tags: z.array(KnowledgeTagSchema).max(16).optional(),
    tagMatch: z.enum(['all', 'any']).default('all'),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().max(256).optional()
  }).strict(),
  knowledge_dashboard_get: z.object({
    id: KnowledgeItemIdSchema
  }).strict(),
  knowledge_dashboard_create: z.object({
    kind: KnowledgeKindSchema.default('memory'),
    scope: KnowledgeScopeSchema.default('owner'),
    projectId: internalId('prj').optional(),
    workspaceId: WorkspaceIdSchema.optional(),
    title: z.string().min(1).max(120),
    content: z.string().max(262_144),
    journalType: JournalTypeSchema.optional(),
    occurredAt: z.number().int().positive().optional(),
    tags: z.array(KnowledgeTagSchema).max(16).default([]),
    retentionSeconds: z.number().int().min(60).max(31_536_000).optional(),
    expectedGeneration: z.literal(0)
  }).strict(),
  knowledge_dashboard_update: z.object({
    id: KnowledgeItemIdSchema,
    title: z.string().min(1).max(120).optional(),
    content: z.string().max(262_144).optional(),
    journalType: JournalTypeSchema.optional(),
    occurredAt: z.number().int().positive().optional(),
    tags: z.array(KnowledgeTagSchema).max(16).optional(),
    retentionSeconds: z.number().int().min(60).max(31_536_000).optional(),
    expectedGeneration: generation
  }).strict(),
  knowledge_dashboard_delete: z.object({
    id: KnowledgeItemIdSchema,
    expectedGeneration: generation
  }).strict(),
  knowledge_dashboard_search: z.object({
    query: z.string().min(1).max(512),
    kinds: z.array(KnowledgeKindSchema).max(2).optional(),
    scope: KnowledgeScopeSchema.optional(),
    projectId: internalId('prj').optional(),
    journalType: JournalTypeSchema.optional(),
    tags: z.array(KnowledgeTagSchema).max(16).optional(),
    tagMatch: z.enum(['all', 'any']).default('all'),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().max(256).optional()
  }).strict(),
  knowledge_dashboard_graph: z.object({
    rootId: KnowledgeItemIdSchema.optional(),
    depth: z.number().int().min(1).max(3).default(1),
    maxNodes: z.number().int().min(1).max(200).default(50),
    kinds: z.array(KnowledgeKindSchema).max(2).optional(),
    projectId: internalId('prj').optional()
  }).strict(),
  knowledge_dashboard_link_create: z.object({
    sourceId: KnowledgeItemIdSchema,
    targetId: KnowledgeItemIdSchema,
    relation: KnowledgeRelationSchema.default('relates-to'),
    expectedGeneration: z.literal(0)
  }).strict(),
  knowledge_dashboard_link_delete: z.object({
    linkId: KnowledgeLinkIdSchema.optional(),
    sourceId: KnowledgeItemIdSchema.optional(),
    targetId: KnowledgeItemIdSchema.optional(),
    relation: KnowledgeRelationSchema.optional(),
    expectedGeneration: generation.optional()
  }).strict(),
  mcp_server_list: z.object({}).strict(),
  mcp_server_get: z.object({ serverId: internalId('mcps') }).strict(),
  mcp_server_create: McpGatewayCreateInputSchema,
  mcp_server_update: McpGatewayUpdateInputSchema.extend({ serverId: internalId('mcps') }),
  mcp_server_delete: z.object({ serverId: internalId('mcps'), expectedGeneration: generation }).strict(),
  mcp_server_set_enabled: z.object({
    serverId: internalId('mcps'),
    enabled: z.boolean(),
    expectedGeneration: generation
  }).strict(),
  mcp_server_set_permissions: McpGatewaySetPermissionsInputSchema
    .omit({ serverId: true, expectedGeneration: true })
    .extend({ serverId: internalId('mcps'), expectedGeneration: generation }),
  mcp_server_replace_tools: z.object({
    serverId: internalId('mcps'),
    tools: z.array(z.object({
      upstreamName: McpGatewayToolNameSchema,
      description: z.string().max(2_000),
      inputSchema: z.unknown(),
      annotations: McpGatewayToolAnnotationsSchema.nullable().default(null),
      availability: McpGatewayToolAvailabilitySchema,
      schemaBytes: z.number().int().min(0)
    }).strict()).max(2_000),
    status: McpGatewayServerStatusSchema.default('connected'),
    cap: z.number().int().min(1).max(2_000).default(500)
  }).strict(),
  mcp_server_connection_result: z.object({
    serverId: internalId('mcps'),
    status: McpGatewayServerStatusSchema,
    error: z.string().max(2_000).nullable().default(null)
  }).strict(),
  mcp_server_get_credentials: z.object({
    serverId: internalId('mcps'),
    toolName: z.string().max(120).optional(),
    purpose: McpGatewayCredentialPurposeSchema
  }).strict(),
  mcp_gateway_catalog: McpGatewayCatalogFilterSchema,
  mcp_gateway_trace_append: z.object({
    serverId: internalId('mcps').nullable().default(null),
    serverName: McpGatewayServerNameSchema,
    tool: z.string().max(190).nullable().default(null),
    operation: z.string().trim().min(1).max(32),
    clientId: z.string().max(120).nullable().default(null),
    durationMs: z.number().int().min(0),
    status: McpGatewayTraceStatusSchema,
    errorCode: z.string().max(64).nullable().default(null),
    errorMessage: z.string().max(4_000).nullable().default(null),
    requestBytes: z.number().int().min(0).nullable().default(null),
    responseBytes: z.number().int().min(0).nullable().default(null),
    /**
     * Resolved credential values must never be sent to the runner. This wire field
     * exists only for runner-local tests; the API must always pass an empty array.
     */
    secrets: z.array(z.string().min(1).max(4_096)).max(8).default([]),
    maxRows: z.number().int().min(100).max(1_000_000).default(20_000)
  }).strict(),
  mcp_gateway_trace_list: z.object({
    serverId: internalId('mcps').optional(),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().max(256).optional()
  }).strict()
} as const;

const metadataRequest = <Operation extends keyof typeof metadataInputs>(operation: Operation) => z.object({
  version: z.literal(2),
  principal: RunnerPrincipalSelectorSchema,
  operation: z.literal(operation),
  input: metadataInputs[operation]
}).strict();

export const MetadataRunnerRequestSchema = z.discriminatedUnion('operation', [
  metadataRequest('project_list'), metadataRequest('project_create'), metadataRequest('project_update'), metadataRequest('project_delete'),
  metadataRequest('environment_list'), metadataRequest('environment_create'), metadataRequest('environment_update'), metadataRequest('environment_delete'),
  metadataRequest('secret_list'), metadataRequest('secret_create'), metadataRequest('secret_rotate'), metadataRequest('secret_update'), metadataRequest('secret_delete'), metadataRequest('secret_bulk_apply'),
  metadataRequest('global_secret_list'), metadataRequest('global_secret_create'), metadataRequest('global_secret_rotate'), metadataRequest('global_secret_update'), metadataRequest('global_secret_delete'), metadataRequest('global_secret_bulk_apply'),
  metadataRequest('audit_list'), metadataRequest('artifact_list'), metadataRequest('artifact_snapshot'),
  metadataRequest('artifact_read'), metadataRequest('artifact_restore'), metadataRequest('artifact_delete'),
  metadataRequest('github_status'), metadataRequest('github_setup_begin'), metadataRequest('github_setup_complete'), metadataRequest('github_reconcile'), metadataRequest('github_disconnect'),
  metadataRequest('privilege_grant_list'), metadataRequest('privilege_grant_approve'), metadataRequest('privilege_grant_reject'),
  metadataRequest('model_credential_list'), metadataRequest('model_credential_create'), metadataRequest('model_credential_rotate'), metadataRequest('model_credential_delete'),
  metadataRequest('model_profile_list'), metadataRequest('model_profile_create'), metadataRequest('model_profile_update'), metadataRequest('model_profile_activate'), metadataRequest('model_profile_disable'), metadataRequest('model_profile_delete'),
  metadataRequest('model_config_status'),
  metadataRequest('knowledge_dashboard_list'), metadataRequest('knowledge_dashboard_get'), metadataRequest('knowledge_dashboard_create'), metadataRequest('knowledge_dashboard_update'),
  metadataRequest('knowledge_dashboard_delete'), metadataRequest('knowledge_dashboard_search'), metadataRequest('knowledge_dashboard_graph'),
  metadataRequest('knowledge_dashboard_link_create'), metadataRequest('knowledge_dashboard_link_delete'),
  metadataRequest('mcp_server_list'), metadataRequest('mcp_server_get'), metadataRequest('mcp_server_create'), metadataRequest('mcp_server_update'),
  metadataRequest('mcp_server_delete'), metadataRequest('mcp_server_set_enabled'), metadataRequest('mcp_server_set_permissions'),
  metadataRequest('mcp_server_replace_tools'), metadataRequest('mcp_server_connection_result'), metadataRequest('mcp_server_get_credentials'),
  metadataRequest('mcp_gateway_catalog'), metadataRequest('mcp_gateway_trace_append'), metadataRequest('mcp_gateway_trace_list')
]);

export type InternalRunnerOperation = z.infer<typeof InternalRunnerOperationSchema>;
export type InternalRunnerRequest = z.infer<typeof InternalRunnerRequestSchema>;
export type InternalRunnerResponse = z.infer<typeof InternalRunnerResponseSchema>;
export type MetadataRunnerOperation = z.infer<typeof MetadataRunnerOperationSchema>;
export type MetadataRunnerRequest = z.infer<typeof MetadataRunnerRequestSchema>;
