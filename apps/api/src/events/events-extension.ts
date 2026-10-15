import { ProtocolError, ProtocolErrorCode, type McpServer } from '@modelcontextprotocol/server';
import {
  MCP_EVENT_DEFINITIONS,
  MCP_EVENT_DEFINITION_BY_NAME,
  MCP_EVENTS_ERROR_CODES,
  MCP_EVENTS_LIMITS,
  McpEventDeliveryStatusSchema,
  McpEventsRunnerDataSchemas,
  WebhookSecretSchema,
  type McpEventsRunnerRequest,
  type McpEventsRunnerResponse
} from '@cloud-harness/contracts';
import { z } from 'zod';
import { parseCallbackUrl, type WebhookSender } from './webhook-sender.js';

/**
 * MCP Events (webhook delivery) adapter. The runner owns subscription storage, ownership checks,
 * quotas, and the outbox; this module validates the wire shape, refuses unsafe callback URLs,
 * runs the signed verification handshake from the API egress lane, and maps runner errors onto
 * the events JSON-RPC codes. Subscriptions are only ever created by an explicit client call.
 */

type PrincipalScopedOperation = 'events_prepare' | 'events_subscribe' | 'events_unsubscribe';
type PrincipalScopedRequest = Extract<McpEventsRunnerRequest, { operation: PrincipalScopedOperation }>;

export interface EventsBackend {
  readonly sender: WebhookSender;
  /** False when the request carries no authenticated principal; every events call is then Forbidden. */
  readonly authenticated: boolean;
  /** Managed API key the request authenticated with, so the runner can stop delivery when it is revoked. */
  readonly apiKeyId?: string | undefined;
  call(operation: PrincipalScopedOperation, input: PrincipalScopedRequest['input'], signal?: AbortSignal): Promise<McpEventsRunnerResponse>;
}

const EventsListParamsSchema = z.object({ cursor: z.string().max(256).optional() }).optional();
const ArgumentsSchema = z.record(z.string(), z.unknown());

const SubscribeParamsSchema = z.object({
  name: z.string().min(1).max(200),
  arguments: ArgumentsSchema.optional(),
  delivery: z.object({
    mode: z.string().min(1).max(50),
    url: z.string().min(1).max(4_096),
    secret: z.string().max(200).optional()
  }),
  // No replay is offered: the cursor and replay bound are accepted and answered with `cursor: null`.
  cursor: z.string().max(1_024).nullable().optional(),
  maxAgeMs: z.number().int().nonnegative().optional(),
  ttlMs: z.number().int().nonnegative().nullable().optional()
});

const UnsubscribeParamsSchema = z.object({
  name: z.string().min(1).max(200),
  arguments: ArgumentsSchema.optional(),
  delivery: z.object({ url: z.string().min(1).max(4_096) })
});

const EventDescriptorSchema = z.object({
  name: z.string(),
  description: z.string(),
  delivery: z.array(z.literal('webhook')),
  inputSchema: z.record(z.string(), z.unknown()),
  payloadSchema: z.record(z.string(), z.unknown())
});

const ListResultSchema = z.object({ events: z.array(EventDescriptorSchema), resultType: z.literal('complete') });
const SubscribeResultSchema = z.object({
  id: z.string(),
  refreshBefore: z.string().nullable(),
  cursor: z.null(),
  truncated: z.literal(false),
  deliveryStatus: McpEventDeliveryStatusSchema.optional(),
  resultType: z.literal('complete')
});
const UnsubscribeResultSchema = z.object({ resultType: z.literal('complete') });

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  delete generated.$schema;
  return generated;
}

/** Built once: the definitions are static. */
const EVENT_DESCRIPTORS = MCP_EVENT_DEFINITIONS.map((definition) => ({
  name: definition.name,
  description: definition.description,
  delivery: ['webhook' as const],
  inputSchema: jsonSchema(definition.arguments),
  payloadSchema: jsonSchema(definition.payload)
}));

const forbidden = () => new ProtocolError(MCP_EVENTS_ERROR_CODES.forbidden, 'Events require an authenticated principal');
const unavailable = () => new ProtocolError(ProtocolErrorCode.InternalError, 'Events are temporarily unavailable');
const unknownEvent = (name: string) => new ProtocolError(MCP_EVENTS_ERROR_CODES.notFound, `Unknown event: ${name.slice(0, 200)}`, { kind: 'event' });

