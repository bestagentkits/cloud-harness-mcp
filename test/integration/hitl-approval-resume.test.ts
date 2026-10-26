import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentApprovalSummarySchema, type AgentApprovalSummary, type GlobalExecutionPolicy } from '@cloud-harness/contracts';
import { CODING_GLOBAL_POLICY, VERIFY_COMMAND } from '../../apps/runner/test/support/coding-policy.js';
import { disableNotifications, enableNotifications } from '../../apps/runner/test/support/notification-fixtures.js';
import { createCodingHarness, FIXED_SOURCES, type CodingHarness } from '../support/coding-harness.js';
import { git } from '../support/fake-github-backend.js';

/**
 * Owner approval of a held coding step, end to end: the real automation engine, coding broker, policy
 * gate, approval service, notifications and trace recorder on one SQLite state database, with a
 * scripted agent, local clone workspaces and the fake GitHub backend. A runner step the policy holds
 * for approval pauses the workflow as WAITING_FOR_HUMAN; one owner decision resumes or ends it.
 */

const harnesses: CodingHarness[] = [];
beforeEach(() => enableNotifications());
afterEach(async () => {
  disableNotifications();
  for (const harness of harnesses.splice(0)) await harness.close();
});

const PUSH_NEEDS_APPROVAL: GlobalExecutionPolicy = {
  ...CODING_GLOBAL_POLICY,
  defaults: { ...CODING_GLOBAL_POLICY.defaults, publish_branch: { effect: 'require_approval', delegable: false } }
};
const COMMIT_NEEDS_APPROVAL: GlobalExecutionPolicy = {
  ...CODING_GLOBAL_POLICY,
  defaults: { ...CODING_GLOBAL_POLICY.defaults, vcs_local: { effect: 'require_approval', delegable: false } }
};
const DIFF_FILE = '.cloud-harness-coding.diff';

const FIX_BOTH = [
  { operation: 'files_write' as const, input: { path: 'src/math.mjs', content: FIXED_SOURCES['src/math.mjs'] } },
  { operation: 'files_write' as const, input: { path: 'src/greeting.mjs', content: FIXED_SOURCES['src/greeting.mjs'] } },
  { operation: 'exec_run' as const, input: { command: VERIFY_COMMAND } }
];

async function setup(options: Parameters<typeof createCodingHarness>[0] = {}): Promise<CodingHarness> {
  const harness = await createCodingHarness({ approvals: true, policy: PUSH_NEEDS_APPROVAL, ...options });
  harnesses.push(harness);
  return harness;
}

/** Delivers the issue, lets the agent fix it, and runs the engine until the workflow waits for the owner. */
async function waiting(harness: CodingHarness): Promise<{ workflowId: string; approval: AgentApprovalSummary }> {
  harness.deliver();
  await harness.tick();
  const workflowId = harness.workflows()[0]!.id;
  await harness.runAgent(workflowId, FIX_BOTH);
  for (let pass = 0; pass < 8 && harness.row(workflowId).state !== 'WAITING_FOR_HUMAN'; pass += 1) await harness.tick();
  expect(harness.row(workflowId)).toMatchObject({ state: 'WAITING_FOR_HUMAN', error_code: null });
  return { workflowId, approval: pending(harness) };
}

function pending(harness: CodingHarness): AgentApprovalSummary {
  const list = harness.approvals('approvals_list', { state: 'PENDING' });
  if (!list.ok) throw new Error(list.error.code);
  const approvals = (list.data as { approvals: unknown[] }).approvals.map((entry) => AgentApprovalSummarySchema.parse(entry));
  expect(approvals).toHaveLength(1);
  return approvals[0]!;
}

function approval(harness: CodingHarness, approvalId: string): AgentApprovalSummary {
  const got = harness.approvals('approval_get', { approvalId });
  if (!got.ok) throw new Error(got.error.code);
  return AgentApprovalSummarySchema.parse((got.data as { approval: unknown }).approval);
}

