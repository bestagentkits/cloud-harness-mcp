import { z } from 'zod';
import { SecretNameSchema } from './secret-policy.js';

/**
 * MCP gateway contracts.
 *
 * A downstream MCP server is registered once by a principal, its tools are cached
 * as metadata, and the five gateway meta-tools disclose those tools progressively
 * instead of aggregating them into `tools/list`.
 */

export const McpGatewayServerIdSchema = z
  .string()
  .regex(/^mcps_[A-Za-z0-9_-]{20,80}$/, 'invalid MCP server identifier');
export const McpGatewayToolIdSchema = z
  .string()
  .regex(/^mcpt_[A-Za-z0-9_-]{20,80}$/, 'invalid MCP tool identifier');
export const McpGatewayTraceIdSchema = z
  .string()
  .regex(/^mcpg_[A-Za-z0-9_-]{20,80}$/, 'invalid MCP trace identifier');
export const McpGatewayServerNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'server name must be 1-63 lowercase letters, numbers, or hyphens');
export const McpGatewayToolNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]{1,120}$/, 'invalid upstream tool name');

/**
 * Rule: a tool name is globally unambiguous, `<server>.<upstream-tool>`.
 * Rationale: `search` returns a single string the model hands back to `inspect`
 * and `execute`, so the identity must not require a second lookup field.
 */
export function qualifiedToolName(serverName: string, toolName: string): string {
  return `${serverName}.${toolName}`;
}

export const McpGatewayQualifiedToolNameSchema = z
  .string()
  .max(190)
  .superRefine((value, ctx) => {
    const separator = value.indexOf('.');
    if (separator <= 0 || separator === value.length - 1) {
      ctx.addIssue({ code: 'custom', message: 'qualified tool name must be <server>.<tool>' });
      return;
    }
    const server = value.slice(0, separator);
    const tool = value.slice(separator + 1);
    if (!McpGatewayServerNameSchema.safeParse(server).success) {
      ctx.addIssue({ code: 'custom', message: 'invalid server segment in qualified tool name' });
    }
    if (!McpGatewayToolNameSchema.safeParse(tool).success) {
      ctx.addIssue({ code: 'custom', message: 'invalid tool segment in qualified tool name' });
    }
  });
export type McpGatewayQualifiedToolName = z.infer<typeof McpGatewayQualifiedToolNameSchema>;

export const McpGatewayTransportSchema = z.enum(['streamable-http', 'sse']);
export type McpGatewayTransport = z.infer<typeof McpGatewayTransportSchema>;

export const McpGatewayPermissionSchema = z.enum(['allow', 'deny']);
export type McpGatewayPermission = z.infer<typeof McpGatewayPermissionSchema>;

export const McpGatewayServerStatusSchema = z.enum([
  'unknown',
  'connected',
  'connecting',
  'disconnected',
  'error',
  'disabled'
]);
export type McpGatewayServerStatus = z.infer<typeof McpGatewayServerStatusSchema>;

export const McpGatewayToolAvailabilitySchema = z.enum(['available', 'unavailable']);
export type McpGatewayToolAvailability = z.infer<typeof McpGatewayToolAvailabilitySchema>;

/**
 * Credential resolution scope. `execute` is the tool path and is gated by the
 * effective tool permission; `connect` is the explicit, audited server-level
 * grant used by Test/Refresh so a deny-by-default server stays testable.
 */
export const McpGatewayCredentialPurposeSchema = z.enum(['execute', 'connect']);
export type McpGatewayCredentialPurpose = z.infer<typeof McpGatewayCredentialPurposeSchema>;

const FORBIDDEN_HEADER_NAMES: Record<string, true> = {
  host: true,
  'content-length': true,
  connection: true,
  'transfer-encoding': true,
  'proxy-connection': true,
  'keep-alive': true,
  upgrade: true
};

export const McpGatewayHeaderNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/, 'invalid HTTP header name')
  .superRefine((value, ctx) => {
    if (FORBIDDEN_HEADER_NAMES[value.toLowerCase()]) {
      ctx.addIssue({ code: 'custom', message: `header ${value} is reserved by the gateway transport` });
    }
  });

/**
 * A header value is either a literal or a reference to an existing global secret.
 * A resolved value is never stored in server configuration and never returned by
 * a view schema.
 */
export const McpGatewayHeaderValueSchema = z.union([
  z.string().max(2_048),
  z.object({ secretRef: SecretNameSchema }).strict()
]);
export type McpGatewayHeaderValue = z.infer<typeof McpGatewayHeaderValueSchema>;

