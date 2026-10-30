import { describe, expect, it } from 'vitest';
import {
  AGENT_APPROVAL_LIMITS,
  AgentApprovalsRunnerErrorCodeSchema,
  AgentApprovalsRunnerRequestSchema,
  AgentApprovalSummarySchema,
  AutomationWorkflowStateSchema,
  RunnerConfigSchema
} from '../src/index.js';

const principal = { kind: 'owner', ownerId: 'owner' } as const;
const APPROVAL = `apv_${'a'.repeat(32)}`;
const DIGEST = 'b'.repeat(64);

describe('agent approvals contract', () => {
  it('accepts the three owner operations and defaults the list limit', () => {
    const list = AgentApprovalsRunnerRequestSchema.parse({ version: 1, principal, operation: 'approvals_list', input: {} });
    expect(list.input).toEqual({ limit: AGENT_APPROVAL_LIMITS.defaultListLimit });
    expect(AgentApprovalsRunnerRequestSchema.safeParse({ version: 1, principal, operation: 'approval_get', input: { approvalId: APPROVAL } }).success).toBe(true);
    expect(AgentApprovalsRunnerRequestSchema.safeParse({
      version: 1, principal, operation: 'approval_decide', input: { approvalId: APPROVAL, decision: 'approve', expectedDigest: DIGEST }
    }).success).toBe(true);
  });

  it('requires a decision to name the digest the owner reviewed', () => {
    const decide = (input: Record<string, unknown>) =>
      AgentApprovalsRunnerRequestSchema.safeParse({ version: 1, principal, operation: 'approval_decide', input }).success;
    expect(decide({ approvalId: APPROVAL, decision: 'approve' })).toBe(false);
    expect(decide({ approvalId: APPROVAL, decision: 'approve', expectedDigest: 'B'.repeat(64) })).toBe(false);
    expect(decide({ approvalId: APPROVAL, decision: 'maybe', expectedDigest: DIGEST })).toBe(false);
    expect(decide({ approvalId: 'apv_short', decision: 'deny', expectedDigest: DIGEST })).toBe(false);
    expect(decide({ approvalId: APPROVAL, decision: 'deny', expectedDigest: DIGEST, note: 'extra' })).toBe(false);
  });

  it('bounds the list limit and rejects unknown operations', () => {
    const list = (limit: number) =>
      AgentApprovalsRunnerRequestSchema.safeParse({ version: 1, principal, operation: 'approvals_list', input: { limit } }).success;
    expect(list(AGENT_APPROVAL_LIMITS.maxListLimit)).toBe(true);
    expect(list(AGENT_APPROVAL_LIMITS.maxListLimit + 1)).toBe(false);
    expect(list(0)).toBe(false);
    expect(AgentApprovalsRunnerRequestSchema.safeParse({ version: 1, principal, operation: 'approval_delete', input: {} }).success).toBe(false);
  });

  it('names every typed refusal and the waiting workflow state', () => {
    for (const code of ['APPROVAL_NOT_FOUND', 'APPROVAL_FORBIDDEN', 'APPROVAL_EXPIRED', 'APPROVAL_STALE', 'APPROVAL_ALREADY_DECIDED', 'FEATURE_DISABLED']) {
      expect(AgentApprovalsRunnerErrorCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(AutomationWorkflowStateSchema.safeParse('WAITING_FOR_HUMAN').success).toBe(true);
  });

  it('rejects a summary with an unknown state or a malformed digest', () => {
    const shape = AgentApprovalSummarySchema.shape;
    expect(shape.state.safeParse('CONSUMED').success).toBe(true);
    expect(shape.state.safeParse('REVOKED').success).toBe(false);
    expect(shape.descriptorDigest.safeParse('z'.repeat(64)).success).toBe(false);
    expect(shape.generation.safeParse(0).success).toBe(false);
  });

  it('defaults AGENT_APPROVALS_ENABLED to off and bounds the approval TTL', () => {
    const shape = RunnerConfigSchema.innerType?.() ?? RunnerConfigSchema;
    const fields = (shape as unknown as { shape: Record<string, { safeParse: (value: unknown) => { success: boolean; data?: unknown } }> }).shape;
    expect(fields.agentApprovalsEnabled!.safeParse(undefined).data).toBe(false);
    expect(fields.agentApprovalsEnabled!.safeParse('true').data).toBe(true);
    expect(fields.agentApprovalTtlMinutes!.safeParse(undefined).data).toBe(60);
    expect(fields.agentApprovalTtlMinutes!.safeParse('10080').data).toBe(10_080);
    expect(fields.agentApprovalTtlMinutes!.safeParse('10081').success).toBe(false);
    expect(fields.agentApprovalTtlMinutes!.safeParse('0').success).toBe(false);
  });
});
