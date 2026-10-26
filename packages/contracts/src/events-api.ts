import { z } from 'zod';
import { ApiKeyIdSchema } from './api-key-api.js';
import { AgentIdSchema, TaskIdSchema, WorkspaceIdSchema } from './identifiers.js';
import { RunnerPrincipalSelectorSchema } from './runner-api.js';
import { NotificationCreatedPayloadSchema, NotificationKindSchema } from './notifications-api.js';

/**
 * MCP Events (webhook delivery) contract. The wire protocol follows the MCP Events design
 * sketch at the revision ChatGPT documents; the runner-facing schemas below are internal.
 */

export const MCP_EVENTS_PROTOCOL_VERSION = '2026-07-28';

/**
 * JSON-RPC error codes for the events methods. ChatGPT implements the design-sketch revision that
 * numbered these -32011..-32015; the sketch has since proposed -32023..-32027 (SEP-3415). Keep
 * every use behind this constant so a renumber is a single change.
 */
export const MCP_EVENTS_ERROR_CODES = {
  notFound: -32011,
  forbidden: -32012,
  resourceExhausted: -32013,
  unsupported: -32014,
  callbackEndpointError: -32015
} as const;

/** Server-generated callback failure categories; never raw endpoint responses. */
export const McpEventCallbackErrorSchema = z.enum([
  'connection_refused', 'timeout', 'tls_error', 'http_4xx', 'http_5xx', 'challenge_failed'
]);

export const MCP_EVENT_NAMES = [
  'cloudharness.task.completed',
  'cloudharness.task.failed',
  'cloudharness.agent.settled',
  'cloudharness.agent.failed',
  'cloudharness.automation.completed',
  'cloudharness.automation.failed',
  'cloudharness.notification.created'
] as const;
export const McpEventNameSchema = z.enum(MCP_EVENT_NAMES);

/** Webhook secret: `whsec_` + base64 of 24–64 random bytes (Standard Webhooks). */
export const WebhookSecretSchema = z.string().max(100).refine((value) => {
  if (!value.startsWith('whsec_')) return false;
  const encoded = value.slice('whsec_'.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) return false;
  const bytes = Buffer.from(encoded, 'base64').length;
  return bytes >= 24 && bytes <= 64;
}, 'secret must be whsec_ followed by base64 of 24-64 bytes');

export const McpEventCallbackUrlSchema = z.string().min(1).max(2_048);

export const TaskEventArgumentsSchema = z.object({
  workspaceId: WorkspaceIdSchema.optional().describe('Only tasks in this workspace (workspaceId from workspace_open). Omit to watch every workspace you own.'),
  taskId: TaskIdSchema.optional().describe('Only this task (taskId from tasks_run).')
}).strict();

export const AgentEventArgumentsSchema = z.object({
  workspaceId: WorkspaceIdSchema.optional().describe('Only agents in this workspace (workspaceId from workspace_open). Omit to watch every workspace you own.'),
  agentId: AgentIdSchema.optional().describe('Only this agent (agentId from agent_spawn).')
}).strict();

export const AutomationEventArgumentsSchema = z.object({
  ruleId: z.string().regex(/^arl_[a-f0-9]{32}$/u).optional().describe('Only workflows of this automation rule.'),
  workflowId: z.string().regex(/^wfl_[a-f0-9]{32}$/u).optional().describe('Only this automation workflow.')
}).strict();

export const NotificationEventArgumentsSchema = z.object({
  kind: NotificationKindSchema.optional().describe('Only notifications of this kind, for example automation.failed. Omit to receive every kind.')
}).strict();

export const TaskCompletedPayloadSchema = z.object({
  workspaceId: z.string(),
  taskId: z.string(),
  status: z.literal('SUCCEEDED'),
  exitCode: z.number().int().nullable(),
  finishedAt: z.string()
}).strict();

export const TaskFailedPayloadSchema = z.object({
  workspaceId: z.string(),
  taskId: z.string(),
  status: z.enum(['FAILED', 'CANCELLED', 'BLOCKED']),
  exitCode: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  finishedAt: z.string()
}).strict();

export const AgentSettledPayloadSchema = z.object({
  workspaceId: z.string(),
  agentId: z.string(),
  parentAgentId: z.string().nullable(),
  status: z.literal('SUCCEEDED'),
  terminalAt: z.string()
}).strict();

export const AgentFailedPayloadSchema = z.object({
  workspaceId: z.string(),
  agentId: z.string(),
  parentAgentId: z.string().nullable(),
  status: z.enum(['FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED']),
  outcomeUnknown: z.boolean(),
  terminalAt: z.string()
}).strict();

export const AutomationCompletedPayloadSchema = z.object({
  workflowId: z.string(),
  ruleId: z.string(),
  status: z.literal('COMPLETED'),
  workspaceId: z.string().nullable(),
  agentId: z.string().nullable(),
  terminalAt: z.string()
}).strict();