async function invoke<T>(
  backend: EventsBackend,
  operation: PrincipalScopedOperation,
  input: PrincipalScopedRequest['input'],
  schema: z.ZodType<T>,
  signal: AbortSignal
): Promise<T> {
  let response: McpEventsRunnerResponse;
  try {
    response = await backend.call(operation, input, signal);
  } catch {
    throw unavailable();
  }
  if (signal.aborted) throw new ProtocolError(ProtocolErrorCode.InternalError, 'Request cancelled');
  if (!response.ok) {
    const { code, message } = response.error;
    switch (code) {
      case 'INVALID_INPUT': throw new ProtocolError(ProtocolErrorCode.InvalidParams, message);
      case 'NOT_FOUND': throw new ProtocolError(MCP_EVENTS_ERROR_CODES.notFound, message, { kind: 'event' });
      case 'FORBIDDEN': throw new ProtocolError(MCP_EVENTS_ERROR_CODES.forbidden, message);
      case 'RESOURCE_EXHAUSTED': throw new ProtocolError(MCP_EVENTS_ERROR_CODES.resourceExhausted, message, {
        limit: 'subscriptions', max: MCP_EVENTS_LIMITS.maxSubscriptionsPerPrincipal
      });
      default: throw unavailable();
    }
  }
  const parsed = schema.safeParse(response.data);
  if (!parsed.success) throw unavailable();
  return parsed.data;
}

/** Advertises `capabilities.events` and installs the events handlers. Must run before the server connects. */
export function registerEventsExtension(server: McpServer, backend: EventsBackend): void {
  server.server.registerCapabilities({ events: {} } as Parameters<typeof server.server.registerCapabilities>[0]);

  server.server.setRequestHandler('events/list', { params: EventsListParamsSchema, result: ListResultSchema }, () => ({
    events: EVENT_DESCRIPTORS,
    resultType: 'complete' as const
  }));

  server.server.setRequestHandler('events/subscribe', { params: SubscribeParamsSchema, result: SubscribeResultSchema }, async (params, ctx) => {
    if (!backend.authenticated) throw forbidden();
    if (!MCP_EVENT_DEFINITION_BY_NAME.has(params.name)) throw unknownEvent(params.name);
    const name = MCP_EVENT_DEFINITION_BY_NAME.get(params.name)!.name;
    if (params.delivery.mode !== 'webhook') {
      throw new ProtocolError(MCP_EVENTS_ERROR_CODES.unsupported, 'Only webhook delivery is supported', {
        feature: 'deliveryMode', value: params.delivery.mode.slice(0, 50)
      });
    }
    const secret = WebhookSecretSchema.safeParse(params.delivery.secret);
    if (!secret.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'delivery.secret must be whsec_ followed by base64 of 24-64 bytes');
    const check = await backend.sender.checkUrl(params.delivery.url);
    if (!check.ok) throw new ProtocolError(ProtocolErrorCode.InvalidParams, check.message);
    const key = { name, arguments: params.arguments ?? {}, url: check.url };
    const signal = ctx.mcpReq.signal;

    const prepared = await invoke(backend, 'events_prepare', key, McpEventsRunnerDataSchemas.events_prepare, signal);
    let verifiedNow = false;
    if (!prepared.verified) {
      const verification = await backend.sender.verify({ url: check.url, subscriptionId: prepared.id, secrets: [secret.data], signal });
      if (!verification.ok) {
        throw new ProtocolError(MCP_EVENTS_ERROR_CODES.callbackEndpointError, 'Callback endpoint verification failed', { reason: verification.reason });
      }
      verifiedNow = true;
    }
    const subscribed = await invoke(backend, 'events_subscribe', {
      ...key,
      secret: secret.data,
      ...(params.ttlMs !== undefined ? { ttlMs: params.ttlMs } : {}),
      ...(backend.apiKeyId ? { apiKeyId: backend.apiKeyId } : {}),
      verified: verifiedNow
    }, McpEventsRunnerDataSchemas.events_subscribe, signal);
    return {
      id: subscribed.id,
      refreshBefore: subscribed.refreshBefore,
      cursor: null,
      truncated: false as const,
      ...(subscribed.deliveryStatus ? { deliveryStatus: subscribed.deliveryStatus } : {}),
      resultType: 'complete' as const
    };
  });

  server.server.setRequestHandler('events/unsubscribe', { params: UnsubscribeParamsSchema, result: UnsubscribeResultSchema }, async (params, ctx) => {
    if (!backend.authenticated) throw forbidden();
    const definition = MCP_EVENT_DEFINITION_BY_NAME.get(params.name);
    const url = parseCallbackUrl(params.delivery.url);
    // Idempotent: a key that could never have been stored has nothing to remove.
    if (definition && url.ok) {
      try {
        await invoke(backend, 'events_unsubscribe', { name: definition.name, arguments: params.arguments ?? {}, url: url.url },
          McpEventsRunnerDataSchemas.events_unsubscribe, ctx.mcpReq.signal);
      } catch (error) {
        // Arguments that fail validation could never have keyed a stored subscription.
        if (!(error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams)) throw error;
      }
    }
    return { resultType: 'complete' as const };
  });
}
