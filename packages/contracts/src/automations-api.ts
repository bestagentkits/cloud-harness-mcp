import { z } from 'zod';
import { AgentIdSchema, WorkspaceIdSchema } from './identifiers.js';
import { AgentProxyOperationSchema, RunnerPrincipalSelectorSchema } from './runner-api.js';

/**
 * Webhook-triggered automations. A provider webhook reaches the API's public ingress, which forwards
 * the raw bytes to the runner; the runner verifies the per-connection signature, stores the delivery,
 * matches owner-authored rules and drives each admitted workflow through the existing workspace and
 * agent operations. The schemas below are the API ⇄ runner internal channel
 * (`POST /v1/internal/automations`, service token) and the Dashboard BFF payloads.
 */

export const AUTOMATION_LIMITS = {
  /** Largest webhook body the ingress forwards. GitHub issue/PR events are far below this. */
  maxRawBodyBytes: 1_048_576,
  maxConnectionsPerPrincipal: 20,
  maxRulesPerPrincipal: 100,
  maxInstructionsChars: 16_000,
  /** Untrusted provider text kept per delivery and placed into the agent prompt. */
  maxUntrustedTitleChars: 512,
  maxUntrustedBodyChars: 8_000,
  /** Agent answer kept on the workflow and posted to GitHub. */
  maxResultChars: 12_000,
  maxListLimit: 200,
  /** A workflow that cannot start within this window expires instead of retrying forever. */
  maxQueueMs: 3_600_000,
  /** Deliveries, terminal workflows and their transitions are purged after this. */
  retentionMs: 30 * 86_400_000
} as const;

export const AutomationConnectionIdSchema = z.string().regex(/^whc_[a-f0-9]{32}$/u);
export const AutomationRuleIdSchema = z.string().regex(/^arl_[a-f0-9]{32}$/u);
export const AutomationWorkflowIdSchema = z.string().regex(/^wfl_[a-f0-9]{32}$/u);
export const AutomationDeliveryIdSchema = z.string().regex(/^dlv_[a-f0-9]{32}$/u);

export const AutomationProviderSchema = z.enum(['github']);
/** Normalized, versioned event types. Only label additions are admitted today. */
export const AutomationEventTypeSchema = z.enum(['github.issue.label_added', 'github.pull_request.label_added']);
/** GitHub `X-GitHub-Event` values a rule may listen to. */
export const AutomationGitHubEventSchema = z.enum(['issues', 'pull_request']);

export const AutomationWorkflowStateSchema = z.enum(['QUEUED', 'STARTING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']);
export const AUTOMATION_TERMINAL_WORKFLOW_STATES = ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'] as const;
export const AutomationDeliveryStateSchema = z.enum(['RECEIVED', 'PROCESSED', 'IGNORED', 'QUARANTINED']);
export const AutomationPublishStateSchema = z.enum(['NONE', 'PENDING', 'DELIVERED', 'FAILED']);

/** Read-only by default: a webhook-triggered agent analyses and reports, it does not edit. */
export const AUTOMATION_DEFAULT_PROXY_OPERATIONS = ['files_list', 'files_read', 'grep_search', 'symbols_search', 'symbols_references'] as const;

const name = z.string().trim().min(1).max(100);
const githubRepository = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u, 'repository must be owner/name')
  .refine((value) => !value.endsWith('.git') && !(value.split('/')[1] ?? '').startsWith('.'), 'repository must be owner/name');
const githubLogin = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/u);
const label = z.string().min(1).max(100).refine((value) => !/[\0\r\n]/u.test(value), 'label cannot contain control characters');
const gitRef = z.string().min(1).max(200).regex(/^[A-Za-z0-9._/-]+$/u).refine((value) => !value.startsWith('-') && !value.includes('..'), 'invalid ref');
const profileId = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/u);
const expectedGeneration = z.number().int().positive();

