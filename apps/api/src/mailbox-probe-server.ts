import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { McpServer, type CallToolResult, type McpRequestContext } from '@modelcontextprotocol/server';
import { ToolResultSchema, type RunnerPrincipalSelector, type ToolResult } from '@cloud-harness/contracts';
import { z } from 'zod';
import { principalFromAuthInfo } from './auth.js';
import { MAILBOX_PROBE_RESOURCE_URI, MCP_APP_RESOURCE_MIME_TYPE, mailboxProbeWidgetHtml } from './mailbox-probe-widget-resource.js';
import type { RunnerClient } from './runner-client.js';
type MailboxProbeRunnerClient = Pick<RunnerClient, 'call'>;


const capabilityHash = (capability: string) => createHash('sha256').update(capability).digest();
const secret = () => randomBytes(32).toString('base64url');
const sessionId = () => `mbp_${randomBytes(18).toString('base64url')}`;
const requestId = () => `mpr_${randomBytes(18).toString('base64url')}`;
const RESOURCE_META = {
  ui: {
    prefersBorder: true,
    csp: { connectDomains: [], resourceDomains: [] }
  },
  'openai/widgetDescription': 'A Cloud Harness mailbox probe that checks widget-private metadata, app-only polling, PiP continuity, and autonomous follow-up turns.',
  'openai/widgetPrefersBorder': true,
  'openai/widgetCSP': { connect_domains: [], resource_domains: [] }
} as const;

type ProbeRequest = { id: string; prompt: string; availableAt: number; deliveredAt?: number; completedAt?: number };
type ProbeSession = {
  id: string;
  principalKey: string;
  capabilityHash: Buffer;
  requests: ProbeRequest[];
  nextRequest: number;
  firstSubmitAt?: number;
};

const ProbeSubmitInputSchema = z.object({
  version: z.literal(1),
  requestId: z.string().regex(/^mpr_[A-Za-z0-9_-]{20,}$/),
  status: z.literal('completed'),
  message: z.object({
    role: z.literal('assistant'),
    content: z.array(z.object({ type: z.literal('output_text'), text: z.string().min(1).max(4_000) }).strict()).min(1).max(8)
  }).strict(),
  finishReason: z.literal('stop'),
  data: z.null(),
  error: z.null()
}).strict();

type ProbeSubmitInput = z.infer<typeof ProbeSubmitInputSchema>;

const ReceiveInputSchema = z.object({
  sessionId: z.string().regex(/^mbp_[A-Za-z0-9_-]{20,}$/),
  capability: z.string().min(32).max(128),
  waitMs: z.number().int().min(0).max(20_000).default(0)
}).strict();

type ReceiveInput = z.infer<typeof ReceiveInputSchema>;
const WorkspaceListInputSchema = z.object({ cursor: z.string().max(256).optional(), limit: z.number().int().min(1).max(500).default(100) }).strict();


function principalKey(principal: RunnerPrincipalSelector): string {
  return principal.kind === 'owner'
    ? `owner:${principal.ownerId}`
    : `external:${principal.issuer}:${principal.subject}`;
}

function resultToMcp(result: ToolResult): CallToolResult {
  return {
    content: [{ type: 'text', text: result.message }],
    structuredContent: result,
    isError: !result.ok
  };
}

function authError(): CallToolResult {
  return resultToMcp({
    ok: false,
    message: 'Authentication context unavailable',
    error: { code: 'AUTHENTICATION_FAILED', message: 'Authentication context unavailable', retryable: false },
    truncated: false
  });
}

function makeSession(principal: RunnerPrincipalSelector): { session: ProbeSession; capability: string } {
  const capability = secret();
  const now = Date.now();
  const session: ProbeSession = {
    id: sessionId(),
    principalKey: principalKey(principal),
    capabilityHash: capabilityHash(capability),
    nextRequest: 0,
    requests: [{
      id: requestId(),
      prompt: 'Probe turn 1: call agent_probe_submit with a strict ProbeResponseV1 object and no native-text-only completion.',
      availableAt: now + 25
    }]
  };
  return { session, capability };
}

