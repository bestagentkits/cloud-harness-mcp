import { z } from 'zod';
import { AgentIdSchema, WorkspaceIdSchema } from './identifiers.js';
import { RunnerPrincipalSelectorSchema } from './runner-api.js';

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

export const AutomationProviderSchema = z.enum(['github', 'linear', 'jira', 'custom']);
/**
 * Normalized, versioned event types: `<provider>.<resource>.<transition>`. A new transition is a new
 * value, never a reinterpretation of an existing one. Linear and Jira transitions are derived from
 * the delivery's previous values (`updatedFrom`, the changelog), not from an action name.
 */
export const AutomationEventTypeSchema = z.enum([
  'github.issue.label_added', 'github.pull_request.label_added',
  'linear.issue.label_added', 'linear.issue.state_changed',
  'jira.issue.label_added', 'jira.issue.status_changed',
  'custom.event'
]);
/** GitHub `X-GitHub-Event` values a rule may listen to. */
export const AutomationGitHubEventSchema = z.enum(['issues', 'pull_request']);

/**
 * The only request headers the public ingress forwards, per provider, lower-cased. `signature`
 * headers that are missing or overlong answer the shared 401, `required` ones a 400; nothing else
 * from the request reaches the runner.
 */
export const AUTOMATION_WEBHOOK_HEADERS = {
  github: [
    { name: 'x-github-event', role: 'required', maxChars: 64 },
    { name: 'x-github-delivery', role: 'required', maxChars: 100 },
    { name: 'x-hub-signature-256', role: 'signature', maxChars: 200 }
  ],
  linear: [
    { name: 'linear-event', role: 'required', maxChars: 64 },
    { name: 'linear-delivery', role: 'required', maxChars: 100 },
    { name: 'linear-signature', role: 'signature', maxChars: 200 }
  ],
  jira: [
    { name: 'x-atlassian-webhook-identifier', role: 'optional', maxChars: 100 },
    { name: 'x-hub-signature', role: 'signature', maxChars: 200 }
  ],
  custom: [
    { name: 'x-cloudharness-delivery', role: 'required', maxChars: 100 },
    { name: 'x-cloudharness-timestamp', role: 'required', maxChars: 20 },
    { name: 'x-cloudharness-signature', role: 'signature', maxChars: 200 }
  ]
} as const satisfies Record<z.infer<typeof AutomationProviderSchema>, readonly { name: string; role: 'required' | 'optional' | 'signature'; maxChars: number }[]>;

export const AutomationWorkflowStateSchema = z.enum(['QUEUED', 'STARTING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']);
export const AUTOMATION_TERMINAL_WORKFLOW_STATES = ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'] as const;
export const AutomationDeliveryStateSchema = z.enum(['RECEIVED', 'PROCESSED', 'IGNORED', 'QUARANTINED']);
export const AutomationPublishStateSchema = z.enum(['NONE', 'PENDING', 'DELIVERED', 'FAILED']);

/** Read-only by default: a webhook-triggered agent analyses and reports, it does not edit. */
export const AUTOMATION_DEFAULT_PROXY_OPERATIONS = ['files_list', 'files_read', 'grep_search', 'symbols_search', 'symbols_references'] as const;
/**
 * Automation agents are read-only: a webhook may start one, but it can only inspect the checkout.
 * Code-changing runs need the approval flow automations do not have yet.
 */
export const AutomationProxyOperationSchema = z.enum(AUTOMATION_DEFAULT_PROXY_OPERATIONS);

const name = z.string().trim().min(1).max(100);
const githubRepository = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u, 'repository must be owner/name')
  .refine((value) => !value.endsWith('.git') && !(value.split('/')[1] ?? '').startsWith('.'), 'repository must be owner/name');
