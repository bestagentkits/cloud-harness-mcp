import { z } from 'zod';
import { WorkspaceNetworkExposureSchema } from './identifiers.js';
import { ToolResultSchema } from './mcp-results.js';

export const RunnerOperationSchema = z.enum([
  'workspace_open', 'workspace_list', 'workspace_status', 'workspace_capabilities', 'workspace_close',
  'workspace_lease_renew', 'workspace_recover', 'workspace_context', 'workspace_set_active',
  'workspace_finalize',
  'files_list', 'files_read', 'files_write', 'files_write_batch', 'files_apply_patch', 'files_delete', 'files_move', 'files_mkdir', 'grep_search',
  'symbols_search', 'symbols_references',
  'exec_run', 'shell_open', 'shell_io', 'shell_close',
  'sessions_list', 'sessions_open', 'sessions_io', 'sessions_close',
  'tasks_list', 'tasks_run', 'tasks_status', 'tasks_cancel', 'tasks_graph',
  'operation_status', 'operation_cancel', 'operation_wait',
  'git_status', 'git_diff', 'git_log', 'git_branch', 'git_checkout', 'git_add', 'git_commit', 'git_fetch', 'git_pull', 'git_push', 'git_merge', 'git_rebase',
  'git_identity_status', 'git_identity_set',
  'worktrees_list', 'worktrees_create', 'worktrees_remove',
  'skills_list', 'skills_read', 'skills_run',
  'hooks_list', 'hooks_run',
  'memories_list', 'memories_read', 'memories_write',
  'deployments_list', 'deployments_run',
  'artifacts_snapshot', 'artifacts_list', 'artifacts_read', 'artifacts_restore', 'artifacts_delete',
  'github_action',
  'secrets_list'
]);

export const ExternalPrincipalSchema = z.object({
  issuer: z.url().refine((value) => new URL(value).protocol === 'https:', 'HTTPS issuer required'),
  subject: z.string().min(1).max(512),
  email: z.email().max(320).optional(),
  name: z.string().min(1).max(200).optional()
}).strict();

export const RunnerPrincipalSelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('owner'), ownerId: z.string().min(1).max(100) }).strict(),
  ExternalPrincipalSchema.extend({ kind: z.literal('external') }).strict()
]);

const runnerOperationFields = {
  operation: RunnerOperationSchema,
  input: z.record(z.string(), z.unknown())
};

export const RunnerRequestSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ownerId: z.string().min(1).max(100), ...runnerOperationFields }).strict(),
  z.object({ version: z.literal(2), principal: RunnerPrincipalSelectorSchema, ...runnerOperationFields }).strict()
]);

export const RunnerResponseSchema = ToolResultSchema;

export type RunnerOperation = z.infer<typeof RunnerOperationSchema>;
export type ExternalPrincipal = z.infer<typeof ExternalPrincipalSchema>;
export type RunnerPrincipalSelector = z.infer<typeof RunnerPrincipalSelectorSchema>;
export type RunnerRequest = z.infer<typeof RunnerRequestSchema>;
export type RunnerResponse = z.infer<typeof RunnerResponseSchema>;

export const RepositoryCapabilitiesSchema = z.object({
  read: z.boolean(),
  push: z.boolean(),
  issuesRead: z.boolean(),
  issuesWrite: z.boolean(),
  pullRequestsRead: z.boolean(),
  pullRequestsWrite: z.boolean()
}).strict();

export const WorkspaceCapabilitiesSchema = z.object({
  shell: z.boolean(),
  tasks: z.boolean(),
  sessions: z.boolean(),
  deployments: z.boolean(),
  privileged: z.boolean().default(false),
  networkProfile: WorkspaceNetworkExposureSchema
}).passthrough();

export const RepositoryPermissionsSchema = z.object({
  contents: z.object({ read: z.boolean(), write: z.boolean() }).strict(),
  issues: z.object({ read: z.boolean(), write: z.boolean() }).strict(),
  pullRequests: z.object({ read: z.boolean(), write: z.boolean() }).strict()
}).strict();

export const RepositoryOperationsSchema = z.object({
  gitFetch: z.boolean(),
  gitPull: z.boolean(),
  gitPush: z.boolean(),
  issueList: z.boolean(),
  issueView: z.boolean(),
  issueCreate: z.boolean(),
  issueComment: z.boolean(),
  issueUpdate: z.boolean(),
  issuePublish: z.boolean(),
  labelCreate: z.boolean(),
  pullRequestList: z.boolean(),
  pullRequestView: z.boolean(),
  pullRequestCreate: z.boolean(),
  execRun: z.boolean(),
  privilegedExec: z.boolean(),
  deploymentsRun: z.boolean()
}).passthrough();

export const WorkspaceCapabilityResultSchema = z.object({
  workspaceId: z.string(),
  repository: z.string().nullable(),
  repositoryUrl: z.string(),
  capabilities: z.object({
    repository: RepositoryCapabilitiesSchema,
    workspace: WorkspaceCapabilitiesSchema
  }).passthrough(),
  permissions: RepositoryPermissionsSchema,
  operations: RepositoryOperationsSchema
}).passthrough();

export type RepositoryCapabilities = z.infer<typeof RepositoryCapabilitiesSchema>;
export type WorkspaceCapabilities = z.infer<typeof WorkspaceCapabilitiesSchema>;
export type RepositoryPermissions = z.infer<typeof RepositoryPermissionsSchema>;
export type RepositoryOperations = z.infer<typeof RepositoryOperationsSchema>;
export type WorkspaceCapabilityResult = z.infer<typeof WorkspaceCapabilityResultSchema>;
