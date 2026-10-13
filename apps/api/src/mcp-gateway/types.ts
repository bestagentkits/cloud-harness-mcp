import type { McpGatewayServerView, McpGatewayToolView } from '@cloud-harness/contracts';

/**
 * Shared gateway value types.
 *
 * The catalog is the runner-persisted view of every server and cached tool; the API
 * never recomputes permission, it only filters on the effective decision the runner
 * supplied (`McpGatewayToolView.permission`).
 */

export type GatewayCatalog = { servers: McpGatewayServerView[]; tools: McpGatewayToolView[] };

export type GatewayToolMatch = { tool: McpGatewayToolView; score: number };

export type GatewayCatalogFilter = { serverId?: string; qualifiedName?: string };

/** The subset of an upstream `tools/list` entry the normalizer reads. */
export type GatewayUpstreamTool = {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  annotations?: unknown;
};

export type GatewayToolNormalizeOptions = { maxTools: number; maxSchemaBytes: number };

export type GatewaySearchOptions = { server?: string; limit?: number };
