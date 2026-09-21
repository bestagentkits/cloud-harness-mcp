import type { Response } from 'express';
import type { RunnerResponse } from '@cloud-harness/contracts';

const statuses: Record<string, number> = {
  AUTHENTICATION_FAILED: 401, FORBIDDEN: 404, INVALID_INPUT: 400, NOT_FOUND: 404,
  CONFLICT: 409, EXPIRED: 410, LIMIT_EXCEEDED: 429, TIMEOUT: 504,
  CANCELLED: 409, UNAVAILABLE: 503, DEPENDENCY_EGRESS_UNAVAILABLE: 503, INTERNAL_ERROR: 500
};

const messages: Record<string, string> = {
  AUTHENTICATION_FAILED: 'Your dashboard session ended.',
  FORBIDDEN: 'Workspace not found or no longer available.',
  INVALID_INPUT: 'The request could not be processed.',
  NOT_FOUND: 'Workspace not found or no longer available.',
  CONFLICT: 'This item changed after you opened it.',
  EXPIRED: 'Workspace expired.',
  LIMIT_EXCEEDED: 'Too many requests. Try again later.',
  TIMEOUT: 'The workspace service took too long to respond.',
  CANCELLED: 'The operation was cancelled.',
  UNAVAILABLE: 'The workspace service is temporarily unavailable.',
  DEPENDENCY_EGRESS_UNAVAILABLE: 'Dependency-access network egress is unavailable.',
  INTERNAL_ERROR: 'The workspace service could not complete the request.'
};

function cleanWorkspace(value: unknown): Record<string, unknown> {
  const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const allowed = ['workspaceId', 'repositoryUrl', 'ref', 'status', 'networkProfile', 'createdAt', 'lastActivityAt', 'expiresAt'];
  const clean = Object.fromEntries(allowed.filter((key) => item[key] !== undefined).map((key) => [key, item[key]]));
  if (typeof item.generation === 'number') clean.version = item.generation;
  if (item.status === 'FAILED' && typeof item.error === 'string') clean.error = 'Workspace setup failed. Review runner logs.';
  return clean;
}

/**
 * The cockpit Summary needs the workspace's posture, not the context document. The
 * workspace record, the branch, the git identity's name and manifest counts are
 * enough to show health, while file paths, file contents and the identity's email
 * stay in the runner.
 */
function workspaceContextProjection(data: Record<string, unknown>): Record<string, unknown> {
  const manifest = data.manifest && typeof data.manifest === 'object' ? data.manifest as Record<string, unknown> : {};
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  const capabilities = data.capabilities && typeof data.capabilities === 'object' ? data.capabilities as Record<string, unknown> : {};
  const identity = data.gitIdentity && typeof data.gitIdentity === 'object' ? data.gitIdentity as Record<string, unknown> : {};
  const truncationReasons = Array.isArray(manifest.truncationReasons)
    ? manifest.truncationReasons.filter((reason): reason is string => typeof reason === 'string').slice(0, 8)
    : [];
  return {
    ...cleanWorkspace(data),
    ...(typeof data.branch === 'string' ? { branch: data.branch } : {}),
    ...(typeof identity.name === 'string' ? { gitIdentityName: identity.name } : {}),
    capabilities: Object.fromEntries(Object.entries(capabilities).filter(([, value]) => typeof value === 'boolean')),
    manifest: { itemCount: items.length, truncated: manifest.truncated === true, truncationReasons }
  };
}

/**
 * A finalize result is a commit outcome and a push outcome. Remote URLs and raw
 * command output stay in the runner; the cockpit only reports what happened.
 */
function workspaceFinalizeProjection(data: Record<string, unknown>): Record<string, unknown> {
  return pick(data, ['branch', 'commitSha', 'committed', 'pushed', 'filesChanged', 'summary', 'message', 'truncated']);
}

const agentKeys = ['agentId', 'workspaceId', 'parentAgentId', 'profileId', 'status', 'generation', 'createdAt', 'startedAt', 'terminalAt', 'expiresAt', 'terminalReason', 'outcomeUnknown', 'proxyOperations'] as const;const agentBudgetKeys = ['ttlSeconds', 'maxOutputBytes', 'maxInputTokens', 'maxOutputTokens', 'maxCostMicros'] as const;
const agentUsageKeys = ['inputTokens', 'outputTokens', 'costMicros', 'outputBytes', 'eventCount', 'toolTimeMs', 'wallTimeMs'] as const;
/** One log event may be 65 KB on the runner; the browser gets a bounded slice. */
const AGENT_LOG_CONTENT_LIMIT = 4_000;

/**
 * Agent identity, budget and usage. Owner identifiers, credentials, prompts and raw
 * runner payloads never project; `proxyOperations` is already the runner's bounded
 * allowlist, so it passes through as computed.
 */
function agentProjection(value: unknown): Record<string, unknown> {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return { ...pick(source, agentKeys), budget: pick(source.budget, agentBudgetKeys), usage: pick(source.usage, agentUsageKeys) };
}

/** Bounded log events: an oversized event is truncated with an explicit marker. */
function agentLogEvents(value: unknown): Record<string, unknown>[] {
  const events = Array.isArray(value) ? value : [];
  return events.map((entry) => {
    const event = pick(entry, ['cursor', 'timestamp', 'type']);
    const content = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).content : undefined;
    const text = typeof content === 'string' ? content : '';
    return { ...event, content: text.length > AGENT_LOG_CONTENT_LIMIT ? `${text.slice(0, AGENT_LOG_CONTENT_LIMIT)}\n… truncated` : text };
  });
}

const taskKeys = ['id', 'name', 'status', 'exitCode', 'dependsOn', 'startedAt', 'finishedAt', 'durationMs', 'cwd', 'outputBytes'] as const;
const sessionKeys = ['id', 'name', 'status', 'cwd', 'createdAt', 'lastActivityAt', 'closedAt', 'cursor'] as const;
/** Task and session output is bounded before it leaves the API. */
const RUNTIME_OUTPUT_LIMIT = 8_000;

function boundedOutput(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > RUNTIME_OUTPUT_LIMIT ? `${value.slice(0, RUNTIME_OUTPUT_LIMIT)}\n… truncated` : value;
}

/** Task identity, timing and outcome. Dependencies stay as ids so the UI can draw the DAG. */
function taskProjection(value: unknown): Record<string, unknown> {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const output = boundedOutput(source.output);
  return { ...pick(source, taskKeys), ...(output !== undefined ? { output } : {}) };
}

