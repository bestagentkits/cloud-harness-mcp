import { z } from 'zod';
import { IdempotencyKeySchema, OperationIdSchema, SessionIdSchema, ShellIdSchema, TaskIdSchema, WorkspaceIdSchema } from './identifiers.js';
import type { RunnerOperation } from './runner-api.js';

const relativePath = z.string().min(1).max(1_024).refine((value) => {
  const normalized = value.replaceAll('\\', '/');
  return !normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized) && !normalized.split('/').includes('..') && !normalized.includes('\0');
}, 'path must stay workspace-relative');
const entryPath = relativePath.refine((value) => value.replaceAll('\\', '/') !== '.', 'path must identify an entry below the workspace root');
const workspace = { workspaceId: WorkspaceIdSchema.optional() };
const pagination = { cursor: z.string().max(256).optional(), limit: z.number().int().min(1).max(500).default(100) };
const gitArgument = z.string().min(1).max(255).refine((value) => !value.startsWith('-') && !value.includes('\0'), 'Git argument cannot start with a dash');
const gitFetchRef = gitArgument.refine((value) => !value.includes(':'), 'Git fetch ref cannot contain a destination');
const gitObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'expected remote object ID must be a lowercase SHA-1 or SHA-256 hash');
const gitRefspec = z.string().min(1).max(512).refine((value) => {
  if (value.startsWith('-') || value.startsWith(':') || value.includes('\0') || value.includes('\n') || value.includes('..') || value.includes('@{')) return false;
  const [source, destination, extra] = value.split(':');
  if (!source || extra !== undefined || !/^(?:HEAD|[A-Za-z0-9._/-]+)$/.test(source)) return false;
  if (destination === undefined) return true;
  if (destination.startsWith('refs/')) return /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(destination);
  return /^[A-Za-z0-9._/-]+$/.test(destination);
}, 'invalid Git branch push refspec');
const sessionName = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/);
const EnvironmentIdSchema = z.string().regex(/^env_[A-Za-z0-9_-]{20,80}$/);

