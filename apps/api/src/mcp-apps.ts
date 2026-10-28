import { readFileSync } from 'node:fs';
import {
  ProtocolError,
  ProtocolErrorCode,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type McpServer,
  type ReadResourceResult,
  type Resource
} from '@modelcontextprotocol/server';
import { MCP_APP_RESOURCE_MIME_TYPE, WORKSPACE_EXPLORER_UI_URI } from '@cloud-harness/contracts';

/**
 * MCP Apps UI resources and the server's single set of `resources/*` handlers. The UI is static,
 * versioned markup with no data, credentials, or remote origins: the view loads everything through
 * the host bridge by calling read-only tools, so the resource is the same for every caller.
 */

const ASSET_DIRECTORY = new URL('../mcp-apps/workspace-explorer/', import.meta.url);

function inline(template: string, marker: string, body: string, closingTag: string): string {
  // Inlined bodies must not end their own element early; the build fails rather than ship broken markup.
  if (body.toLowerCase().includes(closingTag)) throw new Error(`MCP App asset contains ${closingTag}`);
  if (!template.includes(marker)) throw new Error(`MCP App template lacks ${marker}`);
  return template.replace(marker, () => body);
}

/** Built once at startup: the explorer page with its stylesheet and module script inlined. */
export function buildWorkspaceExplorerHtml(directory: URL = ASSET_DIRECTORY): string {
  const template = readFileSync(new URL('index.html', directory), 'utf8');
  const style = readFileSync(new URL('explorer.css', directory), 'utf8');
  const script = readFileSync(new URL('explorer.js', directory), 'utf8');
  return inline(inline(template, '/*__CH_STYLE__*/', style, '</style'), '/*__CH_SCRIPT__*/', script, '</script');
}

const workspaceExplorerHtml = buildWorkspaceExplorerHtml();

/**
 * `_meta.ui` for the resource: no connect, resource, or frame origins (the view fetches nothing
 * itself) and a border, since the explorer is a framed panel.
 */
const UI_RESOURCE_META = { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] }, prefersBorder: true } };

type AppResource = Resource & { mimeType: string; text: string };

const APP_RESOURCES: readonly AppResource[] = [{
  uri: WORKSPACE_EXPLORER_UI_URI,
  name: 'workspace-explorer-v1',
  title: 'Cloud Harness workspace explorer',
  description: 'Read-only MCP Apps view for one workspace: file tree and preview, Git status and diff, task states.',
  mimeType: MCP_APP_RESOURCE_MIME_TYPE,
  text: workspaceExplorerHtml,
  _meta: UI_RESOURCE_META
}];

/** Listings stay per-principal for skills; the static UI entries are identical for everyone. */
const LIST_CACHE_HINT = { ttlMs: 30_000, cacheScope: 'private' } as const;
const APP_CACHE_HINT = { ttlMs: 300_000, cacheScope: 'public' } as const;

/** Tool `_meta` linking a tool to its UI, in the current and the legacy flat key form. */
export function uiToolMeta(resourceUri: string): Record<string, unknown> {
  return { ui: { resourceUri, visibility: ['model', 'app'] }, 'ui/resourceUri': resourceUri };
}

export type ResourceFallback = (uri: unknown, signal: AbortSignal) => Promise<ReadResourceResult>;

/**
 * Advertises `resources` and installs the server's only `resources/read`, `resources/list`, and
 * `resources/templates/list` handlers. App UI resources answer first; every other URI goes to
 * `fallback` (the Skills extension) or is rejected. Must run before the server connects.
 */
export function registerResourceHandlers(server: McpServer, fallback?: ResourceFallback): void {
  server.server.registerCapabilities({ resources: {} });

  server.server.setRequestHandler('resources/read', async (request, ctx): Promise<ReadResourceResult> => {
    const app = APP_RESOURCES.find((resource) => resource.uri === request.params.uri);
    if (app) return { contents: [{ uri: app.uri, mimeType: app.mimeType, text: app.text, _meta: app._meta }], ...APP_CACHE_HINT };
    if (fallback) return await fallback(request.params.uri, ctx.mcpReq.signal);
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown resource URI');
  });

  // Skills are discovered through skills/list, not resources/list; only app UI resources are listed.
  server.server.setRequestHandler('resources/list', (): ListResourcesResult => ({
    resources: APP_RESOURCES.map(({ uri, name, title, description, mimeType, _meta }) => ({ uri, name, title, description, mimeType, _meta })),
    ...LIST_CACHE_HINT
  }));
  server.server.setRequestHandler('resources/templates/list', (): ListResourceTemplatesResult => ({ resourceTemplates: [], ...LIST_CACHE_HINT }));
}
