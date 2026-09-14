import {
  HarnessError,
  McpGatewayQualifiedToolNameSchema,
  type ErrorCode,
  type McpGatewayResolvedCredentials,
  type McpGatewayServerView,
  type McpGatewayToolView,
  type RunnerPrincipalSelector,
  type RunnerResponse,
  type ToolResult
} from '@cloud-harness/contracts';
import type { Tool } from '@modelcontextprotocol/client';
import type { RunnerClient } from '../runner-client.js';
import type { GatewayConnectionManager } from './connection-manager.js';
import {
  assertCatalogWithinLimit,
  filterSearchable,
  gatewayToolSchemaBytes,
  normalizeUpstreamTools,
  searchTools
} from './catalog.js';
import { redactGatewayError, sanitizeGatewayText } from './redaction.js';
import type { GatewayCatalogFilter, GatewayUpstreamTool } from './types.js';

/**
 * The gateway service owns every meta-tool decision: catalog reads, progressive
 * disclosure, permission enforcement, credential scoping, downstream routing, and
 * trace recording. The runner stays the sole permission authority — the API only
 * ever filters on the effective `permission` the runner persisted.
 *
 * Three invariants are load-bearing and covered by tests:
 * - `inspect` and `execute` load the catalog with a filter, so one meta-tool call
 *   never transfers the whole fleet;
 * - a resolved credential only ever travels from the runner into a single
 *   `tools/call` request, and never into a tool result, a trace, or an error;
 * - the `execute` credential purpose is never used on the discovery path, and the
 *   `connect` purpose is never used to run a tool.
 */

export type McpGatewayServiceOptions = {
  timeoutMs: number;
  maxResponseBytes: number;
  maxToolsPerServer: number;
  maxSchemaBytes: number;
  maxCatalogBytes: number;
  maxTraceRows?: number;
  catalogTtlMs?: number;
  now?: () => number;
};

export type McpGatewayCallContext = { signal?: AbortSignal; clientId?: string };

export type McpGatewayTraceEntry = {
  serverId: string | null;
  serverName: string;
  tool: string | null;
  operation: string;
  clientId: string | null;
  durationMs: number;
  status: 'success' | 'error' | 'denied';
  errorCode: string | null;
  errorMessage: string | null;
  requestBytes: number | null;
  responseBytes: number | null;
};

type CatalogView = { servers: McpGatewayServerView[]; tools: McpGatewayToolView[] };

type CacheEntry = { value: CatalogView; expiresAt: number };

type TraceContext = {
  operation: string;
  serverName: string;
  serverId: string | null;
  tool: string | null;
  clientId: string | null;
  started: number;
  requestBytes?: number | null;
  secrets?: string[];
};

const DEFAULT_CATALOG_TTL_MS = 5_000;
const DEFAULT_MAX_TRACE_ROWS = 20_000;
const UNKNOWN_TOOL_MESSAGE = 'unknown or inaccessible MCP tool';
const DENIED_MESSAGE = 'the MCP tool is not permitted for this principal';
const MAX_TRACE_SECRETS = 8;

function bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

/** The resolved header values a trace write is allowed to scrub, bounded and never logged. */
function credentialValues(headers: Record<string, string> | undefined): string[] {
  if (!headers) return [];
  const values: string[] = [];
  for (const value of Object.values(headers)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    values.push(value);
    if (values.length >= MAX_TRACE_SECRETS) break;
  }
  return values;
}

/**
 * Sanitizes every string leaf of a downstream result value, including nested text,
 * while preserving structure and non-string leaves. Applied to both `content` and
 * `structuredContent` so a credential a downstream echoes back never reaches the
 * caller.
 */
function sanitizeGatewayValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') return sanitizeGatewayText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => sanitizeGatewayValue(entry, secrets));
  if (value !== null && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) sanitized[key] = sanitizeGatewayValue(entry, secrets);
    return sanitized;
  }
  return value;
}

function ok(data: unknown, message: string): ToolResult {
  return { ok: true, message, data, truncated: false };
}

function failure(code: ErrorCode, message: string, retryable = false): ToolResult {
  return { ok: false, message, error: { code, message, retryable }, truncated: false };
}

