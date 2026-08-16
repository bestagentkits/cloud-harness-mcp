import { z } from 'zod';
import { IdempotencyKeySchema, ShellIdSchema, TaskIdSchema, WorkspaceIdSchema } from './identifiers.js';
import type { RunnerOperation } from './runner-api.js';

const relativePath = z.string().min(1).max(1_024).refine((value) => {
  const normalized = value.replaceAll('\\', '/');
  return !normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized) && !normalized.split('/').includes('..') && !normalized.includes('\0');
}, 'path must stay workspace-relative');
const workspace = { workspaceId: WorkspaceIdSchema };
const pagination = { cursor: z.string().max(256).optional(), limit: z.number().int().min(1).max(500).default(100) };
const gitArgument = z.string().min(1).max(255).refine((value) => !value.startsWith('-') && !value.includes('\0'), 'Git argument cannot start with a dash');
const gitRemote = z.string().regex(/^(?!-)[A-Za-z0-9._-]{1,100}$/, 'invalid Git remote name');

const schemas = {
  workspace_open: z.object({ repositoryUrl: z.url(), ref: gitArgument.optional(), idempotencyKey: IdempotencyKeySchema, networkMode: z.enum(['none', 'bridge']).optional() }),
  workspace_list: z.object(pagination),
  workspace_status: z.object(workspace),
  workspace_close: z.object(workspace),
  files_list: z.object({ ...workspace, path: relativePath.default('.'), ...pagination }),
  files_read: z.object({ ...workspace, path: relativePath, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(262_144).default(65_536) }),
  files_write: z.object({ ...workspace, path: relativePath, content: z.string().max(1_048_576), expectedSha256: z.string().length(64).optional() }),
  files_apply_patch: z.object({ ...workspace, path: relativePath, oldText: z.string().max(262_144), newText: z.string().max(262_144), expectedSha256: z.string().length(64).optional() }),
  grep_search: z.object({ ...workspace, pattern: z.string().min(1).max(4_096), path: relativePath.default('.'), glob: z.string().max(512).optional(), maxResults: z.number().int().min(1).max(500).default(100) }),
  exec_run: z.object({ ...workspace, command: z.string().min(1).max(32_768), cwd: relativePath.default('.'), timeoutMs: z.number().int().min(100).max(300_000).default(60_000), maxOutputBytes: z.number().int().min(1_024).max(1_048_576).default(262_144) }),
  shell_open: z.object({ ...workspace, cwd: relativePath.default('.'), idempotencyKey: IdempotencyKeySchema }),
  shell_io: z.object({ ...workspace, shellId: ShellIdSchema, input: z.string().max(65_536).optional(), cursor: z.string().max(256).optional(), waitMs: z.number().int().min(0).max(5_000).default(100) }),
  shell_close: z.object({ ...workspace, shellId: ShellIdSchema }),
  tasks_list: z.object({ ...workspace, ...pagination }),
  tasks_run: z.object({ ...workspace, command: z.string().min(1).max(32_768), cwd: relativePath.default('.'), idempotencyKey: IdempotencyKeySchema, timeoutMs: z.number().int().min(100).max(86_400_000).default(900_000) }),
  tasks_status: z.object({ ...workspace, taskId: TaskIdSchema, cursor: z.string().max(256).optional() }),
  tasks_cancel: z.object({ ...workspace, taskId: TaskIdSchema }),
  git_status: z.object(workspace),
  git_diff: z.object({ ...workspace, staged: z.boolean().default(false), path: relativePath.optional() }),
  git_log: z.object({ ...workspace, limit: z.number().int().min(1).max(100).default(20) }),
  git_branch: z.object({ ...workspace, action: z.enum(['list', 'create', 'delete']), name: gitArgument.optional(), startPoint: gitArgument.optional(), force: z.boolean().default(false) }).superRefine((input, context) => {
    if (input.action !== 'list' && !input.name) context.addIssue({ code: 'custom', path: ['name'], message: 'name is required for create and delete' });
  }),
  git_checkout: z.object({ ...workspace, ref: gitArgument, create: z.boolean().default(false) }),
  git_commit: z.object({ ...workspace, message: z.string().min(1).max(10_000), authorName: z.string().min(1).max(200), authorEmail: z.email(), all: z.boolean().default(false) }),
  git_fetch: z.object({ ...workspace, remote: gitRemote.default('origin'), refspec: gitArgument.optional() }),
  worktrees_list: z.object(workspace),
  worktrees_create: z.object({ ...workspace, name: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/), ref: gitArgument, createBranch: z.boolean().default(false) }),
  worktrees_remove: z.object({ ...workspace, name: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/), force: z.boolean().default(false) }),
  skills_list: z.object(workspace),
  skills_read: z.object({ ...workspace, name: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/) }),
  skills_run: z.object({ ...workspace, name: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/), script: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/), args: z.array(z.string().max(2_048)).max(50).default([]), timeoutMs: z.number().int().min(100).max(300_000).default(60_000) }),
  hooks_list: z.object(workspace),
  hooks_run: z.object({ ...workspace, name: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/), timeoutMs: z.number().int().min(100).max(300_000).default(60_000) }),
  memories_list: z.object(workspace),
  memories_read: z.object({ ...workspace, name: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/) }),
  memories_write: z.object({ ...workspace, name: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/), content: z.string().max(262_144) })
} satisfies Record<RunnerOperation, z.ZodType>;

