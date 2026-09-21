import { describe, expect, it } from 'vitest';
import { buildActivityProjection, buildMetricsProjection, buildOverviewProjection, METRIC_WINDOWS } from '../src/dashboard-response.js';
import { renderOverview } from '../dashboard/dashboard-render.js';

const now = Date.parse('2026-08-17T01:00:00.000Z');
const workspaceId = `ws_${'a'.repeat(24)}`;
const agentId = `agent_${'b'.repeat(24)}`;
const inMinutes = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

const workspace = (overrides: Record<string, unknown> = {}) => ({ workspaceId, status: 'ACTIVE', networkProfile: 'network-none', expiresAt: inMinutes(120), ...overrides });
const agent = (overrides: Record<string, unknown> = {}) => ({
  agentId, workspaceId, status: 'RUNNING', usage: { costMicros: 250_000 }, startedAt: new Date(now - 60_000).toISOString(), ...overrides
});

describe('overview projection', () => {
  it('leads with the reasons that need action and nothing else', () => {
    const projection = buildOverviewProjection({
      now,
      workspaces: [
        workspace({ workspaceId: `ws_${'c'.repeat(24)}`, status: 'FAILED' }),
        workspace({ workspaceId: `ws_${'d'.repeat(24)}`, status: 'NETWORK_QUARANTINED' }),
        workspace({ workspaceId: `ws_${'e'.repeat(24)}`, expiresAt: inMinutes(5) }),
        workspace({ workspaceId: `ws_${'f'.repeat(24)}`, expiresAt: inMinutes(600) })
      ],
      agents: [
        agent({ agentId: `agent_${'g'.repeat(24)}`, status: 'FAILED' }),
        agent({ agentId: `agent_${'h'.repeat(24)}`, status: 'LIMIT_EXCEEDED' }),
        agent({ agentId: `agent_${'i'.repeat(24)}`, status: 'RUNNING' })
      ],
      grants: [{ id: 'grant_1' }, { id: 'grant_2' }]
    }) as Record<string, any>;

    const labels = projection.attention.map((item: { id: string }) => item.id);
    expect(labels).toContain(`workspace-failed-ws_${'c'.repeat(24)}`);
    expect(labels).toContain(`workspace-quarantined-ws_${'d'.repeat(24)}`);
    expect(labels).toContain(`workspace-expiring-ws_${'e'.repeat(24)}`);
    expect(labels).toContain(`agent-agent_${'g'.repeat(24)}`);
    expect(labels).toContain('pending-approvals');
    // A healthy workspace and a running agent are not attention items.
    expect(labels.some((id: string) => id.includes(`ws_${'f'.repeat(24)}`))).toBe(false);
    expect(labels.some((id: string) => id.includes(`agent_${'i'.repeat(24)}`))).toBe(false);
    // Every reason links somewhere actionable.
    for (const item of projection.attention) expect(item.href.startsWith('/dashboard')).toBe(true);
  });

  it('counts what is running and scopes the cost to running agents only', () => {
    const projection = buildOverviewProjection({
      now,
      workspaces: [workspace(), workspace({ workspaceId: `ws_${'c'.repeat(24)}`, status: 'CLOSED' })],
      agents: [
        agent({ usage: { costMicros: 1_000_000 } }),
        agent({ agentId: `agent_${'j'.repeat(24)}`, status: 'SUCCEEDED', usage: { costMicros: 9_000_000 } })
      ]
    }) as Record<string, any>;
    expect(projection.running).toEqual({ agents: 1, workspaces: 1 });
    // The finished agent's spend is excluded, and the scope says what was measured.
    expect(projection.cost).toEqual({ scope: 'running agents', costMicros: 1_000_000, agentCount: 1 });
  });

  it('buckets expiry by window and never claims a daily store it does not have', () => {
    const projection = buildOverviewProjection({
      now,
      workspaces: [workspace({ expiresAt: inMinutes(10) }), workspace({ workspaceId: `ws_${'c'.repeat(24)}`, expiresAt: inMinutes(45) }), workspace({ workspaceId: `ws_${'d'.repeat(24)}`, expiresAt: inMinutes(200) })]
    }) as Record<string, any>;
    expect(projection.expiring.map((bucket: { windowMinutes: number; count: number }) => [bucket.windowMinutes, bucket.count])).toEqual([[15, 1], [60, 2], [240, 3]]);
    expect(projection.generatedAt).toBe(new Date(now).toISOString());
  });

  it('tolerates missing sources without inventing numbers', () => {
    const projection = buildOverviewProjection({ now }) as Record<string, any>;
    expect(projection.attention).toEqual([]);
    expect(projection.running).toEqual({ agents: 0, workspaces: 0 });
    expect(projection.cost.costMicros).toBe(0);
    expect(projection.expiring.every((bucket: { count: number }) => bucket.count === 0)).toBe(true);
  });
});

