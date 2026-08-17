import { z } from 'zod';
import { IdempotencyKeySchema, SessionIdSchema, ShellIdSchema, TaskIdSchema, WorkspaceIdSchema } from './identifiers.js';
import type { RunnerOperation } from './runner-api.js';

const relativePath = z.string().min(1).max(1_024).refine((value) => {
  const normalized = value.replaceAll('\\', '/');
  return !normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized) && !normalized.split('/').includes('..') && !normalized.includes('\0');
}, 'path must stay workspace-relative');
const entryPath = relativePath.refine((value) => value.replaceAll('\\', '/') !== '.', 'path must identify an entry below the workspace root');
const workspace = { workspaceId: WorkspaceIdSchema };
const pagination = { cursor: z.string().max(256).optional(), limit: z.number().int().min(1).max(500).default(100) };
const gitArgument = z.string().min(1).max(255).refine((value) => !value.startsWith('-') && !value.includes('\0'), 'Git argument cannot start with a dash');
const gitFetchRef = gitArgument.refine((value) => !value.includes(':'), 'Git fetch ref cannot contain a destination');
const gitObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'expected remote object ID must be a lowercase SHA-1 or SHA-256 hash');
const gitRefspec = z.string().min(1).max(512).refine((value) => {
  if (value.startsWith('-') || value.startsWith(':') || value.includes('\0') || value.includes('\n') || value.includes('..') || value.includes('@{')) return false;
  const [source, destination, extra] = value.split(':');
  if (!source || extra !== undefined || !/^(?:HEAD|[A-Za-z0-9._/-]+)$/.test(source)) return false;
  return destination === undefined || /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(destination);
}, 'invalid Git branch push refspec');
const sessionName = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/);