/** Session identity and lifecycle. `cursor` marks how far the bounded read reached. */
function sessionProjection(value: unknown): Record<string, unknown> {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const output = boundedOutput(source.output);
  return { ...pick(source, sessionKeys), ...(output !== undefined ? { output } : {}) };
}

/**
 * Git arrives from the worker as bounded text (`git status --short --branch`, a diff,
 * `git worktree list`). Parsing it here keeps the browser free of porcelain parsing and
 * makes the summary testable; the raw text still ships so an operator can read it.
 */
export function parseGitStatus(output: unknown): Record<string, unknown> {
  const lines = String(output ?? '').split('\n');
  const header = lines.find((line) => line.startsWith('## ')) ?? '';
  const detail = header.slice(3).trim();
  const bracket = detail.match(/\[([^\]]+)\]/);
  const ahead = Number(bracket?.[1]?.match(/ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(bracket?.[1]?.match(/behind (\d+)/)?.[1] ?? 0);
  const [left, right] = detail.replace(/\s*\[[^\]]+\]\s*/, '').split('...');
  const entries = lines
    .filter((line) => line.trim() && !line.startsWith('## '))
    // The two-character XY code must keep its positions: the first column is the index
    // and the second is the working tree, so trimming would erase which side changed.
    .map((line) => ({ code: line.slice(0, 2).trim(), xy: line.slice(0, 2), path: line.slice(3).trim() }));
  const index = (entry: { xy: string }) => entry.xy[0] !== ' ' && entry.xy[0] !== '?';
  const worktree = (entry: { xy: string }) => entry.xy[1] !== ' ' && entry.xy[1] !== '?';
  return {
    branch: left || 'detached',
    ...(right ? { upstream: right } : {}),
    ahead,
    behind,
    entries: entries.map((entry) => ({ code: entry.code, path: entry.path })),
    staged: entries.filter(index).length,
    modified: entries.filter(worktree).length,
    untracked: entries.filter((entry) => entry.xy.trim() === '??').length
  };
}

/** `git worktree list` text: `<path> <oid> [branch]`. */
export function parseWorktrees(output: unknown): Record<string, unknown>[] {
  return String(output ?? '')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [path, head, ...rest] = line.trim().split(/\s+/);
      const branch = rest.join(' ').replace(/^\[|\]$/g, '');
      return { path, head, ...(branch ? { branch } : {}) };
    });
}

export const DASHBOARD_RESPONSE_OPERATIONS = [
  'workspace_open',
  'workspace_list',
  'workspace_status',
  'workspace_detail',
  'workspace_close',
  'workspace_context',
  'workspace_lease_renew',
  'workspace_recover',
  'workspace_finalize',
  'agent_list',
  'agent_status',
  'agent_logs',
  'agent_message',
  'agent_cancel',
  'tasks_status',
  'tasks_cancel',
  'tasks_graph',
  'sessions_open',
  'sessions_io',
  'sessions_close',
  'git_status',
  'git_diff',
  'git_log',
  'git_fetch',
  'git_pull',
  'git_checkout',
  'git_branch',
  'git_merge',
  'git_rebase',
  'worktrees_list',
  'worktrees_create',
  'worktrees_remove',
  'skills_list',
  'skills_read',
  'skills_run',
  'hooks_list',
  'hooks_run',
  'hooks_activate',
  'hooks_deactivate',
  'deployments_list',
  'deployments_run',
  'toolkits_list',
  'toolkits_preview',
  'settings_get', 'settings_update', 'settings_network_check',
  'files_list',
  'files_read',
  'files_write',
  'files_apply_patch',
  'files_delete',
  'files_move',
  'files_mkdir',
  'tasks_list',
  'sessions_list',
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
  'knowledge_dashboard_list', 'knowledge_dashboard_get', 'knowledge_dashboard_create', 'knowledge_dashboard_update', 'knowledge_dashboard_delete', 'knowledge_dashboard_search', 'knowledge_dashboard_graph', 'knowledge_dashboard_link_create', 'knowledge_dashboard_link_delete',
  'mcp_server_list', 'mcp_server_get', 'mcp_server_create', 'mcp_server_update', 'mcp_server_delete',
  'mcp_server_set_enabled', 'mcp_server_set_permissions', 'mcp_server_replace_tools',
  'mcp_server_connection_result', 'mcp_server_get_credentials',
  'mcp_gateway_catalog', 'mcp_gateway_trace_append', 'mcp_gateway_trace_list',
  'skill_list', 'skill_get', 'skill_create_custom', 'skill_update', 'skill_archive', 'skill_restore', 'skill_bulk',
  'skill_usage', 'skill_search',
  'skill_import_start', 'skill_import_status', 'skill_import_cancel',
  'skill_revision_list', 'skill_revision_get', 'skill_revision_diff',
  'skill_set_list', 'skill_set_get', 'skill_set_create', 'skill_set_update', 'skill_set_delete', 'skill_set_preview',
  'toolkit_registry_list', 'toolkit_registry_update', 'toolkit_registry_refresh',
  'skill_suggest', 'typesafe_status',
  'skill_revision_fork',
  'skill_revision_create',
  'integration_credential_list', 'integration_credential_create', 'integration_credential_rotate', 'integration_credential_delete'
] as const;

/**
 * The runtime list is the single source of truth for both the type and the totality test, so an
 * operation can no longer be added to the mapper's type without being enumerable at runtime.
 */
export type DashboardResponseOperation = typeof DASHBOARD_RESPONSE_OPERATIONS[number];
function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.fromEntries(keys.filter((key) => item[key] !== undefined).map((key) => [key, item[key]]));
}

const metadataKeys = ['id', 'name', 'state', 'generation', 'createdAt', 'updatedAt', 'deletedAt'] as const;
const environmentKeys = [...metadataKeys, 'projectId'] as const;
const secretKeys = ['id', 'environmentId', 'name', 'description', 'state', 'version', 'generation', 'createdAt', 'updatedAt', 'deletedAt'] as const;
const artifactKeys = ['artifactId', 'logicalName', 'sha256', 'sizeBytes', 'projectId', 'environmentId', 'workspaceId', 'createdAt', 'updatedAt', 'expiresAt', 'retentionMs', 'generation'] as const;
const privilegeGrantKeys = ['id', 'ownerId', 'workspaceId', 'command', 'cwd', 'commandSha256', 'status', 'createdAt', 'expiresAt', 'consumedAt'] as const;
const knowledgeItemKeys = ['id', 'kind', 'scope', 'projectId', 'workspaceId', 'title', 'content', 'contentSha256', 'journalType', 'occurredAt', 'generation', 'createdAt', 'updatedAt', 'expiresAt', 'tags', 'provenance', 'outboundLinks', 'backlinks'] as const;
const mcpServerKeys = ['id', 'name', 'description', 'transport', 'endpoint', 'headers', 'enabled', 'status', 'toolCount', 'lastConnectedAt', 'lastError', 'lastCheckedAt', 'permissionDefault', 'generation', 'createdAt', 'updatedAt'] as const;
const mcpToolKeys = ['id', 'serverId', 'qualifiedName', 'upstreamName', 'description', 'inputSchema', 'annotations', 'availability', 'permission', 'discoveredAt'] as const;
const mcpTraceKeys = ['id', 'serverId', 'serverName', 'tool', 'operation', 'clientId', 'durationMs', 'status', 'errorCode', 'errorMessage', 'requestBytes', 'responseBytes', 'createdAt'] as const;
const mcpCredentialKeys = ['allowed', 'reason'] as const;
const mcpConnectionKeys = ['status', 'toolCount', 'error'] as const;

