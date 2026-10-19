import { z } from 'zod';
import {
  AgentActionClassSchema,
  AgentActionDescriptorSchema,
  AgentPolicyProjectIdSchema,
  AgentPolicyRevisionIdSchema,
  GateDecisionValueSchema,
  GateReasonCodeSchema
} from './agent-policy-api.js';
import type { AgentProxyOperation } from './runner-api.js';

/**
 * Brokered coding actions. A coding automation lets a network-none agent edit, build and test a
 * checkout; the runner (never the agent) commits, pushes an `agent/` branch and opens a pull request.
 * Every one of those steps is described as an action, decided by the policy gate, executed by the
 * runner and recorded as a receipt that outlives the workspace.
 */

export const CODING_LIMITS = {
  /** Receipts returned with one workflow. Older receipts stay stored but are not listed. */
  maxReceiptsPerWorkflow: 500,
  /** Prefix of every branch the runner publishes. The policy branch scope must cover it. */
  branchPrefix: 'agent/',
  maxVerifyCommandChars: 512,
  maxPathsPerReceipt: 50
} as const;

/**
 * Tools a coding agent is granted. Deleting files stays off, as in the dashboard code-editing preset;
 * `exec_run`, `git_status` and `git_diff` exist only behind the coding broker.
 */
export const CODING_PROXY_OPERATIONS = [
  'files_list', 'files_read', 'files_write', 'files_apply_patch', 'files_move', 'files_mkdir',
  'grep_search', 'symbols_search', 'symbols_references', 'exec_run', 'git_status', 'git_diff'
] as const satisfies readonly AgentProxyOperation[];

/** Proxy operations only a coding broker may execute. Without a coding binding the runner refuses them. */
export const BROKERED_ONLY_PROXY_OPERATIONS = ['exec_run', 'git_status', 'git_diff'] as const satisfies readonly AgentProxyOperation[];

export const CodingActionIdSchema = z.string().regex(/^act_[a-f0-9]{32}$/u);

/**
 * INTENT: recorded, not yet attempted. DISPATCHED: handed to the executor. APPLIED / REJECTED: the
 * outcome is known. UNKNOWN: the executor did not answer and nothing proves the effect either way.
 * BLOCKED: an UNKNOWN effect that reconciliation could not resolve; the workflow stops.
 */
export const CodingActionStateSchema = z.enum(['INTENT', 'DISPATCHED', 'APPLIED', 'REJECTED', 'UNKNOWN', 'BLOCKED']);

/** `agent`: a tool call the agent requested. `runner`: a pipeline step the runner performs itself. */
export const CodingActionOriginSchema = z.enum(['agent', 'runner']);

export const CodingActionStepSchema = z.enum([
  'files_write', 'files_apply_patch', 'files_move', 'files_mkdir', 'exec_run', 'git_status', 'git_diff',
  'install', 'verify', 'diff_artifact', 'commit', 'push', 'open_pr'
]);

/** Phases of the runner-owned part of a coding workflow, after the agent has finished editing. */
export const CodingPhaseSchema = z.enum(['AGENT', 'VERIFY', 'COMMIT', 'PUSH', 'PR', 'DONE', 'BLOCKED']);

export const CODING_ERROR_CODES = [
  'CODING_DISABLED', 'ACTION_DENIED', 'ACTION_REQUIRES_APPROVAL', 'EFFECT_UNKNOWN', 'COMMAND_UNSUPPORTED',
  'REPOSITORY_AMBIGUOUS', 'CODING_RULE_INVALID', 'CODING_VERIFY_FAILED', 'CODING_NO_CHANGES', 'CODING_AGENT_FAILED',
  'CODING_PUBLISH_FAILED', 'CODING_INSTALL_FAILED', 'LOCKFILE_REJECTED'
] as const;
export const CodingErrorCodeSchema = z.enum(CODING_ERROR_CODES);

const instant = z.string();
const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);

/**
 * What the broker hands the gate and the receipt store for one action. The descriptor is built by the
 * runner from the tool call; principal, project and policy are resolved server-side and are not fields.
 */
export const CodingActionRequestSchema = z.object({
  workflowId: z.string().regex(/^wfl_[a-f0-9]{32}$/u),
  origin: CodingActionOriginSchema,
  step: CodingActionStepSchema,
  /** Unique per effect: a replay with the same key returns the stored receipt instead of acting again. */
  idempotencyKey: z.string().min(1).max(256),
  descriptor: AgentActionDescriptorSchema
}).strict();