const githubLogin = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/u);
const label = z.string().min(1).max(100).refine((value) => !/[\0\r\n]/u.test(value), 'label cannot contain control characters');
const gitRef = z.string().min(1).max(200).regex(/^[A-Za-z0-9._/-]+$/u).refine((value) => !value.startsWith('-') && !value.includes('..'), 'invalid ref');
const profileId = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/u);
const expectedGeneration = z.number().int().positive();
/** A Linear workflow state or Jira status name. */
const stateName = z.string().min(1).max(100).refine((value) => !/[\0\r\n]/u.test(value), 'state cannot contain control characters');
/** A Linear user id or email, or a Jira account id. */
const providerActor = z.string().min(1).max(254).regex(/^[^\s\0]+$/u, 'actor cannot contain whitespace');
const actorFilters = {
  /** Bot and integration actors are ignored unless the owner opts in. */
  ignoreBots: z.boolean().default(true),
  /** When set, only these actors may trigger the rule. */
  actorAllowlist: z.array(providerActor).max(50).optional()
};

/** GitHub rules predate the provider tag, so stored rows have none; `provider` is optional here only. */
export const AutomationGitHubRuleMatchSchema = z.object({
  provider: z.literal('github').optional(),
  repository: githubRepository,
  events: z.array(AutomationGitHubEventSchema).min(1).max(2)
    .refine((events) => new Set(events).size === events.length, 'events must be unique'),
  label,
  /** Bot senders (including this harness's own GitHub App) are ignored unless the owner opts in. */
  ignoreBots: z.boolean().default(true),
  /** When set, only these GitHub logins may trigger the rule. */
  actorAllowlist: z.array(githubLogin).max(50).optional()
}).strict();

const LABEL_TRIGGER_MESSAGE = 'a label_added rule takes exactly a label; a state or status rule takes no label';

/** A Linear issue gained a label, or moved to a workflow state (any state when `toState` is omitted). */
export const AutomationLinearRuleMatchSchema = z.object({
  provider: z.literal('linear'),
  /** Team key (the `ENG` of `ENG-123`); omitted matches every team the webhook covers. */
  teamKey: z.string().regex(/^[A-Za-z0-9_]{1,16}$/u).optional(),
  trigger: z.enum(['label_added', 'state_changed']),
  label: label.optional(),
  toState: stateName.optional(),
  ...actorFilters
}).strict().refine((match) => (match.trigger === 'label_added'
  ? match.label !== undefined && match.toState === undefined
  : match.label === undefined), { message: LABEL_TRIGGER_MESSAGE, path: ['trigger'] });

/** A Jira issue gained a label, or moved to a status (any status when `toStatus` is omitted). */
export const AutomationJiraRuleMatchSchema = z.object({
  provider: z.literal('jira'),
  projectKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,19}$/u),
  trigger: z.enum(['label_added', 'status_changed']),
  label: label.optional(),
  toStatus: stateName.optional(),
  ...actorFilters
}).strict().refine((match) => (match.trigger === 'label_added'
  ? match.label !== undefined && match.toStatus === undefined
  : match.label === undefined), { message: LABEL_TRIGGER_MESSAGE, path: ['trigger'] });

const customEventName = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/u);

/** A signed custom event with this name, optionally carrying this label. */
export const AutomationCustomRuleMatchSchema = z.object({
  provider: z.literal('custom'),
  event: customEventName,
  label: label.optional()
}).strict();

const singleLine = (max: number) => z.string().min(1).max(max).refine((value) => !/[\0\r\n]/u.test(value), 'value cannot contain control characters');

/**
 * The one body shape a custom webhook sends. It is fixed on purpose: there is no field that names a
 * repository, workspace, profile, tool, command or instruction, and unknown keys are rejected, so a
 * sender can only say what happened to which resource. The rule pins everything else.
 */
export const AutomationCustomEnvelopeSchema = z.object({
  version: z.literal(1),
  event: customEventName,
  resource: z.object({
    id: singleLine(100),
    title: z.string().max(AUTOMATION_LIMITS.maxUntrustedTitleChars).optional(),
    body: z.string().max(AUTOMATION_LIMITS.maxUntrustedBodyChars).optional(),
    url: z.string().max(300).url().startsWith('https://').optional()
  }).strict(),
  /** One label added. Mutually exclusive with `labelsAdded`. */
  label: label.optional(),
  /** Labels added; the first one is the event's label, and a label rule matches any of them. */
  labelsAdded: z.array(label).min(1).max(20).optional(),
  actor: z.object({
    login: singleLine(254),
    id: singleLine(200).optional(),
    isBot: z.boolean().optional()
  }).strict().optional()
}).strict().refine((envelope) => envelope.label === undefined || envelope.labelsAdded === undefined, {
  message: 'send label or labelsAdded, not both',
  path: ['labelsAdded']
});