export const AutomationRuleMatchSchema = z.object({
  repository: githubRepository,
  events: z.array(AutomationGitHubEventSchema).min(1).max(2)
    .refine((events) => new Set(events).size === events.length, 'events must be unique'),
  label,
  /** Bot senders (including this harness's own GitHub App) are ignored unless the owner opts in. */
  ignoreBots: z.boolean().default(true),
  /** When set, only these GitHub logins may trigger the rule. */
  actorAllowlist: z.array(githubLogin).max(50).optional()
}).strict();

export const AutomationRuleBudgetSchema = z.object({
  ttlSeconds: z.number().int().min(60).max(7_200).default(900),
  maxInputTokens: z.number().int().min(1).max(2_000_000).default(200_000),
  maxOutputTokens: z.number().int().min(1).max(2_000_000).default(32_000),
  maxCostMicros: z.number().int().min(0).max(100_000_000).default(2_000_000)
}).strict();

export const AutomationRuleActionSchema = z.object({
  /** Branch or tag the workspace checks out; omitted uses the repository default branch. */
  ref: gitRef.optional(),
  profileId,
  instructions: z.string().min(1).max(AUTOMATION_LIMITS.maxInstructionsChars)
    .refine((value) => !value.includes('\0'), 'instructions cannot contain null bytes'),
  proxyOperations: z.array(AgentProxyOperationSchema).min(1).max(AgentProxyOperationSchema.options.length)
    .refine((operations) => new Set(operations).size === operations.length, 'proxy operations must be unique')
    .default([...AUTOMATION_DEFAULT_PROXY_OPERATIONS]),
  budget: AutomationRuleBudgetSchema.default(AutomationRuleBudgetSchema.parse({})),
  /** Post the agent's answer as one comment on the source issue or pull request. */
  publishComment: z.boolean().default(false),
  /** After a workflow for a resource ends, a repeat trigger on it is ignored for this long. */
  cooldownSeconds: z.number().int().min(0).max(86_400).default(300),
  /** Most workflows of this rule that may hold a workspace at once. */
  maxConcurrent: z.number().int().min(1).max(5).default(1)
}).strict();

export const AutomationRuleInputSchema = z.object({
  connectionId: AutomationConnectionIdSchema,
  name,
  enabled: z.boolean().default(false),
  match: AutomationRuleMatchSchema,
  action: AutomationRuleActionSchema
}).strict();

export const AutomationSampleEventSchema = z.object({
  event: AutomationGitHubEventSchema,
  repository: githubRepository,
  label,
  senderLogin: githubLogin,
  senderType: z.enum(['User', 'Bot', 'Organization']).default('User')
}).strict();

const principalScoped = { version: z.literal(1), principal: RunnerPrincipalSelectorSchema };
const owner = <O extends string, I extends z.ZodType>(operation: O, input: I) =>
  z.object({ ...principalScoped, operation: z.literal(operation), input }).strict();

