import { z } from 'zod';
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
  'deployments_list', 'deployments_run'
]);

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
