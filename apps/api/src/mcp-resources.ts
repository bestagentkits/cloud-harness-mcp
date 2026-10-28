import {
  ProtocolError,
  ProtocolErrorCode,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type McpServer,
  type ReadResourceResult,
  type ServerContext
} from '@modelcontextprotocol/server';

/**
 * One owner of the `resources/*` handlers. The Skills extension and MCP Apps both serve
 * `resources/read`, and the SDK keeps a single handler per method, so each contributes here
 * instead of installing its own: static app resources answer by exact URI, and every other URI
 * goes to the Skills reader when the backend has one.
 */

/** Per-principal data: only the requesting client may cache it, briefly. */
export const RESOURCE_CACHE_HINT = { ttlMs: 30_000, cacheScope: 'private' } as const;

export type StaticResource = {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  _meta?: Record<string, unknown>;
  read(): ReadResourceResult['contents'];
};

export type ResourceReader = (uri: unknown, ctx: ServerContext) => Promise<ReadResourceResult>;

/**
 * Advertises `resources` and installs list/read handlers. Must run once, before the server
 * connects. `resources/templates/list` answers empty so the advertised capability is complete.
 */
export function installResourceHandlers(server: McpServer, statics: readonly StaticResource[], fallback?: ResourceReader): void {
  const byUri = new Map(statics.map((resource) => [resource.uri, resource]));
  server.server.registerCapabilities({ resources: {} });

  server.server.setRequestHandler('resources/read', async (request, ctx): Promise<ReadResourceResult> => {
    const resource = typeof request.params.uri === 'string' ? byUri.get(request.params.uri) : undefined;
    if (resource) return { contents: resource.read(), ...RESOURCE_CACHE_HINT };
    if (fallback) return await fallback(request.params.uri, ctx);
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown resource URI');
  });

  // Skills are discovered through skills/list, not resources/list; only static resources are listed.
  const resources = statics.map(({ uri, name, title, description, mimeType, _meta }) => ({ uri, name, title, description, mimeType, ...(_meta ? { _meta } : {}) }));
  server.server.setRequestHandler('resources/list', (): ListResourcesResult => ({ resources, ...RESOURCE_CACHE_HINT }));
  server.server.setRequestHandler('resources/templates/list', (): ListResourceTemplatesResult => ({ resourceTemplates: [], ...RESOURCE_CACHE_HINT }));
}
