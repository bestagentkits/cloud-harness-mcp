import { z } from 'zod';
import { AgentActionDescriptorSchema, GateDecisionSchema } from './agent-policy-api.js';
import { AutomationWorkflowIdSchema, AutomationWorkflowStateSchema } from './automations-api.js';
import { AgentApprovalIdSchema, CodingActionIdSchema, CodingActionStepSchema } from './coding-actions.js';
import { RunnerPrincipalSelectorSchema } from './runner-api.js';

/**
 * Owner approvals of coding workflow steps. When the execution policy requires approval for a step the
 * runner performs itself (verify, the commit's path checks, commit, push, opening the pull request), the
 * workflow waits as WAITING_FOR_HUMAN with one PENDING approval. The approval names the exact action
 * (its descriptor and that descriptor's digest), the gate decision and the policy revisions it was made
 * under. A decision is single-use: exactly one approve or deny moves it out of PENDING, and only for the
 * digest the owner saw. An approval lets that one action run once the workflow resumes; it never lifts a
 * DENY, and the gate decides the action again when it runs.
 */

export const AGENT_APPROVAL_STATES = ['PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'CONSUMED'] as const;
export const AgentApprovalStateSchema = z.enum(AGENT_APPROVAL_STATES);

export const AGENT_APPROVAL_LIMITS = {
  defaultListLimit: 50,
  maxListLimit: 100
} as const;

const instant = z.string();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

/** What the snapshotted change looked like when the workflow paused; null fields when it could not be read. */
export const AgentApprovalDiffSchema = z.object({
  /** The artifact holding the unified diff; it outlives the decision. */
  artifactId: z.string().max(200).nullable(),
  files: z.number().int().nonnegative().nullable(),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable()
}).strict();

export const AgentApprovalSummarySchema = z.object({
  approvalId: AgentApprovalIdSchema,
  workflowId: AutomationWorkflowIdSchema,
  /** The receipt of the step the gate held back. */
  actionId: CodingActionIdSchema,
  step: CodingActionStepSchema,
  state: AgentApprovalStateSchema,
  descriptor: AgentActionDescriptorSchema,
  /** sha256 of the canonical descriptor; a decision must name it, so it can only cover the action shown. */
  descriptorDigest: sha256,
  /** The gate decision that required approval, including its reasons and any advisor consult. */
  gate: GateDecisionSchema,
  /** The workflow's pause counter when the approval was requested; a later pause makes this approval stale. */
  generation: z.number().int().positive(),
  diff: AgentApprovalDiffSchema,
  expiresAt: instant,
  decidedAt: instant.nullable(),
  decidedBy: z.enum(['owner', 'system']).nullable(),
  consumedAt: instant.nullable(),
  createdAt: instant
}).strict();

// ---------------------------------------------------------------------------
// API ⇄ runner internal channel (`POST /v1/internal/agent-approvals`, service token).

const principalScoped = { version: z.literal(1), principal: RunnerPrincipalSelectorSchema };
const owner = <O extends string, I extends z.ZodType>(operation: O, input: I) =>
  z.object({ ...principalScoped, operation: z.literal(operation), input }).strict();

export const AgentApprovalDecisionSchema = z.enum(['approve', 'deny']);

export const AgentApprovalsRunnerRequestSchema = z.discriminatedUnion('operation', [
  owner('approvals_list', z.object({
    state: AgentApprovalStateSchema.optional(),
    limit: z.number().int().min(1).max(AGENT_APPROVAL_LIMITS.maxListLimit).default(AGENT_APPROVAL_LIMITS.defaultListLimit)
  }).strict()),
  owner('approval_get', z.object({ approvalId: AgentApprovalIdSchema }).strict()),
  owner('approval_decide', z.object({
    approvalId: AgentApprovalIdSchema,
    decision: AgentApprovalDecisionSchema,
    /** The descriptor digest the owner reviewed; a different current digest is refused as APPROVAL_STALE. */
    expectedDigest: sha256
  }).strict())
]);

export const AgentApprovalsRunnerDataSchemas = {
  approvals_list: z.object({
    enabled: z.boolean(),
    approvals: z.array(AgentApprovalSummarySchema).max(AGENT_APPROVAL_LIMITS.maxListLimit)
  }).strict(),
  approval_get: z.object({ approval: AgentApprovalSummarySchema }).strict(),
  approval_decide: z.object({
    approval: AgentApprovalSummarySchema,
    workflowState: AutomationWorkflowStateSchema
  }).strict()
} as const;

/**
 * Typed refusals of a decision. NOT_FOUND: no such approval. FORBIDDEN: it belongs to another principal.
 * EXPIRED: its time ran out (the workflow fails). STALE: the digest, the workflow's pause or its workspace
 * changed since it was requested. ALREADY_DECIDED: another decision won.
 */
export const AGENT_APPROVAL_ERROR_CODES = [
  'APPROVAL_NOT_FOUND', 'APPROVAL_FORBIDDEN', 'APPROVAL_EXPIRED', 'APPROVAL_STALE', 'APPROVAL_ALREADY_DECIDED'
] as const;

export const AgentApprovalsRunnerErrorCodeSchema = z.enum([
  'INVALID_INPUT', 'FEATURE_DISABLED', ...AGENT_APPROVAL_ERROR_CODES, 'UNAVAILABLE', 'INTERNAL'
]);

export const AgentApprovalsRunnerResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: AgentApprovalsRunnerErrorCodeSchema, message: z.string().max(500) }).strict()
  }).strict()
]);

export type AgentApprovalState = z.infer<typeof AgentApprovalStateSchema>;
export type AgentApprovalDiff = z.infer<typeof AgentApprovalDiffSchema>;
export type AgentApprovalSummary = z.infer<typeof AgentApprovalSummarySchema>;
export type AgentApprovalDecision = z.infer<typeof AgentApprovalDecisionSchema>;
export type AgentApprovalsRunnerRequest = z.infer<typeof AgentApprovalsRunnerRequestSchema>;
export type AgentApprovalsRunnerOperation = AgentApprovalsRunnerRequest['operation'];
export type AgentApprovalsRunnerResponse = z.infer<typeof AgentApprovalsRunnerResponseSchema>;
export type AgentApprovalsRunnerErrorCode = z.infer<typeof AgentApprovalsRunnerErrorCodeSchema>;
