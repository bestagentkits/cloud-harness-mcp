/**
 * Overview projections as the BFF returns them (`buildOverviewProjection`,
 * `buildMetricsProjection`, `buildReliabilityProjection` in apps/api/src/dashboard-response.ts
 * and the `/server` handler in apps/api/src/dashboard-router.ts).
 */
export const WORKSPACE_ID = `ws_${'a'.repeat(24)}`;
export const AGENT_ID = `agent_${'b'.repeat(24)}`;

const hourAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

export const overviewProjection = {
  data: {
    attention: [
      { id: `workspace-expiring-${WORKSPACE_ID}`, label: 'Lease expires soon', detail: 'Renew the lease or finalize before the workspace is reaped.', href: `/dashboard/workspaces/${WORKSPACE_ID}/summary` },
      { id: `agent-${AGENT_ID}`, label: 'Agent failed', detail: 'Open the agent for its terminal reason and usage.', href: `/dashboard/agents/${AGENT_ID}` },
      { id: 'pending-approvals', label: '2 pending approval(s)', detail: 'Privilege requests are waiting for a decision.', href: '/dashboard/approvals' }
    ],
    running: { agents: 2, workspaces: 1 },
    cost: { scope: 'running agents', costMicros: 1_250_000, agentCount: 2 },
    expiring: [{ windowMinutes: 15, label: '15 min', count: 1 }, { windowMinutes: 60, label: '1 h', count: 3 }, { windowMinutes: 240, label: '4 h', count: 5 }],
    usageByProfile: [{ profileId: 'coding-fast', inputTokens: 1_000, outputTokens: 200, costMicros: 2_500_000 }],
    budgetBurn: [{ agentId: AGENT_ID, profileId: 'coding-fast', inputTokens: 10, maxInputTokens: 0, outputTokens: 5, maxOutputTokens: 0, costMicros: 4_000_000, maxCostMicros: 5_000_000 }],
    agentOutcomes: [
      { at: hourAgo(2), label: '08:00', tick: '1', segments: { succeeded: 3, attention: 1, cancelled: 0, running: 0, other: 0 } },
      { at: hourAgo(1), label: '09:00', tick: '2', segments: { succeeded: 1, attention: 0, cancelled: 1, running: 2, other: 0 } }
    ],
    costSeries: [
      { at: hourAgo(2), label: '08:00', tick: '1', value: 1.5 },
      { at: hourAgo(1), label: '09:00', tick: '2', value: 0.25 }
    ],
    agentSeriesScope: 'retained agents, bucketed by start time',
    generatedAt: new Date().toISOString()
  }
};

export const emptyOverviewProjection = {
  data: {
    attention: [], running: { agents: 0, workspaces: 0 }, cost: { scope: 'running agents', costMicros: 0, agentCount: 0 },
    expiring: [], usageByProfile: [], budgetBurn: [], agentOutcomes: [], costSeries: [],
    agentSeriesScope: 'no agents on record', generatedAt: new Date().toISOString()
  }
};

export const metricsProjection = {
  data: {
    window: '24h', since: hourAgo(24), scope: 'retained audit events in the last 24h', eventCount: 7, categories: { workspace: 5, agent: 2 },
    series: Array.from({ length: 12 }, (_, index) => ({ at: hourAgo(24 - index * 2), count: index % 3 }))
  }
};

export const emptyMetricsProjection = { data: { window: '24h', since: hourAgo(24), scope: 'retained audit events in the last 24h', eventCount: 0, categories: {}, series: [] } };

export const reliabilityProjection = {
  data: { servers: [{ serverId: 'mcp_1', serverName: 'linear', success: 9, error: 3, calls: 12, p50Ms: 40, p95Ms: 120 }], totalCalls: 12 }
};

export const emptyReliabilityProjection = { data: { servers: [], totalCalls: 0 } };

export const serverInfo = {
  data: {
    authMode: 'cloudflare-access',
    managedOAuthUrl: 'https://harness.example.test/mcp',
    apiKeyGateway: { enabled: true, endpoint: 'https://keys.example.test/mcp' },
    limits: { maxRequestBytes: 1_048_576, requestTimeoutMs: 30_000 },
    version: '0.72.0',
    session: { expiresAt: null, scopes: [] },
    checkedAt: new Date().toISOString()
  }
};

/** Attacker-influenceable strings in every projection field the page renders. */
export const HOSTILE = '<img src=x onerror="window.__xss=1">';
export const hostileOverviewProjection = {
  data: {
    ...overviewProjection.data,
    attention: [{ id: 'x', label: HOSTILE, detail: HOSTILE, href: 'javascript:window.__xss=1' }],
    cost: { scope: HOSTILE, costMicros: 1_000_000 },
    expiring: [{ windowMinutes: 60, label: HOSTILE, count: 1 }],
    usageByProfile: [{ profileId: HOSTILE, inputTokens: 1, outputTokens: 1, costMicros: 1 }],
    agentSeriesScope: HOSTILE
  }
};
