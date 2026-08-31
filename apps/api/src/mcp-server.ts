import { McpServer, type CallToolResult, type McpRequestContext } from '@modelcontextprotocol/server';
import {
  TOOL_SPECS,
  ToolResultSchema,
  type RunnerOperation,
  type RunnerPrincipalSelector,
  type RunnerResponse,
  type ToolResult
} from '@cloud-harness/contracts';
import { principalFromAuthInfo } from './auth.js';
import { RunnerClient } from './runner-client.js';
import type { OperationBackend } from './operation-backend.js';
import { formatToolResultText } from './mcp-response-text.js';

function resultToMcp(result: ToolResult): CallToolResult {
  return {
    content: [{ type: 'text', text: formatToolResultText(result) }],
    structuredContent: result,
    isError: !result.ok
  };
}

export class RunnerOperationBackend implements OperationBackend {
  constructor(
    private readonly client: RunnerClient,
    private readonly principal?: RunnerPrincipalSelector
  ) {}

  async call(operation: RunnerOperation, input: Record<string, unknown>, signal?: AbortSignal): Promise<RunnerResponse> {
    if (!this.principal) {
      return {
        ok: false,
        message: 'Authentication context unavailable',
        error: { code: 'AUTHENTICATION_FAILED', message: 'Authentication context unavailable', retryable: false },
        truncated: false
      };
    }
    return await this.client.call(operation, input, this.principal, signal);
  }
}

const DEFAULT_INSTRUCTIONS = 'Open an owner-bound workspace first, pass its opaque workspaceId to later tools, and close it when finished.';

export function createCloudHarnessServer(
  backendOrClient: OperationBackend | RunnerClient,
  principalOrInstructions?: RunnerPrincipalSelector | string,
  maybeInstructions?: string
): McpServer {
  let backend: OperationBackend;
  let instructions = DEFAULT_INSTRUCTIONS;

  if (backendOrClient instanceof RunnerClient) {
    const principal = typeof principalOrInstructions === 'object' && principalOrInstructions !== null ? principalOrInstructions : undefined;
    instructions = typeof maybeInstructions === 'string' ? maybeInstructions : (typeof principalOrInstructions === 'string' ? principalOrInstructions : DEFAULT_INSTRUCTIONS);
    backend = new RunnerOperationBackend(backendOrClient, principal);
  } else {
    backend = backendOrClient;
    instructions = typeof principalOrInstructions === 'string' ? principalOrInstructions : (backend.getInstructions?.() ?? DEFAULT_INSTRUCTIONS);
  }

  const server = new McpServer(
    { name: 'cloud-harness-mcp', version: '0.35.2' },
    { instructions }
  );

  for (const spec of TOOL_SPECS) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
        outputSchema: ToolResultSchema,
        annotations: {
          readOnlyHint: spec.readOnly,
          destructiveHint: spec.destructive,
          idempotentHint: spec.idempotent,
          openWorldHint: spec.openWorld
        }
      },
      async (input, context) => {
        return resultToMcp(await backend.call(spec.name, input as Record<string, unknown>, context.mcpReq.signal));
      }
    );
  }
  return server;
}

export function createCloudHarnessServerFactory(client: RunnerClient): (context: McpRequestContext) => McpServer {
  return (context) => createCloudHarnessServer(new RunnerOperationBackend(client, principalFromAuthInfo(context.authInfo)));
}
