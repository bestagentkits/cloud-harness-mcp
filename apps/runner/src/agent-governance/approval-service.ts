import type { DatabaseSync } from 'node:sqlite';
import {
  AgentApprovalsRunnerDataSchemas,
  AgentApprovalsRunnerRequestSchema,
  type AgentApprovalDiff,
  type AgentApprovalsRunnerErrorCode,
  type AgentApprovalsRunnerRequest,
  type AgentApprovalsRunnerResponse,
  type AutomationWorkflowState,
  type GateDecision,
  type RunnerPrincipalSelector
} from '@cloud-harness/contracts';
import type { AgentApprovalTraceSink, TraceApprovalEvent } from '../agent-trace-recorder.js';
import { withEventSavepoint } from '../event-outbox.js';
import { automationNotificationLink, emitApprovalDecidedNotification, emitWaitingForHumanNotification } from '../notifications/notification-emitter.js';
import type { CodingActionRecord } from './action-store.js';
import { AgentApprovalStore, approvalSummary, type AgentApprovalRecord } from './approval-store.js';

/** PENDING approvals the sweeper settles per pass; the rest wait for the next pass. */
const SWEEP_BATCH = 50;

export class AgentApprovalError extends Error {
  constructor(readonly code: AgentApprovalsRunnerErrorCode, message: string) {
    super(message);
  }
}

/** A rollback that is not a failure: the guarded workflow transition did not apply. */
class TransitionLost extends Error {}

/** The workflow transitions an approval drives, guarded by the workflow's current state. Run inside the caller's savepoint. */
export type ApprovalWorkflowPort = {
  /** RUNNING to WAITING_FOR_HUMAN, recording the approval and when the wait started; false when it already left RUNNING. */
  wait(workflowId: string, approvalId: string, generation: number, at: number): boolean;
  /** WAITING_FOR_HUMAN to RUNNING for this approval, adding the wait to the paused time; false when it is not waiting for it. */
  resume(workflowId: string, approvalId: string, at: number): boolean;
  /** WAITING_FOR_HUMAN to FAILED with the code; false when it is not waiting. */
  fail(workflowId: string, code: string, actor: 'system' | 'owner'): boolean;
};

export type AgentApprovalAudit = (
  database: DatabaseSync,
  principalId: string,
  action: string,
  subjectType: string,
  subjectId: string,
  generation: number,
  details: Record<string, string | number | boolean>
) => void;

export type AgentApprovalServiceOptions = {
  database: DatabaseSync;
  /** AGENT_APPROVALS_ENABLED, read on every use so turning it off drains waiting workflows. */
  enabled: () => boolean;
  /** AGENT_APPROVAL_TTL_MINUTES in seconds: the longest a workflow waits for a decision. */
  ttlSeconds: () => number;
  resolvePrincipal: (selector: RunnerPrincipalSelector) => string;
  workflows: ApprovalWorkflowPort;
  /** The workspace's current generation; a recreated workspace makes a pending approval stale. */
  workspaceGeneration?: ((workspaceId: string) => number | null) | undefined;
  traces?: AgentApprovalTraceSink | undefined;
  audit?: AgentApprovalAudit | undefined;
  now?: () => number;
  log?: (record: Record<string, unknown>) => void;
};

/** What the coding engine hands over when a runner step needs approval. */
export type ApprovalRequest = {
  principalId: string;
  workflowId: string;
  /** The REJECTED receipt of the held step; its idempotency key is the step key. */
  record: CodingActionRecord;
  decision: GateDecision;
  /** The workflow's pause counter for this wait. */
  generation: number;
  diff: AgentApprovalDiff;
  expiresAt: number;
  repository: string;
  /** The agent run whose trace the approval spans join. */
  trace: { agentId: string; generation: number } | null;
};

type WaitingRow = {
  id: string; owner_id: string; state: AutomationWorkflowState; approval_id: string | null; approval_generation: number;
  workspace_id: string | null; workspace_generation: number | null; agent_id: string | null; agent_generation: number | null;
};

const STEP_LABELS: Record<string, string> = {
  verify: 'run the verify command', path_check: 'commit changed paths', commit: 'commit the change',
  push: 'push the branch', open_pr: 'open the pull request'
};

/**
 * Owner approvals of coding workflow steps. A runner step the gate holds for approval pauses its
 * workflow as WAITING_FOR_HUMAN with one PENDING approval (`request`); the owner approves or denies it
 * once (`execute`), and the sweeper expires what can no longer be decided. An approval only ever lifts
 * REQUIRE_APPROVAL for the exact descriptor digest of a runner step of the same workflow, and only while
 * approvals are enabled (`approvedFor`); the gate still decides the step when it runs, so a DENY added
 * since (a hard deny, a changed policy revision) wins.
 */