/** Projected from the `skill_sources` and `skill_revisions` columns Phase 1 created. */
const skillKeys = ['id', 'slug', 'displayName', 'description', 'kind', 'provider', 'sourceRef', 'currentRevisionId', 'state', 'tags', 'generation', 'createdAt', 'updatedAt'] as const;
const skillRevisionKeys = ['id', 'skillSourceId', 'parentRevisionId', 'origin', 'hasExecutableAssets', 'createdAt'] as const;
const skillSetKeys = ['id', 'name', 'description', 'generation', 'createdAt', 'updatedAt'] as const;
const skillSetItemKeys = ['skillSetId', 'ordinal', 'skillSourceId', 'revisionId', 'name'] as const;
const skillUsageSetKeys = ['skillSetId', 'name'] as const;
const skillUsageWorkspaceKeys = ['workspaceId', 'status', 'name', 'revisionId'] as const;
const skillImportJobKeys = ['id', 'sourceKind', 'sourceRef', 'state', 'progress', 'result', 'errorCode', 'skillRevisionId', 'createdAt', 'updatedAt'] as const;
const skillResolvedKeys = ['name', 'tier', 'skillSourceId', 'revisionId', 'contentSha256', 'pinned'] as const;
const skillExcludedKeys = ['name', 'tier', 'reason'] as const;
const skillCatalogKeys = ['id', 'provider', 'slug', 'displayName', 'description', 'fetchedAt', 'cacheState', 'pinnedCommit', 'skillCount', 'lockState'] as const;
/** Credential metadata. No value field, so no projection can produce one. */
const integrationCredentialKeys = ['id', 'integration', 'label', 'status', 'activeVersion', 'generation', 'createdAt', 'updatedAt'] as const;

/**
 * A revision diff is prose the UI renders, so it is passed through only when the runner actually
 * sent a string; anything else is dropped rather than stringified into `[object Object]`.
 */
function skillRevisionProjection(data: Record<string, unknown>): Record<string, unknown> {
  return { ...pick(data, skillRevisionKeys), ...(typeof data.diff === 'string' ? { diff: data.diff } : {}) };
}

function listOf(value: unknown, keys: readonly string[]): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map((entry) => pick(entry, keys)) : [];
}

/**
 * Project header metadata only. A literal value stays projectable so the dashboard
 * can edit it, but a secret header's value is never projected — not even when a
 * misbehaving runner attaches one alongside `kind: 'secret'`.
 */
function mcpHeader(value: unknown): Record<string, unknown> {
  const header = pick(value, ['name', 'kind', 'secretRef', 'value']);
  if (header.kind !== 'literal') delete header.value;
  return header;
}

/** Re-map a server through the allowlist, projecting header metadata only. */
function mcpServer(value: unknown): Record<string, unknown> {
  const server = pick(value, mcpServerKeys);
  const headers = Array.isArray(server.headers) ? server.headers : [];
  return { ...server, headers: headers.map((header) => mcpHeader(header)) };
}

function mcpServerResult(data: Record<string, unknown>): Record<string, unknown> {
  return { server: mcpServer(data.server), ...list(data, 'tools', mcpToolKeys) };
}

const knowledgeLinkKeys = ['id', 'sourceId', 'targetId', 'relation', 'origin', 'generation', 'createdAt'] as const;
const list = (data: Record<string, unknown>, key: string, keys: readonly string[]) => ({
  [key]: Array.isArray(data[key]) ? data[key].map((record) => pick(record, keys)) : []
});

const installationKeys = ['appId', 'installationId', 'accountId', 'accountLogin', 'status', 'generation', 'createdAt', 'updatedAt', 'checkedAt'] as const;
function githubStatus(data: Record<string, unknown>): Record<string, unknown> {
  const installations = Array.isArray(data.installations)
    ? data.installations.map((item) => pick(item, installationKeys))
    : (data.installation && typeof data.installation === 'object' ? [pick(data.installation, installationKeys)] : []);
  const installation = installations[0] ?? (data.installation && typeof data.installation === 'object' ? pick(data.installation, installationKeys) : null);
  return {
    configured: data.configured === true,
    installation,
    installations,
    ...list(data, 'repositories', ['installationId', 'owner', 'repository', 'contents', 'status', 'generation', 'createdAt', 'updatedAt', 'checkedAt'])
  };
}

/**
 * The dashboard projection boundary. Every branch returns an object built by `pick`, `list`, or a
 * literal, so the boundary can be named instead of left as `unknown` that every caller must re-check.
 */
export type DashboardProjection = Record<string, unknown>;