export const McpGatewayRemoteUrlSchema = z.string().url().max(2_048);

export const McpGatewayToolAnnotationsSchema = z.record(z.string(), z.unknown());

/**
 * Literal header values are safe to project back to the dashboard so an operator can
 * edit them. A secret reference is write-only: the resolved value is never projected.
 */
const headerView = z
  .object({
    name: McpGatewayHeaderNameSchema,
    kind: z.enum(['literal', 'secret']),
    secretRef: SecretNameSchema.optional(),
    value: z.string().max(2_048).optional()
  })
  .strict()
  .superRefine((header, ctx) => {
    if (header.kind === 'secret') {
      if (!header.secretRef) ctx.addIssue({ code: 'custom', path: ['secretRef'], message: 'secret header requires secretRef' });
      if (header.value !== undefined) ctx.addIssue({ code: 'custom', path: ['value'], message: 'secret header must not carry a value' });
      return;
    }
    if (header.secretRef !== undefined) ctx.addIssue({ code: 'custom', path: ['secretRef'], message: 'literal header must not carry secretRef' });
    if (header.value === undefined) ctx.addIssue({ code: 'custom', path: ['value'], message: 'literal header requires a value' });
  });

export const McpGatewayServerViewSchema = z
  .object({
    id: McpGatewayServerIdSchema,
    principalId: z.string().min(1).max(100),
    name: McpGatewayServerNameSchema,
    description: z.string().max(500).nullable(),
    transport: McpGatewayTransportSchema,
    endpoint: McpGatewayRemoteUrlSchema,
    headers: z.array(headerView).max(20),
    enabled: z.boolean(),
    status: McpGatewayServerStatusSchema,
    toolCount: z.number().int().min(0),
    lastConnectedAt: z.number().int().positive().nullable(),
    lastError: z.string().max(500).nullable(),
    lastCheckedAt: z.number().int().positive().nullable(),
    permissionDefault: McpGatewayPermissionSchema,
    generation: z.number().int().positive(),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive()
  })
  .strict();
export type McpGatewayServerView = z.infer<typeof McpGatewayServerViewSchema>;

export const McpGatewayToolViewSchema = z
  .object({
    id: McpGatewayToolIdSchema,
    principalId: z.string().min(1).max(100),
    serverId: McpGatewayServerIdSchema,
    serverName: McpGatewayServerNameSchema,
    qualifiedName: McpGatewayQualifiedToolNameSchema,
    upstreamName: McpGatewayToolNameSchema,
    description: z.string().max(2_000),
    /** The upstream schema, never rewritten except to drop an oversized one. */
    inputSchema: z.unknown(),
    annotations: McpGatewayToolAnnotationsSchema.nullable(),
    availability: McpGatewayToolAvailabilitySchema,
    /** The effective decision: tool override when present, else the server default. */
    permission: McpGatewayPermissionSchema,
    discoveredAt: z.number().int().positive()
  })
  .strict();
export type McpGatewayToolView = z.infer<typeof McpGatewayToolViewSchema>;

export const McpGatewayTraceStatusSchema = z.enum(['success', 'error', 'denied']);
export type McpGatewayTraceStatus = z.infer<typeof McpGatewayTraceStatusSchema>;

export const McpGatewayTraceViewSchema = z
  .object({
    id: McpGatewayTraceIdSchema,
    principalId: z.string().min(1).max(100),
    serverId: McpGatewayServerIdSchema.nullable(),
    serverName: z.string().max(63),
    tool: z.string().max(190).nullable(),
    operation: z.string().max(32),
    clientId: z.string().max(120).nullable(),
    durationMs: z.number().int().min(0),
    status: McpGatewayTraceStatusSchema,
    errorCode: z.string().max(64).nullable(),
    errorMessage: z.string().max(500).nullable(),
    requestBytes: z.number().int().min(0).nullable(),
    responseBytes: z.number().int().min(0).nullable(),
    createdAt: z.number().int().positive()
  })
  .strict();
export type McpGatewayTraceView = z.infer<typeof McpGatewayTraceViewSchema>;

export const McpGatewayServerHeadersSchema = z
  .array(z.object({ name: McpGatewayHeaderNameSchema, value: McpGatewayHeaderValueSchema }).strict())
  .max(20);

/**
 * An SSE downstream server's JSON-RPC POST goes to a message path different from
 * the configured endpoint, so a header credential cannot be attached there without
 * widening the credential scope past that endpoint. Reject the combination when the
 * server is written, rather than allowing Test/Refresh to succeed on a configuration
 * whose every real call will fail.
 */
