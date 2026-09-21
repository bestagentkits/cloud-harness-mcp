import { describe, expect, it } from 'vitest';
import { buildOverviewProjection } from '../src/dashboard-response.js';
import { renderAnalyticsSection, renderStackedBars } from '../dashboard/dashboard-render.js';

const now = Date.parse('2026-08-17T01:00:00.000Z');
const workspaceId = `ws_${'a'.repeat(24)}`;
const startedMinutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const agent = (overrides: Record<string, unknown> = {}) => ({
  agentId: `agent_${'b'.repeat(24)}`,
  workspaceId,
  status: 'RUNNING',
  startedAt: startedMinutesAgo(1),
  usage: { inputTokens: 10, outputTokens: 5, costMicros: 500_000 },
  budget: { maxCostMicros: 1_000_000 },
  ...overrides
});

describe('retained-agent execution health and cost series', () => {
  it('buckets retained agents by start time, grouping outcomes and summing cost', () => {
    const projection = buildOverviewProjection({
      now,
      workspaces: [],
      agents: [
        agent({ agentId: `agent_${'c'.repeat(24)}`, status: 'SUCCEEDED', startedAt: startedMinutesAgo(60), usage: { costMicros: 1_000_000 } }),
        agent({ agentId: `agent_${'d'.repeat(24)}`, status: 'FAILED', startedAt: startedMinutesAgo(59), usage: { costMicros: 250_000 } }),
        agent({ agentId: `agent_${'e'.repeat(24)}`, status: 'LIMIT_EXCEEDED', startedAt: startedMinutesAgo(30), usage: { costMicros: 100_000 } }),
        agent({ agentId: `agent_${'f'.repeat(24)}`, status: 'CANCELLED', startedAt: startedMinutesAgo(2), usage: { costMicros: 50_000 } }),
        agent({ agentId: `agent_${'g'.repeat(24)}`, status: 'RUNNING', startedAt: startedMinutesAgo(1), usage: { costMicros: 25_000 } })
      ]
    }) as Record<string, any>;

    expect(projection.agentSeriesScope).toBe('retained agents, bucketed by start time');
    expect(projection.agentOutcomes.length).toBeGreaterThan(1);
    const segments = projection.agentOutcomes.map((bucket: { segments: Record<string, number> }) => bucket.segments);
    const totals = segments.reduce((sum: Record<string, number>, entry: Record<string, number>) => ({
      succeeded: sum.succeeded + entry.succeeded,
      attention: sum.attention + entry.attention,
      cancelled: sum.cancelled + entry.cancelled,
      running: sum.running + entry.running
    }), { succeeded: 0, attention: 0, cancelled: 0, running: 0 });
    // Every retained agent lands in exactly one outcome group, and nothing is invented.
    expect(totals).toEqual({ succeeded: 1, attention: 2, cancelled: 1, running: 1 });
    expect(projection.costSeries.reduce((sum: number, point: { value: number }) => sum + point.value, 0)).toBeCloseTo(1.425, 5);
    // Buckets are ordered oldest first and carry a label and a tick for the axis.
    expect(Date.parse(projection.agentOutcomes[0].at)).toBeLessThanOrEqual(Date.parse(projection.agentOutcomes.at(-1).at));
    expect(projection.agentOutcomes[0].tick).toBe('1');
    expect(projection.agentOutcomes[0].label).toBeTruthy();
  });

  it('collapses to a single bucket when every agent started inside a minute', () => {
    const projection = buildOverviewProjection({
      now,
      workspaces: [],
      agents: [agent({ startedAt: startedMinutesAgo(0.5) }), agent({ agentId: `agent_${'h'.repeat(24)}`, startedAt: startedMinutesAgo(0.9), status: 'SUCCEEDED' })]
    }) as Record<string, any>;
    expect(projection.agentOutcomes).toHaveLength(1);
    expect(projection.agentOutcomes[0].segments).toMatchObject({ running: 1, succeeded: 1 });
  });

  it('reports empty series rather than fabricated buckets when no agent is retained', () => {
    const projection = buildOverviewProjection({ now, workspaces: [], agents: [] }) as Record<string, any>;
    expect(projection.agentOutcomes).toEqual([]);
    expect(projection.costSeries).toEqual([]);
    expect(projection.agentSeriesScope).toBe('no agents on record');
  });
});

