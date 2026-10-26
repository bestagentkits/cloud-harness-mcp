import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentActionDescriptorSchema,
  AgentApprovalSummarySchema,
  type AgentActionDescriptorInput,
  type GateDecision,
  type GlobalExecutionPolicy,
  type RunnerPrincipalSelector
} from '@cloud-harness/contracts';
import { CodingActionStore } from '../src/agent-governance/action-store.js';
import { AgentApprovalService, resumeKey, type ApprovalWorkflowPort } from '../src/agent-governance/approval-service.js';
import { AgentApprovalStore } from '../src/agent-governance/approval-store.js';
import type { TraceApprovalEvent } from '../src/agent-trace-recorder.js';
import { CODING_GLOBAL_POLICY, CODING_PROJECT, CODING_REPOSITORY, createPolicyService, insertCodingWorkflow } from './support/coding-policy.js';
import { disableNotifications, enableNotifications } from './support/notification-fixtures.js';
import { initializeNotificationSchema } from '../src/notifications/notification-schema.js';

const OWNER = 'owner';
const owner: RunnerPrincipalSelector = { kind: 'owner', ownerId: OWNER };
const stranger: RunnerPrincipalSelector = { kind: 'owner', ownerId: 'stranger' };
const WORKFLOW = `wfl_${'e'.repeat(32)}`;
const WORKSPACE = `ws_${'w'.repeat(24)}`;
const STEP_KEY = `automation:${WORKFLOW}:push`;
const T0 = Date.parse('2026-10-20T00:00:00Z');
const CONTENT = 'c'.repeat(64);

const PUSH_NEEDS_APPROVAL: GlobalExecutionPolicy = {
  ...CODING_GLOBAL_POLICY,
  defaults: { ...CODING_GLOBAL_POLICY.defaults, publish_branch: { effect: 'require_approval', delegable: false } }
};
const PUSH: AgentActionDescriptorInput = { version: 1, actionClass: 'publish_branch', repository: CODING_REPOSITORY, branch: 'agent/7-eeeeeeee' };

const databases: DatabaseSync[] = [];
beforeEach(() => enableNotifications([]));
afterEach(() => {
  disableNotifications();
  for (const database of databases.splice(0)) database.close();
});

function setup(options: { enabled?: boolean; workspaceGeneration?: number | null; stepKey?: string } = {}) {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  initializeNotificationSchema(database);
  const policies = createPolicyService(database, (selector) => (selector.kind === 'owner' ? selector.ownerId : 'external'), owner);
  policies.saveGlobal(PUSH_NEEDS_APPROVAL);
  insertCodingWorkflow(database, { id: WORKFLOW, ownerId: OWNER, workspaceId: WORKSPACE, codingPhase: 'PUSH', agentId: 'agent_1', agentGeneration: 1 });
  const clock = { now: T0 };
  let enabled = options.enabled ?? true;
  let workspaceGeneration = options.workspaceGeneration === undefined ? 1 : options.workspaceGeneration;
  const state = () => (database.prepare('SELECT state, approval_id, approval_generation, waiting_since, paused_ms, error_code FROM automation_workflows WHERE id = ?')
    .get(WORKFLOW) as { state: string; approval_id: string | null; approval_generation: number; waiting_since: number | null; paused_ms: number; error_code: string | null });
  const workflows: ApprovalWorkflowPort = {
    wait: (id, approvalId, generation, at) => Number(database.prepare(`UPDATE automation_workflows SET state = 'WAITING_FOR_HUMAN', approval_id = ?,
      approval_generation = ?, waiting_since = ? WHERE id = ? AND state = 'RUNNING'`).run(approvalId, generation, at, id).changes) === 1,
    resume: (id, approvalId, at) => Number(database.prepare(`UPDATE automation_workflows SET state = 'RUNNING', paused_ms = paused_ms + (? - waiting_since),
      waiting_since = NULL WHERE id = ? AND state = 'WAITING_FOR_HUMAN' AND approval_id = ?`).run(at, id, approvalId).changes) === 1,
    fail: (id, code) => Number(database.prepare(`UPDATE automation_workflows SET state = 'FAILED', error_code = ? WHERE id = ? AND state = 'WAITING_FOR_HUMAN'`)
      .run(code, id).changes) === 1
  };
  const spans: TraceApprovalEvent[] = [];
  const audits: string[] = [];
  const service = new AgentApprovalService({
    database,
    enabled: () => enabled,
    ttlSeconds: () => 3_600,
    resolvePrincipal: (selector) => (selector.kind === 'owner' ? selector.ownerId : 'external'),
    workflows,
    workspaceGeneration: () => workspaceGeneration,
    traces: { approval: (_key, event) => { spans.push(event); return { traceId: 't', spanId: 's' }; } },
    audit: (_database, _principal, action) => { audits.push(action); },
    now: () => clock.now
  });
  const actions = new CodingActionStore(database, () => clock.now);
  const decision: GateDecision = policies.service.evaluate(OWNER, CODING_PROJECT, AgentActionDescriptorSchema.parse(PUSH), { usage: {} });
  const record = actions.record({
    principalId: OWNER, workflowId: WORKFLOW, workspaceId: WORKSPACE, agentId: 'agent_1', agentGeneration: 1, idempotencyKey: options.stepKey ?? STEP_KEY,
    origin: 'runner', step: 'push', descriptor: AgentActionDescriptorSchema.parse(PUSH), projectId: CODING_PROJECT, decision, state: 'REJECTED'
  }).record;
  const request = (generation = 1) => service.request({
    principalId: OWNER, workflowId: WORKFLOW, record, decision, generation, repository: CODING_REPOSITORY,
    diff: { artifactId: 'art_1', files: 2, additions: 3, deletions: 1 }, contentDigest: CONTENT, expiresAt: clock.now + 3_600_000, trace: { agentId: 'agent_1', generation: 1 }
  });
  const decide = (approvalId: string, choice: 'approve' | 'deny', options: { digest?: string; principal?: RunnerPrincipalSelector } = {}) =>
    service.execute({ version: 1, principal: options.principal ?? owner, operation: 'approval_decide', input: { approvalId, decision: choice, expectedDigest: options.digest ?? decision.inputFingerprint } });
  const notifications = (kind: string) => (database.prepare('SELECT COUNT(*) AS count FROM notifications WHERE kind = ?').get(kind) as { count: number }).count;
  return { database, service, clock, state, request, decide, decision, spans, audits, notifications, setEnabled: (value: boolean) => { enabled = value; },
    setWorkspaceGeneration: (value: number | null) => { workspaceGeneration = value; } };
}