const githubActionUnion = z.discriminatedUnion('action', [
  z.object({
    ...workspace,
    action: z.literal('pr_list'),
    limit: z.number().int().min(1).max(100).default(20),
    state: z.enum(['open', 'closed', 'all']).default('open')
  }),
  z.object({
    ...workspace,
    action: z.literal('pr_view'),
    prNumber: z.number().int().positive()
  }),
  z.object({
    ...workspace,
    action: z.literal('pr_create'),
    title: z.string().min(1).max(256).refine((val) => !val.includes('\0'), 'title cannot contain null bytes'),
    body: z.string().max(65_536).refine((val) => !val.includes('\0'), 'body cannot contain null bytes').default(''),
    head: z.string().min(1).max(256).refine((val) => !val.includes('\0'), 'head cannot contain null bytes'),
    base: z.string().min(1).max(256).refine((val) => !val.includes('\0'), 'base cannot contain null bytes').default('main'),
    draft: z.boolean().default(false),
    labels: z.array(z.string().min(1).max(100).refine((val) => !val.includes('\0') && !val.includes(','), 'label cannot contain null bytes or commas')).max(50).optional()
  }),
  z.object({
    ...workspace,
    action: z.literal('pr_update'),
    prNumber: z.number().int().positive(),
    title: z.string().min(1).max(256).refine((val) => !val.includes('\0'), 'title cannot contain null bytes').optional(),
    body: z.string().max(65_536).refine((val) => !val.includes('\0'), 'body cannot contain null bytes').optional(),
    base: z.string().min(1).max(256).refine((val) => !val.includes('\0'), 'base cannot contain null bytes').optional(),
    state: z.enum(['open', 'closed']).optional()
  }).superRefine((input, context) => {
    if (!input.title && !input.body && !input.base && !input.state) {
      context.addIssue({ code: 'custom', path: ['title'], message: 'at least one of title, body, base, or state is required' });
    }
  }),
  z.object({
    ...workspace,
    action: z.literal('pr_comment'),
    prNumber: z.number().int().positive(),
    body: z.string().min(1).max(65_536).refine((val) => !val.includes('\0'), 'body cannot contain null bytes'),
    idempotencyKey: IdempotencyKeySchema.optional()
  }),
  z.object({
    ...workspace,
    action: z.literal('issue_list'),
    limit: z.number().int().min(1).max(100).default(20),
    state: z.enum(['open', 'closed', 'all']).default('open')
  }),
  z.object({
    ...workspace,
    action: z.literal('issue_view'),
    issueNumber: z.number().int().positive()
  }),
  z.object({
    ...workspace,
    action: z.literal('issue_create'),
    title: z.string().min(1).max(256).refine((val) => !val.includes('\0'), 'title cannot contain null bytes'),
    body: z.string().max(65_536).refine((val) => !val.includes('\0'), 'body cannot contain null bytes').default(''),
    labels: z.array(z.string().min(1).max(100).refine((val) => !val.includes('\0') && !val.includes(','), 'label cannot contain null bytes or commas')).max(50).optional(),
    assignees: z.array(z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/, 'invalid GitHub username')).max(10).optional()
  }),
  z.object({
    ...workspace,
    action: z.literal('issue_comment'),
    issueNumber: z.number().int().positive(),
    body: z.string().min(1).max(65_536).refine((val) => !val.includes('\0'), 'body cannot contain null bytes'),
    idempotencyKey: IdempotencyKeySchema.optional()
  }),
  z.object({
    ...workspace,
    action: z.literal('issue_comment_update'),
    commentId: z.number().int().positive(),
    body: z.string().min(1).max(65_536).refine((val) => !val.includes('\0'), 'body cannot contain null bytes')
  }),
  z.object({
    ...workspace,
    action: z.literal('label_create'),
    name: z.string().min(1).max(100).refine((val) => !val.includes('\0'), 'label name cannot contain null bytes'),
    color: z.string().regex(/^[0-9A-Fa-f]{6}$/).optional(),
    description: z.string().max(200).optional()
  }),
  z.object({
    ...workspace,
    action: z.literal('issue_labels_add'),
    issueNumber: z.number().int().positive(),
    labels: z.array(z.string().min(1).max(100).refine((val) => !val.includes('\0') && !val.includes(','), 'label cannot contain null bytes or commas')).min(1).max(50),
    createMissing: z.boolean().default(true),
    idempotencyKey: IdempotencyKeySchema.optional()
  }),
  z.object({
    ...workspace,
    action: z.literal('issue_labels_remove'),
    issueNumber: z.number().int().positive(),
    label: z.string().min(1).max(100).refine((val) => !val.includes('\0') && !val.includes(','), 'label cannot contain null bytes or commas')
  }),
  z.object({
    ...workspace,
    action: z.literal('issue_update'),
    issueNumber: z.number().int().positive(),
    title: z.string().min(1).max(256).refine((val) => !val.includes('\0'), 'title cannot contain null bytes').optional(),
    body: z.string().max(65_536).refine((val) => !val.includes('\0'), 'body cannot contain null bytes').optional(),
    state: z.enum(['open', 'closed']).optional(),
    stateReason: z.enum(['completed', 'not_planned', 'reopened']).optional()
  }).superRefine((input, context) => {
    if (!input.title && !input.body && !input.state) {
      context.addIssue({ code: 'custom', path: ['title'], message: 'at least one of title, body, or state is required' });
    }
    if (input.stateReason && input.state !== 'closed' && input.stateReason !== 'reopened') {
      context.addIssue({ code: 'custom', path: ['stateReason'], message: 'stateReason is valid only when closing or reopening an issue' });
    }
  }),
  z.object({
    ...workspace,
    action: z.literal('issue_publish'),
    issueNumber: z.number().int().positive(),
    comment: z.string().max(65_536).refine((val) => !val.includes('\0'), 'comment cannot contain null bytes').optional(),
    addLabels: z.array(z.string().min(1).max(100).refine((val) => !val.includes('\0') && !val.includes(','), 'label cannot contain null bytes or commas')).max(50).optional(),
    removeLabels: z.array(z.string().min(1).max(100).refine((val) => !val.includes('\0') && !val.includes(','), 'label cannot contain null bytes or commas')).max(50).optional(),
    createMissingLabels: z.boolean().default(true),
    idempotencyKey: IdempotencyKeySchema.optional()
  }).superRefine((input, context) => {
    const hasComment = Boolean(input.comment?.trim());
    const hasAdd = Boolean(input.addLabels && input.addLabels.length > 0);
    const hasRemove = Boolean(input.removeLabels && input.removeLabels.length > 0);
    if (!hasComment && !hasAdd && !hasRemove) {
      context.addIssue({
        code: 'custom',
        path: ['comment'],
        message: 'at least one of comment, addLabels, or removeLabels is required'
      });
    }
    if (input.addLabels && input.removeLabels) {
      const addMap: Record<string, true> = {};
      for (const label of input.addLabels) addMap[label] = true;
      for (const label of input.removeLabels) {
        if (addMap[label]) {
          context.addIssue({
            code: 'custom',
            path: ['removeLabels'],
            message: `label "${label}" cannot appear in both addLabels and removeLabels`
          });
        }
      }
    }
  })
]);

