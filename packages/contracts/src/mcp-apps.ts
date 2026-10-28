import { z } from 'zod';
import { WorkspaceIdSchema } from './identifiers.js';
import { RepositorySelectorSchema } from './tool-schemas.js';

/**
 * MCP Apps surface: render tools that hosts with MCP Apps support show as an inline view. They sit
 * beside the native workspace tools without changing them; hosts without MCP Apps get a text
 * result. The view resource URI carries a version, so an incompatible view ships under a new URI.
 */
export const WORKSPACE_EXPLORER_TOOL_NAME = 'workspace_show_ui';
export const WORKSPACE_EXPLORER_RESOURCE_URI = 'ui://cloud-harness/workspace-explorer-v1.html';

/** The native read-only tools the workspace explorer view calls. It calls nothing else. */
export const WORKSPACE_EXPLORER_READ_TOOLS = [
  'workspace_status', 'files_list', 'files_read', 'git_status', 'git_diff', 'tasks_list', 'tasks_status', 'tasks_graph'
] as const;

export const WorkspaceExplorerViewSchema = z.enum(['files', 'git', 'tasks']);
export const WorkspaceExplorerInputSchema = z.object({
  workspaceId: WorkspaceIdSchema.optional().describe('Workspace to show; defaults to the single active workspace.'),
  repositoryId: RepositorySelectorSchema.optional().describe('Repository of a multi-repository workspace, by repo_ id or alias.'),
  view: WorkspaceExplorerViewSchema.default('files').describe('Initial view: files, git, or tasks.')
});

export const MCP_APP_TOOL_SCHEMA_BY_NAME = { [WORKSPACE_EXPLORER_TOOL_NAME]: WorkspaceExplorerInputSchema } as const;
export type McpAppToolName = keyof typeof MCP_APP_TOOL_SCHEMA_BY_NAME;
export const MCP_APP_TOOL_NAMES = Object.keys(MCP_APP_TOOL_SCHEMA_BY_NAME) as McpAppToolName[];