export const AutomationsRunnerRequestSchema = z.discriminatedUnion('operation', [
  // Public ingress. No principal: the connection id selects the owner after the signature verifies.
  z.object({
    version: z.literal(1),
    operation: z.literal('webhook_ingest'),
    input: z.object({
      provider: AutomationProviderSchema,
      connectionId: z.string().min(1).max(100),
      event: z.string().min(1).max(64),
      deliveryId: z.string().min(1).max(100),
      signature: z.string().max(200),
      bodyBase64: z.string().max(Math.ceil(AUTOMATION_LIMITS.maxRawBodyBytes / 3) * 4)
    }).strict()
  }).strict(),
  owner('connections_list', z.object({}).strict()),
  owner('connection_create', z.object({ provider: AutomationProviderSchema, name }).strict()),
  owner('connection_update', z.object({
    id: AutomationConnectionIdSchema, expectedGeneration, name: name.optional(), enabled: z.boolean().optional()
  }).strict()),
  owner('connection_rotate_secret', z.object({ id: AutomationConnectionIdSchema, expectedGeneration }).strict()),
  owner('connection_delete', z.object({ id: AutomationConnectionIdSchema, expectedGeneration }).strict()),
  owner('rules_list', z.object({ connectionId: AutomationConnectionIdSchema.optional() }).strict()),
  owner('rule_create', AutomationRuleInputSchema),
  owner('rule_update', z.object({
    id: AutomationRuleIdSchema,
    expectedGeneration,
    name: name.optional(),
    enabled: z.boolean().optional(),
    match: AutomationRuleMatchSchema.optional(),
    action: AutomationRuleActionSchema.optional()
  }).strict()),
  owner('rule_delete', z.object({ id: AutomationRuleIdSchema, expectedGeneration }).strict()),
  owner('rule_preview', z.object({ id: AutomationRuleIdSchema, sample: AutomationSampleEventSchema }).strict()),
  owner('workflows_list', z.object({
    ruleId: AutomationRuleIdSchema.optional(),
    state: AutomationWorkflowStateSchema.optional(),
    limit: z.number().int().min(1).max(AUTOMATION_LIMITS.maxListLimit).default(50)
  }).strict()),
  owner('workflow_get', z.object({ id: AutomationWorkflowIdSchema }).strict()),
  owner('workflow_cancel', z.object({ id: AutomationWorkflowIdSchema, reason: z.string().max(500).optional() }).strict()),
  owner('deliveries_list', z.object({
    connectionId: AutomationConnectionIdSchema.optional(),
    limit: z.number().int().min(1).max(AUTOMATION_LIMITS.maxListLimit).default(50)
  }).strict())
]);

const instant = z.string();

export const AutomationConnectionSummarySchema = z.object({
  id: AutomationConnectionIdSchema,
  provider: AutomationProviderSchema,
  name: z.string(),
  enabled: z.boolean(),
  generation: z.number().int().positive(),
  /** Path the provider posts to, relative to the public origin. */
  webhookPath: z.string(),
  secretRotatedAt: instant,
  lastDeliveryAt: instant.nullable(),
  createdAt: instant,
  updatedAt: instant
}).strict();

export const AutomationRuleSummarySchema = z.object({
  id: AutomationRuleIdSchema,
  connectionId: AutomationConnectionIdSchema,
  name: z.string(),
  enabled: z.boolean(),
  generation: z.number().int().positive(),
  match: AutomationRuleMatchSchema,
  action: AutomationRuleActionSchema,
  createdAt: instant,
  updatedAt: instant
}).strict();

export const AutomationWorkflowSummarySchema = z.object({
  id: AutomationWorkflowIdSchema,
  ruleId: AutomationRuleIdSchema,
  ruleGeneration: z.number().int().positive(),
  connectionId: AutomationConnectionIdSchema,
  deliveryId: AutomationDeliveryIdSchema,
  eventType: AutomationEventTypeSchema,
  repository: z.string(),
  resourceNumber: z.number().int().positive(),
  resourceUrl: z.string(),
  label: z.string(),
  state: AutomationWorkflowStateSchema,
  workspaceId: WorkspaceIdSchema.nullable(),
  agentId: AgentIdSchema.nullable(),
  agentStatus: z.string().nullable(),
  errorCode: z.string().nullable(),
  publishState: AutomationPublishStateSchema,
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), costMicros: z.number().int().nonnegative() }).strict().nullable(),
  createdAt: instant,
  updatedAt: instant,
  terminalAt: instant.nullable()
}).strict();

export const AutomationWorkflowTransitionSchema = z.object({
  fromState: AutomationWorkflowStateSchema.nullable(),
  toState: AutomationWorkflowStateSchema,
  actor: z.enum(['system', 'owner']),
  code: z.string().nullable(),
  at: instant
}).strict();