export const AutomationFailedPayloadSchema = z.object({
  workflowId: z.string(),
  ruleId: z.string(),
  status: z.enum(['FAILED', 'CANCELLED', 'EXPIRED']),
  workspaceId: z.string().nullable(),
  agentId: z.string().nullable(),
  errorCode: z.string().nullable(),
  terminalAt: z.string()
}).strict();

export type McpEventName = z.infer<typeof McpEventNameSchema>;

export type McpEventDefinition = {
  name: McpEventName;
  description: string;
  arguments: typeof TaskEventArgumentsSchema | typeof AgentEventArgumentsSchema | typeof AutomationEventArgumentsSchema | typeof NotificationEventArgumentsSchema;
  payload: z.ZodType;
};

export const MCP_EVENT_DEFINITIONS: readonly McpEventDefinition[] = [
  {
    name: 'cloudharness.task.completed',
    description: 'A durable task started with tasks_run exited successfully (status SUCCEEDED). Fires once per task; read its output with tasks_status.',
    arguments: TaskEventArgumentsSchema,
    payload: TaskCompletedPayloadSchema
  },
  {
    name: 'cloudharness.task.failed',
    description: 'A durable task ended without success: FAILED (non-zero exit, timeout, or runner restart), CANCELLED, or BLOCKED by a failed dependency. Fires once per task.',
    arguments: TaskEventArgumentsSchema,
    payload: TaskFailedPayloadSchema
  },
  {
    name: 'cloudharness.agent.settled',
    description: 'A managed agent reached its terminal SUCCEEDED state and released its runtime. A turn ending is not settlement; read the result with agent_status.',
    arguments: AgentEventArgumentsSchema,
    payload: AgentSettledPayloadSchema
  },
  {
    name: 'cloudharness.agent.failed',
    description: 'A managed agent reached a terminal state other than SUCCEEDED: FAILED, CANCELLED, TIMED_OUT, LIMIT_EXCEEDED, or INTERRUPTED (outcomeUnknown is true when its effects are uncertain).',
    arguments: AgentEventArgumentsSchema,
    payload: AgentFailedPayloadSchema
  },
  {
    name: 'cloudharness.automation.completed',
    description: 'A webhook-triggered automation workflow finished: its agent reached SUCCEEDED. Any configured GitHub comment is posted afterwards; read the result on the Dashboard Automations page.',
    arguments: AutomationEventArgumentsSchema,
    payload: AutomationCompletedPayloadSchema
  },
  {
    name: 'cloudharness.automation.failed',
    description: 'A webhook-triggered automation workflow ended without success: FAILED (workspace, profile, budget or agent failure), CANCELLED by the owner, or EXPIRED before it could start. errorCode names the cause.',
    arguments: AutomationEventArgumentsSchema,
    payload: AutomationFailedPayloadSchema
  },
  {
    name: 'cloudharness.notification.created',
    description: 'A notification entered your inbox: an automation or agent run finished, a workflow is waiting for a human, or an approval was decided. Carries ids, a short title, a Dashboard link and, for a finished automation, optional links to its source issue, trace and pull request; never prompts, output or credentials. Fires only while the operator has notifications enabled and your mcp_event preference for that kind is on.',
    arguments: NotificationEventArgumentsSchema,
    payload: NotificationCreatedPayloadSchema
  }
];

export const MCP_EVENT_DEFINITION_BY_NAME: ReadonlyMap<string, McpEventDefinition> = new Map(
  MCP_EVENT_DEFINITIONS.map((definition) => [definition.name, definition])
);

/** Server limits shared by the API handler and the runner store. */
export const MCP_EVENTS_LIMITS = {
  defaultTtlMs: 86_400_000,
  maxTtlMs: 86_400_000,
  minTtlMs: 60_000,
  maxSubscriptionsPerPrincipal: 100,
  /** Revoked, expired, and failed rows kept for audit until retention purges them. */
  maxRetainedSubscriptionsPerPrincipal: 1_000,
  verificationCacheMs: 86_400_000,
  secretRotationGraceMs: 600_000,
  maxBodyBytes: 262_144
} as const;

// ---------------------------------------------------------------------------
// API ⇄ runner internal channel (`POST /v1/internal/events`, service token).

export const McpEventSubscriptionIdSchema = z.string().regex(/^sub_[a-f0-9]{32}$/u);
export const McpEventDeliveryIdSchema = z.string().regex(/^dlv_[A-Za-z0-9_-]{22}$/u);
const LeaseTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/u);
const EventArgumentsRecordSchema = z.record(z.string(), z.unknown());

const subscriptionKey = {
  name: McpEventNameSchema,
  arguments: EventArgumentsRecordSchema,
  url: McpEventCallbackUrlSchema
};

const principalScoped = { version: z.literal(1), principal: RunnerPrincipalSelectorSchema };

