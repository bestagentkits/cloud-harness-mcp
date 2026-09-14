import type { DatabaseSync } from 'node:sqlite';
import {
  qualifiedToolName,
  type McpGatewayPermission,
  type McpGatewaySetPermissionsInput,
  type McpGatewayServerStatus,
  type McpGatewayServerView,
  type McpGatewayToolAvailability,
  type McpGatewayToolView,
  type McpGatewayTraceStatus,
  type McpGatewayTraceView,
  type McpGatewayTransport
} from '@cloud-harness/contracts';
import { appendAudit, opaqueId, transaction } from './metadata-records.js';

/** A stored header is either a literal value or a reference to a global secret. */
export type McpGatewayStoredHeader =
  | { name: string; value: string }
  | { name: string; secretRef: string };

export type McpGatewayServerRow = {
  id: string;
  principal_id: string;
  name: string;
  description: string | null;
  transport: McpGatewayTransport;
  endpoint: string;
  headers_json: string;
  enabled: number;
  status: McpGatewayServerStatus;
  tool_count: number;
  last_connected_at: number | null;
  last_error: string | null;
  last_checked_at: number | null;
  permission_default: McpGatewayPermission;
  state: 'ACTIVE' | 'DELETED';
  generation: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

export type McpGatewayToolRow = {
  id: string;
  principal_id: string;
  server_id: string;
  upstream_name: string;
  qualified_name: string;
  description: string;
  input_schema_json: string;
  schema_bytes: number;
  annotations_json: string | null;
  availability: McpGatewayToolAvailability;
  discovered_at: number;
};

export type McpGatewayTraceRow = {
  id: string;
  principal_id: string;
  server_id: string | null;
  server_name: string;
  tool: string | null;
  operation: string;
  client_id: string | null;
  duration_ms: number;
  status: McpGatewayTraceStatus;
  error_code: string | null;
  error_message: string | null;
  request_bytes: number | null;
  response_bytes: number | null;
  created_at: number;
};

export type McpGatewayServerPatch = {
  name?: string;
  description?: string | null;
  transport?: McpGatewayTransport;
  endpoint?: string;
  headers?: McpGatewayStoredHeader[];
  permissionDefault?: McpGatewayPermission;
};

export type McpGatewayToolInput = {
  upstreamName: string;
  description: string;
  inputSchema: unknown;
  annotations: Record<string, unknown> | null;
  availability: McpGatewayToolAvailability;
  schemaBytes: number;
};

export type McpGatewayTraceInput = {
  serverId: string | null;
  serverName: string;
  tool: string | null;
  operation: string;
  clientId: string | null;
  durationMs: number;
  status: McpGatewayTraceStatus;
  errorCode: string | null;
  errorMessage: string | null;
  requestBytes: number | null;
  responseBytes: number | null;
  /**
   * Resolved credential values must never be sent to the runner. This wire field
   * exists only for runner-local tests; the API must always pass an empty array.
   */
  secrets?: string[];
};

export type McpGatewayCatalogFilter = { serverId?: string; qualifiedName?: string };
export type McpGatewayCatalog = { servers: McpGatewayServerView[]; tools: McpGatewayToolView[] };

const CREDENTIAL_HEADER_LINE = /^(\s*(?:authorization|cookie|set-cookie|x-api-key|proxy-authorization)\s*:\s*).*$/gim;
const MAX_STORED_ERROR_CHARS = 500;

/**
 * Defence in depth for the trace ledger: even if the API-side redactor missed
 * something, a credential-shaped header line never persists from the runner side.
 * Known secret values are additionally scrubbed in raw, base64, hex, and
 * percent-encoded forms when the caller knows them.
 */
export function scrubCredentialText(text: string, secrets: string[] = []): string {
  let out = text.replace(CREDENTIAL_HEADER_LINE, '$1[REDACTED]');
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    for (const form of secretForms(secret)) forms.add(form);
  }
  for (const form of [...forms].sort((left, right) => right.length - left.length)) {
    out = out.split(form).join('[REDACTED_SECRET]');
  }
  return out;
}