/**
 * Provider-specific trigger. The rule's connection fixes the provider; the runner refuses a match
 * whose provider differs from its connection's.
 */
export const AutomationRuleMatchSchema = z.union([
  AutomationGitHubRuleMatchSchema,
  AutomationLinearRuleMatchSchema,
  AutomationJiraRuleMatchSchema,
  AutomationCustomRuleMatchSchema
]);

export const AutomationRuleBudgetSchema = z.object({
  ttlSeconds: z.number().int().min(60).max(7_200).default(900),
  maxInputTokens: z.number().int().min(1).max(2_000_000).default(200_000),
  maxOutputTokens: z.number().int().min(1).max(2_000_000).default(32_000),
  maxCostMicros: z.number().int().min(0).max(100_000_000).default(2_000_000)
}).strict();

export const AutomationRuleActionSchema = z.object({
  /**
   * Repository (owner/name on github.com) the workspace checks out. Non-GitHub rules must pin it,
   * since nothing in their events may choose a repository; GitHub rules take it from
   * `match.repository` and leave this unset.
   */
  repository: githubRepository.optional(),
  /** Branch or tag the workspace checks out; omitted uses the repository default branch. */
  ref: gitRef.optional(),
  profileId,
  instructions: z.string().min(1).max(AUTOMATION_LIMITS.maxInstructionsChars)
    .refine((value) => !value.includes('\0'), 'instructions cannot contain null bytes'),
  proxyOperations: z.array(AutomationProxyOperationSchema).min(1).max(AutomationProxyOperationSchema.options.length)
    .refine((operations) => new Set(operations).size === operations.length, 'proxy operations must be unique')
    .default([...AUTOMATION_DEFAULT_PROXY_OPERATIONS]),
  budget: AutomationRuleBudgetSchema.default(AutomationRuleBudgetSchema.parse({})),
  /** Post the agent's answer as one comment on the source issue, pull request or ticket. */
  publishComment: z.boolean().default(false),
  /** After a workflow for a resource ends, a repeat trigger on it is ignored for this long. */
  cooldownSeconds: z.number().int().min(0).max(86_400).default(300),
  /** Most workflows of this rule that may hold a workspace at once. */
  maxConcurrent: z.number().int().min(1).max(5).default(1)
}).strict();

/** The provider a rule match targets. GitHub matches stored before the provider tag carry none. */
export function automationMatchProvider(match: z.infer<typeof AutomationRuleMatchSchema>): z.infer<typeof AutomationProviderSchema> {
  return match.provider ?? 'github';
}

/**
 * The repository a workflow checks out is always owner-authored: GitHub rules name it in
 * `match.repository` (the event must come from that repository), every other provider pins
 * `action.repository`. Returns why a match and action disagree, or undefined.
 */
export function automationRuleProblem(match: z.infer<typeof AutomationRuleMatchSchema>, action: Pick<z.infer<typeof AutomationRuleActionSchema>, 'repository'>): string | undefined {
  if (automationMatchProvider(match) === 'github') {
    return action.repository === undefined ? undefined : 'GitHub rules take the repository from match.repository';
  }
  return action.repository === undefined ? 'rules for this provider must pin action.repository' : undefined;
}

export const AutomationRuleInputSchema = z.object({
  connectionId: AutomationConnectionIdSchema,
  name,
  enabled: z.boolean().default(false),
  match: AutomationRuleMatchSchema,
  action: AutomationRuleActionSchema
}).strict().superRefine((input, context) => {
  const problem = automationRuleProblem(input.match, input.action);
  if (problem) context.addIssue({ code: 'custom', path: ['action', 'repository'], message: problem });
});

/** The original GitHub-shaped preview sample. */
export const AutomationGitHubSampleEventSchema = z.object({
  event: AutomationGitHubEventSchema,
  repository: githubRepository,
  label,
  senderLogin: githubLogin,
  senderType: z.enum(['User', 'Bot', 'Organization']).default('User')
}).strict();

