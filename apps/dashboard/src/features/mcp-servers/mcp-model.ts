import { apiClient } from '@/lib/api-client';
import { ClientValidationError } from '@/lib/bff-mutation';

export type McpTransport = 'streamable-http' | 'sse';
/** A header as the BFF projects it: `value` is present only for literal headers, never for a secret reference. */
export type McpHeader = { name: string; kind: 'literal' | 'secret' | string; secretRef?: string | null; value?: string | null };
export type McpOAuthConfig = { scopes?: string | null; clientId?: string | null; clientSecretRef?: string | null };
export type McpServer = {
  id: string;
  name: string;
  description?: string | null;
  transport: McpTransport | string;
  endpoint: string;
  headers?: McpHeader[] | null;
  oauth?: McpOAuthConfig | null;
  enabled: boolean;
  status?: string | null;
  toolCount?: number | null;
  lastConnectedAt?: string | number | null;
  lastError?: string | null;
  lastCheckedAt?: string | number | null;
  permissionDefault?: 'allow' | 'deny' | string | null;
  generation: number;
  createdAt?: string | number | null;
  updatedAt?: string | number | null;
};
export type McpTool = {
  id: string;
  qualifiedName?: string | null;
  upstreamName: string;
  description?: string | null;
  inputSchema?: unknown;
  availability?: string | null;
  permission?: 'allow' | 'deny' | string | null;
};
export type McpTrace = {
  id: string;
  tool?: string | null;
  operation?: string | null;
  clientId?: string | null;
  durationMs?: number | null;
  status?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  requestBytes?: number | null;
  responseBytes?: number | null;
  createdAt?: string | number | null;
};
export type McpGateway = { endpoint?: string | null; publicUrl?: string | null; apiKeyPublicUrl?: string | null; authMode?: string | null };
export type McpOAuthStatus = {
  state?: string | null;
  issuer?: string | null;
  grantedScopes?: string | string[] | null;
  registrationMode?: string | null;
  authorizedAt?: number | string | null;
  expiresAt?: number | string | null;
  lastError?: string | null;
  redirectUrl?: string | null;
};
export type McpProbe = { status?: string | null; toolCount?: number | null; error?: string | null };

export const SERVER_STATUS: Record<string, { label: string; tone: 'success' | 'info' | 'neutral' | 'danger' }> = {
  connected: { label: 'Connected', tone: 'success' },
  connecting: { label: 'Connecting', tone: 'info' },
  disconnected: { label: 'Disconnected', tone: 'neutral' },
  error: { label: 'Error', tone: 'danger' },
  disabled: { label: 'Disabled', tone: 'neutral' }
};
export function serverStatus(status: string | null | undefined) {
  return SERVER_STATUS[status ?? ''] ?? { label: 'Not yet contacted', tone: 'neutral' as const };
}

export const OAUTH_STATE_LABELS: Record<string, string> = {
  not_configured: 'Not configured',
  authorization_required: 'Authorization required',
  authorizing: 'Authorizing',
  connected: 'Connected',
  reauthorization_required: 'Reauthorization required',
  error: 'Error'
};

export function oauthConnectLabel(state: string): string {
  if (state === 'connected') return 'Reconnect';
  if (state === 'reauthorization_required') return 'Reauthorize';
  return 'Connect';
}

/** Disconnect is offered whenever a grant may be stored, even when Connect is hidden. */
export function oauthCanDisconnect(status: McpOAuthStatus | undefined): boolean {
  if (!status) return false;
  const state = status.state ?? 'authorization_required';
  return Boolean(status.issuer) || (state !== 'authorization_required' && state !== 'not_configured');
}

/** The endpoint without userinfo, query or fragment, for display. */
export function displayEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return endpoint;
  }
}

