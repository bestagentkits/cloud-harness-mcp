import { z } from 'zod';
import { AgentIdSchema, IdempotencyKeySchema, WorkspaceIdSchema } from './identifiers.js';
import { ToolResultSchema } from './mcp-results.js';

export const RunnerOperationSchema = z.enum([
  'workspace_open', 'workspace_list', 'workspace_status', 'workspace_close',
  'files_list', 'files_read', 'files_write', 'files_apply_patch', 'files_delete', 'files_move', 'files_mkdir', 'grep_search',
  'symbols_search', 'symbols_references',
  'exec_run', 'shell_open', 'shell_io', 'shell_close',
  'sessions_list', 'sessions_open', 'sessions_io', 'sessions_close',
  'tasks_list', 'tasks_run', 'tasks_status', 'tasks_cancel', 'tasks_graph',
  'git_status', 'git_diff', 'git_log', 'git_branch', 'git_checkout', 'git_add', 'git_commit', 'git_fetch', 'git_pull', 'git_push', 'git_merge', 'git_rebase',
  'worktrees_list', 'worktrees_create', 'worktrees_remove',
  'skills_list', 'skills_read', 'skills_run',
  'hooks_list', 'hooks_run',
  'memories_list', 'memories_read', 'memories_write',
  'deployments_list', 'deployments_run',
  'agent_spawn', 'agent_status', 'agent_logs', 'agent_message', 'agent_cancel', 'agent_list'
]);

export const AgentProxyOperationSchema = z.enum([
  'files_list',
  'files_read',
  'files_write',
  'files_apply_patch',
  'files_delete',
  'files_move',
  'files_mkdir',
  'grep_search',
  'symbols_search',
  'symbols_references'
]);

export const AgentStatusSchema = z.enum([
  'SPAWNING',
  'RUNNING',
  'CANCELLING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
  'LIMIT_EXCEEDED',
  'INTERRUPTED'
]);

export const AgentMessageModeSchema = z.enum(['steer', 'followUp']);
export const AgentMessageDeliveryStateSchema = z.enum(['RESERVED', 'SENT', 'REJECTED', 'UNKNOWN']);

export const AgentBudgetSchema = z.object({
  ttlSeconds: z.number().int().min(30).max(86_400),
  maxOutputBytes: z.number().int().min(1_024).max(10_485_760),
  maxInputTokens: z.number().int().min(1).max(2_000_000),
  maxOutputTokens: z.number().int().min(1).max(2_000_000),
  maxCostMicros: z.number().int().min(0).max(1_000_000_000)
}).strict();

export const AgentUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costMicros: z.number().int().nonnegative(),
  outputBytes: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  toolTimeMs: z.number().int().nonnegative(),
  wallTimeMs: z.number().int().nonnegative()
}).strict();

const instant = z.iso.datetime({ offset: true });

export const AgentLiveStatusDataSchema = z.object({
  agentId: AgentIdSchema,
  workspaceId: WorkspaceIdSchema,
  parentAgentId: AgentIdSchema.nullable(),
  profileId: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  proxyOperations: z.array(AgentProxyOperationSchema)
    .min(1)
    .max(AgentProxyOperationSchema.options.length)
    .refine((operations) => new Set(operations).size === operations.length, 'proxy operations must be unique'),
  status: AgentStatusSchema,
  generation: z.number().int().positive(),
  createdAt: instant,
  startedAt: instant.nullable(),
  terminalAt: instant.nullable(),
  expiresAt: instant,
  budget: AgentBudgetSchema,
  usage: AgentUsageSchema,
  terminalReason: z.string().max(2_000).nullable(),
  outcomeUnknown: z.boolean()
}).strict();

export const AgentCompactedStatusDataSchema = z.object({
  agentId: AgentIdSchema,
  workspaceId: WorkspaceIdSchema,
  status: AgentStatusSchema,
  generation: z.number().int().positive(),
  compactedAt: instant,
  expiresAt: instant,
  compacted: z.literal(true)
}).strict();

export const AgentStatusDataSchema = z.union([
  AgentLiveStatusDataSchema,
  AgentCompactedStatusDataSchema
]);

export const AgentSpawnDataSchema = z.object({
  agentId: AgentIdSchema,
  status: AgentStatusSchema,
  generation: z.number().int().positive(),
  replayed: z.boolean()
}).strict();

export const AgentLogEventSchema = z.object({
  cursor: z.string().regex(/^(?:0|[1-9]\d*)$/),
  nextCursor: z.string().regex(/^(?:0|[1-9]\d*)$/),
  timestamp: instant,
  type: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
  content: z.string().max(65_536)
}).strict();

export const AgentLogsDataSchema = z.object({
  agentId: AgentIdSchema,
  cursor: z.string().regex(/^(?:0|[1-9]\d*)$/),
  nextCursor: z.string().regex(/^(?:0|[1-9]\d*)$/),
  retainedBaseCursor: z.string().regex(/^(?:0|[1-9]\d*)$/),
  events: z.array(AgentLogEventSchema).max(1_000),
  truncated: z.boolean(),
  hasMore: z.boolean()
}).strict();

export const AgentMessageDataSchema = z.object({
  agentId: AgentIdSchema,
  idempotencyKey: IdempotencyKeySchema,
  state: AgentMessageDeliveryStateSchema,
  replayed: z.boolean()
}).strict();

export const AgentCancelDataSchema = z.object({
  agentId: AgentIdSchema,
  status: AgentStatusSchema,
  affectedAgentIds: z.array(AgentIdSchema).max(1_000)
}).strict();

export const AgentListDataSchema = z.object({
  agents: z.array(AgentLiveStatusDataSchema).max(100),
  nextCursor: z.string().regex(/^[1-9]\d*$/).nullable()
}).strict();

export const RunnerRequestSchema = z.object({
  version: z.literal(1),
  ownerId: z.string().min(1).max(100),
  operation: RunnerOperationSchema,
  input: z.record(z.string(), z.unknown())
});

export const RunnerResponseSchema = ToolResultSchema;

export type RunnerOperation = z.infer<typeof RunnerOperationSchema>;
export type RunnerRequest = z.infer<typeof RunnerRequestSchema>;
export type RunnerResponse = z.infer<typeof RunnerResponseSchema>;
export type AgentProxyOperation = z.infer<typeof AgentProxyOperationSchema>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type AgentMessageMode = z.infer<typeof AgentMessageModeSchema>;
export type AgentMessageDeliveryState = z.infer<typeof AgentMessageDeliveryStateSchema>;
export type AgentBudget = z.infer<typeof AgentBudgetSchema>;
export type AgentUsage = z.infer<typeof AgentUsageSchema>;
export type AgentStatusData = z.infer<typeof AgentStatusDataSchema>;
export type AgentSpawnData = z.infer<typeof AgentSpawnDataSchema>;
export type AgentLogsData = z.infer<typeof AgentLogsDataSchema>;
export type AgentMessageData = z.infer<typeof AgentMessageDataSchema>;
export type AgentCancelData = z.infer<typeof AgentCancelDataSchema>;
export type AgentListData = z.infer<typeof AgentListDataSchema>;