/** Every encoded shape a credential can take in an upstream error or log line. */
function secretForms(secret: string): string[] {
  const bytes = Buffer.from(secret, 'utf8');
  const percent = encodeURIComponent(secret);
  return [
    secret,
    bytes.toString('base64'),
    bytes.toString('base64url'),
    bytes.toString('hex'),
    bytes.toString('hex').toUpperCase(),
    percent,
    percent.toLowerCase()
  ].filter((form) => form.length >= 4);
}

function parseHeaders(raw: string): McpGatewayStoredHeader[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is McpGatewayStoredHeader => {
      if (!entry || typeof entry !== 'object') return false;
      const candidate = entry as { name?: unknown; value?: unknown; secretRef?: unknown };
      if (typeof candidate.name !== 'string') return false;
      return typeof candidate.value === 'string' || typeof candidate.secretRef === 'string';
    });
  } catch {
    return [];
  }
}

function serializeHeaders(headers: McpGatewayStoredHeader[]): string {
  return JSON.stringify(headers.map((header) => (
    'secretRef' in header
      ? { name: header.name, secretRef: header.secretRef }
      : { name: header.name, value: header.value }
  )));
}

function headerView(header: McpGatewayStoredHeader): McpGatewayServerView['headers'][number] {
  return 'secretRef' in header
    ? { name: header.name, kind: 'secret' as const, secretRef: header.secretRef }
    : { name: header.name, kind: 'literal' as const, value: header.value };
}