/** The announcement for the OAuth callback outcome the server appends as `?oauth=&reason=`. */
export function oauthOutcomeMessage(outcome: { oauth?: 'connected' | 'error' | undefined; reason?: string | undefined }): { text: string; ok: boolean } | undefined {
  if (outcome.oauth === 'connected') return { text: 'OAuth connected.', ok: true };
  if (outcome.oauth !== 'error') return undefined;
  const reason = (outcome.reason ?? '').replace(/[^a-z_]/g, '').replace(/_/g, ' ');
  return { text: `OAuth connection failed: ${reason || 'error'}.`, ok: false };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** The authorization server's URL is followed only over HTTPS (or to a loopback host in development). */
export function safeAuthorizationUrl(value: unknown): string {
  try {
    const url = new URL(String(value));
    if (url.protocol === 'https:' || LOCAL_HOSTS.has(url.hostname)) return url.toString();
  } catch { /* fall through */ }
  throw new ClientValidationError('The authorization server returned an unsafe URL.');
}

// Mirrors `packages/contracts/src/mcp-gateway-schemas.ts`; the server stays the authority.
export const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const HEADER_NAME_PATTERN = /^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
export const RESERVED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'proxy-connection', 'keep-alive', 'upgrade']);
export const MAX_HEADERS = 20;

export type HeaderRow = { name: string; mode: 'literal' | 'secret'; value: string; secretRef: string };
export type McpFormValues = {
  name: string;
  description: string;
  transport: McpTransport;
  endpoint: string;
  oauthEnabled: boolean;
  scopes: string;
  clientId: string;
  clientSecretRef: string;
  headers: HeaderRow[];
  enabled: boolean;
};

export function formValuesFor(server: McpServer | undefined): McpFormValues {
  if (!server) {
    return { name: '', description: '', transport: 'streamable-http', endpoint: '', oauthEnabled: false, scopes: '', clientId: '', clientSecretRef: '', headers: [], enabled: true };
  }
  return {
    name: server.name,
    description: server.description ?? '',
    transport: server.transport === 'sse' ? 'sse' : 'streamable-http',
    endpoint: server.endpoint,
    oauthEnabled: Boolean(server.oauth),
    scopes: server.oauth?.scopes ?? '',
    clientId: server.oauth?.clientId ?? '',
    clientSecretRef: server.oauth?.clientSecretRef ?? '',
    headers: (server.headers ?? []).map((header) => header.kind === 'secret'
      ? { name: header.name, mode: 'secret', value: '', secretRef: header.secretRef ?? '' }
      : { name: header.name, mode: 'literal', value: header.value ?? '', secretRef: '' }),
    enabled: server.enabled
  };
}

export function headerNameError(raw: string): string | undefined {
  const name = raw.trim().toLowerCase();
  if (!name) return undefined;
  if (!HEADER_NAME_PATTERN.test(name)) return 'Header names use letters, digits, and the HTTP token characters, up to 64 characters.';
  if (RESERVED_HEADERS.has(name)) return 'This header is managed by the gateway and cannot be set.';
  return undefined;
}

type HeaderPayload = { name: string; value: string | { secretRef: string } };
/** Blank rows are skipped; names are lowercased because the gateway accepts lowercase names only. */
export function headersPayload(rows: readonly HeaderRow[]): HeaderPayload[] {
  return rows.flatMap((row): HeaderPayload[] => {
    const name = row.name.trim().toLowerCase();
    if (!name) return [];
    if (row.mode === 'secret') return row.secretRef ? [{ name, value: { secretRef: row.secretRef } }] : [];
    return [{ name, value: row.value }];
  });
}

/** Client checks with fixed copy; anything they miss is refused by the server with its own message. */
export function validateServerForm(values: McpFormValues): string | undefined {
  if (!SERVER_NAME_PATTERN.test(values.name.trim())) return 'Server names are 1-63 lowercase letters, numbers, or hyphens.';
  const headers = headersPayload(values.headers);
  if (headers.length > MAX_HEADERS) return `Up to ${MAX_HEADERS} headers are allowed.`;
  if (values.oauthEnabled && values.transport !== 'streamable-http') return 'OAuth requires the streamable-http transport.';
  if (values.oauthEnabled && headers.some((header) => header.name === 'authorization')) return 'OAuth owns the Authorization header, so remove the custom Authorization header.';
  if (values.oauthEnabled && values.clientSecretRef && !values.clientId.trim()) return 'A client secret requires a manually registered client ID.';
  if (values.transport === 'sse' && headers.some((header) => typeof header.value !== 'string')) return 'SSE servers cannot send secret-reference headers. Use streamable-http instead.';
  return undefined;
}

function oauthPayload(values: McpFormValues): McpOAuthConfig {
  const oauth: McpOAuthConfig = {};
  if (values.scopes.trim()) oauth.scopes = values.scopes.trim();
  if (values.clientId.trim()) oauth.clientId = values.clientId.trim();
  if (values.clientSecretRef) oauth.clientSecretRef = values.clientSecretRef;
  return oauth;
}