export class AgentApprovalService {
  readonly store: AgentApprovalStore;
  private readonly database: DatabaseSync;
  private readonly options: AgentApprovalServiceOptions;
  private readonly now: () => number;
  private readonly audit: AgentApprovalAudit;
  private readonly log: (record: Record<string, unknown>) => void;

  constructor(options: AgentApprovalServiceOptions) {
    this.options = options;
    this.database = options.database;
    this.store = new AgentApprovalStore(options.database);
    this.now = options.now ?? Date.now;
    this.audit = options.audit ?? (() => undefined);
    this.log = options.log ?? (() => undefined);
  }

  get enabled(): boolean {
    return this.options.enabled();
  }

  ttlSeconds(): number {
    return this.options.ttlSeconds();
  }

  execute(request: unknown): AgentApprovalsRunnerResponse {
    const parsed = AgentApprovalsRunnerRequestSchema.safeParse(request);
    if (!parsed.success) return { ok: false, error: { code: 'INVALID_INPUT', message: (parsed.error.issues[0]?.message ?? 'invalid approvals request').slice(0, 500) } };
    try {
      const data = this.dispatch(parsed.data);
      return { ok: true, data: AgentApprovalsRunnerDataSchemas[parsed.data.operation].parse(data) };
    } catch (error) {
      if (error instanceof AgentApprovalError) return { ok: false, error: { code: error.code, message: error.message.slice(0, 500) } };
      throw error;
    }
  }

  private dispatch(request: AgentApprovalsRunnerRequest): unknown {
    const principalId = this.options.resolvePrincipal(request.principal);
    switch (request.operation) {
      case 'approvals_list':
        return { enabled: this.enabled, approvals: this.store.list(principalId, request.input).map(approvalSummary) };
      case 'approval_get':
        return { approval: approvalSummary(this.owned(principalId, request.input.approvalId)) };
      case 'approval_decide':
        return this.decide(principalId, request.input.approvalId, request.input.decision, request.input.expectedDigest);
    }
  }

  private owned(principalId: string, approvalId: string): AgentApprovalRecord {
    const record = this.store.get(approvalId);
    if (!record) throw new AgentApprovalError('APPROVAL_NOT_FOUND', 'approval not found');
    if (record.principalId !== principalId) throw new AgentApprovalError('APPROVAL_FORBIDDEN', 'the approval belongs to another principal');
    return record;
  }