function verifySession(sessions: Map<string, ProbeSession>, input: ReceiveInput, principal: RunnerPrincipalSelector): ProbeSession | undefined {
  const session = sessions.get(input.sessionId);
  if (!session || session.principalKey !== principalKey(principal)) return undefined;
  const presented = capabilityHash(input.capability);
  if (presented.length !== session.capabilityHash.length || !timingSafeEqual(presented, session.capabilityHash)) return undefined;
  return session;
}

function nextAvailableRequest(session: ProbeSession): ProbeRequest | undefined {
  const candidate = session.requests[session.nextRequest];
  if (!candidate || candidate.availableAt > Date.now()) return undefined;
  candidate.deliveredAt ??= Date.now();
  return candidate;
}

async function receiveProbe(session: ProbeSession, waitMs: number, signal?: AbortSignal): Promise<CallToolResult> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const request = nextAvailableRequest(session);
    if (request) {
      return {
        content: [{ type: 'text', text: `Mailbox probe request ${request.id} received.` }],
        structuredContent: {
          received: true,
          sessionId: session.id,
          request: { id: request.id, prompt: request.prompt }
        }
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        content: [{ type: 'text', text: 'No mailbox probe request is ready.' }],
        structuredContent: { received: false, sessionId: session.id }
      };
    }
    await delay(Math.min(remaining, 50), undefined, { signal });
  }
}

function submitProbe(sessions: Map<string, ProbeSession>, input: ProbeSubmitInput, principal: RunnerPrincipalSelector): CallToolResult {
  for (const session of sessions.values()) {
    if (session.principalKey !== principalKey(principal)) continue;
    const request = session.requests.find((candidate) => candidate.id === input.requestId);
    if (!request || request.completedAt) continue;
    request.completedAt = Date.now();
    if (session.nextRequest === 0) {
      session.nextRequest = 1;
      session.firstSubmitAt = request.completedAt;
      session.requests.push({
        id: requestId(),
        prompt: 'Probe turn 2: call agent_probe_submit again, proving the widget resumed polling after the first autonomous turn settled.',
        availableAt: request.completedAt + 25
      });
    } else {
      session.nextRequest += 1;
    }
    return {
      content: [{ type: 'text', text: `Probe response accepted for ${input.requestId}.` }],
      structuredContent: {
        accepted: true,
        requestId: input.requestId,
        nextRequestReady: session.nextRequest < session.requests.length,
        firstSubmitAt: session.firstSubmitAt
      }
    };
  }
  return {
    content: [{ type: 'text', text: `Probe request ${input.requestId} is unavailable or already completed.` }],
    structuredContent: { accepted: false, requestId: input.requestId },
    isError: true
  };
}