export function mapDashboardData(operation: DashboardResponseOperation, value: unknown): DashboardProjection {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (operation === 'workspace_list') {
    const workspaces = Array.isArray(data.workspaces) ? data.workspaces.map(cleanWorkspace) : [];
    return { workspaces };
  }
  if (operation === 'workspace_open' || operation === 'workspace_status' || operation === 'workspace_detail' || operation === 'workspace_close' || operation === 'workspace_lease_renew' || operation === 'workspace_recover') return cleanWorkspace(data);
  if (operation === 'workspace_context') return workspaceContextProjection(data);
  if (operation === 'workspace_finalize') return workspaceFinalizeProjection(data);
  if (operation === 'agent_list') {
    const agents = Array.isArray(data.agents) ? data.agents.map(agentProjection) : [];
    return { agents };
  }
  if (operation === 'agent_status') return agentProjection(data.agent ?? data);
  if (operation === 'agent_logs') {
    return {
      agentId: data.agentId, cursor: data.cursor, nextCursor: data.nextCursor, retainedBaseCursor: data.retainedBaseCursor,
      truncated: data.truncated === true, hasMore: data.hasMore === true, events: agentLogEvents(data.events)
    };
  }
  if (operation === 'agent_message' || operation === 'agent_cancel') {
    return pick(data, ['agentId', 'status', 'state', 'replayed', 'affectedAgentIds']);
  }
  if (operation === 'tasks_status') {
    return { task: taskProjection(data.task ?? data), ...(data.cursor !== undefined ? { cursor: data.cursor } : {}), truncated: data.truncated === true };
  }
  if (operation === 'tasks_cancel') return { task: taskProjection(data.task ?? data) };
  if (operation === 'tasks_graph') {
    const nodes = Array.isArray(data.nodes) ? data.nodes.map(taskProjection) : [];
    const edges = Array.isArray(data.edges) ? data.edges.map((edge) => pick(edge, ['from', 'to'])) : [];
    return { nodes, edges };
  }
  if (operation === 'sessions_open' || operation === 'sessions_close') return { session: sessionProjection(data.session ?? data) };
  if (operation === 'sessions_io') {
    return { session: sessionProjection(data.session ?? data), ...(data.cursor !== undefined ? { cursor: data.cursor } : {}), truncated: data.truncated === true };
  }
  if (operation === 'git_status') {
    return { ...parseGitStatus(data.output), output: boundedOutput(data.output) ?? '' };
  }
  if (operation === 'git_diff') {
    const diff = boundedOutput(data.output ?? data.diff);
    return { ...(diff !== undefined ? { diff } : {}), ...(typeof data.signature === 'string' ? { signature: data.signature } : {}), truncated: data.truncated === true || (diff ?? '').includes('… truncated') };
  }
  if (operation === 'git_log') {
    const commits = Array.isArray(data.commits)
      ? data.commits.map((commit) => pick(commit, ['oid', 'sha', 'subject', 'message', 'author', 'authoredAt', 'date', 'branch', 'refs']))
      : [];
    const output = boundedOutput(data.output);
    return { commits, ...(output !== undefined ? { output } : {}), ...(data.cursor !== undefined ? { cursor: data.cursor } : {}) };
  }
  if (operation === 'worktrees_list') {
    const worktrees = Array.isArray(data.worktrees) ? data.worktrees.map((entry) => pick(entry, ['path', 'head', 'branch', 'name'])) : parseWorktrees(data.output);
    return { worktrees, output: boundedOutput(data.output) ?? '' };
  }
  if (operation === 'git_fetch' || operation === 'git_pull' || operation === 'git_checkout' || operation === 'git_branch' || operation === 'git_merge' || operation === 'git_rebase' || operation === 'worktrees_create' || operation === 'worktrees_remove') {
    const output = boundedOutput(data.output);
    return { ...pick(data, ['name', 'path', 'head', 'branch', 'ref', 'action']), ...(output !== undefined ? { output } : {}) };
  }
  if (operation === 'skills_list') {
    const skills = Array.isArray(data.skills) ? data.skills.map((skill) => pick(skill, ['name', 'tier', 'source', 'kind', 'state', 'sha256', 'description', 'shadowed'])) : [];
    return { skills, ...(data.cursor !== undefined ? { cursor: data.cursor } : {}) };
  }
  if (operation === 'skills_read') return pick(data, ['name', 'source', 'content', 'sha256', 'bytes', 'offset', 'truncated']);
  if (operation === 'hooks_list') {
    const hooks = Array.isArray(data.hooks) ? data.hooks.map((hook) => pick(hook, ['name', 'path', 'events', 'active', 'trigger', 'description', 'sha256'])) : [];
    return { hooks, ...(typeof data.manifestSha256 === 'string' ? { manifestSha256: data.manifestSha256 } : {}), ...(data.cursor !== undefined ? { cursor: data.cursor } : {}) };
  }
  if (operation === 'deployments_list') {
    const deployments = Array.isArray(data.deployments) ? data.deployments.map((entry) => pick(entry, ['name', 'cwd', 'status', 'lastResult', 'durationMs', 'error'])) : [];
    return { deployments };
  }
  if (operation === 'skills_run' || operation === 'hooks_run' || operation === 'hooks_activate' || operation === 'hooks_deactivate' || operation === 'deployments_run') {
    const output = boundedOutput(data.output);
    return { ...pick(data, ['name', 'event', 'events', 'status', 'exitCode', 'durationMs', 'error', 'manifestSha256']), ...(output !== undefined ? { output } : {}) };
  }
  if (operation === 'toolkits_list' || operation === 'toolkits_preview') return data;
  if (operation === 'files_list') {
    const entries = Array.isArray(data.entries) ? data.entries.map((entry) => {
      const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
      return { name: item.name, type: item.type };
    }) : [];
    return { path: data.path, entries };
  }
  if (operation === 'files_read') return pick(data, ['path', 'content', 'sha256', 'bytes']);
  if (operation === 'files_write') return pick(data, ['path', 'bytes', 'sha256']);
  if (operation === 'files_apply_patch') return pick(data, ['path', 'sha256']);
  if (operation === 'files_delete') return pick(data, ['path', 'type']);
  if (operation === 'files_move') return pick(data, ['source', 'destination']);
  if (operation === 'files_mkdir') return pick(data, ['path']);
  if (operation === 'tasks_list') {
    const tasks = Array.isArray(data.tasks) ? data.tasks.map((record) => pick(record, ['id', 'status', 'exitCode', 'dependsOn'])) : [];
    return { tasks };
  }
  if (operation === 'sessions_list') {
    const sessions = Array.isArray(data.sessions) ? data.sessions.map((record) => pick(record, ['id', 'name', 'status'])) : [];
    return { sessions };
  }
  if (operation === 'project_list') return list(data, 'projects', metadataKeys);
  if (['project_create', 'project_update', 'project_delete'].includes(operation)) return pick(data, metadataKeys);
  if (operation === 'environment_list') return list(data, 'environments', environmentKeys);
  if (['environment_create', 'environment_update', 'environment_delete'].includes(operation)) return pick(data, environmentKeys);
  if (operation === 'secret_list' || operation === 'global_secret_list') return { ...list(data, 'secrets', secretKeys), readiness: pick(data.readiness, ['ready', 'error']) };
  if (operation === 'secret_bulk_apply' || operation === 'global_secret_bulk_apply') return { secrets: Array.isArray(data.secrets) ? data.secrets.map((record) => pick(record, secretKeys)) : [] };
  if (['secret_create', 'secret_rotate', 'secret_update', 'secret_delete', 'global_secret_create', 'global_secret_rotate', 'global_secret_update', 'global_secret_delete'].includes(operation)) return pick(data, secretKeys);
  if (operation === 'audit_list') return list(data, 'events', ['id', 'action', 'subjectType', 'subjectId', 'subjectGeneration', 'details', 'createdAt']);
  if (operation === 'artifact_list') return list(data, 'artifacts', artifactKeys);
  if (operation === 'artifact_snapshot' || operation === 'artifact_delete') return pick(data, artifactKeys);
  if (operation === 'artifact_read') return pick(data, ['artifactId', 'logicalName', 'offset', 'bytesReturned', 'totalBytes', 'sha256', 'eof', 'content']);
  if (operation === 'artifact_restore') return pick(data, ['artifactId', 'workspaceId', 'path', 'sizeBytes', 'sha256']);
  if (operation === 'github_setup_begin') return pick(data, ['url', 'state', 'expiresAt']);
  if (['github_status', 'github_setup_complete', 'github_reconcile', 'github_disconnect'].includes(operation)) return githubStatus(data);
  if (operation === 'privilege_grant_list') return list(data, 'grants', privilegeGrantKeys);
  if (operation === 'privilege_grant_approve' || operation === 'privilege_grant_reject') return { grant: pick(data.grant, privilegeGrantKeys) };
  if (operation === 'knowledge_dashboard_list') return { items: Array.isArray(data.items) ? data.items.map((item) => pick(item, knowledgeItemKeys)) : [] };
  if (operation === 'knowledge_dashboard_get' || operation === 'knowledge_dashboard_create' || operation === 'knowledge_dashboard_update') return pick(data, knowledgeItemKeys);
  if (operation === 'knowledge_dashboard_delete') return pick(data, ['deleted']);
  if (operation === 'knowledge_dashboard_search') return { results: Array.isArray(data.results) ? data.results.map((res) => (typeof res === 'object' && res ? { ...res, item: pick((res as Record<string, unknown>).item, knowledgeItemKeys) } : res)) : [] };
  if (operation === 'knowledge_dashboard_graph') return { nodes: Array.isArray(data.nodes) ? data.nodes.map((n) => pick(n, ['id', 'kind', 'scope', 'title', 'journalType', 'tags', 'updatedAt'])) : [], edges: Array.isArray(data.edges) ? data.edges.map((e) => pick(e, knowledgeLinkKeys)) : [], truncated: Boolean(data.truncated) };
  if (operation === 'knowledge_dashboard_link_create') return pick(data, knowledgeLinkKeys);
  if (operation === 'knowledge_dashboard_link_delete') return pick(data, ['unlinked']);
  if (operation === 'mcp_server_list') return { servers: Array.isArray(data.servers) ? data.servers.map((server) => mcpServer(server)) : [] };
  if (operation === 'mcp_server_get') return mcpServerResult(data);
  if (operation === 'mcp_server_create' || operation === 'mcp_server_update' || operation === 'mcp_server_set_enabled' || operation === 'mcp_server_set_permissions' || operation === 'mcp_server_delete' || operation === 'mcp_server_replace_tools') return mcpServer(data);
  if (operation === 'mcp_server_connection_result') return pick(data, mcpConnectionKeys);
  if (operation === 'mcp_server_get_credentials' || operation === 'mcp_gateway_catalog' || operation === 'mcp_gateway_trace_append') return pick(data, mcpCredentialKeys);
  if (operation === 'mcp_gateway_trace_list') return { traces: Array.isArray(data.traces) ? data.traces.map((trace) => pick(trace, mcpTraceKeys)) : [] };
  if (operation === 'skill_list') return list(data, 'skills', skillKeys);
  if (operation === 'skill_get' || operation === 'skill_create_custom' || operation === 'skill_update' || operation === 'skill_archive' || operation === 'skill_restore') return pick(data, skillKeys);
  if (operation === 'skill_bulk') {
    const results = Array.isArray(data.results) ? data.results : [];
    return {
      results: results.map((entry) => {
        const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
        return {
          ...pick(item, ['skillId', 'name']),
          ok: item.ok === true,
          ...(typeof item.error === 'string' ? { error: item.error } : {}),
          ...(item.skill && typeof item.skill === 'object' ? { skill: pick(item.skill, skillKeys) } : {})
        };
      })
    };
  }
  // The reader answers with the two places a skill can be in use, so the projection mirrors that shape.
  // It previously read a `usages` key that the reader never produced, which left the dashboard with an
  // empty list and made usage look like a skill nobody used rather than a field nobody filled.
  if (operation === 'skill_usage') {
    return {
      sets: listOf(data.sets, skillUsageSetKeys),
      liveWorkspaces: listOf(data.liveWorkspaces, skillUsageWorkspaceKeys)
    };
  }
  if (operation === 'skill_search') {
    return {
      local: listOf(data.local, skillKeys),
      providers: listOf(data.providers, ['provider', 'status', 'warning', 'count']),
      results: listOf(data.results, ['provider', 'reference', 'name', 'description', 'installs'])
    };
  }
  if (operation === 'skill_import_start' || operation === 'skill_import_status' || operation === 'skill_import_cancel') return pick(data, skillImportJobKeys);
  if (operation === 'skill_revision_list') return list(data, 'revisions', skillRevisionKeys);
  if (operation === 'skill_revision_get' || operation === 'skill_revision_diff') return skillRevisionProjection(data);
  if (operation === 'skill_set_list') return list(data, 'sets', skillSetKeys);
  if (operation === 'skill_set_get') return { ...pick(data, skillSetKeys), items: listOf(data.items, skillSetItemKeys) };
  if (operation === 'skill_set_create' || operation === 'skill_set_update' || operation === 'skill_set_delete') return pick(data, skillSetKeys);
  if (operation === 'skill_set_preview') {
    return {
      ...pick(data, ['generation', 'stale']),
      resolved: listOf(data.resolved, skillResolvedKeys),
      excluded: listOf(data.excluded, skillExcludedKeys),
      conflicts: listOf(data.conflicts, ['name', 'candidates', 'candidateCount'])
    };
  }
  // Presets travel separately from entries because they are suggestions a launch could install rather
  // than skills the workspace can already resolve, and merging the two lists would erase that difference.
  if (operation === 'toolkit_registry_update') return pick(data, ['provider', 'slug', 'action', 'revisionId']);
  if (operation === 'toolkit_registry_refresh') return { entries: listOf(data.entries, skillCatalogKeys) };
  if (operation === 'toolkit_registry_list') {
    return {
      entries: listOf(data.entries, skillCatalogKeys),
      presets: listOf(data.presets, ['id', 'name', 'description', 'sourceUrl', 'license', 'defaultRevision', 'supportedScopes', 'installable'])
    };
  }
  if (operation === 'skill_suggest') {
    return {
      ...pick(data, ['reason', 'cached', 'latencyMs', 'outboundCalls', 'redactionCount']),
      // A suggestion is a roster-validated name and its numbers; model prose has nowhere to sit here.
      suggested: data.suggested && typeof data.suggested === 'object'
        ? pick(data.suggested, ['name', 'gate', 'fit', 'confidence'])
        : null
    };
  }
  if (operation === 'typesafe_status') return pick(data, ['configured', 'enabled', 'endpoint', 'model']);
  if (operation === 'integration_credential_list') return list(data, 'credentials', integrationCredentialKeys);
  if (operation === 'integration_credential_delete') return pick(data, ['id', 'deleted']);
  if (operation === 'integration_credential_create' || operation === 'integration_credential_rotate') return pick(data, integrationCredentialKeys);
  if (operation === 'skill_revision_create') return pick(data, ['sourceId', 'revisionId']);
  if (operation === 'skill_revision_fork') {
    return {
      ...pick(data, ['sourceId', 'revisionId']),
      // The provenance of a fork is the pair it started from, which is what the UI shows.
      forkedFrom: pick(data.forkedFrom, ['skillId', 'revisionId'])
    };
  }
  return data;
}
const descriptiveOperations = new Set<string>([
  'secret_create', 'secret_rotate', 'secret_update', 'secret_delete', 'secret_bulk_apply',
  'global_secret_create', 'global_secret_rotate', 'global_secret_update', 'global_secret_delete', 'global_secret_bulk_apply',
  'project_create', 'project_update', 'project_delete',
  'environment_create', 'environment_update', 'environment_delete',
  'artifact_snapshot', 'artifact_read', 'artifact_restore', 'artifact_delete',
  'knowledge_dashboard_create', 'knowledge_dashboard_update', 'knowledge_dashboard_delete',
  'knowledge_dashboard_link_create', 'knowledge_dashboard_link_delete',
  'mcp_server_create', 'mcp_server_update', 'mcp_server_delete', 'mcp_server_set_enabled', 'mcp_server_set_permissions',
  'mcp_server_replace_tools', 'mcp_server_connection_result',
  'mcp_server_list', 'mcp_server_get', 'mcp_gateway_trace_list',
  'skill_create_custom', 'skill_update', 'skill_archive', 'skill_restore', 'skill_bulk',
  'skill_import_start', 'skill_import_cancel',
  'skill_set_create', 'skill_set_update', 'skill_set_delete',
  'integration_credential_create', 'integration_credential_rotate', 'integration_credential_delete',
  'skill_suggest'
]);

