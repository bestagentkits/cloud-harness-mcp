import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import './dashboard-test-dom.js';
import {
  AGENT_APPROVALS_DISABLED_COPY, agentApprovalDecision, agentApprovalIsActionable, agentApprovalsPending, renderAgentActionApprovals
} from '../dashboard/dashboard-action-approvals.js';
import { AUTOMATION_WORKFLOW_STATES, automationWorkflowStateLabel, renderApprovals, renderAutomationRunDetail } from '../dashboard/dashboard-render.js';

const hostile = '<img src=x onerror=alert(1)>';
const NOW = Date.parse('2026-10-20T00:30:00.000Z');
const approvalId = `apv_${'a'.repeat(32)}`;
const workflowId = `wfl_${'c'.repeat(32)}`;
const digest = 'b'.repeat(64);
const approval = (overrides: Record<string, unknown> = {}) => ({
  approvalId, workflowId, actionId: `act_${'d'.repeat(32)}`, step: 'push', state: 'PENDING',
  descriptor: { version: 1, actionClass: 'publish_branch', repository: 'acme/widgets', branch: 'agent/7-abcdef01' },
  descriptorDigest: digest,
  gate: {
    decision: 'REQUIRE_APPROVAL', reasonCode: 'ADVISOR_ESCALATED',
    reasons: [{ code: 'ADVISOR_ESCALATED', source: 'advisor', detail: 'the advisor found the change risky' }],
    advisor: { required: true, consulted: true, effect: 'escalate', decisionId: 'dec_123', risk: 0.82, confidence: 0.91, fallbackReason: null }
  },
  generation: 1, diff: { artifactId: 'art_1', files: 2, additions: 3, deletions: 1 },
  expiresAt: '2026-10-20T01:00:00.000Z', decidedAt: null, decidedBy: null, consumedAt: null, createdAt: '2026-10-20T00:00:00.000Z',
  ...overrides
});

