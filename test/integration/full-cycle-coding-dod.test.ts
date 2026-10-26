import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_TRACE_RESULT_SCHEMAS,
  AgentApprovalSummarySchema,
  type GlobalExecutionPolicy,
  type TraceSpan
} from '@cloud-harness/contracts';
import { ExecutionRiskAdvisor } from '../../apps/runner/src/decision-plane/execution-risk-advisor.js';
import { CODING_GLOBAL_POLICY, VERIFY_COMMAND } from '../../apps/runner/test/support/coding-policy.js';
import { FakeJevProvider, fakeJevPlane } from '../../apps/runner/test/support/fake-jev-provider.js';
import { disableNotifications, enableNotifications } from '../../apps/runner/test/support/notification-fixtures.js';
import { createCodingHarness, FIXED_SOURCES, type CodingHarness } from '../support/coding-harness.js';
import { git } from '../support/fake-github-backend.js';

/**
 * The whole governed coding cycle in one run: a labelled issue starts a coding workflow, the agent fixes
 * it inside the brokered loop, the execution policy leaves opening the pull request to the advisor, the
 * (scripted) Jev advisor escalates it, the workflow waits for the owner, the owner approves, the
 * workflow resumes and opens one pull request on the fake GitHub backend, the owner is notified at each
 * turn, and after the workspace is closed the agent's trace still reads back with model, tool, action,
 * decision and approval spans linked to the workflow and its totals reconciled with the usage ledger.
 */

const TYPESAFE_KEY = 'ts_live_0123456789abcdefghijklmnopqrstuv';
const ESCALATE = { kind: 'risk', risk: 0.82, confidence: 0.91, uncertainSideEffects: 0.2, humanRequired: 0.3 } as const;

/** The coding policy with opening a pull request left to the advisor, which may clear or escalate it. */
const ADVISED_PR_POLICY: GlobalExecutionPolicy = {
  ...CODING_GLOBAL_POLICY,
  defaults: { ...CODING_GLOBAL_POLICY.defaults, open_pr: { effect: 'advisor_or_approval', delegable: true } },
  advisor: { enabled: true, riskThreshold: 0.5, minConfidence: 0.7, fallback: 'require_approval' }
};

const harnesses: CodingHarness[] = [];
beforeEach(() => enableNotifications());
afterEach(async () => {
  disableNotifications();
  for (const harness of harnesses.splice(0)) await harness.close();
});

