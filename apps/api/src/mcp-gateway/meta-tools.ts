import { z } from 'zod';
import type { AuthInfo, McpServer, ServerContext, ToolAnnotations } from '@modelcontextprotocol/server';
import {
  McpGatewayQualifiedToolNameSchema,
  ToolResultSchema,
  type RunnerPrincipalSelector,
  type ToolResult
} from '@cloud-harness/contracts';
import { principalFromAuthInfo } from '../auth.js';
import { resultToMcp } from '../mcp-server.js';
import type { McpGatewayCallContext, McpGatewayService } from './service.js';

/**
 * The constant-size meta-tool surface.
 *
 * `tools/list` advertises exactly five tools no matter how many downstream tools a
 * principal has cached; discovery happens through `search` and `inspect`, and
 * permission enforcement happens server-side on every `execute`.
 */

export const GATEWAY_TOOL_NAMES = ['search', 'inspect', 'execute', 'permissions', 'status'] as const;
export type GatewayToolName = (typeof GATEWAY_TOOL_NAMES)[number];

const readOnly: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
};
const mutating: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
};

export const GatewaySearchInputSchema = z.object({
  query: z.string().trim().min(1).max(512).describe('What you are trying to do, in words.'),
  server: z
    .string()
    .trim()
    .min(1)
    .max(63)
    .optional()
    .describe('Restrict the search to one configured MCP server by name.'),
  limit: z.number().int().min(1).max(25).default(5).describe('Maximum number of matches to return.')
});

export const GatewayInspectInputSchema = z.object({
  tool: McpGatewayQualifiedToolNameSchema.describe('A qualified tool name returned by `search`, as `<server>.<tool>`.')
});

export const GatewayExecuteInputSchema = z.object({
  tool: McpGatewayQualifiedToolNameSchema.describe('A qualified tool name returned by `search`.'),
  arguments: z
    .record(z.string(), z.unknown())
    .default({})
    .describe('Arguments matching the `inputSchema` returned by `inspect`.')
});

export const GatewayPermissionsInputSchema = z.object({
  tool: McpGatewayQualifiedToolNameSchema.optional().describe('Resolve the effective decision for one tool.'),
  server: z
    .string()
    .trim()
    .min(1)
    .max(63)
    .optional()
    .describe('Resolve the default and per-tool decisions for one server.')
});

export const GatewayStatusInputSchema = z.object({});

/** The per-request identity the service records on every trace. */
function callContext(context: ServerContext, clientId: string | undefined): McpGatewayCallContext {
  return {
    signal: context.mcpReq.signal,
    ...(clientId ? { clientId } : {})
  };
}

function unauthenticated(): ToolResult {
  return {
    ok: false,
    message: 'Authentication context unavailable',
    error: { code: 'AUTHENTICATION_FAILED', message: 'Authentication context unavailable', retryable: false },
    truncated: false
  };
}

export function registerGatewayTools(server: McpServer, service: McpGatewayService, authInfo: AuthInfo | undefined): void {
  const principal: RunnerPrincipalSelector | undefined = principalFromAuthInfo(authInfo);
  const clientId = typeof authInfo?.clientId === 'string' && authInfo.clientId.length > 0 ? authInfo.clientId : undefined;

  server.registerTool(
    'search',
    {
      title: 'Search MCP tools',
      description:
        'Find an MCP tool by describing what you need. Returns qualified tool names; call `inspect` for the schema and `execute` to run it.',
      inputSchema: GatewaySearchInputSchema,
      outputSchema: ToolResultSchema,
      annotations: readOnly
    },
    async (input, context) =>
      resultToMcp(principal ? await service.search(principal, input, callContext(context, clientId)) : unauthenticated())
  );

  server.registerTool(
    'inspect',
    {
      title: 'Inspect an MCP tool',
      description:
        'Return one MCP tool\u2019s real input schema, annotations, availability, and permission. Call it before `execute` so arguments match the upstream schema.',
      inputSchema: GatewayInspectInputSchema,
      outputSchema: ToolResultSchema,
      annotations: readOnly
    },
    async (input, context) =>
      resultToMcp(principal ? await service.inspect(principal, input, callContext(context, clientId)) : unauthenticated())
  );

  server.registerTool(
    'execute',
    {
      title: 'Execute an MCP tool',
      description:
        'Run one downstream MCP tool with arguments that match the schema `inspect` returned. The call is re-authorized and routed server-side and is never retried.',
      inputSchema: GatewayExecuteInputSchema,
      outputSchema: ToolResultSchema,
      annotations: mutating
    },
    async (input, context) =>
      resultToMcp(principal ? await service.execute(principal, input, callContext(context, clientId)) : unauthenticated())
  );

  server.registerTool(
    'permissions',
    {
      title: 'Inspect MCP permissions',
      description:
        'Show the effective allow/deny decision for a tool, for every tool on a server, or for every configured server. Permissions are enforced server-side.',
      inputSchema: GatewayPermissionsInputSchema,
      outputSchema: ToolResultSchema,
      annotations: readOnly
    },
    async (input, context) =>
      resultToMcp(principal ? await service.permissions(principal, input, callContext(context, clientId)) : unauthenticated())
  );

  server.registerTool(
    'status',
    {
      title: 'MCP server status',
      description:
        'Report each configured MCP server\u2019s enabled state, connection state, cached tool count, last connection, and a sanitized error when one is stored.',
      inputSchema: GatewayStatusInputSchema,
      outputSchema: ToolResultSchema,
      annotations: readOnly
    },
    async (_input, context) =>
      resultToMcp(principal ? await service.status(principal, callContext(context, clientId)) : unauthenticated())
  );
}
