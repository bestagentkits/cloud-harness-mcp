import { McpServer, type McpRequestContext } from '@modelcontextprotocol/server';
import type { FetchLike } from '@modelcontextprotocol/client';
import type { ApiConfig } from '@cloud-harness/contracts';
import type { RunnerClient } from '../runner-client.js';
import { serverVersion } from '../version.js';
import { GatewayConnectionManager } from './connection-manager.js';
import { registerGatewayTools } from './meta-tools.js';
import { McpGatewayService } from './service.js';

/**
 * The gateway composition root.
 *
 * The gateway is assembled once per API process and served at `/mcp-gateway`. It
 * takes the existing `RunnerClient` because it cannot be derived from `config`;
 * `overrides.fetchImpl` exists so tests can inject an in-process downstream MCP
 * responder instead of reaching the network.
 */

export type McpGatewayOverrides = { fetchImpl?: FetchLike };

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
  const connections = new GatewayConnectionManager({
    timeoutMs: config.mcpGatewayTimeoutMs,
    maxResponseBytes: config.mcpGatewayMaxResponseBytes,
    maxConnections: config.mcpGatewayMaxConnections,
    allowInsecureHttp: config.mcpGatewayAllowInsecureHttp,
    allowPrivateEndpoints: config.mcpGatewayAllowPrivateEndpoints,
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {})
  });
  const service = new McpGatewayService(runnerClient, connections, {
    timeoutMs: config.mcpGatewayTimeoutMs,
    maxResponseBytes: config.mcpGatewayMaxResponseBytes,
    maxToolsPerServer: config.mcpGatewayMaxToolsPerServer,
    maxSchemaBytes: config.mcpGatewayMaxSchemaBytes,
    maxCatalogBytes: config.mcpGatewayMaxCatalogBytes,
    maxTraceRows: config.mcpGatewayMaxTraceRows
  });
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
