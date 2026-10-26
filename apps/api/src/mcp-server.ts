import { McpServer, type AuthInfo, type CallToolResult, type McpRequestContext } from '@modelcontextprotocol/server';
import {
  ApiKeyIdSchema,
  TOOL_SPECS,
  ToolResultSchema,
  WorkspaceIdSchema,
  type RunnerOperation,
  type RunnerPrincipalSelector,
  type RunnerResponse,
  type ToolResult,
  type WorkspaceId
} from '@cloud-harness/contracts';
import { principalFromAuthInfo } from './auth.js';
import { RunnerClient } from './runner-client.js';
import type { OperationBackend, SkillsExtensionOperation } from './operation-backend.js';
import { formatToolResultText } from './mcp-response-text.js';
import { registerSkillsExtension, supportsSkillsExtension } from './skills-extension.js';
import { registerEventsExtension, type EventsBackend } from './events/events-extension.js';
import type { WebhookSender } from './events/webhook-sender.js';

/** MCP Events wiring; absent (no `events` capability) unless the API runs its delivery egress. */
export type EventsOptions = { sender: WebhookSender };

export function resultToMcp(result: ToolResult): CallToolResult {
  return {
    content: [{ type: 'text', text: formatToolResultText(result) }],
    structuredContent: result,
    isError: !result.ok
  };
}

export class RunnerOperationBackend implements OperationBackend {
  /**
   * `skillsWorkspaceId` binds the Skills extension to one workspace. It comes only from the
   * workspace-bound endpoint's URL path and is applied after the request input, so no client
   * parameter can override it. The runner reauthorizes the binding on every call.
   */
  constructor(
    private readonly client: RunnerClient,
    private readonly principal?: RunnerPrincipalSelector,
    private readonly skillsWorkspaceId?: WorkspaceId,
    eventsOptions?: EventsOptions & { apiKeyId?: string | undefined }
  ) {
    if (eventsOptions) {
      const principal = this.principal;
      this.events = {
        sender: eventsOptions.sender,
        authenticated: principal !== undefined,
        apiKeyId: eventsOptions.apiKeyId,
        call: async (operation, input, signal) => {
          if (!principal) return { ok: false, error: { code: 'FORBIDDEN', message: 'Authentication context unavailable' } };
          return await client.callEvents({ version: 1, principal, operation, input } as Parameters<RunnerClient['callEvents']>[0], signal);
        }
      };
    }
  }

  readonly events?: EventsBackend;

  async call(operation: RunnerOperation, input: Record<string, unknown>, signal?: AbortSignal): Promise<RunnerResponse> {
    if (!this.principal) return unauthenticated();
    return await this.client.call(operation, input, this.principal, signal);
  }

  async callSkillsExtension(operation: SkillsExtensionOperation, input: Record<string, unknown>, signal?: AbortSignal): Promise<RunnerResponse> {
    if (!this.principal) return unauthenticated();
    const scoped: Record<string, unknown> = { ...input };
    delete scoped.workspaceId;
    if (this.skillsWorkspaceId !== undefined) scoped.workspaceId = this.skillsWorkspaceId;
    return await this.client.callInternal(operation, scoped, this.principal, signal);
  }
}

function unauthenticated(): RunnerResponse {
  return {
    ok: false,
    message: 'Authentication context unavailable',
    error: { code: 'AUTHENTICATION_FAILED', message: 'Authentication context unavailable', retryable: false },
    truncated: false
  };
}

const DEFAULT_INSTRUCTIONS = 'Open an owner-bound workspace first, pass its opaque workspaceId to later tools, and close it when finished. '
  + 'Before planning work, call skills_list and read the matching skill with skills_read; skills that ship a script are run through skills_run with the digest that skills_list returned.';

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
    { name: 'cloud-harness-mcp', version: '0.76.2' },
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
  if (supportsSkillsExtension(backend)) registerSkillsExtension(server, backend);
  if (backend.events) registerEventsExtension(server, backend.events);
  return server;
}

/** Managed API key behind the request, set only by the API-key authentication lane. */
function eventsFor(authInfo: AuthInfo | undefined, events: EventsOptions | undefined): (EventsOptions & { apiKeyId?: string }) | undefined {
  if (!events) return undefined;
  const apiKeyId = ApiKeyIdSchema.safeParse(authInfo?.extra?.apiKeyId);
  return apiKeyId.success ? { ...events, apiKeyId: apiKeyId.data } : events;
}

export function createCloudHarnessServerFactory(client: RunnerClient, events?: EventsOptions): (context: McpRequestContext) => McpServer {
  return (context) => createCloudHarnessServer(new RunnerOperationBackend(
    client, principalFromAuthInfo(context.authInfo), undefined, eventsFor(context.authInfo, events)
  ));
}

/**
 * The workspace binding travels with the request's server-side authentication context: the API
 * sets it from the validated URL path after authentication, and clients cannot reach `authInfo`.
 * Each request carries its own copy, so concurrent requests never share a binding.
 */
const WORKSPACE_BINDING_KEY = 'cloudHarnessSkillsWorkspace';

export function bindWorkspace(authInfo: AuthInfo, workspaceId: WorkspaceId): AuthInfo {
  return { ...authInfo, extra: { ...authInfo.extra, [WORKSPACE_BINDING_KEY]: workspaceId } };
}

/**
 * Serves the same tools as the unbound endpoint, with the Skills extension bound to the workspace
 * named by the endpoint path. A request without a valid binding fails closed instead of falling
 * back to the unbound skill set.
 */
export function createWorkspaceBoundServerFactory(client: RunnerClient, events?: EventsOptions): (context: McpRequestContext) => McpServer {
  return (context) => {
    const workspaceId = WorkspaceIdSchema.safeParse(context.authInfo?.extra?.[WORKSPACE_BINDING_KEY]);
    if (!workspaceId.success) throw new Error('Workspace binding unavailable');
    return createCloudHarnessServer(new RunnerOperationBackend(
      client, principalFromAuthInfo(context.authInfo), workspaceId.data, eventsFor(context.authInfo, events)
    ));
  };
}
