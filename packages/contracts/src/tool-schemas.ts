import { z } from 'zod';
import { AgentIdSchema, IdempotencyKeySchema, SessionIdSchema, ShellIdSchema, TaskIdSchema, WorkspaceIdSchema } from './identifiers.js';
import { AgentProxyOperationSchema, AgentStatusSchema, type RunnerOperation } from './runner-api.js';

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
const utf8Encoder = new TextEncoder();
const boundedUtf8Text = (maximumBytes: number) => z.string().min(1).refine(
  (value) => utf8Encoder.encode(value).byteLength <= maximumBytes,
  `text must not exceed ${maximumBytes} UTF-8 bytes`
);
const decimalCursor = z.string().regex(/^(?:0|[1-9]\d*)$/);
const positiveDecimalCursor = z.string().regex(/^[1-9]\d*$/);
const profileId = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/);
const uniqueProxyOperations = z.array(AgentProxyOperationSchema)
  .min(1)
  .max(AgentProxyOperationSchema.options.length)
  .refine((operations) => new Set(operations).size === operations.length, 'proxy operations must be unique');
const agentLookup = z.object({
  ...workspace,
  agentId: AgentIdSchema.optional(),
  idempotencyKey: IdempotencyKeySchema.optional()
}).strict().superRefine((input, context) => {
  if ((input.agentId === undefined) === (input.idempotencyKey === undefined)) {
    context.addIssue({ code: 'custom', message: 'exactly one of agentId or idempotencyKey is required' });
  }
});

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
  deployments_run: z.object({ ...workspace, name: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/), timeoutMs: z.number().int().min(100).max(300_000).default(60_000) }),
  agent_spawn: z.object({
    ...workspace,
    prompt: boundedUtf8Text(131_072),
    idempotencyKey: IdempotencyKeySchema,
    profileId,
    parentAgentId: AgentIdSchema.optional(),
    proxyOperations: uniqueProxyOperations,
    ttlSeconds: z.number().int().min(30).max(86_400).default(900),
    maxOutputBytes: z.number().int().min(1_024).max(10_485_760).default(262_144),
    maxInputTokens: z.number().int().min(1).max(2_000_000).default(200_000),
    maxOutputTokens: z.number().int().min(1).max(2_000_000).default(32_000),
    maxCostMicros: z.number().int().min(0).max(1_000_000_000).default(10_000_000)
  }).strict(),
  agent_status: agentLookup,
  agent_logs: z.object({
    ...workspace,
    agentId: AgentIdSchema,
    cursor: decimalCursor.default('0'),
    limitBytes: z.number().int().min(1_024).max(262_144).default(65_536)
  }).strict(),
  agent_message: z.object({
    ...workspace,
    agentId: AgentIdSchema,
    idempotencyKey: IdempotencyKeySchema,
    mode: z.enum(['steer', 'followUp']),
    message: boundedUtf8Text(65_536)
  }).strict(),
  agent_cancel: z.object({ ...workspace, agentId: AgentIdSchema }).strict(),
  agent_list: z.object({
    ...workspace,
    parentAgentId: AgentIdSchema.optional(),
    status: AgentStatusSchema.optional(),
    cursor: positiveDecimalCursor.optional(),
    limit: z.number().int().min(1).max(100).default(50)
  }).strict()
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
  deployments_list: 'List deployment targets', deployments_run: 'Run deployment target',
  agent_spawn: 'Spawn coding agent', agent_status: 'Read coding agent status', agent_logs: 'Read coding agent logs',
  agent_message: 'Message coding agent', agent_cancel: 'Cancel coding agent', agent_list: 'List coding agents'
};

const readOnly: Partial<Record<RunnerOperation, true>> = {
  workspace_list: true, workspace_status: true, files_list: true, files_read: true, grep_search: true,
  symbols_search: true, symbols_references: true, sessions_list: true, tasks_list: true, tasks_status: true,
  tasks_graph: true, git_status: true, git_diff: true, git_log: true, worktrees_list: true, skills_list: true,
  skills_read: true, hooks_list: true, memories_list: true, memories_read: true, deployments_list: true,
  agent_status: true, agent_logs: true, agent_list: true
};
const destructive: Partial<Record<RunnerOperation, true>> = {
  workspace_close: true, files_write: true, files_apply_patch: true, files_delete: true, files_move: true,
  files_mkdir: true, exec_run: true, shell_open: true, shell_io: true, shell_close: true, sessions_open: true,
  sessions_io: true, sessions_close: true, tasks_run: true, tasks_cancel: true, git_branch: true,
  git_checkout: true, git_add: true, git_commit: true, git_fetch: true, git_pull: true, git_push: true,
  git_merge: true, git_rebase: true, worktrees_create: true, worktrees_remove: true, skills_run: true,
  hooks_run: true, memories_write: true, deployments_run: true, agent_spawn: true, agent_message: true,
  agent_cancel: true
};
const idempotent: Partial<Record<RunnerOperation, true>> = {
  workspace_open: true, workspace_list: true, workspace_status: true, workspace_close: true, files_list: true,
  files_read: true, files_write: true, files_apply_patch: true, files_mkdir: true, grep_search: true,
  symbols_search: true, symbols_references: true, shell_open: true, shell_close: true, sessions_list: true,
  sessions_open: true, sessions_close: true, tasks_list: true, tasks_run: true, tasks_status: true,
  tasks_cancel: true, tasks_graph: true, git_status: true, git_diff: true, git_log: true, git_add: true,
  worktrees_list: true, skills_list: true, skills_read: true, hooks_list: true, memories_list: true,
  memories_read: true, memories_write: true, deployments_list: true, agent_spawn: true, agent_status: true,
  agent_logs: true, agent_message: true, agent_cancel: true, agent_list: true
};
const openWorld: Partial<Record<RunnerOperation, true>> = {
  workspace_open: true, git_fetch: true, git_pull: true, git_push: true, deployments_run: true,
  agent_spawn: true, agent_message: true
};

export const TOOL_SPECS: ToolSpec[] = (Object.keys(schemas) as RunnerOperation[]).map((name) => ({
  name,
  title: titles[name],
  description: `${titles[name]} inside an owner-bound, TTL-limited cloud coding workspace.`,
  inputSchema: schemas[name],
  readOnly: readOnly[name] === true,
  destructive: destructive[name] === true,
  idempotent: idempotent[name] === true,
  openWorld: openWorld[name] === true
}));

export const TOOL_SCHEMA_BY_NAME = schemas;
