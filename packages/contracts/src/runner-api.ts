import { z } from 'zod';
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
  'hooks_list', 'hooks_run', 'hooks_activate', 'hooks_deactivate',
  'memories_list', 'memories_read', 'memories_write', 'memories_search', 'memories_delete',
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
  networkMode: z.string()
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

export const ProvenanceSourceSchema = z.enum(['built-in', 'owner', 'workspace', 'repository']);
export const TrustClassSchema = z.enum(['trusted-control-plane', 'owner-controlled', 'untrusted-executor']);
export const MutabilitySchema = z.enum(['release', 'owner', 'workspace-process', 'repository-commit']);

export const ToolkitVerificationSchema = z.enum(['built-in', 'catalog-pinned', 'custom-unverified']);
export const ToolkitOriginSchema = z.object({
  kind: z.literal('toolkit'),
  instanceId: z.string().max(80),
  toolkitId: z.string().max(120),
  resolvedRevision: z.string().max(120).optional(),
  bundleSha256: z.string().length(64),
  adapterVersion: z.number().int().min(1),
  verification: ToolkitVerificationSchema
}).strict();

export const ProvenanceSchema = z.object({
  source: ProvenanceSourceSchema,
  trust: TrustClassSchema,
  mutableBy: MutabilitySchema,
  path: z.string().optional(),
  contentSha256: z.string().length(64),
  discoveredAt: z.string().datetime(),
  origin: ToolkitOriginSchema.optional()
}).strict();

export const ContextClientSchema = z.enum(['all', 'claude', 'codex', 'cursor', 'aider']);
export const ContextKindSchema = z.enum(['instruction', 'language-manifest', 'test-command', 'skill-summary']);

export const ContextManifestItemSchema = z.object({
  id: z.string().min(1).max(120),
  kind: ContextKindSchema,
  format: z.string().max(80),
  clients: z.array(ContextClientSchema),
  path: z.string().optional(),
  appliesTo: z.string().max(256).optional(),
  activeForClient: z.boolean().default(true),
  contentSha256: z.string().length(64),
  byteCount: z.number().int().min(0),
  excerpt: z.string().max(8192).optional(),
  references: z.array(z.string().max(256)).optional(),
  provenance: ProvenanceSchema
}).strict();

export const ContextManifestSchema = z.object({
  contractVersion: z.literal(1).default(1),
  returnedBytes: z.number().int().min(0),
  scannedFiles: z.number().int().min(0),
  scannedSourceBytes: z.number().int().min(0),
  truncated: z.boolean().default(false),
  truncationReasons: z.array(z.string().max(100)).default([]),
  cursor: z.string().max(256).optional(),
  items: z.array(ContextManifestItemSchema),
  warnings: z.array(z.object({
    code: z.string().max(80),
    path: z.string().optional(),
    message: z.string().max(512)
  })).default([])
}).strict();

export const MemoryScopeSchema = z.enum(['owner', 'repository', 'workspace']);
export const HookEventSchema = z.enum(['on_workspace_open', 'post_checkout', 'pre_commit', 'post_commit', 'manual']);


export const ToolkitScopeSchema = z.enum(['owner', 'workspace']);
export const ToolkitStatusSchema = z.enum(['ready', 'failed']);
export const ToolkitActivationSchema = z.enum(['skills-only', 'toolkit-default']);
export const ToolkitCompatibilityLevelSchema = z.enum(['provisioned', 'discoverable', 'context-ready', 'auto-activated']);

export const ToolkitLockItemSchema = z.object({
  instanceId: z.string().max(80),
  id: z.string().max(120),
  requestedVersion: z.string().nullable().optional(),
  resolvedVersion: z.string().max(120),
  resolvedRevision: z.string().max(120),
  bundleSha256: z.string().length(64),
  adapterVersion: z.number().int().min(1),
  scope: ToolkitScopeSchema,
  status: ToolkitStatusSchema,
  cache: z.enum(['hit', 'miss']),
  activation: z.string().max(80),
  skillsCount: z.number().int().min(0),
  verification: ToolkitVerificationSchema,
  compatibility: ToolkitCompatibilityLevelSchema.optional(),
  warnings: z.array(z.string().max(256)).optional()
}).strict();

export const WorkspaceToolkitsLockSchema = z.object({
  requestFingerprint: z.string().length(64),
  items: z.array(ToolkitLockItemSchema),
  repositoryChanges: z.array(z.string().max(256)),
  executorNetworkMode: z.enum(['none', 'bridge']),
  provisioningNetworkUsed: z.boolean()
}).strict();
export type ProvenanceSource = z.infer<typeof ProvenanceSourceSchema>;
export type TrustClass = z.infer<typeof TrustClassSchema>;
export type Mutability = z.infer<typeof MutabilitySchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type ContextClient = z.infer<typeof ContextClientSchema>;
export type ContextKind = z.infer<typeof ContextKindSchema>;
export type ContextManifestItem = z.infer<typeof ContextManifestItemSchema>;
export type ContextManifest = z.infer<typeof ContextManifestSchema>;
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;
export type HookEvent = z.infer<typeof HookEventSchema>;
export type ToolkitVerification = z.infer<typeof ToolkitVerificationSchema>;
export type ToolkitOrigin = z.infer<typeof ToolkitOriginSchema>;
export type ToolkitScope = z.infer<typeof ToolkitScopeSchema>;
export type ToolkitStatus = z.infer<typeof ToolkitStatusSchema>;
export type ToolkitActivation = z.infer<typeof ToolkitActivationSchema>;
export type ToolkitCompatibilityLevel = z.infer<typeof ToolkitCompatibilityLevelSchema>;
export type ToolkitLockItem = z.infer<typeof ToolkitLockItemSchema>;
export type WorkspaceToolkitsLock = z.infer<typeof WorkspaceToolkitsLockSchema>;