/** A preview sample in normalized form, for any provider. */
export const AutomationNormalizedSampleEventSchema = z.object({
  provider: AutomationProviderSchema,
  eventType: AutomationEventTypeSchema,
  /** Repository, Linear team key, Jira project key, or custom event name. */
  scope: z.string().min(1).max(200),
  label: label.optional(),
  fromState: stateName.optional(),
  toState: stateName.optional(),
  actor: z.object({ login: providerActor, isBot: z.boolean().default(false) }).strict()
}).strict().refine((sample) => sample.eventType.startsWith(`${sample.provider}.`), { message: 'eventType must belong to the provider', path: ['eventType'] });

export const AutomationSampleEventSchema = z.union([AutomationGitHubSampleEventSchema, AutomationNormalizedSampleEventSchema]);

/** An outbound API credential: a Linear API key or a Jira API token. Stored sealed, never returned. */
const outboundCredential = z.string().min(8).max(1_024).regex(/^[\x21-\x7E]+$/u, 'credential must be printable ASCII without spaces');
const jiraEmail = z.email().max(254);
const RESERVED_HOST_SUFFIX = /(?:^|\.)(?:localhost|local|internal|lan|home|corp|intranet)$/u;
const DNS_NAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

/**
 * A Jira site origin: `https://<site>.atlassian.net`, or the HTTPS origin of a public DNS name for
 * a self-hosted site. Credentials, ports, paths, IP literals and internal names are refused here;
 * outbound calls must still resolve the name and refuse private addresses.
 */
export const AutomationJiraBaseUrlSchema = z.string().max(300).refine((value) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') return false;
  const host = url.hostname.toLowerCase();
  return DNS_NAME.test(host) && !RESERVED_HOST_SUFFIX.test(host);
}, 'baseUrl must be an https origin such as https://example.atlassian.net').transform((value) => new URL(value).origin);

const sameOutboundPair = (input: { email?: string | undefined; apiToken?: string | undefined }) => (input.email === undefined) === (input.apiToken === undefined);
const OUTBOUND_PAIR_MESSAGE = 'email and apiToken are set together';

/** Connection settings per provider. Outbound credentials are optional and only used to post back. */
export const AutomationConnectionCreateInputSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('github'), name }).strict(),
  z.object({ provider: z.literal('linear'), name, apiKey: outboundCredential.optional() }).strict(),
  z.object({ provider: z.literal('jira'), name, baseUrl: AutomationJiraBaseUrlSchema, email: jiraEmail.optional(), apiToken: outboundCredential.optional() })
    .strict().refine(sameOutboundPair, { message: OUTBOUND_PAIR_MESSAGE, path: ['apiToken'] }),
  z.object({ provider: z.literal('custom'), name }).strict()
]);

export const AutomationConnectionUpdateInputSchema = z.object({
  id: AutomationConnectionIdSchema,
  expectedGeneration,
  name: name.optional(),
  enabled: z.boolean().optional(),
  /** Replaces a Linear connection's outbound API key. */
  apiKey: outboundCredential.optional(),
  /** Replace a Jira connection's outbound credential; set together. */
  email: jiraEmail.optional(),
  apiToken: outboundCredential.optional(),
  /** Removes the stored outbound credential. */
  clearOutbound: z.literal(true).optional()
}).strict()
  .refine(sameOutboundPair, { message: OUTBOUND_PAIR_MESSAGE, path: ['apiToken'] })
  .refine((input) => !input.clearOutbound || (input.apiKey === undefined && input.apiToken === undefined),
    { message: 'clearOutbound cannot be combined with a new credential', path: ['clearOutbound'] });