export const AutomationDeliverySummarySchema = z.object({
  id: AutomationDeliveryIdSchema,
  connectionId: AutomationConnectionIdSchema,
  providerDeliveryId: z.string(),
  providerEvent: z.string(),
  eventType: AutomationEventTypeSchema.nullable(),
  repository: z.string().nullable(),
  resourceNumber: z.number().int().nullable(),
  label: z.string().nullable(),
  state: AutomationDeliveryStateSchema,
  outcome: z.string().nullable(),
  workflowsCreated: z.number().int().nonnegative(),
  receivedAt: instant
}).strict();

export const AutomationsRunnerDataSchemas = {
  webhook_ingest: z.object({ outcome: z.enum(['accepted', 'duplicate', 'ignored']) }).strict(),
  connections_list: z.object({ connections: z.array(AutomationConnectionSummarySchema) }).strict(),
  connection_create: z.object({ connection: AutomationConnectionSummarySchema, secret: z.string() }).strict(),
  connection_update: z.object({ connection: AutomationConnectionSummarySchema }).strict(),
  connection_rotate_secret: z.object({ connection: AutomationConnectionSummarySchema, secret: z.string() }).strict(),
  connection_delete: z.object({ deleted: z.boolean() }).strict(),
  rules_list: z.object({ rules: z.array(AutomationRuleSummarySchema) }).strict(),
  rule_create: z.object({ rule: AutomationRuleSummarySchema }).strict(),
  rule_update: z.object({ rule: AutomationRuleSummarySchema }).strict(),
  rule_delete: z.object({ deleted: z.boolean() }).strict(),
  rule_preview: z.object({ matched: z.boolean(), reason: z.string() }).strict(),
  workflows_list: z.object({ workflows: z.array(AutomationWorkflowSummarySchema) }).strict(),
  workflow_get: z.object({
    workflow: AutomationWorkflowSummarySchema,
    result: z.string().nullable(),
    transitions: z.array(AutomationWorkflowTransitionSchema)
  }).strict(),
  workflow_cancel: z.object({ workflow: AutomationWorkflowSummarySchema }).strict(),
  deliveries_list: z.object({ deliveries: z.array(AutomationDeliverySummarySchema) }).strict()
} as const;

/**
 * `UNAUTHORIZED` covers an unknown, disabled or deleted connection as well as a bad signature, so
 * the public ingress cannot be used as an oracle for which connection ids exist.
 */
export const AutomationsRunnerErrorCodeSchema = z.enum([
  'INVALID_INPUT', 'UNAUTHORIZED', 'NOT_FOUND', 'CONFLICT', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'INTERNAL'
]);

export const AutomationsRunnerResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: AutomationsRunnerErrorCodeSchema, message: z.string().max(500) }).strict()
  }).strict()
]);

export type AutomationsRunnerRequest = z.infer<typeof AutomationsRunnerRequestSchema>;
export type AutomationsRunnerOperation = AutomationsRunnerRequest['operation'];
export type AutomationsRunnerResponse = z.infer<typeof AutomationsRunnerResponseSchema>;
export type AutomationsRunnerErrorCode = z.infer<typeof AutomationsRunnerErrorCodeSchema>;
export type AutomationRuleInput = z.infer<typeof AutomationRuleInputSchema>;
export type AutomationRuleMatch = z.infer<typeof AutomationRuleMatchSchema>;
export type AutomationRuleAction = z.infer<typeof AutomationRuleActionSchema>;
export type AutomationSampleEvent = z.infer<typeof AutomationSampleEventSchema>;
export type AutomationWorkflowState = z.infer<typeof AutomationWorkflowStateSchema>;
export type AutomationEventType = z.infer<typeof AutomationEventTypeSchema>;
export type AutomationConnectionSummary = z.infer<typeof AutomationConnectionSummarySchema>;
export type AutomationRuleSummary = z.infer<typeof AutomationRuleSummarySchema>;
export type AutomationWorkflowSummary = z.infer<typeof AutomationWorkflowSummarySchema>;
export type AutomationDeliverySummary = z.infer<typeof AutomationDeliverySummarySchema>;
