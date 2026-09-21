import { describe, expect, it } from 'vitest';
import { buildMetricsProjection, buildOverviewProjection, buildReliabilityProjection } from '../src/dashboard-response.js';
import { renderAnalyticsSection, renderBarChart, renderBarRows, renderOverview } from '../dashboard/dashboard-render.js';

const now = Date.parse('2026-08-17T01:00:00.000Z');

describe('chart primitives', () => {
  it('draws internal SVG bars with a focusable accessible name and a table fallback', () => {
    const markup = renderBarChart({ label: 'Events per bucket', unit: '', points: [{ label: '00:00', tick: '0', value: 2 }, { label: '01:00', tick: '1', value: 5 }] });
    expect(markup).toContain('<svg class="chart chart-bars"');
    expect(markup).toContain('role="list"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('aria-label="01:00: 5"');
    expect(markup).toContain('chart-fallback');
    expect(markup).toContain('<caption>Events per bucket (numbers)</caption>');
    // No chart dependency, no gradient, no inline style: geometry and classes only.
    expect(markup).not.toContain('gradient');
    expect(markup).not.toContain('style=');
    expect(markup).not.toContain('http');
  });

  it('scales bars against the largest value and never divides by zero', () => {
    const flat = renderBarChart({ label: 'Flat', points: [{ label: 'a', value: 0 }, { label: 'b', value: 0 }] });
    expect(flat).toContain('height="1"');
    const rows = renderBarRows({ label: 'Rows', unit: ' ms', points: [{ label: 'server-a', value: 10, note: 'p95 40 ms' }] });
    expect(rows).toContain('chart-rows');
    expect(rows).toContain('server-a');
    expect(rows).toContain('p95 40 ms');
    expect(rows).toContain('10 ms');
  });

  it('explains an empty chart instead of rendering an empty axis', () => {
    expect(renderBarChart({ label: 'Nothing', points: [], emptyNote: 'No retained events in this window.' })).toContain('No retained events in this window.');
    expect(renderBarRows({ label: 'Nothing', points: [] })).toContain('Nothing to chart yet.');
  });
});

describe('analytics section', () => {
  it('charts only data that is actually retained and says why cost trend is absent', () => {
    const markup = renderAnalyticsSection({
      overview: {
        expiring: [{ windowMinutes: 15, label: '15 min', count: 1 }, { windowMinutes: 60, label: '1 h', count: 3 }],
        usageByProfile: [{ profileId: 'coding-fast', inputTokens: 1_000, outputTokens: 200, costMicros: 2_500_000 }],
        budgetBurn: [{ agentId: 'agent_1', costMicros: 4_000_000, maxCostMicros: 5_000_000 }]
      },
      metrics: { window: '24h', series: [{ at: new Date(now - 3_600_000).toISOString(), count: 2 }, { at: new Date(now).toISOString(), count: 5 }] },
      reliability: { servers: [{ serverName: 'linear', calls: 12, error: 3, p50Ms: 40, p95Ms: 120 }] }
    });
    expect(markup).toContain('id="analytics-heading"');
    expect(markup).toContain('Retained audit events per bucket (24h)');
    expect(markup).toContain('Cost by model profile');
    expect(markup).toContain('coding-fast');
    expect(markup).toContain('2.5 USD');
    expect(markup).toContain('Budget burn of running agents');
    expect(markup).toContain('80% of cost limit');
    expect(markup).toContain('Workspace expiry buckets');
    expect(markup).toContain('MCP reliability by server');
    expect(markup).toContain('3 error(s), p50 40 ms, p95 120 ms');
    expect(markup).toContain('A cost <em>trend</em> is not shown');
  });

  it('degrades to empty notes when a source is missing', () => {
    const markup = renderAnalyticsSection({});
    expect(markup).toContain('No retained events in this window.');
    expect(markup).toContain('No agent usage reported yet.');
    expect(markup).toContain('No running agents report a budget.');
    expect(markup).toContain('No gateway traces reported yet.');
  });
});

describe('metrics series and reliability projections', () => {
  it('buckets the window into an evenly spaced series', () => {
    const projection = buildMetricsProjection({
      now,
      window: '1h',
      buckets: 4,
      events: [
        { action: 'a', subjectType: 'workspace', createdAt: new Date(now - 10 * 60_000).toISOString() },
        { action: 'b', subjectType: 'workspace', createdAt: new Date(now - 40 * 60_000).toISOString() }
      ]
    }) as Record<string, any>;
    expect(projection.series).toHaveLength(4);
    expect(projection.series.reduce((total: number, point: { count: number }) => total + point.count, 0)).toBe(2);
    // Buckets are ordered oldest first and evenly spaced.
    expect(Date.parse(projection.series[0].at)).toBeLessThan(Date.parse(projection.series[3].at));
  });

  it('derives per-server success, error and latency percentiles from traces', () => {
    const traces = [
      { serverId: 'mcps_a', serverName: 'linear', durationMs: 10, status: 'ok' },
      { serverId: 'mcps_a', serverName: 'linear', durationMs: 20, status: 'ok' },
      { serverId: 'mcps_a', serverName: 'linear', durationMs: 30, status: 'error', errorCode: 'TIMEOUT' },
      { serverId: 'mcps_a', serverName: 'linear', durationMs: 40, status: 'ok' },
      { serverId: 'mcps_a', serverName: 'linear', durationMs: 50, status: 'ok' },
      { serverId: 'mcps_b', serverName: 'jira', durationMs: 5, status: 'ok' }
    ];
    const projection = buildReliabilityProjection({ traces }) as Record<string, any>;
    expect(projection.totalCalls).toBe(6);
    const linear = projection.servers.find((server: { serverId: string }) => server.serverId === 'mcps_a');
    expect(linear).toMatchObject({ success: 4, error: 1, calls: 5, p50Ms: 30, p95Ms: 50 });
    expect(projection.servers.find((server: { serverId: string }) => server.serverId === 'mcps_b').p50Ms).toBe(5);
    // No traces means no invented latency.
    expect(buildReliabilityProjection({ traces: [] })).toEqual({ servers: [], totalCalls: 0 });
  });

  it('sums usage per profile and burns only running agents', () => {
    const projection = buildOverviewProjection({
      now,
      workspaces: [],
      agents: [
        { agentId: 'agent_1', workspaceId: 'ws_1', status: 'RUNNING', profileId: 'fast', usage: { inputTokens: 10, outputTokens: 5, costMicros: 1_000 }, budget: { maxCostMicros: 2_000, maxInputTokens: 100, maxOutputTokens: 100 } },
        { agentId: 'agent_2', workspaceId: 'ws_1', status: 'SUCCEEDED', profileId: 'fast', usage: { inputTokens: 20, outputTokens: 10, costMicros: 3_000 } },
        { agentId: 'agent_3', workspaceId: 'ws_1', status: 'RUNNING', profileId: 'deep', usage: { inputTokens: 1, outputTokens: 1, costMicros: 500 }, budget: { maxCostMicros: 500 } }
      ]
    }) as Record<string, any>;
    expect(projection.usageByProfile).toEqual([
      { profileId: 'fast', inputTokens: 30, outputTokens: 15, costMicros: 4_000 },
      { profileId: 'deep', inputTokens: 1, outputTokens: 1, costMicros: 500 }
    ]);
    // Only the two running agents appear in the burn list, most-used first.
    expect(projection.budgetBurn.map((entry: { agentId: string }) => entry.agentId)).toEqual(['agent_3', 'agent_1']);
  });
});

describe('overview composition', () => {
  it('places analytics between the decision panels and Access', () => {
    const markup = renderOverview({
      overview: { attention: [], running: { agents: 0, workspaces: 0 }, cost: { scope: 'running agents', costMicros: 0 }, expiring: [] },
      metrics: { window: '24h', series: [] },
      reliability: { servers: [] }
    });
    expect(markup.indexOf('Needs attention')).toBeLessThan(markup.indexOf('id="analytics-heading"'));
    expect(markup.indexOf('id="analytics-heading"')).toBeLessThan(markup.indexOf('Signed in as'));
  });
});