export const CodingActionOutcomeSchema = z.object({
  exitCode: z.number().int().nullable().optional(),
  commitSha: sha.optional(),
  branch: z.string().max(255).optional(),
  prNumber: z.number().int().positive().optional(),
  prUrl: z.string().max(2_048).optional(),
  artifactId: z.string().max(200).optional(),
  errorCode: z.string().max(100).optional()
}).strict();

export const CodingActionReceiptSchema = z.object({
  actionId: CodingActionIdSchema,
  workflowId: z.string().regex(/^wfl_[a-f0-9]{32}$/u),
  origin: CodingActionOriginSchema,
  step: CodingActionStepSchema,
  actionClass: AgentActionClassSchema,
  repository: z.string(),
  branch: z.string().nullable(),
  paths: z.array(z.string()).max(CODING_LIMITS.maxPathsPerReceipt),
  command: z.array(z.string()).nullable(),
  decision: GateDecisionValueSchema,
  reasonCode: GateReasonCodeSchema.or(CodingErrorCodeSchema),
  state: CodingActionStateSchema,
  projectId: AgentPolicyProjectIdSchema.nullable(),
  globalRevisionId: AgentPolicyRevisionIdSchema.nullable(),
  projectRevisionId: AgentPolicyRevisionIdSchema.nullable(),
  /** sha256 of the canonical descriptor the gate decided. */
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  /** The Decision Plane evaluation id when the gate consulted the advisor for this action; `null` otherwise. */
  decisionId: z.string().max(200).nullable().default(null),
  workspaceId: z.string().nullable(),
  agentId: z.string().nullable(),
  traceId: z.string().nullable(),
  spanId: z.string().nullable(),
  outcome: CodingActionOutcomeSchema,
  createdAt: instant,
  updatedAt: instant
}).strict();

/** The verify command is argv-shaped: plain tokens, no shell syntax, so the gate can analyze it. */
export const CodingVerifyCommandSchema = z.string().min(1).max(CODING_LIMITS.maxVerifyCommandChars)
  .regex(/^[A-Za-z0-9._:@/=+-]+(?: [A-Za-z0-9._:@/=+-]+)*$/u, 'verify command must be space-separated plain tokens');

export const CodingRuleActionSchema = z.object({
  /** The Cloud Harness project whose policy governs this repository. Server-side binding, never from a payload. */
  projectId: AgentPolicyProjectIdSchema,
  /** Deterministic command the runner runs after the agent finishes; it must pass before anything is committed. */
  verifyCommand: CodingVerifyCommandSchema,
  /** Base branch of the pull request. Always explicit: the runner never relies on a provider default. */
  baseBranch: z.string().min(1).max(200).regex(/^[A-Za-z0-9._/-]+$/u)
    .refine((value) => !value.startsWith('-') && !value.includes('..') && !value.startsWith(CODING_LIMITS.branchPrefix), 'invalid base branch')
}).strict();

export const CodingWorkflowSummarySchema = z.object({
  projectId: AgentPolicyProjectIdSchema,
  phase: CodingPhaseSchema,
  branch: z.string().nullable(),
  commitSha: z.string().nullable(),
  prNumber: z.number().int().positive().nullable(),
  prUrl: z.string().nullable(),
  traceId: z.string().nullable()
}).strict();

export type CodingActionState = z.infer<typeof CodingActionStateSchema>;
export type CodingActionOrigin = z.infer<typeof CodingActionOriginSchema>;
export type CodingActionStep = z.infer<typeof CodingActionStepSchema>;
export type CodingPhase = z.infer<typeof CodingPhaseSchema>;
export type CodingErrorCode = z.infer<typeof CodingErrorCodeSchema>;
export type CodingActionOutcome = z.infer<typeof CodingActionOutcomeSchema>;
export type CodingActionRequest = z.infer<typeof CodingActionRequestSchema>;
export type CodingActionReceipt = z.infer<typeof CodingActionReceiptSchema>;
export type CodingRuleAction = z.infer<typeof CodingRuleActionSchema>;
export type CodingWorkflowSummary = z.infer<typeof CodingWorkflowSummarySchema>;