describe('stacked chart primitive', () => {
  it('draws one segment per category with the category named in class, legend and table', () => {
    const markup = renderStackedBars({
      label: 'Execution health',
      categories: [{ key: 'succeeded', label: 'Succeeded' }, { key: 'attention', label: 'Failed / limit' }],
      points: [{ label: '10:00', tick: '1', segments: { succeeded: 3, attention: 1 } }]
    });
    expect(markup).toContain('class="chart chart-stacked"');
    expect(markup).toContain('segment-succeeded');
    expect(markup).toContain('segment-attention');
    // The accessible name spells out every category count, so height is not the only signal.
    expect(markup).toContain('aria-label="10:00: Succeeded 3, Failed / limit 1"');
    expect(markup).toContain('class="chart-legend"');
    expect(markup).toContain('legend-attention');
    expect(markup).toContain('<caption>Execution health (numbers)</caption>');
    expect(markup).toContain('<th>Failed / limit</th>');
    expect(markup).not.toContain('gradient');
    expect(markup).not.toContain('style=');
  });

  it('explains an empty series instead of drawing an empty axis', () => {
    expect(renderStackedBars({ label: 'Nothing', categories: [], points: [], emptyNote: 'No agents are on record yet.' })).toContain('No agents are on record yet.');
  });

  it('skips zero-height segments while keeping the bucket and its labels', () => {
    const markup = renderStackedBars({
      label: 'Execution health',
      categories: [{ key: 'succeeded', label: 'Succeeded' }, { key: 'running', label: 'Running' }],
      points: [{ label: '10:00', tick: '1', segments: { succeeded: 0, running: 2 } }]
    });
    expect(markup).not.toContain('segment-succeeded');
    expect(markup).toContain('segment-running');
    expect(markup).toContain('aria-label="10:00: Succeeded 0, Running 2"');
  });
});

describe('analytics section completeness', () => {
  it('carries all eight decision charts with their scope named', () => {
    const markup = renderAnalyticsSection({
      overview: {
        expiring: [{ windowMinutes: 60, label: '1 h', count: 2 }],
        usageByProfile: [{ profileId: 'coding-fast', inputTokens: 10, outputTokens: 5, costMicros: 1_000_000 }],
        budgetBurn: [{ agentId: 'agent_1', costMicros: 500_000, maxCostMicros: 1_000_000 }],
        agentOutcomes: [{ at: startedMinutesAgo(30), label: '10:00', tick: '1', segments: { succeeded: 1, attention: 0, cancelled: 0, running: 1 } }],
        costSeries: [{ at: startedMinutesAgo(30), label: '10:00', tick: '1', value: 0.5 }],
        agentSeriesScope: 'retained agents, bucketed by start time'
      },
      metrics: { window: '24h', series: [{ at: startedMinutesAgo(30), count: 3 }] },
      reliability: { servers: [{ serverName: 'linear', calls: 4, error: 1, p50Ms: 20, p95Ms: 80 }] }
    });
    for (const title of [
      'Retained audit events per bucket (24h)',
      'Execution health over retained agents',
      'Cost over retained agents',
      'Cost by model profile',
      'Budget burn of running agents',
      'Workspace expiry buckets',
      'MCP reliability by server'
    ]) expect(markup, title).toContain(title);
    // The two series charts state the scope they measured rather than implying a ledger.
    expect(markup).toContain('retained agents, bucketed by start time');
    expect(markup).toContain('keeps agent state and per-agent usage');
    expect(markup).toContain('Cost over retained agents');
  });

  it('exposes only bucketed counts and costs, with no agent, owner or credential fields', () => {
    const projection = buildOverviewProjection({
      now,
      workspaces: [],
      agents: [
        agent({ agentId: `agent_${'h'.repeat(24)}`, status: 'SUCCEEDED', startedAt: startedMinutesAgo(60), usage: { costMicros: 1_000_000 } }),
        agent({ agentId: `agent_${'i'.repeat(24)}`, status: 'FAILED', startedAt: startedMinutesAgo(1), usage: { costMicros: 500_000 } })
      ]
    }) as Record<string, any>;

    const series = JSON.stringify({
      agentOutcomes: projection.agentOutcomes,
      costSeries: projection.costSeries,
      agentSeriesScope: projection.agentSeriesScope
    });
    // A bucket carries a timestamp, a label, a tick and the numbers behind the bar — no
    // agent or workspace identity, no owner, no credential and no filesystem path.
    expect(series).not.toMatch(/agent_/);
    expect(series).not.toMatch(/ws_/);
    expect(series).not.toMatch(/owner/i);
    expect(series).not.toMatch(/token|secret|credential|password/i);
    expect(series).not.toMatch(/\/(Users|home|var|tmp)\b/);
    for (const bucket of projection.agentOutcomes) {
      expect(Object.keys(bucket).sort()).toEqual(['at', 'label', 'segments', 'tick']);
    }
    for (const bucket of projection.costSeries) {
      expect(Object.keys(bucket).sort()).toEqual(['at', 'label', 'tick', 'value']);
    }
  });
});