/** Gateway operations need gateway wording; the shared table is workspace-oriented. */
const operationMessages: Partial<Record<DashboardResponseOperation, Record<string, string>>> = {
  mcp_server_list: { UNAVAILABLE: 'The MCP registry is temporarily unavailable.' },
  mcp_server_get: { NOT_FOUND: 'MCP server not found.' },
  mcp_gateway_trace_list: { NOT_FOUND: 'MCP server not found.' },
  mcp_server_set_permissions: { CONFLICT: 'This MCP server changed after you opened it.' },
  mcp_server_update: { CONFLICT: 'This MCP server changed after you opened it.' },
  mcp_server_delete: { CONFLICT: 'This MCP server changed after you opened it.' },
  mcp_server_set_enabled: { CONFLICT: 'This MCP server changed after you opened it.' },
  settings_get: { UNAVAILABLE: 'Instance settings are temporarily unavailable.' },
  settings_update: { UNAVAILABLE: 'Instance settings are temporarily unavailable.', INVALID_INPUT: 'The default network profile must be network-none or dependency-access.' },
  settings_network_check: { UNAVAILABLE: 'The egress readiness check is temporarily unavailable.' },
  skill_list: { UNAVAILABLE: 'The skill registry is temporarily unavailable.' },
  skill_get: { NOT_FOUND: 'Skill not found.' },
  skill_update: { CONFLICT: 'This skill changed after you opened it.' },
  skill_archive: { CONFLICT: 'This skill changed after you opened it.' },
  skill_restore: { CONFLICT: 'This skill changed after you opened it.' },
  skill_create_custom: { CONFLICT: 'A skill with this name already exists.' },
  skill_bulk: { UNAVAILABLE: 'The skill registry is temporarily unavailable.' },
  skill_search: { UNAVAILABLE: 'Skill search is temporarily unavailable.' },
  skill_import_start: { CONFLICT: 'This import already started.', UNAVAILABLE: 'The provider is temporarily unavailable.' },
  skill_import_status: { NOT_FOUND: 'Import job not found.' },
  skill_import_cancel: { NOT_FOUND: 'Import job not found.', CONFLICT: 'This import already finished.' },
  skill_revision_list: { NOT_FOUND: 'Skill not found.' },
  skill_revision_get: { NOT_FOUND: 'Revision not found.' },
  skill_revision_diff: { NOT_FOUND: 'Revision not found.' },
  skill_set_list: { UNAVAILABLE: 'Skill sets are temporarily unavailable.' },
  skill_set_get: { NOT_FOUND: 'Skill set not found.' },
  skill_set_create: { CONFLICT: 'A skill set with this name already exists.' },
  skill_set_update: { CONFLICT: 'This skill set changed after you opened it.' },
  skill_set_delete: { CONFLICT: 'This skill set is still used by a workspace.' },
  skill_set_preview: { CONFLICT: 'This skill set changed after you opened it.', NOT_FOUND: 'Skill set not found.' }
};

