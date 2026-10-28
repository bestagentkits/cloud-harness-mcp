import { z } from 'zod';
import { WorkspaceIdSchema } from './identifiers.js';
import type { RunnerOperation } from './runner-api.js';

/**
 * MCP Apps (`io.modelcontextprotocol/ui`) surface: one versioned, read-only workspace explorer.
 * The UI resource is static and carries no data or credentials; every view it shows comes from
 * the existing tools below, called through the host bridge under the caller's own MCP
 * authorization. A breaking UI change ships under a new `-vN` URI.
 */
export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';
export const MCP_APP_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
export const WORKSPACE_EXPLORER_UI_URI = 'ui://cloud-harness/workspace-explorer-v1.html';
export const WORKSPACE_EXPLORER_TOOL = 'workspace_show_ui';

/**
 * The only tools the explorer calls. All are runner read operations; the explorer never offers
 * execution, mutation, lifecycle, or downstream gateway tools.
 */
export const WORKSPACE_EXPLORER_READ_TOOLS = [
  'workspace_status',
  'files_list',
  'files_read',
  'git_status',
  'git_diff',
  'tasks_list',
  'tasks_status',
  'tasks_graph'
] as const satisfies readonly RunnerOperation[];

export const WorkspaceShowUiInputSchema = z.object({
  workspaceId: WorkspaceIdSchema.describe('Workspace to inspect. The explorer stays bound to it; it cannot switch workspaces.')
}).strict();

export const WORKSPACE_EXPLORER_TOOL_SPEC = {
  name: WORKSPACE_EXPLORER_TOOL,
  title: 'Show workspace explorer',
  description: 'Open a read-only interactive explorer for one workspace (file tree and bounded preview, Git status and diff, task states) in MCP Apps hosts. '
    + 'Returns the same result as workspace_status, so clients without MCP Apps get a text summary; use files_list, files_read, git_status, git_diff, and tasks_list directly there.',
  inputSchema: WorkspaceShowUiInputSchema,
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false
} as const;