describe('agent approval service', () => {
  it('pauses the workflow with one pending approval, its notification, audit entry and span', () => {
    const context = setup();
    const approval = context.request();
    expect(approval).toMatchObject({ state: 'PENDING', stepKey: STEP_KEY, descriptorDigest: context.decision.inputFingerprint, contentDigest: CONTENT, generation: 1 });
    expect(context.state()).toMatchObject({ state: 'WAITING_FOR_HUMAN', approval_id: approval!.approvalId, approval_generation: 1, waiting_since: T0 });
    expect(context.notifications('workflow.waiting_for_human')).toBe(1);
    expect(context.audits).toEqual(['agent.approval.requested']);
    expect(context.spans).toEqual([expect.objectContaining({ phase: 'requested', outcome: 'pending', approvalId: approval!.approvalId })]);
    const listed = context.service.execute({ version: 1, principal: owner, operation: 'approvals_list', input: {} });
    expect(listed.ok && AgentApprovalSummarySchema.array().parse((listed.data as { approvals: unknown[] }).approvals)).toHaveLength(1);
    expect(context.service.execute({ version: 1, principal: stranger, operation: 'approvals_list', input: {} })).toMatchObject({ ok: true, data: { approvals: [] } });
  });

  it('writes nothing when the workflow already left RUNNING', () => {
    const context = setup();
    context.database.prepare("UPDATE automation_workflows SET state = 'CANCELLED' WHERE id = ?").run(WORKFLOW);
    expect(context.request()).toBeNull();
    expect(context.database.prepare('SELECT COUNT(*) AS count FROM agent_action_approvals').get()).toEqual({ count: 0 });
    expect(context.notifications('workflow.waiting_for_human')).toBe(0);
  });

  it('approves once, resumes the workflow with the wait counted as paused, and lifts only the exact digest', () => {
    const context = setup();
    const approval = context.request()!;
    expect(context.service.approvedFor(OWNER, WORKFLOW, STEP_KEY, context.decision.inputFingerprint)).toBeNull();
    expect(context.service.stepKey(OWNER, WORKFLOW, STEP_KEY)).toBe(STEP_KEY);
    context.clock.now += 60_000;
    expect(context.decide(approval.approvalId, 'approve')).toMatchObject({ ok: true, data: { workflowState: 'RUNNING', approval: { state: 'APPROVED' } } });
    expect(context.state()).toMatchObject({ state: 'RUNNING', paused_ms: 60_000, waiting_since: null });
    expect(context.decide(approval.approvalId, 'approve')).toMatchObject({ ok: false, error: { code: 'APPROVAL_ALREADY_DECIDED' } });

    expect(context.service.stepKey(OWNER, WORKFLOW, STEP_KEY)).toBe(resumeKey(WORKFLOW, approval.approvalId));
    expect(context.service.stepKey(OWNER, WORKFLOW, `automation:${WORKFLOW}:pr`)).toBe(`automation:${WORKFLOW}:pr`);
    expect(context.service.approvedFor(OWNER, WORKFLOW, STEP_KEY, 'f'.repeat(64))).toBeNull();
    expect(context.service.approvedFor('stranger', WORKFLOW, STEP_KEY, context.decision.inputFingerprint)).toBeNull();
    expect(context.service.approvedFor(OWNER, WORKFLOW, STEP_KEY, context.decision.inputFingerprint)).toBe(approval.approvalId);
    expect(context.service.store.get(approval.approvalId)).toMatchObject({ state: 'CONSUMED', consumedAt: context.clock.now });
    // A replay of the resumed step after a restart still finds it.
    expect(context.service.approvedFor(OWNER, WORKFLOW, STEP_KEY, context.decision.inputFingerprint)).toBe(approval.approvalId);
    // Turned off, nothing is lifted any more.
    context.setEnabled(false);
    expect(context.service.approvedFor(OWNER, WORKFLOW, STEP_KEY, context.decision.inputFingerprint)).toBeNull();
    expect(context.service.stepKey(OWNER, WORKFLOW, STEP_KEY)).toBe(STEP_KEY);
  });

  it('denies into a failed workflow with the decided notification and span', () => {
    const context = setup();
    const approval = context.request()!;
    expect(context.decide(approval.approvalId, 'deny')).toMatchObject({ ok: true, data: { workflowState: 'FAILED', approval: { state: 'DENIED', decidedBy: 'owner' } } });
    expect(context.state()).toMatchObject({ state: 'FAILED', error_code: 'APPROVAL_DENIED' });
    expect(context.notifications('approval.decided')).toBe(1);
    expect(context.audits).toEqual(['agent.approval.requested', 'agent.approval.denied']);
    expect(context.spans.at(-1)).toMatchObject({ phase: 'decided', outcome: 'denied' });
    expect(context.service.approvedFor(OWNER, WORKFLOW, STEP_KEY, context.decision.inputFingerprint)).toBeNull();
  });

  it('refuses typed: not found, another principal, a changed digest, a stale pause or workspace, disabled, expired', () => {
    const context = setup();
    const approval = context.request()!;
    expect(context.decide(`apv_${'0'.repeat(32)}`, 'approve')).toMatchObject({ ok: false, error: { code: 'APPROVAL_NOT_FOUND' } });
    expect(context.decide(approval.approvalId, 'approve', { principal: stranger })).toMatchObject({ ok: false, error: { code: 'APPROVAL_FORBIDDEN' } });
    expect(context.decide(approval.approvalId, 'approve', { digest: 'f'.repeat(64) })).toMatchObject({ ok: false, error: { code: 'APPROVAL_STALE' } });
    context.database.prepare('UPDATE automation_workflows SET approval_generation = 2 WHERE id = ?').run(WORKFLOW);
    expect(context.decide(approval.approvalId, 'approve')).toMatchObject({ ok: false, error: { code: 'APPROVAL_STALE' } });
    context.database.prepare('UPDATE automation_workflows SET approval_generation = 1 WHERE id = ?').run(WORKFLOW);
    context.setEnabled(false);
    expect(context.decide(approval.approvalId, 'approve')).toMatchObject({ ok: false, error: { code: 'FEATURE_DISABLED' } });
    context.setEnabled(true);
    expect(context.service.execute({ version: 1, principal: owner, operation: 'approval_decide', input: { approvalId: 'nope' } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(context.state().state).toBe('WAITING_FOR_HUMAN');

    context.clock.now = approval.expiresAt;
    expect(context.decide(approval.approvalId, 'approve')).toMatchObject({ ok: false, error: { code: 'APPROVAL_EXPIRED' } });
    expect(context.state()).toMatchObject({ state: 'FAILED', error_code: 'APPROVAL_EXPIRED' });
    expect(context.service.store.get(approval.approvalId)).toMatchObject({ state: 'EXPIRED', decidedBy: 'system' });
  });

  it('refuses a decision once the workspace was recreated and ends the wait there', () => {
    const context = setup({ workspaceGeneration: 2 });
    const approval = context.request()!;
    expect(context.decide(approval.approvalId, 'approve')).toMatchObject({ ok: false, error: { code: 'APPROVAL_STALE' } });
    expect(context.state()).toMatchObject({ state: 'FAILED', error_code: 'APPROVAL_STALE' });
    expect(context.service.store.get(approval.approvalId)).toMatchObject({ state: 'EXPIRED', decidedBy: 'system' });
    expect(context.notifications('approval.decided')).toBe(1);
    expect(context.audits).toEqual(['agent.approval.requested', 'agent.approval.expired']);
    expect(context.spans.at(-1)).toMatchObject({ phase: 'decided', outcome: 'expired' });
    expect(context.decide(approval.approvalId, 'approve')).toMatchObject({ ok: false, error: { code: 'APPROVAL_EXPIRED' } });
  });

  it('fails a waiting workflow on the sweeper as soon as its workspace is gone, long before the deadline', () => {
    const context = setup();
    const approval = context.request()!;
    context.service.sweep();
    expect(context.state().state).toBe('WAITING_FOR_HUMAN');

    context.setWorkspaceGeneration(null);
    context.clock.now += 60_000;
    context.service.sweep();
    expect(context.state()).toMatchObject({ state: 'FAILED', error_code: 'APPROVAL_STALE' });
    expect(context.service.store.get(approval.approvalId)).toMatchObject({ state: 'EXPIRED', decidedBy: 'system' });
    expect(context.notifications('approval.decided')).toBe(1);
    expect(context.audits.at(-1)).toBe('agent.approval.expired');
    // Settled once: another pass changes nothing.
    context.service.sweep();
    expect(context.notifications('approval.decided')).toBe(1);
  });

  it('lets only the held step use an approval and consumes one the re-gate no longer needed', () => {
    const context = setup();
    const approval = context.request()!;
    expect(context.decide(approval.approvalId, 'approve').ok).toBe(true);
    // Same descriptor digest, another step of the workflow: not covered.
    expect(context.service.approvedFor(OWNER, WORKFLOW, `automation:${WORKFLOW}:pr`, context.decision.inputFingerprint)).toBeNull();
    expect(context.service.store.get(approval.approvalId)?.state).toBe('APPROVED');
    // Another step's admission leaves it alone; the held step's admission without the approval consumes it.
    context.service.consume(OWNER, WORKFLOW, `automation:${WORKFLOW}:pr`);
    expect(context.service.store.get(approval.approvalId)?.state).toBe('APPROVED');
    context.service.consume(OWNER, WORKFLOW, STEP_KEY);
    expect(context.service.store.get(approval.approvalId)).toMatchObject({ state: 'CONSUMED', consumedAt: context.clock.now });
    expect(context.service.latestApproved(OWNER, WORKFLOW)).toMatchObject({ approvalId: approval.approvalId, contentDigest: CONTENT });
  });

  it("lets the push's repeat of an approved commit path check use that approval, and nothing else", () => {
    const commitPaths = `automation:${WORKFLOW}:commit:paths:0`;
    const context = setup({ stepKey: commitPaths });
    const approval = context.request()!;
    expect(approval.stepKey).toBe(commitPaths);
    expect(context.decide(approval.approvalId, 'approve').ok).toBe(true);
    const digest = context.decision.inputFingerprint;
    for (const key of [`automation:${WORKFLOW}:push:paths:1`, `automation:${WORKFLOW}:push:paths:00`, `automation:${WORKFLOW}:push:paths:`,
      `automation:${WORKFLOW}:push`, `automation:wfl_${'f'.repeat(32)}:push:paths:0`, `automation:${WORKFLOW}:pr:paths:0`]) {
      expect(context.service.approvedFor(OWNER, WORKFLOW, key, digest), key).toBeNull();
    }
    expect(context.service.approvedFor(OWNER, WORKFLOW, `automation:${WORKFLOW}:push:paths:0`, 'f'.repeat(64))).toBeNull();
    expect(context.service.store.get(approval.approvalId)?.state).toBe('APPROVED');
    expect(context.service.approvedFor(OWNER, WORKFLOW, commitPaths, digest)).toBe(approval.approvalId);
    expect(context.service.store.get(approval.approvalId)?.state).toBe('CONSUMED');
    expect(context.service.approvedFor(OWNER, WORKFLOW, `automation:${WORKFLOW}:push:paths:0`, digest)).toBe(approval.approvalId);
  });

  it('retires an unused approval whose change no longer matches, audited', () => {
    const context = setup();
    const approval = context.request()!;
    expect(context.decide(approval.approvalId, 'approve').ok).toBe(true);
    context.service.revoke(context.service.store.get(approval.approvalId)!);
    expect(context.service.store.get(approval.approvalId)?.state).toBe('EXPIRED');
    expect(context.audits.at(-1)).toBe('agent.approval.stale');
    expect(context.service.approvedFor(OWNER, WORKFLOW, STEP_KEY, context.decision.inputFingerprint)).toBeNull();
    expect(context.service.stepKey(OWNER, WORKFLOW, STEP_KEY)).toBe(STEP_KEY);
  });

  it('sweeps expired approvals into failed workflows and drains every wait when approvals are off', () => {
    const expired = setup();
    const first = expired.request()!;
    expired.clock.now = first.expiresAt + 1;
    expired.service.sweep();
    expect(expired.state()).toMatchObject({ state: 'FAILED', error_code: 'APPROVAL_EXPIRED' });
    expect(expired.notifications('approval.decided')).toBe(1);
    expect(expired.spans.at(-1)).toMatchObject({ phase: 'decided', outcome: 'expired' });

    const drained = setup();
    const second = drained.request()!;
    drained.setEnabled(false);
    drained.service.sweep();
    expect(drained.state()).toMatchObject({ state: 'FAILED', error_code: 'APPROVALS_DISABLED' });
    expect(drained.service.store.get(second.approvalId)?.state).toBe('EXPIRED');
  });

  it('expires the approval of a workflow that stopped waiting without touching the workflow', () => {
    const context = setup();
    const approval = context.request()!;
    context.database.prepare("UPDATE automation_workflows SET state = 'CANCELLED' WHERE id = ?").run(WORKFLOW);
    context.service.sweep();
    expect(context.service.store.get(approval.approvalId)?.state).toBe('EXPIRED');
    expect(context.state()).toMatchObject({ state: 'CANCELLED', error_code: null });
    expect(context.notifications('approval.decided')).toBe(0);
  });
});

describe('agent approval store', () => {
  it('moves each approval out of PENDING exactly once', () => {
    const context = setup();
    const approval = context.request()!;
    const store = new AgentApprovalStore(context.database);
    const digest = context.decision.inputFingerprint;
    expect(store.decide(approval.approvalId, OWNER, digest, 'APPROVED', T0 + 1)).toBe(true);
    expect(store.decide(approval.approvalId, OWNER, digest, 'DENIED', T0 + 2)).toBe(false);
    expect(store.expire(approval.approvalId, T0 + 3)).toBe(false);
    expect(store.consume(approval.approvalId, T0 + 4)).toBe(true);
    expect(store.consume(approval.approvalId, T0 + 5)).toBe(false);
    expect(store.get(approval.approvalId)).toMatchObject({ state: 'CONSUMED', decidedAt: T0 + 1, consumedAt: T0 + 4 });
  });

  it('decides only for the principal, the digest and before the deadline', () => {
    const context = setup();
    const approval = context.request()!;
    const store = new AgentApprovalStore(context.database);
    const digest = context.decision.inputFingerprint;
    expect(store.decide(approval.approvalId, 'stranger', digest, 'APPROVED', T0)).toBe(false);
    expect(store.decide(approval.approvalId, OWNER, 'f'.repeat(64), 'APPROVED', T0)).toBe(false);
    expect(store.decide(approval.approvalId, OWNER, digest, 'APPROVED', approval.expiresAt)).toBe(false);
    expect(store.get(approval.approvalId)?.state).toBe('PENDING');
  });

  it('indexes pending approvals by deadline for the sweeper', () => {
    const context = setup();
    const indexes = (context.database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_action_approvals'").all() as { name: string }[])
      .map((entry) => entry.name);
    expect(indexes).toContain('agent_action_approvals_deadline');
    const plan = context.database.prepare("EXPLAIN QUERY PLAN SELECT approval_id FROM agent_action_approvals WHERE state = 'PENDING' AND expires_at <= ?").all(T0) as { detail: string }[];
    expect(plan.map((step) => step.detail).join(' ')).toContain('agent_action_approvals_deadline');
  });

  it('purges the approvals of deleted workflows past the horizon only', () => {
    const context = setup();
    const approval = context.request()!;
    const store = new AgentApprovalStore(context.database);
    expect(store.purgeOrphans(T0 + 1)).toBe(0);
    context.database.prepare('DELETE FROM automation_workflows WHERE id = ?').run(WORKFLOW);
    expect(store.purgeOrphans(T0)).toBe(0);
    expect(store.purgeOrphans(T0 + 1)).toBe(1);
    expect(store.get(approval.approvalId)).toBeUndefined();
  });
});