/**
 * The Overview's decision buckets. Each bucket carries the scope its numbers came
 * from, so the UI can label them honestly instead of implying a historical store the
 * harness does not keep.
 */
export function buildOverviewProjection(input: {
  workspaces?: Record<string, unknown>[];
  agents?: Record<string, unknown>[];
  grants?: Record<string, unknown>[];
  now?: number;
}): Record<string, unknown> {
  const nowMs = input.now ?? Date.now();
  const workspaces = input.workspaces ?? [];
  const agents = input.agents ?? [];
  const grants = input.grants ?? [];
  const remaining = (value: unknown) => {
    const at = Date.parse(String(value ?? ''));
    return Number.isFinite(at) ? at - nowMs : undefined;
  };
  const expiringWithin = (minutes: number) => workspaces.filter((workspace) => {
    const ms = remaining(workspace.expiresAt);
    return ms !== undefined && ms > 0 && ms <= minutes * 60_000;
  });
  const attention: Record<string, unknown>[] = [];
  for (const workspace of workspaces) {
    const id = String(workspace.workspaceId ?? '');
    if (workspace.status === 'FAILED') attention.push({ id: `workspace-failed-${id}`, label: 'Workspace setup failed', detail: 'Review the failure and recover if the checkout is worth keeping.', href: `/dashboard/workspaces/${encodeURIComponent(id)}/summary` });
    if (workspace.status === 'NETWORK_QUARANTINED') attention.push({ id: `workspace-quarantined-${id}`, label: 'Workspace network quarantined', detail: 'Egress was revoked, so dependency access is denied.', href: `/dashboard/workspaces/${encodeURIComponent(id)}/summary` });
  }
  for (const workspace of expiringWithin(15)) {
    attention.push({ id: `workspace-expiring-${String(workspace.workspaceId ?? '')}`, label: 'Lease expires soon', detail: 'Renew the lease or finalize before the workspace is reaped.', href: `/dashboard/workspaces/${encodeURIComponent(String(workspace.workspaceId ?? ''))}/summary` });
  }
  for (const agent of agents) {
    const status = String(agent.status ?? '');
    if (!['FAILED', 'LIMIT_EXCEEDED', 'TIMED_OUT'].includes(status)) continue;
    attention.push({ id: `agent-${String(agent.agentId ?? '')}`, label: `Agent ${status.toLowerCase().replace('_', ' ')}`, detail: 'Open the agent for its terminal reason and usage.', href: `/dashboard/agents/${encodeURIComponent(String(agent.agentId ?? ''))}` });
  }
  if (grants.length) attention.push({ id: 'pending-approvals', label: `${grants.length} pending approval(s)`, detail: 'Privilege requests are waiting for a decision.', href: '/dashboard/approvals' });

  const runningAgents = agents.filter((agent) => agent.status === 'RUNNING');
  const activeWorkspaces = workspaces.filter((workspace) => workspace.status === 'ACTIVE');
  const runningCost = runningAgents.reduce((total, agent) => {
    const usage = agent.usage && typeof agent.usage === 'object' ? agent.usage as Record<string, unknown> : {};
    return total + (Number(usage.costMicros) || 0);
  }, 0);
  const buckets = [15, 60, 240].map((minutes) => ({ windowMinutes: minutes, label: minutes < 60 ? `${minutes} min` : `${minutes / 60} h`, count: expiringWithin(minutes).length }));

  // Execution health and cost over the *retained* agent window. The harness keeps agent
  // state and per-agent usage, not a long-lived outcome or billing ledger, so the series
  // is bucketed over the agents on record and labelled as such rather than presented as
  // a daily history.
  const outcomeGroup = (status: unknown) => {
    const value = String(status ?? '');
    if (value === 'SUCCEEDED') return 'succeeded';
    if (['FAILED', 'TIMED_OUT', 'LIMIT_EXCEEDED'].includes(value)) return 'attention';
    if (value === 'CANCELLED') return 'cancelled';
    if (['RUNNING', 'SPAWNING', 'CANCELLING'].includes(value)) return 'running';
    return 'other';
  };
  const starts = agents
    .map((agent) => ({ at: Date.parse(String(agent.startedAt ?? agent.createdAt ?? '')), agent }))
    .filter((entry) => Number.isFinite(entry.at));
  const OUTCOME_BUCKETS = 8;
  const agentOutcomes: Record<string, unknown>[] = [];
  const costSeries: Record<string, unknown>[] = [];
  if (starts.length) {
    const min = Math.min(...starts.map((entry) => entry.at));
    const max = Math.max(...starts.map((entry) => entry.at));
    // Agents that all started inside one minute would otherwise produce eight empty
    // buckets, so a narrow window collapses to a single bucket.
    const bucketsCount = max - min < 60_000 ? 1 : OUTCOME_BUCKETS;
    const bucketMs = bucketsCount === 1 ? 1 : (max - min) / bucketsCount;
    for (let index = 0; index < bucketsCount; index += 1) {
      const from = min + index * bucketMs;
      const to = index === bucketsCount - 1 ? max + 1 : min + (index + 1) * bucketMs;
      const inBucket = starts.filter((entry) => entry.at >= from && entry.at < to);
      const segments = { succeeded: 0, attention: 0, cancelled: 0, running: 0, other: 0 };
      let costMicros = 0;
      for (const entry of inBucket) {
        segments[outcomeGroup(entry.agent.status)] += 1;
        const usage = entry.agent.usage && typeof entry.agent.usage === 'object' ? entry.agent.usage as Record<string, unknown> : {};
        costMicros += Number(usage.costMicros) || 0;
      }
      const at = new Date(from).toISOString();
      agentOutcomes.push({ at, label: new Date(from).toLocaleString(), tick: String(index + 1), segments });
      costSeries.push({ at, label: new Date(from).toLocaleTimeString(), tick: String(index + 1), value: costMicros / 1_000_000 });
    }
  }

  const usageByProfile = new Map<string, { profileId: string; inputTokens: number; outputTokens: number; costMicros: number }>();
  const budgetBurn: Record<string, unknown>[] = [];
  for (const agent of agents) {
    const usage = agent.usage && typeof agent.usage === 'object' ? agent.usage as Record<string, unknown> : {};
    const budget = agent.budget && typeof agent.budget === 'object' ? agent.budget as Record<string, unknown> : {};
    const profileId = String(agent.profileId ?? 'unprofiled');
    const entry = usageByProfile.get(profileId) ?? { profileId, inputTokens: 0, outputTokens: 0, costMicros: 0 };
    entry.inputTokens += Number(usage.inputTokens) || 0;
    entry.outputTokens += Number(usage.outputTokens) || 0;
    entry.costMicros += Number(usage.costMicros) || 0;
    usageByProfile.set(profileId, entry);
    if (agent.status === 'RUNNING') {
      budgetBurn.push({
        agentId: String(agent.agentId ?? ''), profileId,
        inputTokens: Number(usage.inputTokens) || 0, maxInputTokens: Number(budget.maxInputTokens) || 0,
        outputTokens: Number(usage.outputTokens) || 0, maxOutputTokens: Number(budget.maxOutputTokens) || 0,
        costMicros: Number(usage.costMicros) || 0, maxCostMicros: Number(budget.maxCostMicros) || 0
      });
    }
  }
  return {
    attention,
    running: { agents: runningAgents.length, workspaces: activeWorkspaces.length },
    // The harness retains per-agent usage, not a daily ledger, so the cost bucket names
    // the scope it actually measured instead of claiming a window it cannot prove.
    cost: { scope: 'running agents', costMicros: runningCost, agentCount: runningAgents.length },
    expiring: buckets,
    // Token and cost totals per model profile, and the burn of every running agent, so the
    // analytics view needs one request and no client-side fan-out.
    usageByProfile: [...usageByProfile.values()].sort((left, right) => right.costMicros - left.costMicros),
    budgetBurn: budgetBurn.sort((left, right) => (Number(right.costMicros) / Math.max(1, Number(right.maxCostMicros))) - (Number(left.costMicros) / Math.max(1, Number(left.maxCostMicros)))),
    // Both series cover the retained agent window only; the UI labels the scope.
    agentOutcomes,
    costSeries,
    agentSeriesScope: starts.length ? 'retained agents, bucketed by start time' : 'no agents on record',
    generatedAt: new Date(nowMs).toISOString()
  };
}

