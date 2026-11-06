/**
 * Realistic BFF answers for the Activity page: the `buildActivityProjection` shape
 * (`apps/api/src/dashboard-response.ts`) and the privilege-grant and package-plan lists the
 * approvals summary counts.
 */
export const AGENT_ID = `agent_${'a1'.repeat(12)}`;
export const WORKSPACE_ID = `ws_${'b2'.repeat(12)}`;

export const ACTIVITY = {
  data: {
    events: [
      { at: '2026-10-20T10:05:00.000Z', category: 'agents', status: 'running', actor: WORKSPACE_ID, summary: `Agent ${AGENT_ID} RUNNING`, href: `/dashboard/agents/${AGENT_ID}`, durable: false },
      { at: '2026-10-20T10:04:00.000Z', category: 'agents', status: 'failed', actor: WORKSPACE_ID, summary: 'Agent with a hostile link FAILED', href: 'javascript:alert(1)', durable: false },
      { at: '2026-10-20T10:03:00.000Z', category: 'audit', status: 'recorded', actor: `workspace ${WORKSPACE_ID}`, summary: 'workspace_open', durable: true },
      { at: '2026-10-20T10:02:00.000Z', category: 'mcp', status: 'recorded', actor: 'mcp_server srv_1', summary: 'mcp_server_create', durable: true },
      { at: '2026-10-20T10:01:00.000Z', category: 'tasks', status: 'recorded', actor: 'task task_1', summary: '<img src=x onerror=alert(1)>', durable: true }
    ]
  }
};

export const EMPTY_ACTIVITY = { data: { events: [] } };

export const GRANTS = {
  data: {
    grants: [
      { id: `grant_${'c'.repeat(24)}`, workspaceId: WORKSPACE_ID, command: 'npm run migrate', cwd: '.', commandSha256: 'd'.repeat(64), status: 'PENDING', createdAt: '2026-10-20T09:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' },
      { id: `grant_${'e'.repeat(24)}`, workspaceId: WORKSPACE_ID, command: 'apt-get install jq', cwd: '.', commandSha256: 'f'.repeat(64), status: 'APPROVED', createdAt: '2026-10-19T09:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' }
    ]
  }
};

export const PLANS = {
  data: {
    enabled: true,
    approvalMode: 'required',
    plans: [
      { planId: `plan_${'g'.repeat(24)}`, planDigest: 'h'.repeat(64), status: 'PENDING_APPROVAL', scope: 'instance', ecosystem: 'npm', name: 'typescript', version: '5.9.0', createdAt: '2026-10-20T08:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' }
    ]
  }
};