const githubActionInput = z.object({
  ...workspace,
  action: z.enum([
    'pr_list', 'pr_view', 'pr_create', 'pr_update', 'pr_comment',
    'issue_list', 'issue_view', 'issue_create', 'issue_comment',
    'issue_comment_update', 'label_create', 'issue_labels_add',
    'issue_labels_remove', 'issue_update', 'issue_publish'
  ]),
  limit: z.number().int().min(1).max(100).optional(),
  state: z.enum(['open', 'closed', 'all']).optional(),
  prNumber: z.number().int().positive().optional(),
  issueNumber: z.number().int().positive().optional(),
  commentId: z.number().int().positive().optional(),
  title: z.string().min(1).max(256).refine((val) => !val.includes('\0'), 'title cannot contain null bytes').optional(),
  body: z.string().max(65_536).refine((val) => !val.includes('\0'), 'body cannot contain null bytes').optional(),
  head: z.string().min(1).max(256).refine((val) => !val.includes('\0'), 'head cannot contain null bytes').optional(),
  base: z.string().min(1).max(256).refine((val) => !val.includes('\0'), 'base cannot contain null bytes').optional(),
  draft: z.boolean().optional(),
  labels: z.array(z.string().min(1).max(100).refine((val) => !val.includes('\0') && !val.includes(','), 'label cannot contain null bytes or commas')).max(50).optional(),
  assignees: z.array(z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/, 'invalid GitHub username')).max(10).optional(),
  name: z.string().min(1).max(100).refine((val) => !val.includes('\0'), 'label name cannot contain null bytes').optional(),
  color: z.string().regex(/^[0-9A-Fa-f]{6}$/).optional(),
  description: z.string().max(200).optional(),
  label: z.string().min(1).max(100).refine((val) => !val.includes('\0') && !val.includes(','), 'label cannot contain null bytes or commas').optional(),
  createMissing: z.boolean().optional(),
  createMissingLabels: z.boolean().optional(),
  stateReason: z.enum(['completed', 'not_planned', 'reopened']).optional(),
  comment: z.string().max(65_536).refine((val) => !val.includes('\0'), 'comment cannot contain null bytes').optional(),
  addLabels: z.array(z.string().min(1).max(100).refine((val) => !val.includes('\0') && !val.includes(','), 'label cannot contain null bytes or commas')).max(50).optional(),
  removeLabels: z.array(z.string().min(1).max(100).refine((val) => !val.includes('\0') && !val.includes(','), 'label cannot contain null bytes or commas')).max(50).optional(),
  idempotencyKey: IdempotencyKeySchema.optional()
});