const schemas = {
  workspace_open: z.object({ repositoryUrl: z.url(), ref: gitArgument.optional(), idempotencyKey: IdempotencyKeySchema, networkMode: z.enum(['none', 'bridge']).optional() }),
  workspace_list: z.object(pagination),
  workspace_status: z.object(workspace),
  workspace_close: z.object(workspace),
  files_list: z.object({ ...workspace, path: relativePath.default('.'), ...pagination }),
  files_read: z.object({ ...workspace, path: relativePath, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(262_144).default(65_536) }),
  files_write: z.object({ ...workspace, path: relativePath, content: z.string().max(1_048_576), expectedSha256: z.string().length(64).optional() }),
  files_apply_patch: z.object({ ...workspace, path: relativePath, oldText: z.string().max(262_144), newText: z.string().max(262_144), expectedSha256: z.string().length(64).optional() }),
  files_delete: z.object({ ...workspace, path: entryPath, recursive: z.boolean().default(false), expectedSha256: z.string().length(64).optional() }),
  files_move: z.object({ ...workspace, source: entryPath, destination: entryPath, overwrite: z.boolean().default(false) }),
  files_mkdir: z.object({ ...workspace, path: entryPath, recursive: z.boolean().default(true) }),
  grep_search: z.object({ ...workspace, pattern: z.string().min(1).max(4_096), path: relativePath.default('.'), glob: z.string().max(512).optional(), maxResults: z.number().int().min(1).max(500).default(100) }),
  symbols_search: z.object({ ...workspace, query: z.string().min(1).max(256), path: relativePath.default('.'), language: z.string().regex(/^[A-Za-z0-9_+#.-]{1,40}$/).optional(), maxResults: z.number().int().min(1).max(500).default(100) }),
  symbols_references: z.object({ ...workspace, symbol: z.string().min(1).max(256).refine((value) => !value.includes('\0') && !value.includes('\n')), path: relativePath.default('.'), glob: z.string().max(512).optional(), maxResults: z.number().int().min(1).max(500).default(100) }),
  exec_run: z.object({ ...workspace, command: z.string().min(1).max(32_768), cwd: relativePath.default('.'), timeoutMs: z.number().int().min(100).max(300_000).default(60_000), maxOutputBytes: z.number().int().min(1_024).max(1_048_576).default(262_144) }),
  shell_open: z.object({ ...workspace, cwd: relativePath.default('.'), idempotencyKey: IdempotencyKeySchema }),
  shell_io: z.object({ ...workspace, shellId: ShellIdSchema, input: z.string().max(65_536).optional(), cursor: z.string().max(256).optional(), waitMs: z.number().int().min(0).max(5_000).default(100) }),
  shell_close: z.object({ ...workspace, shellId: ShellIdSchema }),
  sessions_list: z.object({ ...workspace, ...pagination }),
  sessions_open: z.object({ ...workspace, name: sessionName, cwd: relativePath.default('.'), idempotencyKey: IdempotencyKeySchema }),
  sessions_io: z.object({ ...workspace, sessionId: SessionIdSchema, input: z.string().max(65_536).optional(), cursor: z.string().max(256).optional(), waitMs: z.number().int().min(0).max(5_000).default(100) }),
  sessions_close: z.object({ ...workspace, sessionId: SessionIdSchema }),
  tasks_list: z.object({ ...workspace, ...pagination }),
  tasks_run: z.object({ ...workspace, command: z.string().min(1).max(32_768), cwd: relativePath.default('.'), idempotencyKey: IdempotencyKeySchema, timeoutMs: z.number().int().min(100).max(86_400_000).default(900_000), dependsOn: z.array(TaskIdSchema).max(32).default([]) }),
  tasks_status: z.object({ ...workspace, taskId: TaskIdSchema, cursor: z.string().max(256).optional() }),
  tasks_cancel: z.object({ ...workspace, taskId: TaskIdSchema }),
  tasks_graph: z.object(workspace),
  git_status: z.object(workspace),
  git_diff: z.object({ ...workspace, staged: z.boolean().default(false), path: relativePath.optional() }),
  git_log: z.object({ ...workspace, limit: z.number().int().min(1).max(100).default(20) }),
  git_branch: z.object({ ...workspace, action: z.enum(['list', 'create', 'delete']), name: gitArgument.optional(), startPoint: gitArgument.optional(), force: z.boolean().default(false) }).superRefine((input, context) => {
    if (input.action !== 'list' && !input.name) context.addIssue({ code: 'custom', path: ['name'], message: 'name is required for create and delete' });
  }),
  git_checkout: z.object({ ...workspace, ref: gitArgument, create: z.boolean().default(false) }),
  git_add: z.object({ ...workspace, all: z.boolean().default(false), paths: z.array(relativePath).max(200).default([]) }).superRefine((input, context) => {
    if (!input.all && input.paths.length === 0) context.addIssue({ code: 'custom', path: ['paths'], message: 'paths are required unless all is true' });
    if (input.all && input.paths.length > 0) context.addIssue({ code: 'custom', path: ['paths'], message: 'paths must be empty when all is true' });
  }),
  git_commit: z.object({ ...workspace, message: z.string().min(1).max(10_000), authorName: z.string().min(1).max(200), authorEmail: z.email(), all: z.boolean().default(false) }),
  git_fetch: z.object({ ...workspace, remote: z.literal('origin').default('origin'), refspec: gitFetchRef.optional() }),
  git_pull: z.object({ ...workspace, remote: z.literal('origin').default('origin'), branch: gitArgument.optional(), strategy: z.enum(['ff-only', 'merge', 'rebase']).default('ff-only') }),
  git_push: z.object({
    ...workspace,
    remote: z.literal('origin').default('origin'),
    refspec: gitRefspec.optional(),
    forceWithLease: z.boolean().default(false),
    expectedRemoteOid: gitObjectId.optional()
  }).superRefine((input, context) => {
    if (input.forceWithLease && !input.expectedRemoteOid) context.addIssue({ code: 'custom', path: ['expectedRemoteOid'], message: 'expectedRemoteOid is required with forceWithLease' });
    if (!input.forceWithLease && input.expectedRemoteOid) context.addIssue({ code: 'custom', path: ['expectedRemoteOid'], message: 'expectedRemoteOid is only valid with forceWithLease' });
    if (input.forceWithLease && input.refspec && !input.refspec.includes(':')) context.addIssue({ code: 'custom', path: ['refspec'], message: 'an explicit destination branch is required with forceWithLease' });
  }),
  git_merge: z.object({ ...workspace, ref: gitArgument, fastForward: z.enum(['allow', 'only', 'never']).default('allow'), message: z.string().min(1).max(10_000).optional() }),
  git_rebase: z.object({ ...workspace, action: z.enum(['start', 'continue', 'abort']), upstream: gitArgument.optional() }).superRefine((input, context) => {
    if (input.action === 'start' && !input.upstream) context.addIssue({ code: 'custom', path: ['upstream'], message: 'upstream is required when starting a rebase' });
    if (input.action !== 'start' && input.upstream) context.addIssue({ code: 'custom', path: ['upstream'], message: 'upstream is only valid when starting a rebase' });
  }),
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
  memories_write: z.object({ ...workspace, name: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/), content: z.string().max(262_144) }),
  deployments_list: z.object(workspace),
  deployments_run: z.object({ ...workspace, name: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/), timeoutMs: z.number().int().min(100).max(300_000).default(60_000) })
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
  files_list: 'List files', files_read: 'Read file', files_write: 'Write file', files_apply_patch: 'Apply text patch', files_delete: 'Delete file or directory', files_move: 'Move file or directory', files_mkdir: 'Create directory', grep_search: 'Search workspace',
  symbols_search: 'Find symbol definitions', symbols_references: 'Find lexical symbol references',
  exec_run: 'Run command', shell_open: 'Open shell', shell_io: 'Use shell', shell_close: 'Close shell', tasks_list: 'List tasks', tasks_run: 'Run task', tasks_status: 'Task status', tasks_cancel: 'Cancel task',
  sessions_list: 'List coding sessions', sessions_open: 'Open coding session', sessions_io: 'Use coding session', sessions_close: 'Close coding session',
  tasks_graph: 'Read task dependency graph',
  git_status: 'Git status', git_diff: 'Git diff', git_log: 'Git log', git_branch: 'Manage Git branches', git_checkout: 'Checkout Git ref', git_add: 'Stage Git changes', git_commit: 'Create Git commit', git_fetch: 'Fetch Git refs', git_pull: 'Pull Git changes', git_push: 'Push Git changes', git_merge: 'Merge Git ref', git_rebase: 'Manage Git rebase',
  worktrees_list: 'List worktrees', worktrees_create: 'Create worktree', worktrees_remove: 'Remove worktree',
  skills_list: 'List skills', skills_read: 'Read skill', skills_run: 'Run skill script', hooks_list: 'List hooks', hooks_run: 'Run hook', memories_list: 'List memories', memories_read: 'Read memory', memories_write: 'Write memory',
  deployments_list: 'List deployment targets', deployments_run: 'Run deployment target'
};

const descriptions: Record<RunnerOperation, string> = {
  workspace_open: 'Clone an approved HTTPS repository and start an owner-bound, TTL-limited coding workspace.',
  workspace_list: 'List owner-visible workspace records with bounded cursor pagination.',
  workspace_status: 'Read the lifecycle state and metadata for one workspace.',
  workspace_close: 'Stop a workspace executor and permanently remove all workspace files, including unpushed commits.',
  files_list: 'List one workspace directory with bounded cursor pagination.',
  files_read: 'Read a bounded byte range from a workspace file with its size and SHA-256.',
  files_write: 'Atomically create or replace a workspace file, optionally guarded by its current SHA-256.',
  files_apply_patch: 'Replace one unique exact text occurrence, optionally guarded by the file SHA-256.',
  files_delete: 'Delete one workspace file or directory, with explicit recursion and optional file hash guard.',
  files_move: 'Move or rename one workspace entry, optionally overwriting an existing file.',
  files_mkdir: 'Create one workspace directory, including missing parents by default.',
  grep_search: 'Search workspace text with a bounded regular expression and optional path or glob filter.',
  symbols_search: 'Find bounded indexed symbol definitions by case-insensitive substring.',
  symbols_references: 'Find bounded lexical whole-word occurrences of a symbol in workspace text.',
  exec_run: 'Run one bounded shell command in the workspace and return captured output.',
  shell_open: 'Open an idempotent ephemeral interactive shell in the workspace.',
  shell_io: 'Send input to or poll bounded output from an open interactive shell.',
  shell_close: 'Terminate an interactive shell and release its in-memory state.',
  sessions_list: 'List named coding sessions in a workspace with bounded cursor pagination.',
  sessions_open: 'Open an idempotent named coding session in the workspace.',
  sessions_io: 'Send input to or poll bounded output from a named coding session.',
  sessions_close: 'Terminate a coding session and release its in-memory state.',
  tasks_list: 'List managed background task records with bounded cursor pagination.',
  tasks_run: 'Start an idempotent managed command task with optional task dependencies.',
  tasks_status: 'Read one managed task state and its next bounded output chunk.',
  tasks_cancel: 'Terminate a managed task process group without rolling back completed effects.',
  tasks_graph: 'Read the current managed-task dependency graph for a workspace.',
  git_status: 'Read branch, index, and working-tree status for the workspace repository.',
  git_diff: 'Read a bounded staged or unstaged Git diff, optionally narrowed to one path.',
  git_log: 'Read bounded recent commit metadata from the workspace repository.',
  git_branch: 'List, create, or delete a local Git branch with constrained ref arguments.',
  git_checkout: 'Check out an existing Git ref or create and check out a local branch.',
  git_add: 'Stage either explicit workspace paths or all tracked and untracked changes.',
  git_commit: 'Create an unsigned local Git commit with an explicit author and message.',
  git_fetch: 'Fetch a constrained source ref from origin through the trusted repository broker.',
  git_pull: 'Integrate an origin branch using ff-only, merge, or rebase strategy.',
  git_push: 'Push a constrained branch refspec to origin, with optional explicit force-with-lease.',
  git_merge: 'Merge a Git ref with an explicit fast-forward policy and optional message.',
  git_rebase: 'Start, continue, or abort a local Git rebase with constrained ref arguments.',
  worktrees_list: 'List managed Git worktrees and their current branch or HEAD state.',
  worktrees_create: 'Create a named managed worktree, optionally with a new local branch.',
  worktrees_remove: 'Remove one named managed worktree, optionally discarding dirty state.',
  skills_list: 'List repository-provided agent skills discovered in the workspace.',
  skills_read: 'Read bounded instructions for one repository-provided agent skill.',
  skills_run: 'Execute one reviewed script packaged by a repository-provided skill.',
  hooks_list: 'List repository-defined Cloud Harness automation hooks without running them.',
  hooks_run: 'Execute one named repository-defined hook as a bounded shell command.',
  memories_list: 'List repository-local Cloud Harness memory note names.',
  memories_read: 'Read one bounded repository-local Cloud Harness memory note.',
  memories_write: 'Create or replace one repository-local Cloud Harness memory note.',
  deployments_list: 'List repository-defined deployment targets without running them.',
  deployments_run: 'Execute one named repository-defined deployment target with external-effect risk.'
};

const readOnly = new Set<RunnerOperation>(['workspace_list', 'workspace_status', 'files_list', 'files_read', 'grep_search', 'symbols_search', 'symbols_references', 'sessions_list', 'tasks_list', 'tasks_status', 'tasks_graph', 'git_status', 'git_diff', 'git_log', 'worktrees_list', 'skills_list', 'skills_read', 'hooks_list', 'memories_list', 'memories_read', 'deployments_list']);
const destructive = new Set<RunnerOperation>(['workspace_close', 'files_write', 'files_apply_patch', 'files_delete', 'files_move', 'exec_run', 'shell_io', 'shell_close', 'sessions_io', 'sessions_close', 'tasks_run', 'tasks_cancel', 'git_branch', 'git_checkout', 'git_pull', 'git_push', 'git_merge', 'git_rebase', 'worktrees_remove', 'skills_run', 'hooks_run', 'memories_write', 'deployments_run']);
const idempotent = new Set<RunnerOperation>(['workspace_open', 'workspace_list', 'workspace_status', 'workspace_close', 'files_list', 'files_read', 'files_write', 'files_apply_patch', 'files_mkdir', 'grep_search', 'symbols_search', 'symbols_references', 'shell_open', 'shell_close', 'sessions_list', 'sessions_open', 'sessions_close', 'tasks_list', 'tasks_run', 'tasks_status', 'tasks_cancel', 'tasks_graph', 'git_status', 'git_diff', 'git_log', 'git_add', 'worktrees_list', 'skills_list', 'skills_read', 'hooks_list', 'memories_list', 'memories_read', 'memories_write', 'deployments_list']);
const openWorld = new Set<RunnerOperation>(['workspace_open', 'exec_run', 'shell_io', 'sessions_io', 'tasks_run', 'git_fetch', 'git_pull', 'git_push', 'skills_run', 'hooks_run', 'deployments_run']);

export const TOOL_SPECS: ToolSpec[] = (Object.keys(schemas) as RunnerOperation[]).map((name) => ({
  name,
  title: titles[name],
  description: descriptions[name],
  inputSchema: schemas[name],
  readOnly: readOnly.has(name),
  destructive: destructive.has(name),
  idempotent: idempotent.has(name),
  openWorld: openWorld.has(name)
}));

export const TOOL_SCHEMA_BY_NAME = schemas;
