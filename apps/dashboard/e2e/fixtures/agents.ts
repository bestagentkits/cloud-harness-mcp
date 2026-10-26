/**
 * Realistic BFF answers for the Agents pages: the `agentProjection` list and status shapes
 * and the `agent_logs` projection (`apps/api/src/dashboard-response.ts`).
 */
export const WORKSPACE_ID = `ws_${'w1'.repeat(12)}`;
export const PARENT_ID = `agent_${'p1'.repeat(12)}`;
export const CHILD_ID = `agent_${'c1'.repeat(12)}`;
export const FAILED_ID = `agent_${'f1'.repeat(12)}`;

const budget = { ttlSeconds: 3_600, maxOutputBytes: 1_048_576, maxInputTokens: 200_000, maxOutputTokens: 32_000, maxCostMicros: 5_000_000 };

export const PARENT = {
  agentId: PARENT_ID, workspaceId: WORKSPACE_ID, parentAgentId: null, profileId: 'coding-fast', status: 'RUNNING', generation: 2,
  createdAt: '2026-10-20T09:00:00.000Z', startedAt: '2026-10-20T09:00:05.000Z', terminalAt: null, expiresAt: '2099-01-01T00:00:00.000Z',
  terminalReason: null, outcomeUnknown: false, proxyOperations: ['files_read', 'exec_run'],
  budget, usage: { inputTokens: 12_000, outputTokens: 3_400, costMicros: 4_200_000, outputBytes: 20_480, eventCount: 42, toolTimeMs: 81_000, wallTimeMs: 600_000 }
};

export const CHILD = {
  ...PARENT, agentId: CHILD_ID, parentAgentId: PARENT_ID, profileId: 'review', status: 'SUCCEEDED', terminalAt: '2026-10-20T09:30:00.000Z',
  createdAt: '2026-10-20T09:10:00.000Z', usage: { inputTokens: 900, outputTokens: 300, costMicros: 120_000, outputBytes: 1_024, eventCount: 6, toolTimeMs: 2_000, wallTimeMs: 40_000 }
};

export const FAILED = {
  ...PARENT, agentId: FAILED_ID, profileId: 'coding-fast', status: 'FAILED', terminalReason: 'budget exhausted', terminalAt: '2026-10-20T08:30:00.000Z',
  createdAt: '2026-10-20T08:00:00.000Z', usage: { inputTokens: 200_000, outputTokens: 1_000, costMicros: 5_000_000, outputBytes: 4_096, eventCount: 12, toolTimeMs: 9_000, wallTimeMs: 90_000 }
};

export const AGENTS = { data: { agents: [PARENT, CHILD, FAILED] } };
export const FAILED_ONLY = { data: { agents: [FAILED] } };
export const NO_AGENTS = { data: { agents: [] } };

export const LOGS_FIRST = {
  data: {
    agentId: PARENT_ID, cursor: '0', nextCursor: '120', retainedBaseCursor: '0', truncated: false, hasMore: true,
    events: [
      { cursor: '0', timestamp: 1_792_486_800_000, type: 'turn.start', content: 'Planning the change' },
      { cursor: '60', timestamp: 1_792_486_830_000, type: 'tool.call', content: '<img src=x onerror=alert(1)>' }
    ]
  }
};

export const LOGS_NEXT = {
  data: {
    agentId: PARENT_ID, cursor: '120', nextCursor: '180', retainedBaseCursor: '0', truncated: false, hasMore: false,
    events: [{ cursor: '120', timestamp: 1_792_486_860_000, type: 'tool.result', content: 'Tests passed' }]
  }
};

export const LOGS_EMPTY_TAIL = {
  data: { agentId: PARENT_ID, cursor: '180', nextCursor: '180', retainedBaseCursor: '0', truncated: false, hasMore: false, events: [] }
};
