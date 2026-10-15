import { z } from 'zod';
import { McpGatewayQualifiedToolNameSchema } from './mcp-gateway-schemas.js';

/**
 * The provider-neutral Decision Plane contract.
 *
 * A decision is `state + typed questions -> typed answers with confidence`. It is a bounded,
 * advisory control-plane judgment, not a generative model call: no answer is free text, every
 * choice is validated against the options the caller offered, and a caller always owns a
 * deterministic fallback. Deterministic policy (permissions, provenance, known error rules) is
 * never an input the Decision Plane may change.
 */

/** Every purpose the contract names. Only the implemented ones may be enabled by configuration. */
export const DECISION_PURPOSES = [
  'failure-classification',
  'mcp-routing',
  'agent-supervision',
  'execution-risk',
  'context-relevance',
  'task-selection'
] as const;
export const DecisionPurposeSchema = z.enum(DECISION_PURPOSES);
export type DecisionPurpose = z.infer<typeof DecisionPurposeSchema>;

/** The purposes this release integrates. Configuration refuses any other value. */
export const IMPLEMENTED_DECISION_PURPOSES = ['failure-classification', 'mcp-routing'] as const;
export const ImplementedDecisionPurposeSchema = z.enum(IMPLEMENTED_DECISION_PURPOSES);
export type ImplementedDecisionPurpose = z.infer<typeof ImplementedDecisionPurposeSchema>;

const decisionKey = z.string().regex(/^[a-z][a-z0-9_:.-]{0,79}$/);
const criterionText = z.string().min(1).max(400);

/**
 * A question the provider must answer. `choice` picks one option key, `boolean` answers a yes/no
 * probability, and `score` places the state on a low..high scale in [0, 1].
 */
export const DecisionQuestionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('choice'),
    key: decisionKey,
    question: z.string().min(1).max(400),
    options: z.record(decisionKey, criterionText)
      .refine((options) => Object.keys(options).length >= 2 && Object.keys(options).length <= 32, 'a choice needs 2 to 32 options')
  }).strict(),
  z.object({
    kind: z.literal('boolean'),
    key: decisionKey,
    question: z.string().min(1).max(400)
  }).strict(),
  z.object({
    kind: z.literal('score'),
    key: decisionKey,
    question: z.string().min(1).max(400),
    low: criterionText,
    high: criterionText
  }).strict()
]);
export type DecisionQuestion = z.infer<typeof DecisionQuestionSchema>;

export const DecisionRequestSchema = z.object({
  purpose: DecisionPurposeSchema,
  /** Bounded, redacted text the provider judges. Providers redact again before egress. */
  state: z.string().min(1).max(8_192),
  questions: z.array(DecisionQuestionSchema).min(1).max(40)
    .refine((questions) => new Set(questions.map((question) => question.key)).size === questions.length, 'question keys must be unique')
}).strict();
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

export type DecisionAnswer =
  | { kind: 'choice'; value: string; confidence: number; probabilities: Record<string, number> }
  | { kind: 'boolean'; probability: number }
  | { kind: 'score'; value: number; confidence: number };

/** Why a decision fell back to the caller's deterministic path. */
export const DECISION_FALLBACK_REASONS = [
  'purpose_disabled',
  'not_configured',
  'invalid_request',
  'redaction_failed',
  'invalid_endpoint',
  'rate_limited',
  'timeout',
  'unauthorized',
  'unprocessable',
  'upstream_unavailable',
  'connection_error',
  'unexpected_response',
  'invalid_answer',
  'low_confidence'
] as const;
export type DecisionFallbackReason = typeof DECISION_FALLBACK_REASONS[number];

/** The failure taxonomy a failure-classification decision answers with. */
export const FAILURE_TYPES = [
  'auth',
  'permission',
  'rate_limit',
  'transient_network',
  'dependency',
  'test_failure',
  'flaky_test',
  'code_error',
  'resource_exhaustion',
  'unknown'
] as const;
export const FailureTypeSchema = z.enum(FAILURE_TYPES);
export type FailureType = z.infer<typeof FailureTypeSchema>;

/**
 * The advisory diagnosis a generic failure carries in `data.diagnosis`. It never replaces the
 * deterministic `error.code` or `error.retryable`; it explains the failure and suggests a next step.
 */
export const FailureDiagnosisSchema = z.object({
  advisory: z.literal(true),
  source: z.literal('decision-plane'),
  decisionId: z.string().min(1).max(64),
  failureType: FailureTypeSchema,
  confidence: z.number().min(0).max(1),
  retryLikelyToSucceed: z.number().min(0).max(1),
  credentialRefreshNeeded: z.boolean(),
  workspaceRecreateNeeded: z.boolean(),
  agentNeeded: z.boolean(),
  humanNeeded: z.boolean(),
  priorFailures: z.number().int().min(0)
}).strict();
export type FailureDiagnosis = z.infer<typeof FailureDiagnosisSchema>;

/** Gateway -> runner: rerank a lexical candidate pool that is already permission-filtered. */
export const DecisionRerankToolsInputSchema = z.object({
  query: z.string().trim().min(1).max(512),
  candidates: z.array(z.object({
    tool: McpGatewayQualifiedToolNameSchema,
    description: z.string().max(2_000)
  }).strict()).min(2).max(25)
    .refine((candidates) => new Set(candidates.map((candidate) => candidate.tool)).size === candidates.length, 'candidate tools must be unique')
}).strict();
export type DecisionRerankToolsInput = z.infer<typeof DecisionRerankToolsInputSchema>;

/**
 * The rerank answer. `ordering` is a permutation of the candidate tools when `applied` is true and
 * is empty otherwise; the caller still validates it before use.
 */
export type DecisionRerankToolsResult = {
  applied: boolean;
  decisionId: string | null;
  ordering: string[];
  relevance: Record<string, number>;
  reason?: DecisionFallbackReason;
};