/** The create body, as the classic Dashboard sends it, with a generation-zero fence. */
export function createPayload(values: McpFormValues): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: values.name.trim(), transport: values.transport, endpoint: values.endpoint.trim(), headers: headersPayload(values.headers), enabled: values.enabled,
    permissionDefault: 'allow', expectedGeneration: 0
  };
  if (values.description.trim()) body.description = values.description.trim();
  if (values.oauthEnabled) body.oauth = oauthPayload(values);
  return body;
}

/**
 * The update body. `enabled` is not part of the strict update schema, so a changed enabled
 * state is sent separately to `POST /enabled` after the update (see `mcpApi.update`).
 */
export function updatePayload(values: McpFormValues, expectedGeneration: number): Record<string, unknown> {
  return {
    name: values.name.trim(), transport: values.transport, endpoint: values.endpoint.trim(), headers: headersPayload(values.headers),
    description: values.description.trim() || null,
    oauth: values.oauthEnabled ? oauthPayload(values) : null,
    expectedGeneration
  };
}

const id = (server: { id: string }) => encodeURIComponent(server.id);
const unwrap = <T>(body: unknown) => (body as { data: T }).data;

export const mcpApi = {
  create: async (values: McpFormValues) => unwrap<McpServer>(await apiClient.request('/mcp-servers', { method: 'POST', body: createPayload(values) })),
  update: async (server: McpServer, values: McpFormValues) => {
    const updated = unwrap<McpServer>(await apiClient.request(`/mcp-servers/${id(server)}`, { method: 'PATCH', body: updatePayload(values, server.generation) }));
    if (values.enabled !== server.enabled) return mcpApi.setEnabled(updated, values.enabled);
    return updated;
  },
  setEnabled: async (server: McpServer, enabled: boolean) =>
    unwrap<McpServer>(await apiClient.request(`/mcp-servers/${id(server)}/enabled`, { method: 'POST', body: { enabled, expectedGeneration: server.generation } })),
  remove: (server: McpServer) => apiClient.request(`/mcp-servers/${id(server)}`, { method: 'DELETE', body: { expectedGeneration: server.generation } }),
  test: async (server: { id: string }) => unwrap<McpProbe>(await apiClient.request(`/mcp-servers/${id(server)}/test`, { method: 'POST' })),
  refresh: async (server: { id: string }) => unwrap<McpProbe>(await apiClient.request(`/mcp-servers/${id(server)}/refresh`, { method: 'POST' })),
  setPermissions: (server: McpServer, permissionDefault: string, tools: Array<{ name: string; permission: string }>) =>
    apiClient.request(`/mcp-servers/${id(server)}/permissions`, { method: 'PUT', body: { permissionDefault, tools, expectedGeneration: server.generation } }),
  oauthStatus: async (serverId: string) => unwrap<{ status: McpOAuthStatus }>(await apiClient.request(`/mcp-servers/${encodeURIComponent(serverId)}/oauth`)).status,
  oauthStart: async (server: { id: string }) => safeAuthorizationUrl(unwrap<{ authorizationUrl?: string }>(await apiClient.request(`/mcp-servers/${id(server)}/oauth/start`, { method: 'POST' })).authorizationUrl),
  oauthDisconnect: (server: { id: string }) => apiClient.request(`/mcp-servers/${id(server)}/oauth/disconnect`, { method: 'POST' }),
  gateway: async () => unwrap<McpGateway>(await apiClient.request('/mcp-gateway')),
  logs: async (serverId: string, cursor?: string) => {
    const body = await apiClient.request(`/mcp-servers/${encodeURIComponent(serverId)}/logs`, cursor ? { query: { cursor } } : {}) as { data: { traces: McpTrace[] }; cursor?: string | null };
    return { traces: body.data.traces ?? [], cursor: body.cursor ?? undefined };
  }
};

export function probeMessage(probe: McpProbe): { text: string; ok: boolean } {
  if (probe.status === 'connected') return { text: `Connected — ${probe.toolCount ?? 0} tools discovered.`, ok: true };
  return { text: `Connection failed: ${probe.error || 'the server did not connect.'}`, ok: false };
}

export const MCP_READS = ['/mcp-servers'] as const;
