import { readFileSync } from 'node:fs';
import { RESOURCE_MIME_TYPE, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/server';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import {
  ToolResultSchema,
  WORKSPACE_EXPLORER_RESOURCE_URI,
  WORKSPACE_EXPLORER_TOOL_NAME,
  WorkspaceExplorerInputSchema,
  type ToolResult
} from '@cloud-harness/contracts';
import type { z } from 'zod';
import type { OperationBackend } from '../operation-backend.js';
import type { StaticResource } from '../mcp-resources.js';
import { resultToMcp } from '../mcp-response-text.js';

/**
 * MCP Apps workspace explorer: one render tool plus one versioned, self-contained HTML view.
 *
 * The tool reads `workspace_status` for the caller's principal and nothing else. The view never
 * talks to the API directly: it asks the host to call the existing read-only tools, so every read
 * goes through the same authentication, owner scoping and workspace checks as an agent's call.
 * The view holds no credential; its workspace and path selections are request inputs, not grants.
 * A new incompatible view ships under a new `-vN` URI so hosts never pair a cached view with a
 * tool result it does not understand.
 */

const DESCRIPTION = 'Show a read-only workspace explorer (file tree and preview, Git status and diff, task states) '
  + 'in hosts that render MCP Apps. Reads the workspace status for your principal; the explorer only calls read-only tools. '
  + 'Hosts without MCP Apps get the workspace status as text and can use files_list, git_diff and tasks_list directly.';

/**
 * The bundled view is a build output (`scripts/build-mcp-apps.mjs`), resolved against the package
 * root so it loads the same from `src/` under tests and from `dist/` in production. It is read on
 * first use and cached for the process; a missing bundle fails that read instead of process start.
 */
const bundleUrl = new URL('../../dist/mcp-apps/workspace-explorer-v1.html', import.meta.url);
let cachedHtml: string | undefined;
function explorerHtml(): string {
  if (cachedHtml === undefined) {
    try {
      cachedHtml = readFileSync(bundleUrl, 'utf8');
    } catch {
      throw new ProtocolError(ProtocolErrorCode.InternalError, 'Workspace explorer view is unavailable');
    }
  }
  return cachedHtml;
}

/** Hosts sandbox the view with no network origins: it makes no fetches and loads nothing remote. */
const RESOURCE_META = { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } };

export const WORKSPACE_EXPLORER_RESOURCE: StaticResource = {
  uri: WORKSPACE_EXPLORER_RESOURCE_URI,
  name: 'workspace-explorer-v1',
  title: 'Workspace explorer',
  description: 'Read-only Cloud Harness workspace explorer view for MCP Apps hosts.',
  mimeType: RESOURCE_MIME_TYPE,
  _meta: RESOURCE_META,
  read: () => [{ uri: WORKSPACE_EXPLORER_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: explorerHtml(), _meta: RESOURCE_META }]
};

export function registerWorkspaceExplorer(server: McpServer, backend: OperationBackend): void {
  registerAppTool(
    server,
    WORKSPACE_EXPLORER_TOOL_NAME,
    {
      title: 'Show workspace explorer',
      description: DESCRIPTION,
      inputSchema: WorkspaceExplorerInputSchema,
      outputSchema: ToolResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: {
        ui: { resourceUri: WORKSPACE_EXPLORER_RESOURCE_URI },
        'openai/outputTemplate': WORKSPACE_EXPLORER_RESOURCE_URI
      }
    },
    async (input, context) => resultToMcp(await showWorkspace(backend, input, context.mcpReq.signal))
  );
}

async function showWorkspace(backend: OperationBackend, input: z.infer<typeof WorkspaceExplorerInputSchema>, signal: AbortSignal): Promise<ToolResult> {
  const status = await backend.call('workspace_status', input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }, signal);
  if (!status.ok) return status;
  return {
    ...status,
    data: {
      view: input.view,
      ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
      workspace: status.data
    }
  };
}