function decide(harness: CodingHarness, summary: AgentApprovalSummary, decision: 'approve' | 'deny', options: { digest?: string; principal?: Parameters<CodingHarness['approvals']>[2] } = {}) {
  return harness.approvals('approval_decide', { approvalId: summary.approvalId, decision, expectedDigest: options.digest ?? summary.descriptorDigest }, options.principal);
}

function notifications(harness: CodingHarness, kind: string): { subject_id: string; title: string }[] {
  return harness.store.database.prepare('SELECT subject_id, title FROM notifications WHERE kind = ? ORDER BY created_at').all(kind) as { subject_id: string; title: string }[];
}

function receiptKeys(harness: CodingHarness, workflowId: string, step: string): { idempotency_key: string; state: string; decision: string }[] {
  return harness.store.database.prepare('SELECT idempotency_key, state, decision FROM coding_actions WHERE workflow_id = ? AND step = ? ORDER BY created_at, rowid')
    .all(workflowId, step) as { idempotency_key: string; state: string; decision: string }[];
}

function zeroPublishEffects(harness: CodingHarness): void {
  expect(harness.github.pushAttempts).toBe(0);
  expect(harness.github.remoteBranches()).toEqual(['main']);
  expect(harness.github.pulls).toHaveLength(0);
}

describe('coding automation: owner approval of a held step', { timeout: 30_000 }, () => {
  it('pauses a held push as WAITING_FOR_HUMAN with the agent stopped, the workspace kept, a diff artifact, one notification and an approval span', async () => {
    const harness = await setup();
    const { workflowId, approval: held } = await waiting(harness);

    // The agent finished before the runner-owned steps: no live run is left behind.
    const row = harness.row(workflowId);
    const record = harness.store.byId(String(row.workspace_id))!;
    const status = await harness.manager.dispatch(harness.ownerId, record, 'agent_status', { workspaceId: record.id, agentId: String(row.agent_id) });
    expect((status.data as { status: string }).status).toBe('SUCCEEDED');
    // The workspace is kept (and counted as held) for the resume.
    expect(record.status).toBe('ACTIVE');
    expect(row.workspace_closed).toBe(0);

    const { workflow } = harness.workflow(workflowId);
    expect(workflow).toMatchObject({ state: 'WAITING_FOR_HUMAN', approvalId: held.approvalId });
    expect(held).toMatchObject({ workflowId, step: 'push', state: 'PENDING', generation: 1, decidedAt: null });
    expect(held.gate).toMatchObject({ decision: 'REQUIRE_APPROVAL', inputFingerprint: held.descriptorDigest });
    expect(held.descriptor).toMatchObject({ actionClass: 'publish_branch', branch: workflow.coding!.branch });
    // The lease was renewed for the wait, and the approval never outlives it.
    expect(Date.parse(held.expiresAt)).toBeLessThanOrEqual(harness.store.byId(record.id)!.expiresAt);
    expect(Date.parse(held.expiresAt)).toBeGreaterThan(harness.clock.now);

    // The committed change is kept as an artifact, and the file it was read from is gone again.
    expect(held.diff).toMatchObject({ files: 2, additions: expect.any(Number), deletions: expect.any(Number) });
    const artifact = harness.workspaces.artifacts.get(String(held.diff.artifactId));
    expect(artifact?.logicalName).toBe(`coding-${workflowId}-approval-1.diff`);
    expect(artifact?.content).toContain('src/math.mjs');
    expect(existsSync(join(harness.workspaces.checkout(record.id), DIFF_FILE))).toBe(false);

    expect(notifications(harness, 'workflow.waiting_for_human')).toEqual([expect.objectContaining({ subject_id: workflowId })]);
    expect(harness.audits.filter((entry) => entry.action === 'agent.approval.requested')).toHaveLength(1);
    const spans = harness.traces.spanRows(workflow.coding!.traceId!, 500).filter((span) => span.kind === 'approval');
    expect(spans).toHaveLength(1);
    zeroPublishEffects(harness);

    // Waiting is not running: further passes change nothing.
    await harness.tick(3);
    expect(harness.row(workflowId).state).toBe('WAITING_FOR_HUMAN');
    zeroPublishEffects(harness);
  });

  it('resumes exactly once on approval and publishes one push and one pull request; the approval is consumed', async () => {
    const harness = await setup();
    const { workflowId, approval: held } = await waiting(harness);

    const decided = decide(harness, held, 'approve');
    expect(decided.ok).toBe(true);
    expect(decided.ok && (decided.data as { workflowState: string }).workflowState).toBe('RUNNING');
    await harness.tick(4);

    const { workflow } = harness.workflow(workflowId);
    expect(workflow.state).toBe('COMPLETED');
    expect(harness.github.pushes).toEqual([{ branch: workflow.coding!.branch, oid: workflow.coding!.commitSha }]);
    expect(harness.github.pulls).toHaveLength(1);
    expect(approval(harness, held.approvalId)).toMatchObject({ state: 'CONSUMED', decidedBy: 'owner' });
    // The held push keeps its refusal; the approved push ran once under its resume key.
    expect(receiptKeys(harness, workflowId, 'push')).toEqual([
      { idempotency_key: `automation:${workflowId}:push`, state: 'REJECTED', decision: 'REQUIRE_APPROVAL' },
      { idempotency_key: `automation:${workflowId}:resume:${held.approvalId}`, state: 'APPLIED', decision: 'REQUIRE_APPROVAL' }
    ]);
    const resumed = harness.workflow(workflowId).actions.find((receipt) => receipt.step === 'push' && receipt.state === 'APPLIED');
    expect(resumed?.outcome.approvalId).toBe(held.approvalId);
    expect(notifications(harness, 'approval.decided')).toEqual([expect.objectContaining({ subject_id: held.approvalId })]);
    const transitions = harness.store.database.prepare('SELECT to_state, actor, code FROM automation_transitions WHERE workflow_id = ? ORDER BY seq')
      .all(workflowId) as { to_state: string; actor: string; code: string | null }[];
    expect(transitions.map((entry) => entry.to_state)).toEqual(['QUEUED', 'STARTING', 'RUNNING', 'WAITING_FOR_HUMAN', 'RUNNING', 'COMPLETED']);
    expect(transitions[4]).toMatchObject({ actor: 'owner', code: 'APPROVAL_GRANTED' });
    const kinds = harness.traces.spanRows(workflow.coding!.traceId!, 500).filter((span) => span.kind === 'approval');
    expect(kinds).toHaveLength(2);
  });

  it('holds a commit before anything is staged for publishing and never commits the diff file it snapshotted', async () => {
    const harness = await setup({ policy: COMMIT_NEEDS_APPROVAL });
    const { workflowId, approval: held } = await waiting(harness);
    expect(held).toMatchObject({ step: 'commit', diff: { files: 2 } });
    const checkout = harness.workspaces.checkout(String(harness.row(workflowId).workspace_id));
    expect(existsSync(join(checkout, DIFF_FILE))).toBe(false);
    expect(harness.count('git_commit')).toBe(0);

    expect(decide(harness, held, 'approve').ok).toBe(true);
    await harness.tick(5);
    const { workflow } = harness.workflow(workflowId);
    expect(workflow.state).toBe('COMPLETED');
    const branch = workflow.coding!.branch!;
    expect(git(harness.github.remote, ['diff', '--name-only', `main..${branch}`]).split('\n').filter(Boolean).sort()).toEqual(['src/greeting.mjs', 'src/math.mjs']);
    expect(harness.count('git_commit')).toBe(1);
  });

  it('takes one decision only: a double submit and a late deny are refused with no extra effect', async () => {
    const harness = await setup();
    const { workflowId, approval: held } = await waiting(harness);

    const [first, second] = [decide(harness, held, 'approve'), decide(harness, held, 'approve')];
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, error: { code: 'APPROVAL_ALREADY_DECIDED' } });
    expect(decide(harness, held, 'deny')).toMatchObject({ ok: false, error: { code: 'APPROVAL_ALREADY_DECIDED' } });
    await harness.tick(4);
    expect(harness.workflow(workflowId).workflow.state).toBe('COMPLETED');
    expect(harness.github.pushes).toHaveLength(1);
    expect(harness.github.pulls).toHaveLength(1);
  });

  it('refuses another principal, a changed digest, a stale pause and an expired approval, all with zero effects', async () => {
    const harness = await setup();
    const { workflowId, approval: held } = await waiting(harness);
    const stranger = { kind: 'external' as const, issuer: 'https://issuer.example.com', subject: 'someone-else' };

    expect(decide(harness, held, 'approve', { principal: stranger })).toMatchObject({ ok: false, error: { code: 'APPROVAL_FORBIDDEN' } });
    expect(harness.approvals('approval_get', { approvalId: held.approvalId }, stranger)).toMatchObject({ ok: false, error: { code: 'APPROVAL_FORBIDDEN' } });
    expect(decide(harness, held, 'approve', { digest: 'f'.repeat(64) })).toMatchObject({ ok: false, error: { code: 'APPROVAL_STALE' } });

    // A later pause of the workflow makes this approval stale.
    harness.store.database.prepare('UPDATE automation_workflows SET approval_generation = approval_generation + 1 WHERE id = ?').run(workflowId);
    expect(decide(harness, held, 'approve')).toMatchObject({ ok: false, error: { code: 'APPROVAL_STALE' } });
    harness.store.database.prepare('UPDATE automation_workflows SET approval_generation = approval_generation - 1 WHERE id = ?').run(workflowId);
    expect(approval(harness, held.approvalId).state).toBe('PENDING');

    harness.clock.now = Date.parse(held.expiresAt) + 1;
    expect(decide(harness, held, 'approve')).toMatchObject({ ok: false, error: { code: 'APPROVAL_EXPIRED' } });
    expect(approval(harness, held.approvalId)).toMatchObject({ state: 'EXPIRED', decidedBy: 'system' });
    expect(harness.workflow(workflowId).workflow).toMatchObject({ state: 'FAILED', errorCode: 'APPROVAL_EXPIRED' });
    expect(decide(harness, held, 'approve')).toMatchObject({ ok: false, error: { code: 'APPROVAL_EXPIRED' } });
    await harness.tick(3);
    zeroPublishEffects(harness);
  });

  it('expires an undecided approval on the sweeper and fails the workflow', async () => {
    const harness = await setup();
    const { workflowId, approval: held } = await waiting(harness);
    harness.clock.now = Date.parse(held.expiresAt) + 1;
    await harness.tick();
    expect(harness.workflow(workflowId).workflow).toMatchObject({ state: 'FAILED', errorCode: 'APPROVAL_EXPIRED' });
    expect(approval(harness, held.approvalId).state).toBe('EXPIRED');
    expect(notifications(harness, 'approval.decided')).toHaveLength(1);
    zeroPublishEffects(harness);
  });

  it('fails the workflow as APPROVAL_DENIED on deny, audited and notified, and keeps the diff artifact', async () => {
    const harness = await setup();
    const { workflowId, approval: held } = await waiting(harness);

    const denied = decide(harness, held, 'deny');
    expect(denied.ok && (denied.data as { workflowState: string }).workflowState).toBe('FAILED');
    expect(harness.workflow(workflowId).workflow).toMatchObject({ state: 'FAILED', errorCode: 'APPROVAL_DENIED' });
    expect(approval(harness, held.approvalId)).toMatchObject({ state: 'DENIED', decidedBy: 'owner' });
    expect(harness.audits.filter((entry) => entry.action === 'agent.approval.denied')).toEqual([
      expect.objectContaining({ subjectType: 'agent_approval', subjectId: held.approvalId })
    ]);
    expect(notifications(harness, 'approval.decided')).toEqual([expect.objectContaining({ subject_id: held.approvalId })]);
    expect(harness.workspaces.artifacts.has(String(held.diff.artifactId))).toBe(true);
    await harness.tick(3);
    zeroPublishEffects(harness);
  });

  it('still refuses the step when a hard deny was added after the request, approval or not', async () => {
    const harness = await setup();
    const { workflowId, approval: held } = await waiting(harness);
    const { publish_branch: _held, ...defaults } = PUSH_NEEDS_APPROVAL.defaults;
    void _held;
    harness.policies.saveGlobal({
      ...PUSH_NEEDS_APPROVAL,
      hardDeny: ['publish_branch'],
      allowedActionClasses: PUSH_NEEDS_APPROVAL.allowedActionClasses.filter((entry) => entry !== 'publish_branch'),
      defaults
    });

    expect(decide(harness, held, 'approve').ok).toBe(true);
    await harness.tick(3);
    const { workflow } = harness.workflow(workflowId);
    expect(workflow.state).toBe('FAILED');
    expect(workflow.errorCode).toMatch(/^ACTION_DENIED:/u);
    expect(receiptKeys(harness, workflowId, 'push').at(-1)).toMatchObject({ state: 'REJECTED', decision: 'DENY' });
    zeroPublishEffects(harness);
  });

  it('resumes once across a runner restart while waiting and another one during the resumed push', async () => {
    const harness = await setup();
    const { workflowId, approval: held } = await waiting(harness);
    harness.restart();
    await harness.tick();
    expect(harness.row(workflowId).state).toBe('WAITING_FOR_HUMAN');

    expect(decide(harness, held, 'approve').ok).toBe(true);
    harness.github.inject('push', 'crash-after-effect');
    await harness.tickUntilCrash();
    harness.restart();
    await harness.tick(4);

    const { workflow } = harness.workflow(workflowId);
    expect(workflow.state).toBe('COMPLETED');
    expect(harness.github.pushes).toEqual([{ branch: workflow.coding!.branch, oid: workflow.coding!.commitSha }]);
    expect(harness.github.pulls).toHaveLength(1);
    const resumed = receiptKeys(harness, workflowId, 'push').filter((entry) => entry.idempotency_key === `automation:${workflowId}:resume:${held.approvalId}`);
    expect(resumed).toEqual([expect.objectContaining({ state: 'APPLIED' })]);
  });

  it('drains a waiting workflow to FAILED/APPROVALS_DISABLED when approvals are turned off', async () => {
    const harness = await setup();
    const { workflowId, approval: held } = await waiting(harness);
    harness.setApprovalsEnabled(false);
    expect(decide(harness, held, 'approve')).toMatchObject({ ok: false, error: { code: 'FEATURE_DISABLED' } });
    await harness.tick();

    expect(harness.workflow(workflowId).workflow).toMatchObject({ state: 'FAILED', errorCode: 'APPROVALS_DISABLED' });
    expect(approval(harness, held.approvalId)).toMatchObject({ state: 'EXPIRED', decidedBy: 'system' });
    expect(harness.store.database.prepare("SELECT COUNT(*) AS count FROM automation_workflows WHERE state = 'WAITING_FOR_HUMAN'").get()).toEqual({ count: 0 });
    zeroPublishEffects(harness);
  });

  it('refuses to commit when the checkout changed after the owner approved the commit', async () => {
    const harness = await setup({ policy: COMMIT_NEEDS_APPROVAL });
    const { workflowId, approval: held } = await waiting(harness);
    expect(decide(harness, held, 'approve').ok).toBe(true);
    // Something in the workspace edits the change the owner reviewed before the resumed commit runs.
    const checkout = harness.workspaces.checkout(String(harness.row(workflowId).workspace_id));
    writeFileSync(join(checkout, 'src/math.mjs'), `${FIXED_SOURCES['src/math.mjs']}\nexport const injected = true;\n`);
    await harness.tick(5);

    expect(harness.workflow(workflowId).workflow).toMatchObject({ state: 'FAILED', errorCode: 'APPROVAL_STALE' });
    expect(harness.count('git_commit')).toBe(0);
    expect(approval(harness, held.approvalId)).toMatchObject({ state: 'EXPIRED', decidedBy: 'owner' });
    expect(harness.audits.filter((entry) => entry.action === 'agent.approval.stale')).toEqual([
      expect.objectContaining({ subjectId: held.approvalId, details: expect.objectContaining({ reason: 'CONTENT_CHANGED' }) })
    ]);
    expect(receiptKeys(harness, workflowId, 'commit').filter((entry) => entry.idempotency_key.includes(':resume:'))).toEqual([]);
    zeroPublishEffects(harness);
  });

  it('fails the waiting workflow as soon as its workspace is gone instead of at the deadline', async () => {
    const harness = await setup();
    const { workflowId, approval: held } = await waiting(harness);
    const workspaceId = String(harness.row(workflowId).workspace_id);
    harness.store.update(workspaceId, { status: 'CLOSED' });
    await harness.tick();

    expect(harness.clock.now).toBeLessThan(Date.parse(held.expiresAt));
    expect(harness.workflow(workflowId).workflow).toMatchObject({ state: 'FAILED', errorCode: 'APPROVAL_STALE' });
    expect(approval(harness, held.approvalId)).toMatchObject({ state: 'EXPIRED', decidedBy: 'system' });
    expect(notifications(harness, 'approval.decided')).toEqual([expect.objectContaining({ subject_id: held.approvalId })]);
    expect(harness.audits.filter((entry) => entry.action === 'agent.approval.expired')).toEqual([
      expect.objectContaining({ subjectId: held.approvalId, details: expect.objectContaining({ reason: 'APPROVAL_STALE' }) })
    ]);
    expect(decide(harness, held, 'approve')).toMatchObject({ ok: false, error: { code: 'APPROVAL_EXPIRED' } });
    zeroPublishEffects(harness);
  });

  it('does not wait while the workspace lease cannot be read, and waits within it once it can', async () => {
    const harness = await setup();
    const run = harness.workspaces.run.bind(harness.workspaces);
    let leaseReadable = false;
    harness.workspaces.run = async (workspaceId, operation, input) => {
      if (!leaseReadable && (operation === 'workspace_lease_renew' || operation === 'workspace_status')) {
        return { ok: false, error: { code: 'UNAVAILABLE', retryable: true } } as Awaited<ReturnType<typeof run>>;
      }
      return await run(workspaceId, operation, input);
    };
    harness.deliver();
    await harness.tick();
    const workflowId = harness.workflows()[0]!.id;
    await harness.runAgent(workflowId, FIX_BOTH);
    for (let pass = 0; pass < 8; pass += 1) {
      await harness.tick();
      harness.clock.now += 10_000;
    }
    expect(harness.row(workflowId)).toMatchObject({ state: 'RUNNING', approval_id: null });
    expect(harness.store.database.prepare('SELECT COUNT(*) AS count FROM agent_action_approvals').get()).toEqual({ count: 0 });
    expect(harness.count('workspace_status')).toBeGreaterThan(0);
    zeroPublishEffects(harness);

    leaseReadable = true;
    for (let pass = 0; pass < 4 && harness.row(workflowId).state !== 'WAITING_FOR_HUMAN'; pass += 1) {
      harness.clock.now += 10_000;
      await harness.tick();
    }
    const held = pending(harness);
    const lease = harness.store.byId(String(harness.row(workflowId).workspace_id))!;
    expect(Date.parse(held.expiresAt)).toBeLessThanOrEqual(Math.min(lease.expiresAt, lease.hardExpiresAt));
  });

  it('expires the pending approval of a workflow the owner cancels while it waits', async () => {
    const harness = await setup();
    const { workflowId, approval: held } = await waiting(harness);
    const cancelled = harness.service.execute({ version: 1, principal: harness.owner, operation: 'workflow_cancel', input: { id: workflowId } });
    expect(cancelled.ok).toBe(true);
    await harness.tick();
    expect(harness.workflow(workflowId).workflow.state).toBe('CANCELLED');
    expect(approval(harness, held.approvalId).state).toBe('EXPIRED');
    expect(decide(harness, held, 'approve')).toMatchObject({ ok: false, error: { code: 'APPROVAL_EXPIRED' } });
    zeroPublishEffects(harness);
  });
});