export const MCP_GATEWAY_AUTHENTICATED_SSE_MESSAGE =
  'authenticated SSE is not supported: credentials are attached only to the configured endpoint, so use transport streamable-http for a server that needs a secret header';

function rejectAuthenticatedSse(
  value: {
    transport?: McpGatewayTransport | undefined;
    headers?: ReadonlyArray<{ value: McpGatewayHeaderValue }> | undefined;
  },
  ctx: z.RefinementCtx
): void {
  if (value.transport !== 'sse') return;
  const hasSecretHeader = (value.headers ?? []).some((header) => typeof header.value !== 'string');
  if (hasSecretHeader) {
    ctx.addIssue({ code: 'custom', path: ['headers'], message: MCP_GATEWAY_AUTHENTICATED_SSE_MESSAGE });
  }
}

const transportInput = z
  .string()
  .superRefine((value, ctx) => {
    if (value === 'stdio') {
      ctx.addIssue({
        code: 'custom',
        message: 'stdio downstream transport is not supported; use streamable-http or sse'
      });
      return;
    }
    if (!McpGatewayTransportSchema.safeParse(value).success) {
      ctx.addIssue({ code: 'custom', message: "transport must be 'streamable-http' or 'sse'" });
    }
  })
  .transform((value) => value as McpGatewayTransport);

export const McpGatewayCreateInputSchema = z
  .object({
    name: McpGatewayServerNameSchema,
    description: z.string().trim().max(500).optional(),
    transport: transportInput,
    endpoint: McpGatewayRemoteUrlSchema,
    headers: McpGatewayServerHeadersSchema.default([]),
    permissionDefault: McpGatewayPermissionSchema.default('allow'),
    enabled: z.boolean().default(true),
    expectedGeneration: z.literal(0)
  })
  .strict()
  .superRefine(rejectAuthenticatedSse);
export type McpGatewayCreateInput = z.infer<typeof McpGatewayCreateInputSchema>;

export const McpGatewayUpdateInputSchema = z
  .object({
    name: McpGatewayServerNameSchema.optional(),
    description: z.string().trim().max(500).nullable().optional(),
    transport: transportInput.optional(),
    endpoint: McpGatewayRemoteUrlSchema.optional(),
    headers: McpGatewayServerHeadersSchema.optional(),
    permissionDefault: McpGatewayPermissionSchema.optional(),
    expectedGeneration: z.number().int().positive()
  })
  .strict()
  // A partial update can carry only one of the two fields, so the guard fires only
  // when the payload itself combines `transport: 'sse'` with a secret header.
  .superRefine(rejectAuthenticatedSse);
export type McpGatewayUpdateInput = z.infer<typeof McpGatewayUpdateInputSchema>;

export const McpGatewaySetPermissionsInputSchema = z
  .object({
    serverId: McpGatewayServerIdSchema,
    permissionDefault: McpGatewayPermissionSchema,
    tools: z
      .array(z.object({ name: McpGatewayToolNameSchema, permission: McpGatewayPermissionSchema }).strict())
      .max(2_000),
    expectedGeneration: z.number().int().positive()
  })
  .strict();
export type McpGatewaySetPermissionsInput = z.infer<typeof McpGatewaySetPermissionsInputSchema>;

export const McpGatewayResolvedCredentialsSchema = z
  .object({
    allowed: z.boolean(),
    reason: z.enum(['server_disabled', 'tool_denied', 'tool_unknown']).optional(),
    transport: McpGatewayTransportSchema.optional(),
    endpoint: McpGatewayRemoteUrlSchema.optional(),
    headers: z.record(z.string(), z.string()).optional()
  })
  .strict();
export type McpGatewayResolvedCredentials = z.infer<typeof McpGatewayResolvedCredentialsSchema>;

export const McpGatewayCatalogFilterSchema = z
  .object({
    serverId: McpGatewayServerIdSchema.optional(),
    qualifiedName: McpGatewayQualifiedToolNameSchema.optional()
  })
  .strict();
export type McpGatewayCatalogFilter = z.infer<typeof McpGatewayCatalogFilterSchema>;

export const McpGatewaySearchResultSchema = z
  .object({
    tool: McpGatewayQualifiedToolNameSchema,
    server: McpGatewayServerNameSchema,
    description: z.string().max(2_000),
    score: z.number().min(0).max(1)
  })
  .strict();
export type McpGatewaySearchResult = z.infer<typeof McpGatewaySearchResultSchema>;
