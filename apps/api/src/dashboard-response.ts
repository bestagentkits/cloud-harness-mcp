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

export const DASHBOARD_RESPONSE_OPERATIONS = [
  'workspace_open',
  'workspace_list',
  'workspace_status',
  'workspace_detail',
  'workspace_close',
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
  'mcp_gateway_catalog', 'mcp_gateway_trace_append', 'mcp_gateway_trace_list'
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

export function mapDashboardData(operation: DashboardResponseOperation, value: unknown): unknown {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (operation === 'workspace_list') {
    const workspaces = Array.isArray(data.workspaces) ? data.workspaces.map(cleanWorkspace) : [];
    return { workspaces };
  }
  if (operation === 'workspace_open' || operation === 'workspace_status' || operation === 'workspace_detail' || operation === 'workspace_close') return cleanWorkspace(data);
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
  'mcp_server_list', 'mcp_server_get', 'mcp_gateway_trace_list'
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
  settings_network_check: { UNAVAILABLE: 'The egress readiness check is temporarily unavailable.' }
};

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
