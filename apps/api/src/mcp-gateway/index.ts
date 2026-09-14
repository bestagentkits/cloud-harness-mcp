import { McpServer, type McpRequestContext } from '@modelcontextprotocol/server';
import type { FetchLike } from '@modelcontextprotocol/client';
import type { ApiConfig } from '@cloud-harness/contracts';
import type { RunnerClient } from '../runner-client.js';
import { serverVersion } from '../version.js';
import { GatewayConnectionManager, type GatewayConnectionOptions } from './connection-manager.js';
import { registerGatewayTools } from './meta-tools.js';
import { McpGatewayService, type McpGatewayServiceOptions } from './service.js';

/**
 * The gateway composition root.
 *
 * The gateway is assembled once per API process and served at `/mcp-gateway`. It
 * takes the existing `RunnerClient` because it cannot be derived from `config`;
 * `overrides.fetchImpl` exists so tests can inject an in-process downstream MCP
 * responder instead of reaching the network.
 */

export type McpGatewayOverrides = { fetchImpl?: FetchLike };

/**
 * Documented defaults for the gateway limits. `ApiConfigSchema` owns the same
 * values when it parses the environment; these exist so a config object that
 * bypassed `ApiConfigSchema.parse` can never put `undefined`/`NaN` into a numeric
 * context (`Math.max(1, undefined)` is `NaN`, and `AbortSignal.timeout(NaN)`
 * throws `RangeError [ERR_OUT_OF_RANGE]` on the first downstream connect).
 */
export const MCP_GATEWAY_DEFAULTS = {
  timeoutMs: 30_000,
  maxResponseBytes: 262_144,
  maxToolsPerServer: 500,
  maxSchemaBytes: 65_536,
  maxCatalogBytes: 2_097_152,
  maxTraceRows: 20_000,
  maxConnections: 32
} as const;

export type ResolvedMcpGatewayOptions = {
  connection: GatewayConnectionOptions;
  service: McpGatewayServiceOptions;
};

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Normalizes the gateway's numeric options at the composition boundary. A missing
 * or non-finite value falls back to its documented default; a valid value is
 * preserved unchanged. Both consumers read the normalized object, so no downstream
 * `Math.max(1, …)` or `AbortSignal.timeout(…)` can ever see `NaN`.
 */
export function resolveMcpGatewayOptions(config: ApiConfig): ResolvedMcpGatewayOptions {
  return {
    connection: {
      timeoutMs: finiteOr(config.mcpGatewayTimeoutMs, MCP_GATEWAY_DEFAULTS.timeoutMs),
      maxResponseBytes: finiteOr(config.mcpGatewayMaxResponseBytes, MCP_GATEWAY_DEFAULTS.maxResponseBytes),
      maxConnections: finiteOr(config.mcpGatewayMaxConnections, MCP_GATEWAY_DEFAULTS.maxConnections),
      allowInsecureHttp: config.mcpGatewayAllowInsecureHttp === true,
      allowPrivateEndpoints: config.mcpGatewayAllowPrivateEndpoints === true
    },
    service: {
      timeoutMs: finiteOr(config.mcpGatewayTimeoutMs, MCP_GATEWAY_DEFAULTS.timeoutMs),
      maxResponseBytes: finiteOr(config.mcpGatewayMaxResponseBytes, MCP_GATEWAY_DEFAULTS.maxResponseBytes),
      maxToolsPerServer: finiteOr(config.mcpGatewayMaxToolsPerServer, MCP_GATEWAY_DEFAULTS.maxToolsPerServer),
      maxSchemaBytes: finiteOr(config.mcpGatewayMaxSchemaBytes, MCP_GATEWAY_DEFAULTS.maxSchemaBytes),
      maxCatalogBytes: finiteOr(config.mcpGatewayMaxCatalogBytes, MCP_GATEWAY_DEFAULTS.maxCatalogBytes),
      maxTraceRows: finiteOr(config.mcpGatewayMaxTraceRows, MCP_GATEWAY_DEFAULTS.maxTraceRows)
    }
  };
}

const GATEWAY_INSTRUCTIONS = [
  'This endpoint manages your configured downstream MCP servers through a small, stable tool set.',
  'Work progressively: call `search` to find a tool by describing what you need, `inspect` to read that one tool\u2019s real input schema, then `execute` to run it with matching arguments.',
  '`permissions` shows the effective allow/deny decision and `status` reports server health.',
  'Only the five meta-tools are ever exposed, no matter how many downstream tools exist, and every call is authorized server-side against the principal that authenticated this request.'
].join(' ');

export function createMcpGateway(
  config: ApiConfig,
  runnerClient: RunnerClient,
  overrides: McpGatewayOverrides = {}
): { factory: (context: McpRequestContext) => McpServer; service: McpGatewayService } {
  const resolved = resolveMcpGatewayOptions(config);
  const connections = new GatewayConnectionManager({
    ...resolved.connection,
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {})
  });
  const service = new McpGatewayService(runnerClient, connections, resolved.service);
  const factory = (context: McpRequestContext): McpServer => {
    const server = new McpServer(
      { name: 'cloud-harness-mcp-gateway', version: serverVersion },
      { instructions: GATEWAY_INSTRUCTIONS }
    );
    // The five tools are always registered so `tools/list` is constant; a request
    // without a verified principal is refused at call time instead.
    registerGatewayTools(server, service, context.authInfo);
    return server;
  };
  return { factory, service };
}