const schemas = {
  workspace_open: z.object({
    repositoryUrl: z.url(), ref: gitArgument.optional(), idempotencyKey: IdempotencyKeySchema,
    networkMode: z.enum(['none', 'bridge']).optional(), environmentId: EnvironmentIdSchema.optional(),
    confirmEnvironmentInjection: z.literal(true).optional()
  }).superRefine((input, context) => {
    if (Boolean(input.environmentId) !== Boolean(input.confirmEnvironmentInjection)) {
      context.addIssue({ code: 'custom', path: ['confirmEnvironmentInjection'], message: 'environment injection requires an explicit environment selection and confirmation' });
    }
  }),
  workspace_list: z.object(pagination),
  workspace_status: z.object(workspace),
  workspace_capabilities: z.object(workspace),
  workspace_close: z.object(workspace),
  workspace_lease_renew: z.object({ ...workspace, extensionSeconds: z.number().int().min(60).max(86_400).optional() }),
  workspace_recover: z.object({ ...workspace, mode: z.enum(['resume', 'status', 'patch', 'export']).default('resume'), targetBranch: gitArgument.optional() }),
  workspace_context: z.object(workspace),
  workspace_set_active: z.object({ workspaceId: WorkspaceIdSchema }),
  workspace_finalize: z.object({
    ...workspace,
    paths: z.array(relativePath).max(500).optional(),
    all: z.boolean().default(true),
    commitMessage: z.string().min(1).max(10_000),
    branch: gitArgument.optional(),
    push: z.boolean().default(true),
    authorName: z.string().min(1).max(200).optional(),
    authorEmail: z.email().optional(),
    preflight: z.object({ checkDiff: z.boolean().default(true), forbiddenPatterns: z.array(z.string()).optional() }).optional(),
    idempotencyKey: IdempotencyKeySchema.optional()
  }).superRefine((input, context) => {
    if (!input.all && (!input.paths || input.paths.length === 0)) {
      context.addIssue({ code: 'custom', path: ['paths'], message: 'paths are required when all is false' });
    }
    if (input.all && input.paths && input.paths.length > 0) {
      context.addIssue({ code: 'custom', path: ['paths'], message: 'paths must be empty when all is true' });
    }
  }),
  files_list: z.object({ ...workspace, path: relativePath.default('.'), ...pagination }),
  files_read: z.object({ ...workspace, path: relativePath, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(1_048_576).default(65_536), cursor: z.string().max(256).optional(), readAll: z.boolean().optional() }),
  files_write: z.object({ ...workspace, path: relativePath, content: z.string().max(1_048_576), expectedSha256: z.string().length(64).optional() }),
  files_write_batch: z.object({
    ...workspace,
    files: z.array(z.object({
      path: relativePath,
      content: z.string().max(1_048_576),
      expectedSha256: z.string().length(64).optional()
    })).min(1).max(100),
    createParents: z.boolean().default(true),
    atomic: z.boolean().default(true),
    idempotencyKey: IdempotencyKeySchema.optional()
  }),
  files_apply_patch: z.object({ ...workspace, path: relativePath, oldText: z.string().max(262_144), newText: z.string().max(262_144), expectedSha256: z.string().length(64).optional() }),
  files_delete: z.object({ ...workspace, path: entryPath, recursive: z.boolean().default(false), expectedSha256: z.string().length(64).optional() }),
  files_move: z.object({ ...workspace, source: entryPath, destination: entryPath, overwrite: z.boolean().default(false) }),
  files_mkdir: z.object({ ...workspace, path: entryPath, recursive: z.boolean().default(true) }),
  grep_search: z.object({ ...workspace, pattern: z.string().min(1).max(4_096), path: relativePath.default('.'), glob: z.string().max(512).optional(), maxResults: z.number().int().min(1).max(500).default(100) }),
  symbols_search: z.object({ ...workspace, query: z.string().min(1).max(256), path: relativePath.default('.'), language: z.string().regex(/^[A-Za-z0-9_+#.-]{1,40}$/).optional(), maxResults: z.number().int().min(1).max(500).default(100) }),
  symbols_references: z.object({ ...workspace, symbol: z.string().min(1).max(256).refine((value) => !value.includes('\0') && !value.includes('\n')), path: relativePath.default('.'), glob: z.string().max(512).optional(), maxResults: z.number().int().min(1).max(500).default(100) }),
  exec_run: z.object({
    ...workspace,
    command: z.string().min(1).max(32_768),
    cwd: relativePath.default('.'),
    timeoutMs: z.number().int().min(100).max(300_000).default(60_000),
    maxOutputBytes: z.number().int().min(1_024).max(1_048_576).default(262_144),
    privileged: z.boolean().default(false),
    approvalGrantToken: z.string().min(1).max(128).optional(),
    async: z.boolean().default(false)
  }),
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
  operation_status: z.object({ operationId: OperationIdSchema, cursor: z.string().max(256).optional() }),
  operation_cancel: z.object({ operationId: OperationIdSchema }),
  operation_wait: z.object({ operationId: OperationIdSchema, timeoutMs: z.number().int().min(100).max(300_000).default(60_000) }),
  git_status: z.object(workspace),
  git_diff: z.object({ ...workspace, staged: z.boolean().default(false), path: relativePath.optional(), cursor: z.string().max(256).optional(), limit: z.number().int().min(1).max(500_000).default(65_536), readAll: z.boolean().optional() }),
  git_log: z.object({ ...workspace, limit: z.number().int().min(1).max(500).default(20), cursor: z.string().max(256).optional(), readAll: z.boolean().optional() }),
  git_branch: z.object({ ...workspace, action: z.enum(['list', 'create', 'delete']), name: gitArgument.optional(), startPoint: gitArgument.optional(), force: z.boolean().default(false) }).superRefine((input, context) => {
    if (input.action !== 'list' && !input.name) context.addIssue({ code: 'custom', path: ['name'], message: 'name is required for create and delete' });
  }),
  git_checkout: z.object({ ...workspace, ref: gitArgument, create: z.boolean().default(false) }),
  git_add: z.object({ ...workspace, all: z.boolean().default(false), paths: z.array(relativePath).max(200).default([]) }).superRefine((input, context) => {
    if (!input.all && input.paths.length === 0) context.addIssue({ code: 'custom', path: ['paths'], message: 'paths are required unless all is true' });
    if (input.all && input.paths.length > 0) context.addIssue({ code: 'custom', path: ['paths'], message: 'paths must be empty when all is true' });
  }),
  git_commit: z.object({ ...workspace, message: z.string().min(1).max(10_000), authorName: z.string().min(1).max(200).optional(), authorEmail: z.email().optional(), all: z.boolean().default(false), expectedHeadOid: gitObjectId.optional(), idempotencyKey: z.string().min(1).max(256).optional() }),
  git_identity_status: z.object(workspace),
  git_identity_set: z.object({ ...workspace, name: z.string().min(1).max(200), email: z.email() }),
  git_fetch: z.object({ ...workspace, remote: z.literal('origin').default('origin'), refspec: gitFetchRef.optional() }),
  git_pull: z.object({ ...workspace, remote: z.literal('origin').default('origin'), branch: gitArgument.optional(), strategy: z.enum(['ff-only', 'merge', 'rebase']).default('ff-only') }),
  git_push: z.object({
    ...workspace,
    remote: z.literal('origin').default('origin'),
    refspec: gitRefspec.optional(),
    forceWithLease: z.boolean().default(false),
    expectedRemoteOid: gitObjectId.optional(),
    idempotencyKey: z.string().min(1).max(256).optional()
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
  artifacts_snapshot: z.object({
    ...workspace,
    path: relativePath,
    logicalName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'invalid artifact logical name'),
    retentionSeconds: z.number().int().min(60).max(2_592_000).optional()
  }),
  artifacts_list: z.object({
    cursor: z.string().max(256).optional(),
    limit: z.number().int().min(1).max(100).default(50)
  }),
  artifacts_read: z.object({
    artifactId: z.string().regex(/^art_[A-Za-z0-9_-]{20,80}$/, 'invalid artifact identifier'),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(1_048_576).default(65_536)
  }),
  artifacts_restore: z.object({
    ...workspace,
    artifactId: z.string().regex(/^art_[A-Za-z0-9_-]{20,80}$/, 'invalid artifact identifier'),
    path: relativePath,
    overwrite: z.boolean().default(false),
    expectedSha256: z.string().length(64).optional()
  }),
  artifacts_delete: z.object({
    artifactId: z.string().regex(/^art_[A-Za-z0-9_-]{20,80}$/, 'invalid artifact identifier'),
    expectedGeneration: z.number().int().positive().default(1)
  }),
  github_action: githubActionInput.pipe(githubActionUnion as unknown as z.ZodType<unknown, z.output<typeof githubActionInput>>),
  secrets_list: z.object({
    ...workspace,
    environmentId: EnvironmentIdSchema.optional(),
    query: z.string().max(200).optional(),
    ...pagination
  })
};

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
  workspace_open: 'Open workspace', workspace_list: 'List workspaces', workspace_status: 'Workspace status', workspace_capabilities: 'Workspace capabilities', workspace_close: 'Close workspace',
  workspace_lease_renew: 'Renew workspace lease', workspace_recover: 'Recover workspace state', workspace_context: 'Workspace context', workspace_set_active: 'Set active workspace',
  workspace_finalize: 'Finalize workspace commit and push',
  files_list: 'List files', files_read: 'Read file', files_write: 'Write file', files_write_batch: 'Write batch files', files_apply_patch: 'Apply text patch', files_delete: 'Delete file or directory', files_move: 'Move file or directory', files_mkdir: 'Create directory', grep_search: 'Search workspace',
  symbols_search: 'Find symbol definitions', symbols_references: 'Find lexical symbol references',
  exec_run: 'Run command', shell_open: 'Open shell', shell_io: 'Use shell', shell_close: 'Close shell', tasks_list: 'List tasks', tasks_run: 'Run task', tasks_status: 'Task status', tasks_cancel: 'Cancel task',
  sessions_list: 'List coding sessions', sessions_open: 'Open coding session', sessions_io: 'Use coding session', sessions_close: 'Close coding session',
  tasks_graph: 'Read task dependency graph',
  operation_status: 'Read operation status', operation_cancel: 'Cancel operation', operation_wait: 'Wait for operation',
  git_status: 'Git status', git_diff: 'Git diff', git_log: 'Git log', git_branch: 'Manage Git branches', git_checkout: 'Checkout Git ref', git_add: 'Stage Git changes', git_commit: 'Create Git commit', git_fetch: 'Fetch Git refs', git_pull: 'Pull Git changes', git_push: 'Push Git changes', git_merge: 'Merge Git ref', git_rebase: 'Manage Git rebase',
  git_identity_status: 'Read Git author identity', git_identity_set: 'Set Git author identity',
  worktrees_list: 'List worktrees', worktrees_create: 'Create worktree', worktrees_remove: 'Remove worktree',
  skills_list: 'List skills', skills_read: 'Read skill', skills_run: 'Run skill script', hooks_list: 'List hooks', hooks_run: 'Run hook', memories_list: 'List memories', memories_read: 'Read memory', memories_write: 'Write memory',
  deployments_list: 'List deployment targets', deployments_run: 'Run deployment target',
  artifacts_snapshot: 'Preserve workspace file snapshot', artifacts_list: 'List retained artifacts', artifacts_read: 'Read retained artifact chunk', artifacts_restore: 'Restore artifact to workspace', artifacts_delete: 'Delete retained artifact',
  github_action: 'Perform brokered GitHub operations',
  secrets_list: 'List available secrets'
};

const descriptions: Record<RunnerOperation, string> = {
  workspace_open: 'Clone an approved HTTPS repository and start an owner-bound, TTL-limited coding workspace.',
  workspace_list: 'List owner-visible workspace records with bounded cursor pagination.',
  workspace_status: 'Read the lifecycle state and metadata for one workspace.',
  workspace_capabilities: 'Inspect workspace and repository authorization capabilities without modifying state or minting tokens.',
  workspace_close: 'Stop a workspace executor and permanently remove all workspace files, including unpushed commits.',
  workspace_lease_renew: 'Explicitly renew the workspace idle lease duration or reactivate a recoverable expired workspace.',
  workspace_recover: 'Recover a recoverable expired workspace to active state, or inspect, patch, or export unpushed work.',
  workspace_context: 'Read the active workspace ID, branch, lease time, Git identity, and repository overview.',
  workspace_set_active: 'Set the caller preferred active workspace when multiple workspaces exist.',
  workspace_finalize: 'Transactionally stage changes, run preflights, commit with default or explicit identity, and push to remote in one call.',
  files_list: 'List one workspace directory with bounded cursor pagination.',
  files_read: 'Read a bounded byte range from a workspace file with its size, SHA-256, and continuation cursor.',
  files_write: 'Atomically create or replace a workspace file, optionally guarded by its current SHA-256.',
  files_write_batch: 'Atomically write multiple workspace files in one call, automatically creating missing parent directories.',
  files_apply_patch: 'Replace one unique exact text occurrence, optionally guarded by the file SHA-256.',
  files_delete: 'Delete one workspace file or directory, with explicit recursion and optional file hash guard.',
  files_move: 'Move or rename one workspace entry, optionally overwriting an existing file.',
  files_mkdir: 'Create one workspace directory, including missing parents by default.',
  grep_search: 'Search workspace text with a bounded regular expression and optional path, glob filter, and continuation cursor.',
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
  operation_status: 'Query the execution state, progress, and terminal result of a long-running operation.',
  operation_cancel: 'Cancel an in-flight long-running operation.',
  operation_wait: 'Wait for a long-running operation to reach a terminal state with a timeout.',
  git_status: 'Read branch, index, and working-tree status for the workspace repository.',
  git_diff: 'Read a bounded staged or unstaged Git diff with cursor pagination and readAll convenience.',
  git_log: 'Read bounded recent commit metadata from the workspace repository with cursor pagination.',
  git_branch: 'List, create, or delete a local Git branch with constrained ref arguments.',
  git_checkout: 'Check out an existing Git ref or create and check out a local branch.',
  git_add: 'Stage either explicit workspace paths or all tracked and untracked changes.',
  git_commit: 'Create an unsigned local Git commit with default or explicit author and message.',
  git_identity_status: 'Read the default or configured Git author name and email for the workspace.',
  git_identity_set: 'Configure default Git author name and email for workspace commits.',
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
  deployments_run: 'Execute one named repository-defined deployment target with external-effect risk.',
  artifacts_snapshot: 'Preserve one workspace file as a principal-owned, TTL-retained artifact snapshot.',
  artifacts_list: 'List principal-owned retained artifact snapshots with bounded pagination.',
  artifacts_read: 'Read a bounded base64 byte chunk from a principal-owned retained artifact with hash and EOF verification.',
  artifacts_restore: 'Restore an unexpired principal-owned artifact into an active workspace file with overwrite protection.',
  artifacts_delete: 'Delete a principal-owned retained artifact snapshot before its retention expiry.',
  github_action: 'Perform brokered GitHub operations via brokered helper without exposing tokens to workspace.',
  secrets_list: 'List available environment secret names and descriptions without revealing secret values. Reference credentials by name in commands.'
};

const readOnly = new Set<RunnerOperation>([
  'workspace_list', 'workspace_status', 'workspace_capabilities', 'workspace_context',
  'files_list', 'files_read', 'grep_search', 'symbols_search', 'symbols_references',
  'sessions_list', 'tasks_list', 'tasks_status', 'tasks_graph',
  'operation_status', 'operation_wait',
  'git_status', 'git_diff', 'git_log', 'git_identity_status',
  'worktrees_list', 'skills_list', 'skills_read', 'hooks_list', 'memories_list', 'memories_read', 'deployments_list',
  'artifacts_list', 'artifacts_read', 'secrets_list'
]);
const destructive = new Set<RunnerOperation>([
  'workspace_close', 'workspace_recover', 'workspace_finalize',
  'files_write', 'files_write_batch', 'files_apply_patch', 'files_delete', 'files_move',
  'exec_run', 'shell_io', 'shell_close', 'sessions_io', 'sessions_close',
  'tasks_run', 'tasks_cancel', 'operation_cancel',
  'git_branch', 'git_checkout', 'git_pull', 'git_push', 'git_merge', 'git_rebase', 'git_identity_set',
  'worktrees_remove', 'skills_run', 'hooks_run', 'memories_write', 'deployments_run', 'artifacts_restore', 'artifacts_delete', 'github_action'
]);
const idempotent = new Set<RunnerOperation>([
  'workspace_open', 'workspace_list', 'workspace_status', 'workspace_capabilities', 'workspace_close', 'workspace_lease_renew', 'workspace_context', 'workspace_set_active', 'workspace_finalize',
  'files_list', 'files_read', 'files_write', 'files_write_batch', 'files_apply_patch', 'files_mkdir', 'grep_search', 'symbols_search', 'symbols_references',
  'shell_open', 'shell_close', 'sessions_list', 'sessions_open', 'sessions_close',
  'tasks_list', 'tasks_run', 'tasks_status', 'tasks_cancel', 'tasks_graph',
  'operation_status', 'operation_cancel', 'operation_wait',
  'git_status', 'git_diff', 'git_log', 'git_add', 'git_identity_status', 'git_identity_set',
  'worktrees_list', 'skills_list', 'skills_read', 'hooks_list', 'memories_list', 'memories_read', 'memories_write', 'deployments_list',
  'artifacts_list', 'artifacts_read', 'secrets_list'
]);
const openWorld = new Set<RunnerOperation>([
  'workspace_open', 'workspace_finalize', 'exec_run', 'shell_io', 'sessions_io', 'tasks_run',
  'git_fetch', 'git_pull', 'git_push', 'skills_run', 'hooks_run', 'deployments_run', 'github_action'
]);

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