  /**
   * The single-use decision. Every check is repeated by the compare-and-set update itself, so of two
   * concurrent decisions exactly one changes the row and the other is refused as already decided.
   */
  private decide(principalId: string, approvalId: string, decision: 'approve' | 'deny', expectedDigest: string) {
    if (!this.enabled) throw new AgentApprovalError('FEATURE_DISABLED', 'approvals are disabled on this instance');
    const record = this.owned(principalId, approvalId);
    if (record.state === 'EXPIRED') throw new AgentApprovalError('APPROVAL_EXPIRED', 'the approval expired');
    if (record.state !== 'PENDING') throw new AgentApprovalError('APPROVAL_ALREADY_DECIDED', 'the approval was already decided');
    const now = this.now();
    if (record.expiresAt <= now) {
      this.expire(record, 'APPROVAL_EXPIRED');
      throw new AgentApprovalError('APPROVAL_EXPIRED', 'the approval expired');
    }
    if (record.descriptorDigest !== expectedDigest) throw new AgentApprovalError('APPROVAL_STALE', 'the action changed since it was shown');
    const workflow = this.waiting(record.workflowId);
    if (!workflow || workflow.state !== 'WAITING_FOR_HUMAN' || workflow.approval_id !== record.approvalId || workflow.approval_generation !== record.generation) {
      throw new AgentApprovalError('APPROVAL_STALE', 'the workflow is no longer waiting for this approval');
    }
    if (workflow.workspace_id !== null && this.options.workspaceGeneration
      && this.options.workspaceGeneration(workflow.workspace_id) !== workflow.workspace_generation) {
      throw new AgentApprovalError('APPROVAL_STALE', 'the workspace changed since the approval was requested');
    }
    const approved = decision === 'approve';
    let workflowState: AutomationWorkflowState;
    try {
      workflowState = withEventSavepoint(this.database, () => {
        if (!this.store.decide(record.approvalId, principalId, expectedDigest, approved ? 'APPROVED' : 'DENIED', now)) throw new TransitionLost();
        const moved = approved
          ? this.options.workflows.resume(record.workflowId, record.approvalId, now)
          : this.options.workflows.fail(record.workflowId, 'APPROVAL_DENIED', 'owner');
        if (!moved) throw new TransitionLost();
        emitApprovalDecidedNotification(this.database, {
          principalId, approvalId: record.approvalId, decision: approved ? 'approved' : 'denied', workflowId: record.workflowId,
          title: `${approved ? 'Approved' : 'Denied'}: ${this.stepLabel(record)}`, link: automationNotificationLink(record.workflowId)
        }, now);
        this.audit(this.database, principalId, approved ? 'agent.approval.approved' : 'agent.approval.denied', 'agent_approval', record.approvalId,
          record.generation, { workflowId: record.workflowId, step: record.step, descriptorDigest: record.descriptorDigest });
        return approved ? 'RUNNING' : 'FAILED';
      });
    } catch (error) {
      if (!(error instanceof TransitionLost)) throw error;
      const current = this.store.get(record.approvalId);
      if (current?.state === 'EXPIRED' || (current?.state === 'PENDING' && current.expiresAt <= now)) throw new AgentApprovalError('APPROVAL_EXPIRED', 'the approval expired');
      if (current?.state !== 'PENDING') throw new AgentApprovalError('APPROVAL_ALREADY_DECIDED', 'the approval was already decided');
      throw new AgentApprovalError('APPROVAL_STALE', 'the workflow is no longer waiting for this approval');
    }
    this.span(record, workflowSpanKey(this.waiting(record.workflowId)), 'decided', approved ? 'approved' : 'denied', now);
    return { approval: approvalSummary(this.store.get(record.approvalId)!), workflowState };
  }

  /**
   * Pauses a running workflow on a held runner step: records the PENDING approval, moves the workflow to
   * WAITING_FOR_HUMAN, and writes the waiting notification and audit entry in one savepoint. False when
   * the workflow left RUNNING meanwhile (nothing is written then).
   */
  request(input: ApprovalRequest): AgentApprovalRecord | null {
    const now = this.now();
    let created: AgentApprovalRecord;
    try {
      created = withEventSavepoint(this.database, () => {
        const approval = this.store.create({
          principalId: input.principalId, workflowId: input.workflowId, actionId: input.record.actionId, step: input.record.step,
          stepKey: input.record.idempotencyKey, descriptor: input.record.descriptor, gate: input.decision,
          generation: input.generation, diff: input.diff, expiresAt: input.expiresAt
        }, now);
        if (!this.options.workflows.wait(input.workflowId, approval.approvalId, input.generation, now)) throw new TransitionLost();
        emitWaitingForHumanNotification(this.database, {
          principalId: input.principalId, workflowId: input.workflowId, approvalId: approval.approvalId,
          title: `Approval needed to ${this.stepLabel(approval)} in ${input.repository}`
        }, now);
        this.audit(this.database, input.principalId, 'agent.approval.requested', 'agent_approval', approval.approvalId, input.generation, {
          workflowId: input.workflowId, step: approval.step, reasonCode: input.decision.reasonCode, descriptorDigest: approval.descriptorDigest,
          expiresAt: new Date(approval.expiresAt).toISOString()
        });
        return approval;
      });
    } catch (error) {
      if (error instanceof TransitionLost) return null;
      throw error;
    }
    this.span(created, input.trace, 'requested', 'pending', now);
    return created;
  }

  /**
   * The id of an approval that lets a runner step of this workflow with this descriptor digest run
   * although the gate required approval; null when there is none or approvals are off. The first use
   * marks an approved approval CONSUMED; a replay of the same step after a restart still finds it.
   */
  approvedFor(principalId: string, workflowId: string, digest: string): string | null {
    if (!this.enabled) return null;
    const record = this.store.approvedForDigest(principalId, workflowId, digest);
    if (!record) return null;
    if (record.state === 'APPROVED') this.store.consume(record.approvalId, this.now());
    return record.approvalId;
  }

  /**
   * The idempotency key a runner step runs under: a step the owner approved resumes under
   * `automation:<workflow>:resume:<approval>`, because its original key holds the refused receipt. Every
   * replay of the resumed step finds the same key, so it acts at most once.
   */
  stepKey(principalId: string, workflowId: string, key: string): string {
    if (!this.enabled) return key;
    const record = this.store.approvedForStep(principalId, workflowId, key);
    return record ? resumeKey(workflowId, record.approvalId) : key;
  }