/** Most allowlisted headers any provider forwards; keeps the record bounded before it is checked. */
const MAX_WEBHOOK_HEADERS = 8;

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
      /** The provider's allowlisted request headers (`AUTOMATION_WEBHOOK_HEADERS`), lower-cased. */
      headers: z.record(z.string().max(64), z.string().max(200)).optional(),
      /** The earlier GitHub-only form of the three GitHub headers, accepted when `headers` is absent. */
      event: z.string().min(1).max(64).optional(),
      deliveryId: z.string().min(1).max(100).optional(),
      signature: z.string().max(200).optional(),
      bodyBase64: z.string().max(Math.ceil(AUTOMATION_LIMITS.maxRawBodyBytes / 3) * 4)
    }).strict().superRefine((input, context) => {
      const legacy = [input.event, input.deliveryId, input.signature];
      if (!input.headers) {
        if (input.provider !== 'github' || legacy.some((value) => value === undefined)) {
          context.addIssue({ code: 'custom', path: ['headers'], message: 'webhook headers are required' });
        }
        return;
      }
      if (legacy.some((value) => value !== undefined)) {
        context.addIssue({ code: 'custom', path: ['headers'], message: 'send webhook headers in one form only' });
      }
      const allowed = new Map<string, number>(AUTOMATION_WEBHOOK_HEADERS[input.provider].map((header) => [header.name, header.maxChars]));
      const entries = Object.entries(input.headers);
      if (entries.length > MAX_WEBHOOK_HEADERS) context.addIssue({ code: 'custom', path: ['headers'], message: 'too many webhook headers' });
      for (const [header, value] of entries) {
        const maxChars = allowed.get(header);
        if (maxChars === undefined || value.length > maxChars) {
          context.addIssue({ code: 'custom', path: ['headers'], message: 'webhook header is not allowed for this provider' });
          return;
        }
      }
    })
  }).strict(),
  owner('connections_list', z.object({}).strict()),
  owner('connection_create', AutomationConnectionCreateInputSchema),
  owner('connection_update', AutomationConnectionUpdateInputSchema),
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
  }).strict().superRefine((input, context) => {
    // A partial update is checked again by the runner against the stored half.
    const problem = input.match && input.action ? automationRuleProblem(input.match, input.action) : undefined;
    if (problem) context.addIssue({ code: 'custom', path: ['action', 'repository'], message: problem });
  })),
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
  /** Whether an outbound credential is stored. The credential itself is never returned. */
  outboundConfigured: z.boolean().optional(),
  /** Non-secret provider settings, such as a Jira site's origin. */
  config: z.object({ baseUrl: z.string().optional() }).strict().optional(),
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
  provider: AutomationProviderSchema.optional(),
  /** The repository the workspace checked out. */
  repository: z.string(),
  /** GitHub issue or pull request number; null for other providers. */
  resourceNumber: z.number().int().positive().nullable(),
  /** Provider reference of the source, such as `#12` or `ENG-123`. */
  resourceRef: z.string().optional(),
  resourceUrl: z.string(),
  /** The label added, or the state or status moved to. */
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
  provider: AutomationProviderSchema.optional(),
  repository: z.string().nullable(),
  resourceNumber: z.number().int().nullable(),
  resourceRef: z.string().nullable().optional(),
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
export type AutomationNormalizedSampleEvent = z.infer<typeof AutomationNormalizedSampleEventSchema>;
export type AutomationProvider = z.infer<typeof AutomationProviderSchema>;
export type AutomationGitHubRuleMatch = z.infer<typeof AutomationGitHubRuleMatchSchema>;
export type AutomationLinearRuleMatch = z.infer<typeof AutomationLinearRuleMatchSchema>;
export type AutomationJiraRuleMatch = z.infer<typeof AutomationJiraRuleMatchSchema>;
export type AutomationCustomRuleMatch = z.infer<typeof AutomationCustomRuleMatchSchema>;
export type AutomationCustomEnvelope = z.infer<typeof AutomationCustomEnvelopeSchema>;
export type AutomationConnectionCreateInput = z.infer<typeof AutomationConnectionCreateInputSchema>;
export type AutomationConnectionUpdateInput = z.infer<typeof AutomationConnectionUpdateInputSchema>;
export type AutomationWebhookHeader = (typeof AUTOMATION_WEBHOOK_HEADERS)[AutomationProvider][number];
export type AutomationWorkflowState = z.infer<typeof AutomationWorkflowStateSchema>;
export type AutomationEventType = z.infer<typeof AutomationEventTypeSchema>;
export type AutomationConnectionSummary = z.infer<typeof AutomationConnectionSummarySchema>;
export type AutomationRuleSummary = z.infer<typeof AutomationRuleSummarySchema>;
export type AutomationWorkflowSummary = z.infer<typeof AutomationWorkflowSummarySchema>;
export type AutomationDeliverySummary = z.infer<typeof AutomationDeliverySummarySchema>;