export function mcpGatewayServerView(row: McpGatewayServerRow): McpGatewayServerView {
  return {
    id: row.id,
    principalId: row.principal_id,
    name: row.name,
    description: row.description ?? null,
    transport: row.transport,
    endpoint: row.endpoint,
    headers: parseHeaders(row.headers_json).map(headerView),
    enabled: row.enabled === 1,
    status: row.status,
    toolCount: row.tool_count,
    lastConnectedAt: row.last_connected_at ?? null,
    lastError: row.last_error ?? null,
    lastCheckedAt: row.last_checked_at ?? null,
    permissionDefault: row.permission_default,
    generation: row.generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mcpGatewayToolView(row: McpGatewayToolRow, permission: McpGatewayPermission): McpGatewayToolView {
  let inputSchema: unknown;
  try {
    inputSchema = JSON.parse(row.input_schema_json);
  } catch {
    inputSchema = { type: 'object' };
  }
  let annotations: Record<string, unknown> | null = null;
  if (row.annotations_json) {
    try {
      const parsed: unknown = JSON.parse(row.annotations_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) annotations = parsed as Record<string, unknown>;
    } catch {
      annotations = null;
    }
  }
  return {
    id: row.id,
    principalId: row.principal_id,
    serverId: row.server_id,
    serverName: row.qualified_name.slice(0, row.qualified_name.indexOf('.')),
    qualifiedName: row.qualified_name,
    upstreamName: row.upstream_name,
    description: row.description,
    inputSchema,
    annotations,
    availability: row.availability,
    permission,
    discoveredAt: row.discovered_at
  };
}

export function mcpGatewayTraceView(row: McpGatewayTraceRow): McpGatewayTraceView {
  return {
    id: row.id,
    principalId: row.principal_id,
    serverId: row.server_id ?? null,
    serverName: row.server_name,
    tool: row.tool ?? null,
    operation: row.operation,
    clientId: row.client_id ?? null,
    durationMs: row.duration_ms,
    status: row.status,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    requestBytes: row.request_bytes ?? null,
    responseBytes: row.response_bytes ?? null,
    createdAt: row.created_at
  };
}

export class McpGatewayStore {
  constructor(readonly database: DatabaseSync) {}

  listServers(principalId: string): McpGatewayServerView[] {
    const rows = this.database.prepare(
      "SELECT * FROM mcp_gateway_servers WHERE principal_id = ? AND state = 'ACTIVE' ORDER BY updated_at DESC, id"
    ).all(principalId) as McpGatewayServerRow[];
    return rows.map(mcpGatewayServerView);
  }

  getServer(principalId: string, serverId: string): McpGatewayServerView | undefined {
    const row = this.serverRow(principalId, serverId);
    return row ? mcpGatewayServerView(row) : undefined;
  }

  createServer(
    principalId: string,
    input: {
      name: string;
      description?: string | undefined;
      transport: McpGatewayTransport;
      endpoint: string;
      headers: McpGatewayStoredHeader[];
      permissionDefault: McpGatewayPermission;
      enabled: boolean;
    },
    expectedGeneration: 0
  ): McpGatewayServerView | undefined {
    if (expectedGeneration !== 0) return undefined;
    return transaction(this.database, () => {
      if (this.database.prepare('SELECT 1 FROM mcp_gateway_servers WHERE principal_id = ? AND name = ?').get(principalId, input.name)) {
        return undefined;
      }
      const id = opaqueId('mcps');
      const now = Date.now();
      this.database.prepare(`INSERT INTO mcp_gateway_servers
        (id, principal_id, name, description, transport, endpoint, headers_json, enabled, status, tool_count,
         last_connected_at, last_error, last_checked_at, permission_default, state, generation, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?, 'ACTIVE', 1, ?, ?, NULL)`).run(
        id, principalId, input.name, input.description ?? null, input.transport, input.endpoint,
        serializeHeaders(input.headers), input.enabled ? 1 : 0,
        input.enabled ? 'unknown' : 'disabled', input.permissionDefault, now, now
      );
      appendAudit(this.database, principalId, 'mcp_server.created', 'mcp_server', id, 1, { transport: input.transport }, now);
      return this.getServer(principalId, id);
    });
  }

  updateServer(
    principalId: string,
    serverId: string,
    expectedGeneration: number,
    patch: McpGatewayServerPatch
  ): McpGatewayServerView | undefined {
    return transaction(this.database, () => {
      const current = this.serverRow(principalId, serverId);
      if (!current || current.state !== 'ACTIVE' || current.generation !== expectedGeneration) return undefined;
      const now = Date.now();
      const nextName = patch.name;
      const changedName = nextName !== undefined && nextName !== current.name;
      if (changedName && nextName !== undefined && this.database.prepare(
        'SELECT 1 FROM mcp_gateway_servers WHERE principal_id = ? AND name = ? AND id != ?'
      ).get(principalId, nextName, serverId)) {
        return undefined;
      }
      const result = this.database.prepare(`UPDATE mcp_gateway_servers
        SET name = ?, description = ?, transport = ?, endpoint = ?, headers_json = ?, permission_default = ?,
            generation = generation + 1, updated_at = ?
        WHERE principal_id = ? AND id = ? AND generation = ? AND state = 'ACTIVE'`).run(
        patch.name ?? current.name,
        patch.description === undefined ? current.description : patch.description,
        patch.transport ?? current.transport,
        patch.endpoint ?? current.endpoint,
        patch.headers ? serializeHeaders(patch.headers) : current.headers_json,
        patch.permissionDefault ?? current.permission_default,
        now, principalId, serverId, expectedGeneration
      );
      if (result.changes !== 1) return undefined;
      if (changedName && nextName !== undefined) {
        // Keep the cached catalog consistent with the identity the model was handed.
        this.database.prepare(`UPDATE mcp_gateway_tools
          SET qualified_name = ? || '.' || upstream_name
          WHERE principal_id = ? AND server_id = ?`).run(nextName, principalId, serverId);
      }
      appendAudit(this.database, principalId, 'mcp_server.updated', 'mcp_server', serverId, expectedGeneration + 1, {}, now);
      return this.getServer(principalId, serverId);
    });
  }

  setEnabled(
    principalId: string,
    serverId: string,
    enabled: boolean,
    expectedGeneration: number
  ): McpGatewayServerView | undefined {
    return transaction(this.database, () => {
      const current = this.serverRow(principalId, serverId);
      if (!current || current.state !== 'ACTIVE' || current.generation !== expectedGeneration) return undefined;
      const now = Date.now();
      const status: McpGatewayServerStatus = enabled
        ? (current.status === 'disabled' ? 'unknown' : current.status)
        : 'disabled';
      const result = this.database.prepare(`UPDATE mcp_gateway_servers
        SET enabled = ?, status = ?, generation = generation + 1, updated_at = ?
        WHERE principal_id = ? AND id = ? AND generation = ? AND state = 'ACTIVE'`).run(
        enabled ? 1 : 0, status, now, principalId, serverId, expectedGeneration
      );
      if (result.changes !== 1) return undefined;
      appendAudit(this.database, principalId, enabled ? 'mcp_server.enabled' : 'mcp_server.disabled', 'mcp_server', serverId, expectedGeneration + 1, {}, now);
      return this.getServer(principalId, serverId);
    });
  }

  setPermissions(principalId: string, input: McpGatewaySetPermissionsInput): McpGatewayServerView | undefined {
    return transaction(this.database, () => {
      const current = this.serverRow(principalId, input.serverId);
      if (!current || current.state !== 'ACTIVE' || current.generation !== input.expectedGeneration) return undefined;
      const now = Date.now();
      this.database.prepare('DELETE FROM mcp_gateway_tool_permissions WHERE principal_id = ? AND server_id = ?')
        .run(principalId, input.serverId);
      const insert = this.database.prepare(`INSERT INTO mcp_gateway_tool_permissions
        (principal_id, server_id, tool_name, permission) VALUES (?, ?, ?, ?)`);
      for (const tool of input.tools) insert.run(principalId, input.serverId, tool.name, tool.permission);
      const result = this.database.prepare(`UPDATE mcp_gateway_servers
        SET permission_default = ?, generation = generation + 1, updated_at = ?
        WHERE principal_id = ? AND id = ? AND generation = ? AND state = 'ACTIVE'`).run(
        input.permissionDefault, now, principalId, input.serverId, input.expectedGeneration
      );
      if (result.changes !== 1) throw new Error('mcp server generation changed during permission update');
      appendAudit(this.database, principalId, 'mcp_policy.updated', 'mcp_server', input.serverId, input.expectedGeneration + 1, {
        default: input.permissionDefault,
        overrides: input.tools.length
      }, now);
      return this.getServer(principalId, input.serverId);
    });
  }

  deleteServer(principalId: string, serverId: string, expectedGeneration: number): McpGatewayServerView | undefined {
    return transaction(this.database, () => {
      const current = this.serverRow(principalId, serverId);
      if (!current || current.state !== 'ACTIVE' || current.generation !== expectedGeneration) return undefined;
      const now = Date.now();
      const result = this.database.prepare(`UPDATE mcp_gateway_servers
        SET state = 'DELETED', enabled = 0, status = 'disabled', generation = generation + 1, updated_at = ?, deleted_at = ?
        WHERE principal_id = ? AND id = ? AND generation = ? AND state = 'ACTIVE'`).run(
        now, now, principalId, serverId, expectedGeneration
      );
      if (result.changes !== 1) return undefined;
      // Deleting a server deletes its cached tools, overrides, and recorded logs:
      // no orphaned traces, and a reused identifier cannot resurface old history.
      this.database.prepare('DELETE FROM mcp_gateway_tools WHERE principal_id = ? AND server_id = ?').run(principalId, serverId);
      this.database.prepare('DELETE FROM mcp_gateway_tool_permissions WHERE principal_id = ? AND server_id = ?').run(principalId, serverId);
      this.database.prepare('DELETE FROM mcp_gateway_traces WHERE principal_id = ? AND server_id = ?').run(principalId, serverId);
      appendAudit(this.database, principalId, 'mcp_server.deleted', 'mcp_server', serverId, expectedGeneration + 1, {}, now);
      return { ...mcpGatewayServerView({ ...current, state: 'DELETED', enabled: 0, status: 'disabled', generation: current.generation + 1, updated_at: now, deleted_at: now }) };
    });
  }

  /**
   * Replace the cached catalog for one server. Tools beyond `cap` are retained as
   * `unavailable` rows with an explicit description rather than silently dropped, so
   * `tool_count` and `status` stay honest about what the upstream actually serves.
   */
  replaceTools(
    principalId: string,
    serverId: string,
    tools: McpGatewayToolInput[],
    cap: number,
    status: McpGatewayServerStatus = 'connected'
  ): McpGatewayToolView[] {
    return transaction(this.database, () => {
      const current = this.serverRow(principalId, serverId);
      if (!current || current.state !== 'ACTIVE') return [];
      const now = Date.now();
      this.database.prepare('DELETE FROM mcp_gateway_tools WHERE principal_id = ? AND server_id = ?').run(principalId, serverId);
      const insert = this.database.prepare(`INSERT INTO mcp_gateway_tools
        (id, principal_id, server_id, upstream_name, qualified_name, description, input_schema_json, schema_bytes,
         annotations_json, availability, discovered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const boundedCap = Math.max(1, cap);
      for (const [index, tool] of tools.entries()) {
        const withinCap = index < boundedCap;
        insert.run(
          opaqueId('mcpt'), principalId, serverId, tool.upstreamName,
          qualifiedToolName(current.name, tool.upstreamName),
          withinCap ? tool.description : 'tool omitted: per-server tool limit reached',
          JSON.stringify(tool.inputSchema ?? { type: 'object' }), tool.schemaBytes,
          tool.annotations ? JSON.stringify(tool.annotations) : null,
          withinCap ? tool.availability : 'unavailable', now
        );
      }
      this.database.prepare(`UPDATE mcp_gateway_servers
        SET tool_count = ?, status = ?, last_error = ?, last_checked_at = ?,
            last_connected_at = CASE WHEN ? = 'connected' THEN ? ELSE last_connected_at END,
            updated_at = ?
        WHERE principal_id = ? AND id = ?`).run(
        tools.length, status,
        status === 'connected' ? null : current.last_error,
        now, status, now, now, principalId, serverId
      );
      return this.listTools(principalId, serverId);
    });
  }

  recordConnectionResult(
    principalId: string,
    serverId: string,
    status: McpGatewayServerStatus,
    error: string | null
  ): McpGatewayServerView | undefined {
    return transaction(this.database, () => {
      const current = this.serverRow(principalId, serverId);
      if (!current || current.state !== 'ACTIVE') return undefined;
      const now = Date.now();
      const sanitized = error ? scrubCredentialText(error).slice(0, MAX_STORED_ERROR_CHARS) : null;
      this.database.prepare(`UPDATE mcp_gateway_servers
        SET status = ?, last_error = ?, last_checked_at = ?,
            last_connected_at = CASE WHEN ? = 'connected' THEN ? ELSE last_connected_at END,
            updated_at = ?
        WHERE principal_id = ? AND id = ?`).run(
        status, sanitized, now, status, now, now, principalId, serverId
      );
      return this.getServer(principalId, serverId);
    });
  }

  listTools(principalId: string, serverId?: string): McpGatewayToolView[] {
    const rows = (serverId
      ? this.database.prepare('SELECT * FROM mcp_gateway_tools WHERE principal_id = ? AND server_id = ? ORDER BY upstream_name')
          .all(principalId, serverId)
      : this.database.prepare('SELECT * FROM mcp_gateway_tools WHERE principal_id = ? ORDER BY qualified_name')
          .all(principalId)) as McpGatewayToolRow[];
    const overrides = this.permissionOverrides(principalId);
    const defaults = this.permissionDefaults(principalId);
    return rows.map((row) => mcpGatewayToolView(
      row,
      this.decide(row.server_id, row.upstream_name, overrides, defaults.get(row.server_id) ?? 'deny')
    ));
  }

  getTool(principalId: string, qualifiedName: string): McpGatewayToolView | undefined {
    const row = this.database.prepare('SELECT * FROM mcp_gateway_tools WHERE principal_id = ? AND qualified_name = ?')
      .get(principalId, qualifiedName) as McpGatewayToolRow | undefined;
    if (!row) return undefined;
    return mcpGatewayToolView(row, this.effectivePermission(principalId, row.server_id, row.upstream_name));
  }

  getServerTools(principalId: string, serverId: string): McpGatewayToolView[] {
    return this.listTools(principalId, serverId);
  }

  catalog(principalId: string, filter: McpGatewayCatalogFilter = {}): McpGatewayCatalog {
    const servers = filter.serverId
      ? [this.getServer(principalId, filter.serverId)].filter((server): server is McpGatewayServerView => Boolean(server))
      : this.listServers(principalId);
    if (filter.qualifiedName) {
      const tool = this.getTool(principalId, filter.qualifiedName);
      return { servers, tools: tool ? [tool] : [] };
    }
    const tools = filter.serverId
      ? this.listTools(principalId, filter.serverId)
      : this.listTools(principalId);
    return { servers, tools };
  }

  effectivePermission(principalId: string, serverId: string, toolName: string): McpGatewayPermission {
    const server = this.serverRow(principalId, serverId);
    if (!server) return 'deny';
    return this.decide(serverId, toolName, this.permissionOverrides(principalId), server.permission_default);
  }

  appendTrace(principalId: string, input: McpGatewayTraceInput, maxRows: number): McpGatewayTraceView {
    return transaction(this.database, () => {
      const id = opaqueId('mcpg');
      const now = Date.now();
      const message = input.errorMessage
        ? scrubCredentialText(input.errorMessage, input.secrets ?? []).slice(0, MAX_STORED_ERROR_CHARS)
        : null;
      this.database.prepare(`INSERT INTO mcp_gateway_traces
        (id, principal_id, server_id, server_name, tool, operation, client_id, duration_ms, status,
         error_code, error_message, request_bytes, response_bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, principalId, input.serverId, input.serverName, input.tool, input.operation, input.clientId,
        input.durationMs, input.status, input.errorCode, message, input.requestBytes, input.responseBytes, now
      );
      // Order by rowid as the tie-break so a row inserted in the same millisecond as
      // its neighbours is never pruned before the caller reads it back.
      this.database.prepare(`DELETE FROM mcp_gateway_traces
        WHERE principal_id = ? AND rowid NOT IN (
          SELECT rowid FROM mcp_gateway_traces WHERE principal_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
        )`).run(principalId, principalId, maxRows);
      const row = this.database.prepare('SELECT * FROM mcp_gateway_traces WHERE id = ?').get(id) as McpGatewayTraceRow;
      return mcpGatewayTraceView(row);
    });
  }

  listTraces(
    principalId: string,
    options: { serverId?: string; limit: number; cursor?: string }
  ): { traces: McpGatewayTraceView[]; cursor?: string } {
    const clauses = ['principal_id = ?'];
    const parameters: (string | number)[] = [principalId];
    if (options.serverId) {
      clauses.push('server_id = ?');
      parameters.push(options.serverId);
    }
    const cursor = parseTraceCursor(options.cursor);
    if (cursor) {
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
      parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const rows = this.database.prepare(
      `SELECT * FROM mcp_gateway_traces WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`
    ).all(...parameters, options.limit) as McpGatewayTraceRow[];
    const traces = rows.map(mcpGatewayTraceView);
    const last = traces.at(-1);
    return {
      traces,
      ...(traces.length === options.limit && last ? { cursor: formatTraceCursor(last.createdAt, last.id) } : {})
    };
  }

  private serverRow(principalId: string, serverId: string): McpGatewayServerRow | undefined {
    return this.database.prepare("SELECT * FROM mcp_gateway_servers WHERE principal_id = ? AND id = ? AND state = 'ACTIVE'")
      .get(principalId, serverId) as McpGatewayServerRow | undefined;
  }

  private permissionOverrides(principalId: string): Map<string, McpGatewayPermission> {
    const rows = this.database.prepare('SELECT server_id, tool_name, permission FROM mcp_gateway_tool_permissions WHERE principal_id = ?')
      .all(principalId) as { server_id: string; tool_name: string; permission: McpGatewayPermission }[];
    return new Map(rows.map((row) => [`${row.server_id}\u0000${row.tool_name}`, row.permission]));
  }

  /**
   * Effective permission needs the owning server's default for tools without an
   * override. `listTools` maps every cached tool, so it resolves the defaults for
   * the principal's active servers once instead of falling back to `deny`.
   */
  private permissionDefaults(principalId: string): Map<string, McpGatewayPermission> {
    const rows = this.database.prepare(
      "SELECT id, permission_default FROM mcp_gateway_servers WHERE principal_id = ? AND state = 'ACTIVE'"
    ).all(principalId) as { id: string; permission_default: McpGatewayPermission }[];
    return new Map(rows.map((row) => [row.id, row.permission_default]));
  }

  private decide(
    serverId: string,
    toolName: string,
    overrides: Map<string, McpGatewayPermission>,
    serverDefault: McpGatewayPermission = 'deny'
  ): McpGatewayPermission {
    return overrides.get(`${serverId}\u0000${toolName}`) ?? serverDefault;
  }
}

function formatTraceCursor(createdAt: number, id: string): string {
  return `${createdAt}.${id}`;
}

function parseTraceCursor(cursor: string | undefined): { createdAt: number; id: string } | undefined {
  if (!cursor) return undefined;
  const separator = cursor.indexOf('.');
  if (separator <= 0) return undefined;
  const createdAt = Number(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  if (!Number.isInteger(createdAt) || !id) return undefined;
  return { createdAt, id };
}