export type ToolSpec = {
  name: RunnerOperation;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
};

const titles: Record<RunnerOperation, string> = {
  workspace_open: 'Open workspace', workspace_list: 'List workspaces', workspace_status: 'Workspace status', workspace_close: 'Close workspace',
  files_list: 'List files', files_read: 'Read file', files_write: 'Write file', files_apply_patch: 'Apply text patch', grep_search: 'Search workspace',
  exec_run: 'Run command', shell_open: 'Open shell', shell_io: 'Use shell', shell_close: 'Close shell', tasks_list: 'List tasks', tasks_run: 'Run task', tasks_status: 'Task status', tasks_cancel: 'Cancel task',
  git_status: 'Git status', git_diff: 'Git diff', git_log: 'Git log', git_branch: 'Manage Git branches', git_checkout: 'Checkout Git ref', git_commit: 'Create Git commit', git_fetch: 'Fetch Git refs',
  worktrees_list: 'List worktrees', worktrees_create: 'Create worktree', worktrees_remove: 'Remove worktree',
  skills_list: 'List skills', skills_read: 'Read skill', skills_run: 'Run skill script', hooks_list: 'List hooks', hooks_run: 'Run hook', memories_list: 'List memories', memories_read: 'Read memory', memories_write: 'Write memory'
};

const readOnly = new Set<RunnerOperation>(['workspace_list', 'workspace_status', 'files_list', 'files_read', 'grep_search', 'tasks_list', 'tasks_status', 'git_status', 'git_diff', 'git_log', 'worktrees_list', 'skills_list', 'skills_read', 'hooks_list', 'memories_list', 'memories_read']);
const destructive = new Set<RunnerOperation>(['workspace_close', 'files_write', 'files_apply_patch', 'exec_run', 'shell_open', 'shell_io', 'shell_close', 'tasks_run', 'tasks_cancel', 'git_branch', 'git_checkout', 'git_commit', 'git_fetch', 'worktrees_create', 'worktrees_remove', 'skills_run', 'hooks_run', 'memories_write']);
const idempotent = new Set<RunnerOperation>(['workspace_open', 'workspace_list', 'workspace_status', 'workspace_close', 'files_list', 'files_read', 'files_write', 'files_apply_patch', 'grep_search', 'shell_open', 'shell_close', 'tasks_list', 'tasks_run', 'tasks_status', 'tasks_cancel', 'git_status', 'git_diff', 'git_log', 'worktrees_list', 'skills_list', 'skills_read', 'hooks_list', 'memories_list', 'memories_read', 'memories_write']);
const openWorld = new Set<RunnerOperation>(['workspace_open', 'git_fetch']);

export const TOOL_SPECS: ToolSpec[] = (Object.keys(schemas) as RunnerOperation[]).map((name) => ({
  name,
  title: titles[name],
  description: `${titles[name]} inside an owner-bound, TTL-limited cloud coding workspace.`,
  inputSchema: schemas[name],
  readOnly: readOnly.has(name),
  destructive: destructive.has(name),
  idempotent: idempotent.has(name),
  openWorld: openWorld.has(name)
}));

export const TOOL_SCHEMA_BY_NAME = schemas;