  /**
   * Settles what can no longer be decided. With approvals off, every waiting workflow fails as
   * APPROVALS_DISABLED (the rollback drain). A pending approval past its deadline expires and fails its
   * workflow as APPROVAL_EXPIRED; one whose workflow stopped waiting for it (cancelled) just expires.
   */
  sweep(): void {
    if (!this.enabled) {
      const waiting = this.database.prepare(`SELECT * FROM automation_workflows WHERE state = 'WAITING_FOR_HUMAN' ORDER BY updated_at, id LIMIT ${SWEEP_BATCH}`)
        .all() as WaitingRow[];
      for (const row of waiting) {
        const record = row.approval_id ? this.store.get(row.approval_id) : undefined;
        if (record) this.expire(record, 'APPROVALS_DISABLED');
        else withEventSavepoint(this.database, () => { this.options.workflows.fail(row.id, 'APPROVALS_DISABLED', 'system'); });
      }
    }
    for (const record of this.store.undecidable(this.now(), SWEEP_BATCH)) this.expire(record, 'APPROVAL_EXPIRED');
  }

  /** Expires a pending approval and, when its workflow still waits for it, fails the workflow with the code. */
  private expire(record: AgentApprovalRecord, code: 'APPROVAL_EXPIRED' | 'APPROVALS_DISABLED'): void {
    const now = this.now();
    const workflow = this.waiting(record.workflowId);
    let failed = false;
    try {
      withEventSavepoint(this.database, () => {
        const expired = this.store.expire(record.approvalId, now);
        const waits = workflow?.state === 'WAITING_FOR_HUMAN' && workflow.approval_id === record.approvalId;
        if (waits) {
          failed = this.options.workflows.fail(record.workflowId, code, 'system');
          if (!failed) throw new TransitionLost();
        }
        if (!expired && !failed) return;
        if (failed) {
          emitApprovalDecidedNotification(this.database, {
            principalId: record.principalId, approvalId: record.approvalId, decision: 'expired', workflowId: record.workflowId,
            title: `${code === 'APPROVALS_DISABLED' ? 'Approvals turned off' : 'Approval expired'}: ${this.stepLabel(record)}`,
            link: automationNotificationLink(record.workflowId)
          }, now);
        }
        this.audit(this.database, record.principalId, 'agent.approval.expired', 'agent_approval', record.approvalId, record.generation,
          { workflowId: record.workflowId, step: record.step, reason: failed ? code : 'WORKFLOW_NOT_WAITING' });
      });
    } catch (error) {
      if (error instanceof TransitionLost) return;
      this.log({ event: 'agent_approval_expire_failed', approvalId: record.approvalId, error: error instanceof Error ? error.name : 'unknown' });
      return;
    }
    if (failed) this.span(record, workflowSpanKey(workflow), 'decided', 'expired', now);
  }

  private waiting(workflowId: string): WaitingRow | undefined {
    return this.database.prepare(`SELECT id, owner_id, state, approval_id, approval_generation, workspace_id, workspace_generation,
      agent_id, agent_generation FROM automation_workflows WHERE id = ?`).get(workflowId) as WaitingRow | undefined;
  }

  private stepLabel(record: AgentApprovalRecord): string {
    return STEP_LABELS[record.step] ?? record.step;
  }

  private span(record: AgentApprovalRecord, key: { agentId: string; generation: number } | null, phase: TraceApprovalEvent['phase'], outcome: TraceApprovalEvent['outcome'], now: number): void {
    if (!this.options.traces || !key) return;
    const placed = this.options.traces.approval(key, {
      approvalId: record.approvalId, actionId: record.actionId, step: record.step, phase, outcome, reasonCode: record.gate.reasonCode,
      startedAt: phase === 'requested' ? now : record.createdAt, endedAt: now
    });
    if (!placed) this.log({ event: 'agent_approval_span_skipped', approvalId: record.approvalId, phase });
  }
}

/** The idempotency key of a step resumed by an approval. */
export function resumeKey(workflowId: string, approvalId: string): string {
  return `automation:${workflowId}:resume:${approvalId}`;
}

function workflowSpanKey(row: WaitingRow | undefined): { agentId: string; generation: number } | null {
  return row?.agent_id && row.agent_generation !== null ? { agentId: row.agent_id, generation: row.agent_generation } : null;
}