export const McpEventsRunnerRequestSchema = z.discriminatedUnion('operation', [
  z.object({ ...principalScoped, operation: z.literal('events_prepare'), input: z.object(subscriptionKey).strict() }).strict(),
  z.object({
    ...principalScoped,
    operation: z.literal('events_subscribe'),
    input: z.object({
      ...subscriptionKey,
      secret: WebhookSecretSchema,
      ttlMs: z.number().int().nonnegative().nullable().optional(),
      apiKeyId: ApiKeyIdSchema.optional(),
      verified: z.boolean()
    }).strict()
  }).strict(),
  z.object({ ...principalScoped, operation: z.literal('events_unsubscribe'), input: z.object(subscriptionKey).strict() }).strict(),
  z.object({ ...principalScoped, operation: z.literal('events_subscriptions_list'), input: z.object({}).strict() }).strict(),
  z.object({
    ...principalScoped,
    operation: z.literal('events_subscription_revoke'),
    input: z.object({ id: McpEventSubscriptionIdSchema }).strict()
  }).strict(),
  z.object({
    version: z.literal(1),
    operation: z.literal('events_delivery_claim'),
    input: z.object({ limit: z.number().int().min(1).max(100), leaseMs: z.number().int().min(1_000).max(300_000) }).strict()
  }).strict(),
  z.object({
    version: z.literal(1),
    operation: z.literal('events_delivery_report'),
    input: z.object({
      results: z.array(z.object({
        deliveryId: McpEventDeliveryIdSchema,
        leaseToken: LeaseTokenSchema,
        outcome: z.enum(['delivered', 'failed', 'rejected']),
        error: McpEventCallbackErrorSchema.optional()
      }).strict()).max(100)
    }).strict()
  }).strict()
]);

export const McpEventDeliveryStatusSchema = z.object({
  active: z.boolean(),
  lastDeliveryAt: z.string().nullable(),
  lastError: McpEventCallbackErrorSchema.nullable(),
  failedSince: z.string().optional()
}).strict();

export const McpEventSubscriptionSummarySchema = z.object({
  id: McpEventSubscriptionIdSchema,
  name: McpEventNameSchema,
  arguments: EventArgumentsRecordSchema,
  callbackOrigin: z.string(),
  viaApiKey: z.boolean(),
  state: z.enum(['ACTIVE', 'EXPIRED', 'REVOKED']),
  createdAt: z.string(),
  refreshBefore: z.string(),
  deliveryStatus: McpEventDeliveryStatusSchema,
  recentDeliveries: z.array(z.object({
    eventId: z.string(),
    status: z.enum(['PENDING', 'DELIVERED', 'ABANDONED']),
    attempts: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
    createdAt: z.string(),
    completedAt: z.string().nullable()
  }).strict())
}).strict();

export const McpEventClaimedDeliverySchema = z.object({
  deliveryId: McpEventDeliveryIdSchema,
  leaseToken: LeaseTokenSchema,
  subscriptionId: McpEventSubscriptionIdSchema,
  eventId: z.string().min(1).max(100),
  url: McpEventCallbackUrlSchema,
  secrets: z.array(WebhookSecretSchema).min(1).max(2),
  body: z.string().max(MCP_EVENTS_LIMITS.maxBodyBytes)
}).strict();

export const McpEventsRunnerDataSchemas = {
  events_prepare: z.object({ id: McpEventSubscriptionIdSchema, verified: z.boolean() }).strict(),
  events_subscribe: z.object({
    id: McpEventSubscriptionIdSchema,
    refreshBefore: z.string(),
    deliveryStatus: McpEventDeliveryStatusSchema.optional()
  }).strict(),
  events_unsubscribe: z.object({ removed: z.boolean() }).strict(),
  events_subscriptions_list: z.object({ subscriptions: z.array(McpEventSubscriptionSummarySchema), truncated: z.boolean() }).strict(),
  events_subscription_revoke: z.object({ revoked: z.boolean() }).strict(),
  events_delivery_claim: z.object({ deliveries: z.array(McpEventClaimedDeliverySchema) }).strict(),
  events_delivery_report: z.object({ accepted: z.number().int().nonnegative() }).strict()
} as const;

/** Error codes the runner returns; the API maps them onto the events JSON-RPC codes. */
export const McpEventsRunnerErrorCodeSchema = z.enum([
  'INVALID_INPUT', 'NOT_FOUND', 'FORBIDDEN', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'INTERNAL'
]);

export const McpEventsRunnerResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: McpEventsRunnerErrorCodeSchema, message: z.string().max(500) }).strict()
  }).strict()
]);

export type McpEventsRunnerRequest = z.infer<typeof McpEventsRunnerRequestSchema>;
export type McpEventsRunnerOperation = McpEventsRunnerRequest['operation'];
export type McpEventsRunnerResponse = z.infer<typeof McpEventsRunnerResponseSchema>;
export type McpEventsRunnerErrorCode = z.infer<typeof McpEventsRunnerErrorCodeSchema>;
export type McpEventCallbackError = z.infer<typeof McpEventCallbackErrorSchema>;
export type McpEventClaimedDelivery = z.infer<typeof McpEventClaimedDeliverySchema>;
export type McpEventSubscriptionSummary = z.infer<typeof McpEventSubscriptionSummarySchema>;
export type McpEventDeliveryStatus = z.infer<typeof McpEventDeliveryStatusSchema>;