describe('agent action approvals rendering', () => {
  it('shows what would run, why it waits, the advisor answer, the change and the digest the decision posts', () => {
    const markup = renderAgentActionApprovals({ approvals: [approval()], enabled: true, now: NOW });
    expect(markup).toContain('Push the branch');
    expect(markup).toContain('agent/7-abcdef01');
    expect(markup).toContain('ADVISOR_ESCALATED');
    expect(markup).toContain('the advisor found the change risky');
    expect(markup).toContain('risk 0.82');
    expect(markup).toContain('confidence 0.91');
    expect(markup).toContain('2 files, +3 −1');
    expect(markup).toContain(`href="/dashboard/automations/runs/${workflowId}"`);
    expect(markup).toContain(`data-approval-digest="${digest}"`);
    expect(markup.match(/class="accent-btn approve-agent-action"/g)).toHaveLength(1);
    expect(markup.match(/class="danger deny-agent-action"/g)).toHaveLength(1);
    expect(markup).not.toContain(AGENT_APPROVALS_DISABLED_COPY);
  });

  it('escapes every value and links only well-formed run ids', () => {
    const markup = renderAgentActionApprovals({
      approvals: [approval({ workflowId: hostile, step: hostile, descriptor: { actionClass: hostile, repository: hostile, branch: hostile, command: hostile, paths: [hostile] }, gate: { reasonCode: hostile, reasons: [{ code: hostile, detail: hostile }], advisor: { consulted: true, effect: hostile, decisionId: hostile, risk: 0.5, confidence: 0.5, fallbackReason: hostile } }, diff: { artifactId: hostile, files: 1, additions: 0, deletions: 0 } })],
      enabled: true, now: NOW
    });
    expect(markup).not.toContain(hostile);
    expect(markup).toContain('&lt;img');
    expect(markup).not.toContain('href="/dashboard/automations/runs/&lt;');
    expect(markup).not.toMatch(/style=/i);
  });

  it('offers no decision for an expired, decided or malformed approval and says so in words', () => {
    const rows = [
      approval({ expiresAt: '2026-10-20T00:00:01.000Z' }),
      approval({ state: 'DENIED', decidedAt: '2026-10-20T00:10:00.000Z', decidedBy: 'owner' }),
      approval({ state: 'CONSUMED', decidedAt: '2026-10-20T00:10:00.000Z', decidedBy: 'owner', consumedAt: '2026-10-20T00:11:00.000Z' }),
      approval({ descriptorDigest: 'not-a-digest' })
    ];
    const markup = renderAgentActionApprovals({ approvals: rows, enabled: true, now: NOW });
    expect(markup).not.toContain('approve-agent-action');
    expect(markup).toContain('Expired');
    expect(markup).toContain('Denied');
    expect(markup).toContain('Approved and used');
    expect(agentApprovalIsActionable(rows[0], NOW)).toBe(false);
    expect(agentApprovalsPending([approval(), ...rows.slice(0, 3)], NOW)).toBe(1);
  });

  it('explains an empty list, the feature being off, and a runner that could not be asked', () => {
    expect(renderAgentActionApprovals({ approvals: [], enabled: true })).toContain('No agent actions are waiting.');
    expect(renderAgentActionApprovals({ approvals: [], enabled: false })).toContain('AGENT_APPROVALS_ENABLED=true');
    expect(renderAgentActionApprovals({ available: false })).toContain('could not be loaded');
  });

  it('builds the decision request only for a well-formed id, verdict and digest', () => {
    expect(agentApprovalDecision(approvalId, 'approve', digest)).toEqual({ path: `/agent-approvals/${approvalId}/decision`, body: { decision: 'approve', expectedDigest: digest } });
    expect(agentApprovalDecision(approvalId, 'deny', digest)?.body.decision).toBe('deny');
    expect(agentApprovalDecision('apv_../x', 'approve', digest)).toBeNull();
    expect(agentApprovalDecision(approvalId, 'maybe', digest)).toBeNull();
    expect(agentApprovalDecision(approvalId, 'approve', 'B'.repeat(64))).toBeNull();
  });

  it('places the section first on the Approvals page and marks waiting runs on the automation pages', () => {
    const page = renderApprovals({ agentActions: renderAgentActionApprovals({ approvals: [approval()], enabled: true, now: NOW }), now: NOW });
    expect(page.indexOf('Agent actions')).toBeLessThan(page.indexOf('Privilege requests'));
    expect(AUTOMATION_WORKFLOW_STATES).toContain('WAITING_FOR_HUMAN');
    expect(automationWorkflowStateLabel('WAITING_FOR_HUMAN')).toBe('Waiting for approval');
    const detail = renderAutomationRunDetail({
      workflow: {
        id: workflowId, state: 'WAITING_FOR_HUMAN', label: 'claude', eventType: 'github.issue.label_added', ruleId: 'rule_1', ruleGeneration: 1,
        deliveryId: 'delivery-1', repository: 'acme/widgets', resourceNumber: 7, resourceUrl: 'https://github.com/acme/widgets/issues/7',
        workspaceId: null, agentId: null, agentStatus: null, errorCode: null, publishState: 'NONE', usage: null,
        createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z', terminalAt: null, approvalId
      }
    });
    expect(detail).toContain('<span class="status pending">Waiting for approval</span>');
    expect(detail).toContain('href="/dashboard/approvals"');
  });

  it('is served as a Dashboard asset and wired into the Approvals page', () => {
    const assets = readFileSync(new URL('../src/dashboard-assets.ts', import.meta.url), 'utf8');
    expect(assets).toContain("'dashboard-action-approvals.js'");
    const shell = readFileSync(new URL('../dashboard/dashboard.js', import.meta.url), 'utf8');
    expect(shell).toContain("from './dashboard-action-approvals.js'");
    expect(shell).toContain('readAgentApprovals()');
  });
});
