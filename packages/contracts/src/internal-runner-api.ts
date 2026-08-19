import { z } from 'zod';
import { WorkspaceIdSchema } from './identifiers.js';
import { ToolResultSchema } from './mcp-results.js';
import { RunnerPrincipalSelectorSchema } from './runner-api.js';

export const InternalRunnerOperationSchema = z.enum([
  'workspace_detail',
  'workspace_close_fenced'
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

export const InternalRunnerRequestSchema = z.discriminatedUnion('operation', [
  workspaceDetailRequest,
  workspaceCloseFencedRequest
]);

export const InternalRunnerResponseSchema = ToolResultSchema;

const internalId = (prefix: string) => z.string()
  .regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{20,80}$`), `invalid ${prefix} identifier`);
const generation = z.number().int().positive();
const name = z.string().trim().min(1).max(100);

export const MetadataRunnerOperationSchema = z.enum([
  'project_list', 'project_create', 'project_update', 'project_delete',
  'environment_list', 'environment_create', 'environment_update', 'environment_delete',
  'secret_list', 'secret_create', 'secret_rotate', 'secret_delete', 'audit_list',
  'artifact_list', 'artifact_snapshot', 'artifact_delete',
  'github_status', 'github_setup_begin', 'github_setup_complete', 'github_reconcile', 'github_disconnect'
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
  secret_create: z.object({ environmentId: internalId('env'), name, value: z.string().min(1).max(65_536), expectedGeneration: z.literal(0) }).strict(),
  secret_rotate: z.object({ environmentId: internalId('env'), name, value: z.string().min(1).max(65_536), expectedGeneration: generation }).strict(),
  secret_delete: z.object({ environmentId: internalId('env'), name, expectedGeneration: generation }).strict(),
  audit_list: z.object({ cursor: internalId('aud').optional(), limit: z.number().int().min(1).max(100).default(50) }).strict(),
  artifact_list: z.object({ cursor: z.string().max(256).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict(),
  artifact_snapshot: z.object({
    workspaceId: WorkspaceIdSchema, path: z.string().min(1).max(1_024), logicalName: z.string().min(1).max(128),
    projectId: internalId('prj').optional(), environmentId: internalId('env').optional(),
    retentionSeconds: z.number().int().min(60).max(2_592_000).optional(), expectedGeneration: z.literal(0)
  }).strict(),
  artifact_delete: z.object({ artifactId: internalId('art'), expectedGeneration: generation }).strict(),
  github_status: z.object({}).strict(),
  github_setup_begin: z.object({ expectedAccountId: z.string().min(1).max(100).optional() }).strict(),
  github_setup_complete: z.object({
    state: z.string().min(32).max(128), installationId: z.string().min(1).max(100)
  }).strict(),
  github_reconcile: z.object({ installationId: z.string().min(1).max(100).optional() }).strict(),
  github_disconnect: z.object({ installationId: z.string().min(1).max(100) }).strict()
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
  metadataRequest('secret_list'), metadataRequest('secret_create'), metadataRequest('secret_rotate'), metadataRequest('secret_delete'),
  metadataRequest('audit_list'), metadataRequest('artifact_list'), metadataRequest('artifact_snapshot'), metadataRequest('artifact_delete'),
  metadataRequest('github_status'), metadataRequest('github_setup_begin'), metadataRequest('github_setup_complete'),
  metadataRequest('github_reconcile'), metadataRequest('github_disconnect')
]);

export type InternalRunnerOperation = z.infer<typeof InternalRunnerOperationSchema>;
export type InternalRunnerRequest = z.infer<typeof InternalRunnerRequestSchema>;
export type InternalRunnerResponse = z.infer<typeof InternalRunnerResponseSchema>;
export type MetadataRunnerOperation = z.infer<typeof MetadataRunnerOperationSchema>;
export type MetadataRunnerRequest = z.infer<typeof MetadataRunnerRequestSchema>;
