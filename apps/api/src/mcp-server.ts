import { McpServer, type CallToolResult, type McpRequestContext } from '@modelcontextprotocol/server';
import { TOOL_SPECS, ToolResultSchema, type RunnerPrincipalSelector, type ToolResult } from '@cloud-harness/contracts';
import { principalFromAuthInfo } from './auth.js';
import type { RunnerClient } from './runner-client.js';

function resultToMcp(result: ToolResult): CallToolResult {
  return {
    content: [{ type: 'text', text: result.message }],
    structuredContent: result,
    isError: !result.ok
  };
}

export function createCloudHarnessServer(client: RunnerClient, principal?: RunnerPrincipalSelector): McpServer {
  const server = new McpServer(
    { name: 'cloud-harness-mcp', version: '0.6.0' },
    { instructions: 'Open an owner-bound workspace first, pass its opaque workspaceId to later tools, and close it when finished.' }
  );
  for (const spec of TOOL_SPECS) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema as any,
        outputSchema: ToolResultSchema,
        annotations: {
          readOnlyHint: spec.readOnly,
          destructiveHint: spec.destructive,
          idempotentHint: spec.idempotent,
          openWorldHint: spec.openWorld
        }
      },
      async (input, context) => {
        if (!principal) return resultToMcp({ ok: false, message: 'Authentication context unavailable', error: { code: 'AUTHENTICATION_FAILED', message: 'Authentication context unavailable', retryable: false }, truncated: false });
        return resultToMcp(await client.call(spec.name, input as Record<string, unknown>, principal, context.mcpReq.signal));
      }
    );
  }
  return server;
}

export function createCloudHarnessServerFactory(client: RunnerClient): (context: McpRequestContext) => McpServer {
  return (context) => createCloudHarnessServer(client, principalFromAuthInfo(context.authInfo));
}