describe('governed coding cycle: issue to approved pull request', { timeout: 30_000 }, () => {
  it('escalates the pull request through the advisor, waits for the owner, resumes on approval and keeps a reconciled trace', async () => {
    const jev = new FakeJevProvider(ESCALATE);
    const { plane, traces: decisionTraces } = fakeJevPlane({ provider: jev, secretsFor: () => ({ TYPESAFE_API_KEY: TYPESAFE_KEY }) });
    const harness = await createCodingHarness({ approvals: true, policy: ADVISED_PR_POLICY, advisor: new ExecutionRiskAdvisor(plane) });
    harnesses.push(harness);

    // A labelled issue starts one coding workflow; the agent fixes it and runs the tests.
    expect(harness.deliver().response.outcome).toBe('accepted');
    await harness.tick();
    const workflowId = harness.workflows()[0]!.id;
    await harness.runAgent(workflowId, [
      { operation: 'files_write', input: { path: 'src/math.mjs', content: FIXED_SOURCES['src/math.mjs'] } },
      { operation: 'files_write', input: { path: 'src/greeting.mjs', content: FIXED_SOURCES['src/greeting.mjs'] } },
      { operation: 'exec_run', input: { command: VERIFY_COMMAND } }
    ]);
    for (let pass = 0; pass < 8 && harness.row(workflowId).state !== 'WAITING_FOR_HUMAN'; pass += 1) await harness.tick();

    // The advisor escalated opening the pull request: the branch is pushed, the workflow waits.
    expect(harness.row(workflowId)).toMatchObject({ state: 'WAITING_FOR_HUMAN', error_code: null });
    expect(jev.calls).toBeGreaterThanOrEqual(1);
    expect(harness.github.pushes).toHaveLength(1);
    expect(harness.github.pulls).toHaveLength(0);
    const listed = harness.approvals('approvals_list', { state: 'PENDING' });
    if (!listed.ok) throw new Error(listed.error.code);
    const [held] = (listed.data as { approvals: unknown[] }).approvals.map((entry) => AgentApprovalSummarySchema.parse(entry));
    expect(held).toMatchObject({ workflowId, step: 'open_pr', state: 'PENDING' });
    expect(held!.gate).toMatchObject({ decision: 'REQUIRE_APPROVAL', advisor: { consulted: true, effect: 'escalate' } });
    const advisorDecisionId = held!.gate.advisor.decisionId;
    expect(advisorDecisionId).toEqual(expect.any(String));
    expect(decisionTraces.map((trace) => trace.decisionId)).toContain(advisorDecisionId);

    // The owner approves once; the workflow resumes and opens exactly one pull request.
    const decided = harness.approvals('approval_decide', { approvalId: held!.approvalId, decision: 'approve', expectedDigest: held!.descriptorDigest });
    expect(decided.ok && (decided.data as { workflowState: string }).workflowState).toBe('RUNNING');
    await harness.tick(4);

    const { workflow, actions } = harness.workflow(workflowId);
    expect(workflow.state).toBe('COMPLETED');
    const branch = workflow.coding!.branch!;
    expect(harness.github.pushes).toEqual([{ branch, oid: workflow.coding!.commitSha }]);
    expect(harness.github.pulls).toHaveLength(1);
    expect(harness.github.pulls[0]).toMatchObject({ head: branch, base: 'main', state: 'OPEN' });
    expect(workflow.coding!.prUrl).toBe(harness.github.pulls[0]!.url);
    expect(git(harness.github.remote, ['diff', '--name-only', `main..${branch}`]).split('\n').filter(Boolean).sort()).toEqual(['src/greeting.mjs', 'src/math.mjs']);
    const opened = actions.filter((receipt) => receipt.step === 'open_pr');
    expect(opened.map((receipt) => receipt.state).sort()).toEqual(['APPLIED', 'REJECTED']);
    expect(opened.find((receipt) => receipt.state === 'APPLIED')?.outcome.approvalId).toBe(held!.approvalId);
    const approvalAfter = harness.approvals('approval_get', { approvalId: held!.approvalId });
    expect(approvalAfter.ok && (approvalAfter.data as { approval: { state: string } }).approval.state).toBe('CONSUMED');

    // The owner was told when the workflow started waiting, when the approval was decided, and when it finished.
    const kinds = (harness.store.database.prepare('SELECT kind FROM notifications ORDER BY created_at, rowid').all() as { kind: string }[]).map((row) => row.kind);
    expect(kinds).toEqual(expect.arrayContaining(['workflow.waiting_for_human', 'approval.decided', 'automation.completed']));
    expect(kinds.filter((kind) => kind === 'workflow.waiting_for_human')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'approval.decided')).toHaveLength(1);

    // After the workspace is closed, the trace reads back through the trace operations' result contracts.
    const row = harness.row(workflowId);
    expect(row.workspace_closed).toBe(1);
    expect(harness.store.byId(String(row.workspace_id))?.status).toBe('CLOSED');
    const traceId = workflow.coding!.traceId!;
    const detail = AGENT_TRACE_RESULT_SCHEMAS.agent_trace_get.parse(harness.traces.get(harness.ownerId, traceId, harness.clock.now)).trace;
    expect(detail).toMatchObject({ workflowId, state: 'COMPLETED' });
    const spans: TraceSpan[] = AGENT_TRACE_RESULT_SCHEMAS.agent_trace_spans
      .parse(harness.traces.spans(harness.ownerId, { traceId, limit: 500 }, harness.clock.now)).spans;
    for (const kind of ['model_call', 'tool_call', 'action', 'decision', 'approval'] as const) {
      expect(spans.some((span) => span.kind === kind), kind).toBe(true);
    }

    // Every span hangs off the trace's tree, and the receipts point at their action spans.
    const ids = new Set(spans.map((span) => span.spanId));
    for (const span of spans) if (span.parentSpanId !== null) expect(ids.has(span.parentSpanId), span.name).toBe(true);
    for (const receipt of actions) {
      expect(receipt.traceId).toBe(traceId);
      expect(spans.find((span) => span.spanId === receipt.spanId)?.kind).toBe('action');
    }
    // The advisor's decision span sits under the open_pr action it decided and names its Decision Plane id.
    const decisions = spans.filter((span) => span.kind === 'decision');
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    for (const span of decisions) {
      const parent = spans.find((candidate) => candidate.spanId === span.parentSpanId);
      expect(parent).toMatchObject({ kind: 'action', attributes: { workflow_step: 'open_pr' } });
    }
    expect(decisions.map((span) => span.attributes.decision_id)).toContain(advisorDecisionId);
    expect(decisions[0]!.attributes).toMatchObject({ advisor_effect: 'escalate', risk: 0.82, confidence: 0.91 });
    // The approval spans: requested, then approved.
    expect(spans.filter((span) => span.kind === 'approval').map((span) => [span.name, span.attributes.outcome, span.attributes.approval_id])).toEqual([
      ['approval.requested', 'pending', held!.approvalId],
      ['approval.decided', 'approved', held!.approvalId]
    ]);

    // Totals reconcile: the model spans add up to the agent's usage ledger and to the trace totals.
    const models = spans.filter((span) => span.kind === 'model_call');
    const sum = (pick: (span: TraceSpan) => number | null) => models.reduce((total, span) => total + (pick(span) ?? 0), 0);
    expect(detail.reconciliationStatus).toBe('reconciled');
    expect(detail.reconciliation.spans).toEqual({
      inputTokens: sum((span) => span.tokens.prompt), outputTokens: sum((span) => span.tokens.output), costMicros: sum((span) => span.costMicros)
    });
    expect(detail.reconciliation.ledger).toMatchObject({ inputTokens: detail.reconciliation.spans.inputTokens, outputTokens: detail.reconciliation.spans.outputTokens });
    expect(detail.modelCalls).toBe(models.length);
    expect(detail.spanCount).toBe(spans.length);
  });
});