/** The only windows the metrics projection accepts; anything else is rejected. */
export const METRIC_WINDOWS: Record<string, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 };

/**
 * Metrics over retained audit events for a validated window. There is no daily cost
 * ledger, so this projection counts what is actually retained and says so in `scope`,
 * and returns the same counts as a time series so a chart never has to invent shape.
 */
export function buildMetricsProjection(input: { events?: Record<string, unknown>[]; window: string; now?: number; buckets?: number }): Record<string, unknown> {
  const span = METRIC_WINDOWS[input.window];
  if (!span) throw new Error(`unsupported metrics window: ${input.window}`);
  const nowMs = input.now ?? Date.now();
  const since = nowMs - span;
  const events = (input.events ?? []).filter((event) => {
    const at = Date.parse(String(event.createdAt ?? ''));
    return Number.isFinite(at) && at >= since;
  });
  const categories: Record<string, number> = {};
  for (const event of events) {
    const key = String(event.subjectType ?? 'other');
    categories[key] = (categories[key] ?? 0) + 1;
  }
  // A fixed number of equal buckets keeps the series comparable between windows.
  const bucketCount = Math.min(Math.max(input.buckets ?? 12, 1), 48);
  const bucketMs = span / bucketCount;
  const series = Array.from({ length: bucketCount }, (_, index) => ({
    at: new Date(since + index * bucketMs).toISOString(),
    count: 0
  }));
  for (const event of events) {
    const at = Date.parse(String(event.createdAt ?? ''));
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((at - since) / bucketMs)));
    const bucket = series[index];
    if (bucket) bucket.count += 1;
  }
  return { window: input.window, since: new Date(since).toISOString(), scope: `retained audit events in the last ${input.window}`, eventCount: events.length, categories, series };
}