export function createMailboxProbeServer(client: MailboxProbeRunnerClient, sessions: Map<string, ProbeSession>, principal?: RunnerPrincipalSelector): McpServer {
  const server = new McpServer(
    { name: 'cloud-harness-mailbox-probe', version: '0.17.0' },
    { instructions: 'Mailbox probe profile only: open the probe widget, let it poll, and answer probe requests only through agent_probe_submit.' }
  );

  server.registerResource(
    'Cloud Harness Mailbox Probe Widget',
    MAILBOX_PROBE_RESOURCE_URI,
    {
      title: 'Cloud Harness Mailbox Probe',
      description: 'Interactive mailbox capability probe widget.',
      mimeType: MCP_APP_RESOURCE_MIME_TYPE,
      _meta: RESOURCE_META
    },
    async () => ({
      contents: [{
        uri: MAILBOX_PROBE_RESOURCE_URI,
        mimeType: MCP_APP_RESOURCE_MIME_TYPE,
        text: mailboxProbeWidgetHtml(),
        _meta: RESOURCE_META
      }]
    })
  );

  server.registerTool(
    'mailbox_probe_open',
    {
      title: 'Open Mailbox Probe',
      description: 'Mounts the Cloud Harness mailbox capability probe widget.',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ sessionId: z.string(), resourceUri: z.string(), privateMetadataVisibleToWidget: z.literal(true) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: {
        ui: { resourceUri: MAILBOX_PROBE_RESOURCE_URI, visibility: ['model', 'app'] },
        'ui/resourceUri': MAILBOX_PROBE_RESOURCE_URI,
        'openai/outputTemplate': MAILBOX_PROBE_RESOURCE_URI,
        'openai/toolInvocation/invoking': 'Opening probe',
        'openai/toolInvocation/invoked': 'Probe opened'
      }
    },
    async () => {
      if (!principal) return authError();
      const created = makeSession(principal);
      sessions.set(created.session.id, created.session);
      return {
        content: [{
          type: 'resource_link',
          uri: MAILBOX_PROBE_RESOURCE_URI,
          name: 'Cloud Harness Mailbox Probe',
          mimeType: MCP_APP_RESOURCE_MIME_TYPE,
          description: 'Mailbox probe widget'
        }],
        structuredContent: {
          sessionId: created.session.id,
          resourceUri: MAILBOX_PROBE_RESOURCE_URI,
          privateMetadataVisibleToWidget: true
        },
        _meta: {
          mailboxProbeSessionId: created.session.id,
          mailboxProbeCapability: created.capability,
          mailboxProbePrivateMarker: 'widget-only'
        }
      } satisfies CallToolResult;
    }
  );

  server.registerTool(
    'mailbox_probe_receive',
    {
      title: 'Receive Mailbox Probe Request',
      description: 'App-only bounded long poll for one in-memory mailbox probe request.',
      inputSchema: ReceiveInputSchema,
      outputSchema: z.object({
        received: z.boolean(),
        sessionId: z.string(),
        request: z.object({ id: z.string(), prompt: z.string() }).strict().optional()
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: {
        ui: { resourceUri: MAILBOX_PROBE_RESOURCE_URI, visibility: ['app'] },
        'ui/resourceUri': MAILBOX_PROBE_RESOURCE_URI,
        'openai/widgetAccessible': true,
        'openai/visibility': 'private'
      }
    },
    async (input, context) => {
      if (!principal) return authError();
      const parsed = ReceiveInputSchema.parse(input);
      const session = verifySession(sessions, parsed, principal);
      if (!session) {
        return {
          content: [{ type: 'text', text: 'Mailbox probe capability rejected.' }],
          structuredContent: { received: false, sessionId: parsed.sessionId },
          isError: true
        };
      }
      return await receiveProbe(session, parsed.waitMs, context.mcpReq.signal);
    }
  );

  server.registerTool(
    'agent_probe_submit',
    {
      title: 'Submit Probe Response',
      description: 'Submit the strict ProbeResponseV1 required by the mailbox capability probe.',
      inputSchema: ProbeSubmitInputSchema,
      outputSchema: z.object({ accepted: z.boolean(), requestId: z.string(), nextRequestReady: z.boolean().optional(), firstSubmitAt: z.number().optional() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (input) => {
      if (!principal) return authError();
      return submitProbe(sessions, ProbeSubmitInputSchema.parse(input), principal);
    }
  );

  server.registerTool(
    'workspace_list',
    {
      title: 'List Workspaces',
      description: 'Harmless read-only Cloud Harness capability included for probe discovery boundary checks.',
      inputSchema: WorkspaceListInputSchema,
      outputSchema: ToolResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (input, context) => {
      if (!principal) return authError();
      const parsed = WorkspaceListInputSchema.parse(input);
      const runnerInput: Record<string, unknown> = { ...parsed };
      return resultToMcp(await client.call('workspace_list', runnerInput, principal, context.mcpReq.signal));
    }
  );

  return server;
}

export function createMailboxProbeServerFactory(client: MailboxProbeRunnerClient): (context: McpRequestContext) => McpServer {
  const sessions = new Map<string, ProbeSession>();
  return (context) => createMailboxProbeServer(client, sessions, principalFromAuthInfo(context.authInfo));
}