/**
 * The call-path definition handed to `Client.callTool`. `outputSchema` is
 * deliberately absent: the SDK refuses a text-only result (`isError` falsy,
 * `structuredContent` undefined) for any tool that declares an output schema, and
 * that guard sits outside the permissive-validator seam. An explicit
 * `toolDefinition` takes precedence over the cached `tools/list` entry, so this
 * skips the output validator while `inputSchema` still drives `x-mcp-header`
 * resolution. It is never stored or advertised — the catalog view is untouched.
 */
type CallPathToolDefinition = Omit<Tool, 'outputSchema'> & { outputSchema?: undefined };

function callPathToolDefinition(tool: McpGatewayToolView): CallPathToolDefinition {
  return {
    name: tool.upstreamName,
    description: tool.description,
    inputSchema: tool.inputSchema as Tool['inputSchema'],
    ...(tool.annotations === null
      ? {}
      : { annotations: tool.annotations as unknown as NonNullable<Tool['annotations']> }),
    outputSchema: undefined
  };
}

export class McpGatewayService {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxToolsPerServer: number;
  private readonly maxSchemaBytes: number;
  private readonly maxCatalogBytes: number;
  private readonly maxTraceRows: number;
  private readonly catalogTtlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly runner: RunnerClient,
    private readonly connections: GatewayConnectionManager,
    options: McpGatewayServiceOptions
  ) {
    this.timeoutMs = Math.max(1, options.timeoutMs);
    this.maxResponseBytes = Math.max(1, options.maxResponseBytes);
    this.maxToolsPerServer = Math.max(1, options.maxToolsPerServer);
    this.maxSchemaBytes = Math.max(1, options.maxSchemaBytes);
    this.maxCatalogBytes = Math.max(1, options.maxCatalogBytes);
    this.maxTraceRows = Math.max(100, options.maxTraceRows ?? DEFAULT_MAX_TRACE_ROWS);
    this.catalogTtlMs = Math.max(0, options.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS);
    this.now = options.now ?? (() => Date.now());
  }

  /** Drops every cached catalog view for one principal after a registry mutation. */
  invalidateCatalog(principal: RunnerPrincipalSelector): void {
    const prefix = `${this.principalKey(principal)}\u0001`;
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  /**
   * Evicts the cached downstream connection for one server. Phase 4 calls this
   * alongside `invalidateCatalog` after any registry mutation or server deletion,
   * so a rotated credential or changed endpoint cannot ride a stale connection.
   */
  invalidateConnection(serverId: string): void {
    this.connections.invalidate(serverId);
  }

  async close(): Promise<void> {
    await this.connections.closeAll();
  }

  async search(
    principal: RunnerPrincipalSelector,
    input: { query: string; server?: string | undefined; limit: number },
    context: McpGatewayCallContext = {}
  ): Promise<ToolResult> {
    const started = this.now();
    try {
      const catalog = await this.loadCatalog(principal, {}, context.signal);
      assertCatalogWithinLimit(catalog, this.maxCatalogBytes);
      const matches = searchTools(filterSearchable(catalog), input.query, {
        ...(input.server ? { server: input.server } : {}),
        limit: input.limit
      });
      const results = matches.map((match) => ({
        tool: match.tool.qualifiedName,
        server: match.tool.serverName,
        description: match.tool.description,
        score: match.score
      }));
      await this.trace(principal, {
        serverId: null,
        serverName: '*',
        tool: null,
        operation: 'search',
        clientId: context.clientId ?? null,
        durationMs: Math.max(0, this.now() - started),
        status: 'success',
        errorCode: null,
        errorMessage: null,
        requestBytes: bytes(input.query),
        responseBytes: bytes(results)
      });
      return ok({ results }, `Found ${results.length} matching MCP tool(s)`);
    } catch (error) {
      return await this.fail(principal, error, {
        operation: 'search',
        serverName: '*',
        serverId: null,
        tool: null,
        clientId: context.clientId ?? null,
        started,
        requestBytes: bytes(input.query)
      });
    }
  }

  async inspect(
    principal: RunnerPrincipalSelector,
    input: { tool: string },
    context: McpGatewayCallContext = {}
  ): Promise<ToolResult> {
    const started = this.now();
    try {
      const { tool, server } = await this.resolveTool(principal, input.tool, context.signal);
      const data = {
        name: tool.qualifiedName,
        server: server.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        permission: tool.permission,
        availability: tool.availability
      };
      await this.trace(principal, {
        serverId: tool.serverId,
        serverName: tool.serverName,
        tool: tool.qualifiedName,
        operation: 'inspect',
        clientId: context.clientId ?? null,
        durationMs: Math.max(0, this.now() - started),
        status: 'success',
        errorCode: null,
        errorMessage: null,
        requestBytes: bytes(input.tool),
        responseBytes: bytes(data)
      });
      return ok(data, `Inspected MCP tool ${tool.qualifiedName}`);
    } catch (error) {
      return await this.fail(principal, error, {
        operation: 'inspect',
        serverName: '*',
        serverId: null,
        tool: input.tool,
        clientId: context.clientId ?? null,
        started,
        requestBytes: bytes(input.tool)
      });
    }
  }

  async execute(
    principal: RunnerPrincipalSelector,
    input: { tool: string; arguments: Record<string, unknown> },
    context: McpGatewayCallContext = {}
  ): Promise<ToolResult> {
    const started = this.now();
    let server: McpGatewayServerView | undefined;
    let secrets: string[] = [];
    try {
      const { tool, server: resolved } = await this.resolveTool(principal, input.tool, context.signal);
      server = resolved;
      if (tool.availability === 'unavailable') throw new HarnessError('INVALID_INPUT', 'tool is unavailable', 400, false);

      const response = await this.runner.callInternal(
        'mcp_server_get_credentials',
        { serverId: server.id, toolName: tool.upstreamName, purpose: 'execute' },
        principal,
        context.signal
      );
      const credentials = this.credentialsOf(response);
      if (credentials?.allowed !== true) {
        await this.trace(principal, {
          serverId: server.id,
          serverName: server.name,
          tool: tool.qualifiedName,
          operation: 'execute',
          clientId: context.clientId ?? null,
          durationMs: Math.max(0, this.now() - started),
          status: 'denied',
          errorCode: 'FORBIDDEN',
          errorMessage: DENIED_MESSAGE,
          requestBytes: bytes(input.arguments),
          responseBytes: null
        });
        return ok(
          { tool: tool.qualifiedName, server: server.name, allowed: false, reason: credentials?.reason ?? 'tool_denied' },
          'MCP tool access denied'
        );
      }

      secrets = credentialValues(credentials.headers);
      const target: McpGatewayServerView = credentials.endpoint
        ? { ...server, endpoint: credentials.endpoint }
        : server;
      const result = await this.connections.withConnection(
        target,
        credentials.headers ?? {},
        (client) =>
          client.callTool(
            { name: tool.upstreamName, arguments: input.arguments },
            {
              timeout: this.timeoutMs,
              toolDefinition: callPathToolDefinition(tool),
              ...(context.signal ? { signal: context.signal } : {})
            }
          ),
        context.signal
      );
      const data = {
        content: sanitizeGatewayValue(result.content ?? [], secrets),
        structuredContent: sanitizeGatewayValue(result.structuredContent, secrets),
        isError: Boolean(result.isError)
      };
      await this.trace(principal, {
        serverId: server.id,
        serverName: server.name,
        tool: tool.qualifiedName,
        operation: 'execute',
        clientId: context.clientId ?? null,
        durationMs: Math.max(0, this.now() - started),
        status: result.isError ? 'error' : 'success',
        errorCode: result.isError ? 'EXECUTION_FAILED' : null,
        errorMessage: result.isError ? 'the downstream MCP tool reported an error' : null,
        requestBytes: bytes(input.arguments),
        responseBytes: bytes(data)
      });
      return ok(data, `Executed MCP tool ${tool.qualifiedName}`);
    } catch (error) {
      return await this.fail(principal, error, {
        operation: 'execute',
        serverName: server?.name ?? '*',
        serverId: server?.id ?? null,
        tool: input.tool,
        clientId: context.clientId ?? null,
        started,
        requestBytes: bytes(input.arguments),
        secrets
      });
    }
  }

  async permissions(
    principal: RunnerPrincipalSelector,
    input: { tool?: string | undefined; server?: string | undefined },
    context: McpGatewayCallContext = {}
  ): Promise<ToolResult> {
    const started = this.now();
    try {
      if (input.tool) {
        const catalog = await this.loadCatalog(principal, { qualifiedName: input.tool }, context.signal);
        const tool = catalog.tools.find((candidate) => candidate.qualifiedName === input.tool);
        const server = tool ? catalog.servers.find((candidate) => candidate.id === tool.serverId) : undefined;
        // `inspect` and `execute` treat a disabled server as inaccessible; `permissions`
        // must not report `allow` for a tool that cannot run.
        const reason = tool === undefined
          ? 'tool_unknown'
          : !server || !server.enabled
            ? 'server_disabled'
            : tool.permission !== 'allow'
              ? 'tool_denied'
              : undefined;
        return ok(
          { tool: input.tool, allowed: reason === undefined, ...(reason ? { reason } : {}) },
          'MCP tool permission resolved'
        );
      }
      if (input.server) {
        const servers = (await this.loadCatalog(principal, {}, context.signal)).servers;
        const server = servers.find((candidate) => candidate.name === input.server);
        if (!server) throw new HarnessError('NOT_FOUND', 'unknown or inaccessible MCP server', 404, false);
        const serverCatalog = await this.loadCatalog(principal, { serverId: server.id }, context.signal);
        return ok(
          {
            server: server.name,
            permissionDefault: server.permissionDefault,
            tools: serverCatalog.tools.map((tool) => ({ name: tool.qualifiedName, permission: tool.permission }))
          },
          'MCP server permissions resolved'
        );
      }
      const servers = (await this.loadCatalog(principal, {}, context.signal)).servers;
      return ok(
        { servers: servers.map((server) => ({ name: server.name, permissionDefault: server.permissionDefault })) },
        'MCP server permissions listed'
      );
    } catch (error) {
      return await this.fail(principal, error, {
        operation: 'permissions',
        serverName: input.server ?? '*',
        serverId: null,
        tool: input.tool ?? null,
        clientId: context.clientId ?? null,
        started
      });
    }
  }

  async status(principal: RunnerPrincipalSelector, context: McpGatewayCallContext = {}): Promise<ToolResult> {
    const started = this.now();
    try {
      const catalog = await this.loadCatalog(principal, {}, context.signal);
      const servers = catalog.servers.map((server) => ({
        server: server.name,
        enabled: server.enabled,
        connection: this.reconcileConnection(server),
        toolCount: catalog.tools.filter((tool) => tool.serverId === server.id).length,
        lastConnectedAt: server.lastConnectedAt,
        lastCheckedAt: server.lastCheckedAt,
        error: server.lastError
      }));
      return ok({ servers }, `Reported ${servers.length} MCP server(s)`);
    } catch (error) {
      return await this.fail(principal, error, {
        operation: 'status',
        serverName: '*',
        serverId: null,
        tool: null,
        clientId: context.clientId ?? null,
        started
      });
    }
  }

  async refreshServer(
    principal: RunnerPrincipalSelector,
    serverId: string,
    context: McpGatewayCallContext = {}
  ): Promise<ToolResult> {
    return await this.discoverServer(principal, serverId, context, 'refresh');
  }

  async testServer(
    principal: RunnerPrincipalSelector,
    serverId: string,
    context: McpGatewayCallContext = {}
  ): Promise<ToolResult> {
    return await this.discoverServer(principal, serverId, context, 'test');
  }

  private async discoverServer(
    principal: RunnerPrincipalSelector,
    serverId: string,
    context: McpGatewayCallContext,
    kind: 'refresh' | 'test'
  ): Promise<ToolResult> {
    const started = this.now();
    let server: McpGatewayServerView | undefined;
    try {
      server = (await this.loadCatalog(principal, { serverId }, context.signal)).servers.find(
        (candidate) => candidate.id === serverId
      );
      if (!server) throw new HarnessError('NOT_FOUND', 'unknown or inaccessible MCP server', 404, false);
      const outcome = await this.discover(principal, server, context.signal);
      const data = {
        server: server.name,
        status: outcome.status,
        toolCount: outcome.toolCount,
        error: outcome.error
      };
      if (outcome.error) {
        return ok(data, `MCP server ${server.name} is not reachable`);
      }
      return ok(
        data,
        kind === 'refresh' ? `Refreshed ${outcome.toolCount} MCP tool(s)` : `MCP server ${server.name} is reachable`
      );
    } catch (error) {
      return await this.fail(principal, error, {
        operation: kind,
        serverName: server?.name ?? '*',
        serverId: server?.id ?? null,
        tool: null,
        clientId: context.clientId ?? null,
        started
      });
    }
  }

  /**
   * Test/Refresh discovery. The credential purpose is `connect`, the explicit
   * server-level grant, so a deny-by-default server with no cached tools stays
   * testable. This is not the `execute` gate and is never used on the execute path.
   */
  private async discover(
    principal: RunnerPrincipalSelector,
    server: McpGatewayServerView,
    signal?: AbortSignal
  ): Promise<{ status: 'connected' | 'error'; toolCount: number; error: string | null }> {
    const response = await this.runner.callInternal(
      'mcp_server_get_credentials',
      { serverId: server.id, purpose: 'connect' },
      principal,
      signal
    );
    const credentials = this.credentialsOf(response);
    if (credentials?.allowed !== true) {
      const error = 'credential resolution was refused for this MCP server';
      await this.recordConnectionResult(principal, server, 'error', error);
      return { status: 'error', toolCount: 0, error };
    }
    const resolved: McpGatewayServerView = credentials.endpoint ? { ...server, endpoint: credentials.endpoint } : server;
    const secrets = credentialValues(credentials.headers);
    try {
      const listed = await this.connections.withConnection(
        resolved,
        credentials.headers ?? {},
        (client) => client.listTools(),
        signal
      );
      const normalized = normalizeUpstreamTools(server, (listed.tools ?? []) as GatewayUpstreamTool[], {
        maxTools: this.maxToolsPerServer,
        maxSchemaBytes: this.maxSchemaBytes
      });
      await this.runner.callInternal(
        'mcp_server_replace_tools',
        {
          serverId: server.id,
          tools: normalized.map((tool) => ({
            upstreamName: tool.upstreamName,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
            availability: tool.availability,
            schemaBytes: gatewayToolSchemaBytes(tool)
          })),
          status: 'connected',
          cap: this.maxToolsPerServer
        },
        principal,
        signal
      );
      this.invalidateCatalog(principal);
      return { status: 'connected', toolCount: normalized.length, error: null };
    } catch (error) {
      const sanitized = redactGatewayError(error, secrets);
      await this.recordConnectionResult(principal, server, 'error', sanitized.message);
      return { status: 'error', toolCount: 0, error: sanitized.message };
    }
  }

  private async recordConnectionResult(
    principal: RunnerPrincipalSelector,
    server: McpGatewayServerView,
    status: 'connected' | 'error',
    error: string | null
  ): Promise<void> {
    try {
      await this.runner.callInternal('mcp_server_connection_result', { serverId: server.id, status, error }, principal);
    } catch {
      // A failed status write must not turn a reachability answer into an error.
    }
  }

  private reconcileConnection(server: McpGatewayServerView): string {
    if (!server.enabled) return 'disabled';
    return this.connections.health(server.id);
  }

  private async loadCatalog(
    principal: RunnerPrincipalSelector,
    filter: GatewayCatalogFilter,
    signal?: AbortSignal
  ): Promise<CatalogView> {
    const key = this.cacheKey(principal, filter);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const request: GatewayCatalogFilter = {
      ...(filter.serverId ? { serverId: filter.serverId } : {}),
      ...(filter.qualifiedName ? { qualifiedName: filter.qualifiedName } : {})
    };
    const response = await this.runner.callInternal('mcp_gateway_catalog', request, principal, signal);
    if (!response.ok) {
      throw new HarnessError(
        response.error?.code ?? 'UNAVAILABLE',
        response.error?.message ?? response.message ?? 'MCP gateway catalog is unavailable',
        502,
        response.error?.retryable ?? false
      );
    }
    const value = this.catalogOf(response);
    this.cache.set(key, { value, expiresAt: this.now() + this.catalogTtlMs });
    return value;
  }

  private principalKey(principal: RunnerPrincipalSelector): string {
    return principal.kind === 'owner' ? principal.ownerId : `${principal.issuer}\u0000${principal.subject}`;
  }

  private cacheKey(principal: RunnerPrincipalSelector, filter: GatewayCatalogFilter): string {
    return `${this.principalKey(principal)}\u0001${filter.serverId ?? ''}\u0001${filter.qualifiedName ?? ''}`;
  }

  private catalogOf(response: RunnerResponse): CatalogView {
    const data = response.data;
    if (typeof data !== 'object' || data === null) return { servers: [], tools: [] };
    const record = data as { servers?: unknown; tools?: unknown };
    return {
      servers: Array.isArray(record.servers) ? (record.servers as McpGatewayServerView[]) : [],
      tools: Array.isArray(record.tools) ? (record.tools as McpGatewayToolView[]) : []
    };
  }

  private credentialsOf(response: RunnerResponse): McpGatewayResolvedCredentials | undefined {
    const data = response.data;
    if (typeof data !== 'object' || data === null) return undefined;
    return data as McpGatewayResolvedCredentials;
  }

  private async requireTool(
    principal: RunnerPrincipalSelector,
    qualifiedName: string,
    signal?: AbortSignal
  ): Promise<McpGatewayToolView> {
    return (await this.resolveTool(principal, qualifiedName, signal)).tool;
  }

  /**
   * Resolves one accessible tool and its server with a single filtered catalog read.
   * A tool whose server is disabled or whose effective permission is `deny` is
   * reported as `NOT_FOUND` with the same message as an unknown tool, so `inspect`
   * can never confirm that a forbidden tool exists.
   */
  private async resolveTool(
    principal: RunnerPrincipalSelector,
    qualifiedName: string,
    signal?: AbortSignal
  ): Promise<{ tool: McpGatewayToolView; server: McpGatewayServerView }> {
    if (!McpGatewayQualifiedToolNameSchema.safeParse(qualifiedName).success) {
      throw new HarnessError('NOT_FOUND', UNKNOWN_TOOL_MESSAGE, 404, false);
    }
    const catalog = await this.loadCatalog(principal, { qualifiedName }, signal);
    const tool = catalog.tools.find((candidate) => candidate.qualifiedName === qualifiedName);
    const server = tool ? catalog.servers.find((candidate) => candidate.id === tool.serverId) : undefined;
    if (!tool || !server || !server.enabled || tool.permission !== 'allow') {
      throw new HarnessError('NOT_FOUND', UNKNOWN_TOOL_MESSAGE, 404, false);
    }
    return { tool, server };
  }

  private async requireServer(
    principal: RunnerPrincipalSelector,
    serverId: string,
    signal?: AbortSignal
  ): Promise<McpGatewayServerView> {
    const catalog = await this.loadCatalog(principal, { serverId }, signal);
    const server = catalog.servers.find((candidate) => candidate.id === serverId);
    if (!server) throw new HarnessError('NOT_FOUND', 'unknown or inaccessible MCP server', 404, false);
    return server;
  }

  private async fail(
    principal: RunnerPrincipalSelector,
    error: unknown,
    context: TraceContext
  ): Promise<ToolResult> {
    const sanitized = redactGatewayError(error, context.secrets ?? []);
    const message = sanitizeGatewayText(sanitized.message, context.secrets ?? []);
    await this.trace(principal, {
      serverId: context.serverId,
      serverName: context.serverName,
      tool: context.tool,
      operation: context.operation,
      clientId: context.clientId,
      durationMs: Math.max(0, this.now() - context.started),
      status: 'error',
      errorCode: sanitized.code,
      errorMessage: message,
      requestBytes: context.requestBytes ?? null,
      responseBytes: null
    });
    return failure(sanitized.code, message, error instanceof HarnessError ? error.retryable : false);
  }

  /**
   * Records one metadata-only trace. Arguments, results, and credentials are never
   * included, only their sizes, and a failed trace write is swallowed so an audit
   * outage cannot fail a tool call.
   */
  private async trace(principal: RunnerPrincipalSelector, entry: McpGatewayTraceEntry): Promise<void> {
    try {
      await this.runner.callInternal(
        'mcp_gateway_trace_append',
        {
          serverId: entry.serverId,
          serverName: entry.serverName,
          tool: entry.tool,
          operation: entry.operation,
          clientId: entry.clientId,
          durationMs: entry.durationMs,
          status: entry.status,
          errorCode: entry.errorCode,
          errorMessage: entry.errorMessage,
          requestBytes: entry.requestBytes,
          responseBytes: entry.responseBytes,
          // Resolved credential values must never be sent to the runner. This wire
          // field exists only for runner-local tests; the API must always pass an
          // empty array and never populate it from `credentialValues`.
          secrets: [],
          maxRows: this.maxTraceRows
        },
        principal
      );
    } catch {
      // Tracing is best-effort: a broken audit sink must not break a tool call.
    }
  }
}
