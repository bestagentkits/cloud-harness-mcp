import { describe, expect, it } from 'vitest';
import {
  AGENT_STATUSES, agentAge, agentStatusLabel, agentTreeIndex, agentTtl, budgetUtilization,
  renderAgentDetail, renderAgentHierarchy, renderAgentTable, renderAgentsIndex
} from '../dashboard/dashboard-render.js';

const workspaceId = `ws_${'a'.repeat(24)}`;
const agent = (overrides: Record<string, unknown> = {}) => ({
  agentId: `agent_${'b'.repeat(24)}`,
  workspaceId,
  parentAgentId: null,
  profileId: 'coding-fast',
  status: 'RUNNING',
  generation: 2,
  createdAt: '2026-08-17T00:00:00.000Z',
  startedAt: '2026-08-17T00:00:00.000Z',
  terminalAt: null,
  expiresAt: '2026-08-17T02:00:00.000Z',
  budget: { ttlSeconds: 3_600, maxOutputBytes: 1_024, maxInputTokens: 200_000, maxOutputTokens: 32_000, maxCostMicros: 5_000_000 },
  usage: { inputTokens: 100, outputTokens: 50, costMicros: 1_000_000, outputBytes: 10, eventCount: 3, toolTimeMs: 5, wallTimeMs: 9 },
  terminalReason: null,
  outcomeUnknown: false,
  proxyOperations: ['files_read'],
  ...overrides
});

describe('agent control center renderers', () => {
  it('names every status the runner can report', () => {
    expect(AGENT_STATUSES).toHaveLength(9);
    for (const status of AGENT_STATUSES) expect(agentStatusLabel(status), status).not.toBe('Unknown');
    expect(agentStatusLabel('NOPE')).toBe('Unknown');
  });

  it('treats missing or unlimited budgets as not reported rather than 0%', () => {
    expect(budgetUtilization(Number.NaN, 100)).toEqual({ state: 'unknown', percent: undefined });
    expect(budgetUtilization(10, 0)).toEqual({ state: 'unknown', percent: undefined });
    expect(budgetUtilization(10, 100)).toEqual({ state: 'ok', percent: 10 });
    expect(budgetUtilization(80, 100)).toEqual({ state: 'close', percent: 80 });
    expect(budgetUtilization(100, 100)).toEqual({ state: 'exhausted', percent: 100 });
    // Over-spend clamps at 100% instead of rendering a nonsensical number.
    expect(budgetUtilization(250, 100)).toEqual({ state: 'exhausted', percent: 100 });
  });

  it('reports age and TTL, and says so when they are missing', () => {
    const now = Date.parse('2026-08-17T01:00:00.000Z');
    expect(agentAge(agent(), now)).toBe('1.0 h');
    expect(agentAge(agent({ startedAt: '2026-08-17T00:30:00.000Z' }), now)).toBe('30 min');
    expect(agentAge({ createdAt: 'not-a-date' }, now)).toBe('Not reported');
    expect(agentTtl(agent(), now)).toBe('60 min');
    expect(agentTtl(agent({ expiresAt: '2026-08-17T00:30:00.000Z' }), now)).toBe('Expired');
    expect(agentTtl({}, now)).toBe('Not reported');
  });

  it('nests children under their parent and keeps an orphan visible', () => {
    const parent = agent();
    const child = agent({ agentId: `agent_${'c'.repeat(24)}`, parentAgentId: parent.agentId, status: 'SUCCEEDED' });
    const orphan = agent({ agentId: `agent_${'d'.repeat(24)}`, parentAgentId: `agent_${'e'.repeat(24)}` });
    const index = agentTreeIndex([parent, child, orphan]);
    expect(index.get('root')?.map((item: { agentId: string }) => item.agentId)).toEqual([parent.agentId, orphan.agentId]);
    expect(index.get(parent.agentId)?.map((item: { agentId: string }) => item.agentId)).toEqual([child.agentId]);

    const markup = renderAgentHierarchy([parent, child, orphan]);
    expect(markup).toContain('class="agent-tree"');
    // The child renders inside the parent's list item, so nesting is real, not cosmetic.
    expect(markup.indexOf(child.agentId)).toBeGreaterThan(markup.indexOf(parent.agentId));
    expect(markup).toContain(`href="/dashboard/agents/${orphan.agentId}"`);
    expect(renderAgentHierarchy([])).toContain('No agents reported yet.');
  });

  it('offers the flat table fallback with the parent column', () => {
    const parent = agent();
    const child = agent({ agentId: `agent_${'c'.repeat(24)}`, parentAgentId: parent.agentId });
    const table = renderAgentTable([parent, child]);
    expect(table).toContain('<th>Parent</th>');
    expect(table).toContain(parent.agentId);
    expect(table).toContain('2 agent(s)');
    expect(renderAgentTable([])).toContain('No agents reported yet.');
  });

  it('renders the same body for the global page and the workspace tab', () => {
    const global = renderAgentsIndex({ agents: [agent()], filters: {} });
    expect(global).toContain('id="agent-status-filter"');
    expect(global).toContain('id="agent-workspace-filter"');
    expect(global).toContain('Hierarchy');
    expect(global).toContain('All agents');
    const scoped = renderAgentsIndex({ agents: [agent()], filters: { workspaceId, status: 'RUNNING' } });
    expect(scoped).toContain(`value="${workspaceId}"`);
    expect(scoped).toContain('<option value="RUNNING" selected>');
    // A scoped view does not offer a workspace filter it would contradict.
    expect(scoped).not.toContain('id="agent-workspace-filter"');
  });

  it('reports usage with limits, and says Not reported when a limit was never set', () => {
    const detail = renderAgentDetail({ agent: agent(), logs: [{ type: 'tool.call', timestamp: '2026-08-17T00:00:30.000Z', content: 'ran a tool' }] });
    expect(detail).toContain('id="agent-overview-heading"');
    expect(detail).toContain('id="agent-usage-heading"');
    expect(detail).toContain('id="agent-logs-heading"');
    expect(detail).toContain('id="agent-messages-heading"');
    expect(detail).toContain('100 of 200000 (0%)');
    expect(detail).toContain('ran a tool');
    expect(detail).toContain('id="agent-message-form"');
    expect(detail).toContain('id="cancel-agent"');

    const unlimited = renderAgentDetail({ agent: agent({ budget: { maxCostMicros: 0 }, usage: { costMicros: 10 } }) });
    expect(unlimited).toContain('Not reported');
    expect(unlimited).toContain('No retained log events for this agent.');
  });

  it('marks an unknown outcome and escapes log content', () => {
    const markup = renderAgentDetail({
      agent: agent({ outcomeUnknown: true, terminalReason: 'runner stopped' }),
      logs: [{ type: 'tool.call', timestamp: '2026-08-17T00:00:30.000Z', content: '<img src=x onerror=alert(1)>' }]
    });
    expect(markup).toContain('Unknown — no terminal state was recorded');
    expect(markup).toContain('runner stopped');
    expect(markup).not.toContain('<img src=x');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