describe('metrics projection', () => {
  const events = [
    { action: 'workspace_open', subjectType: 'workspace', createdAt: new Date(now - 30 * 60_000).toISOString() },
    { action: 'workspace_close', subjectType: 'workspace', createdAt: new Date(now - 3 * 3_600_000).toISOString() },
    { action: 'skill_import_start', subjectType: 'skill', createdAt: new Date(now - 6 * 86_400_000).toISOString() }
  ];

  it('accepts only the documented windows', () => {
    expect(Object.keys(METRIC_WINDOWS)).toEqual(['1h', '24h', '7d']);
    expect(() => buildMetricsProjection({ events, window: '30d', now })).toThrow(/unsupported metrics window/);
  });

  it('counts only events inside the window and names the scope', () => {
    const hour = buildMetricsProjection({ events, window: '1h', now }) as Record<string, any>;
    expect(hour.eventCount).toBe(1);
    expect(hour.categories).toEqual({ workspace: 1 });
    expect(hour.scope).toBe('retained audit events in the last 1h');
    expect(hour.since).toBe(new Date(now - 3_600_000).toISOString());

    const week = buildMetricsProjection({ events, window: '7d', now }) as Record<string, any>;
    expect(week.eventCount).toBe(3);
    expect(week.categories).toEqual({ workspace: 2, skill: 1 });
  });
});

describe('activity projection', () => {
  it('labels durable audit rows apart from live runtime rows and sorts newest first', () => {
    const projection = buildActivityProjection({
      events: [
        { action: 'workspace_open', subjectType: 'workspace', subjectId: workspaceId, createdAt: new Date(now - 120_000).toISOString() },
        { action: 'mcp_server_update', subjectType: 'mcp_server', subjectId: 'linear', createdAt: new Date(now - 300_000).toISOString() },
        { action: 'deployment_run', subjectType: 'deployment', subjectId: 'staging', createdAt: new Date(now - 60_000).toISOString() }
      ],
      agents: [agent({ startedAt: new Date(now - 30_000).toISOString() })]
    }) as Record<string, any>;
    expect(projection.events.map((event: { category: string }) => event.category)).toEqual(['agents', 'deployments', 'audit', 'mcp']);
    expect(projection.events[0].durable).toBe(false);
    expect(projection.events[0].href).toBe(`/dashboard/agents/${agentId}`);
    expect(projection.events[1]).toMatchObject({ durable: true, status: 'recorded', summary: 'deployment_run' });
    // The newest row is first, so the timeline reads top-down.
    expect(projection.events[0].at >= projection.events[1].at).toBe(true);
  });
});

describe('overview renderer', () => {
  it('puts the decision tiles above Access and links each one to a filtered view', () => {
    const markup = renderOverview({
      overview: {
        attention: [{ id: 'x', label: 'Lease expires soon', detail: 'Renew it', href: `/dashboard/workspaces/${workspaceId}/summary` }],
        running: { agents: 2, workspaces: 1 },
        cost: { scope: 'running agents', costMicros: 1_250_000, agentCount: 2 },
        expiring: [{ windowMinutes: 15, label: '15 min', count: 0 }, { windowMinutes: 60, label: '1 h', count: 3 }, { windowMinutes: 240, label: '4 h', count: 5 }]
      },
      access: { name: 'Operator', email: 'op@example.com' }
    });
    expect(markup).toContain('class="metric-grid decision-grid"');
    expect(markup).toContain('Needs attention');
    expect(markup).toContain('Running now');
    expect(markup).toContain('$1.2500');
    expect(markup).toContain('scope: running agents');
    expect(markup).toContain('Expiring soon');
    expect(markup).toContain('metric decision-attention');
    expect(markup).toContain('metric decision-running');
    expect(markup).toContain('metric decision-cost');
    expect(markup).toContain('metric decision-expiry');
    expect(markup).toContain('href="/dashboard/activity"');
    expect(markup).toContain('href="/dashboard/agents"');
    expect(markup).toContain('href="/dashboard/workspaces"');
    expect(markup).toContain(`/dashboard/workspaces/${workspaceId}/summary`);
    // Decision metrics come before the Access panel.
    expect(markup.indexOf('Needs attention')).toBeLessThan(markup.indexOf('Signed in as'));
    // The expiry tile reports the hour bucket, not every bucket.
    expect(markup).toContain('lease(s) within the hour');
  });

  it('says nothing needs attention when the projection is empty', () => {
    const markup = renderOverview({ overview: { attention: [], expiring: [] } });
    expect(markup).toContain('Nothing needs attention right now.');
    expect(markup).toContain('No workspaces are close to expiry.');
    expect(markup).toContain('Not reported');
  });
});