/**
 * MCP reliability from gateway traces: per-server success and error counts plus the
 * p50/p95 latency of the traced calls. Only the fields the reliability answer needs
 * cross this boundary; traces carry request and response payloads that do not.
 */
export function buildReliabilityProjection(input: { traces?: Record<string, unknown>[] }): Record<string, unknown> {
  const byServer = new Map<string, { serverName: string; durations: number[]; success: number; error: number }>();
  for (const trace of input.traces ?? []) {
    const serverId = String(trace.serverId ?? 'unknown');
    const entry = byServer.get(serverId) ?? { serverName: String(trace.serverName ?? serverId), durations: [], success: 0, error: 0 };
    const duration = Number(trace.durationMs);
    if (Number.isFinite(duration)) entry.durations.push(duration);
    const status = String(trace.status ?? '').toLowerCase();
    if (status === 'error' || status === 'failed' || trace.errorCode !== undefined) entry.error += 1;
    else entry.success += 1;
    byServer.set(serverId, entry);
  }
  const percentile = (sorted: number[], fraction: number) => {
    if (!sorted.length) return undefined;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
    return sorted[index];
  };
  const servers = [...byServer.entries()].map(([serverId, entry]) => {
    const sorted = [...entry.durations].sort((left, right) => left - right);
    return {
      serverId, serverName: entry.serverName, success: entry.success, error: entry.error,
      calls: entry.success + entry.error,
      p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95)
    };
  });
  return { servers, totalCalls: servers.reduce((total, server) => total + server.calls, 0) };
}

/**
 * The Activity Center timeline, composed server-side so the browser makes one request
 * instead of merging several. Live runtime rows are labelled apart from retained ones.
 */
export function buildActivityProjection(input: { events?: Record<string, unknown>[]; agents?: Record<string, unknown>[] }): Record<string, unknown> {
  const categoryFor = (action: unknown, subjectType: unknown) => {
    const text = `${String(action ?? '')} ${String(subjectType ?? '')}`.toLowerCase();
    if (text.includes('agent')) return 'agents';
    if (text.includes('task')) return 'tasks';
    if (text.includes('mcp') || text.includes('gateway')) return 'mcp';
    if (text.includes('deploy')) return 'deployments';
    return 'audit';
  };
  const auditRows = (input.events ?? []).map((event) => ({
    at: event.createdAt, category: categoryFor(event.action, event.subjectType), status: 'recorded',
    actor: `${String(event.subjectType ?? 'subject')} ${String(event.subjectId ?? '')}`.trim(),
    summary: String(event.action ?? 'Audit event'), durable: true
  }));
  const liveRows = (input.agents ?? []).map((agent) => ({
    at: agent.startedAt ?? agent.createdAt, category: 'agents', status: String(agent.status ?? 'unknown').toLowerCase(),
    actor: String(agent.workspaceId ?? ''), summary: `Agent ${String(agent.agentId ?? '')} ${String(agent.status ?? '')}`,
    href: `/dashboard/agents/${encodeURIComponent(String(agent.agentId ?? ''))}`, durable: false
  }));
  const events = [...liveRows, ...auditRows].sort((left, right) => String(right.at ?? '').localeCompare(String(left.at ?? ''))).slice(0, 200);
  return { events };
}

export function sendRunnerResponse(response: Response, operation: DashboardResponseOperation, result: RunnerResponse): void {
  if (!result.ok) {
    const code = result.error?.code ?? 'INTERNAL_ERROR';
    const perOperation = operationMessages[operation]?.[code];
    // `LIMIT_EXCEEDED` is raised only by our own admission, quota, and reserve
    // checks, and its message carries the active count, the configured limit, and
    // the remedy. Every other code keeps the shared table so raw runner, Docker, and
    // Git error text never reaches the browser.
    const message = perOperation ?? (result.error?.message && (descriptiveOperations.has(operation) || code === 'LIMIT_EXCEEDED')
      ? result.error.message
      : (messages[code] ?? messages.INTERNAL_ERROR));
    response.status(statuses[code] ?? 500).json({ error: code.toLowerCase(), message });
    return;
  }
  response.json({ data: mapDashboardData(operation, result.data), truncated: result.truncated, ...(result.cursor ? { cursor: result.cursor } : {}) });
}
