import { describe, expect, it } from 'vitest';
import {
  attentionItems, burnRows, costSeries, dashboardRoute, decisionTiles, expiryRows, metricsSeries, outcomeBuckets, outcomeDescription,
  profileRows, reliabilityRows, serverFacts, tileCost
} from './overview-model';

describe('dashboardRoute', () => {
  it('turns classic absolute paths into router paths', () => {
    expect(dashboardRoute('/dashboard/workspaces/ws_1/summary')).toBe('/workspaces/ws_1/summary');
    expect(dashboardRoute('/dashboard/approvals')).toBe('/approvals');
    expect(dashboardRoute('/dashboard/agents/agent%5F1')).toBe('/agents/agent%5F1');
    expect(dashboardRoute('/dashboard')).toBe('/');
  });

  it('refuses anything that is not a plain same-app path', () => {
    for (const href of ['https://evil.example/dashboard', '//evil.example/x', '/dashboard//evil', '/dashboard/../api', '/dashboard/x?q=1', '/dashboard/x#y', 'javascript:alert(1)', '/other', '/dashboardx', 42, undefined]) {
      expect(dashboardRoute(href), String(href)).toBeUndefined();
    }
  });
});

describe('decision tiles', () => {
  it('counts attention, running work, scoped cost and the hour bucket', () => {
    const tiles = decisionTiles({
      attention: [{ id: 'a' }, { id: 'b' }],
      running: { agents: 2, workspaces: 1 },
      cost: { scope: 'running agents', costMicros: 1_250_000 },
      expiring: [{ windowMinutes: 15, count: 0 }, { windowMinutes: 60, count: 3 }, { windowMinutes: 240, count: 5 }]
    });
    expect(tiles).toEqual({ attention: { count: 2 }, running: { agents: 2, workspaces: 1 }, cost: { value: '$1.2500', scope: 'running agents' }, expiry: { count: 3 } });
  });

  it('tolerates missing sources without inventing numbers', () => {
    expect(decisionTiles({ items: [] })).toEqual({ attention: { count: 0 }, running: { agents: 0, workspaces: 0 }, cost: { value: 'Not reported', scope: 'not reported' }, expiry: { count: 0 } });
    expect(tileCost(null)).toBe('Not reported');
    expect(tileCost('abc')).toBe('Not reported');
    expect(tileCost(0)).toBe('$0.0000');
  });

  it('keeps attention text as data and drops unsafe links', () => {
    const items = attentionItems({ attention: [{ id: 'x', label: '<script>a</script>', detail: 'd', href: 'https://evil.example' }, { label: 'L', href: '/dashboard/activity' }] });
    expect(items).toEqual([
      { id: 'x', label: '<script>a</script>', detail: 'd', href: undefined },
      { id: 'attention-1', label: 'L', detail: '', href: '/activity' }
    ]);
  });
});

describe('chart data', () => {
  it('maps the metrics and cost series to bars', () => {
    expect(metricsSeries({ series: [{ at: '2026-08-17T00:00:00.000Z', count: 2 }, { at: 'bad', count: 'x' }] }).map((point) => point.value)).toEqual([2, 0]);
    expect(costSeries({ costSeries: [{ at: '2026-08-17T00:00:00.000Z', label: '10:00', value: 0.5 }] })).toEqual([{ key: '2026-08-17T00:00:00.000Z-0', label: '10:00', value: 0.5, display: '0.5 USD' }]);
    expect(metricsSeries({})).toEqual([]);
  });

  it('spells out every outcome count in words', () => {
    const [bucket] = outcomeBuckets({ agentOutcomes: [{ at: 'x', label: '10:00', segments: { succeeded: 3, attention: 1 } }] });
    expect(bucket?.segments).toEqual({ succeeded: 3, attention: 1, cancelled: 0, running: 0 });
    expect(outcomeDescription(bucket!)).toBe('10:00: Succeeded 3, Failed / limit 1, Cancelled 0, Running 0');
  });

  it('builds the row charts with their notes', () => {
    expect(profileRows({ usageByProfile: [{ profileId: 'coding-fast', inputTokens: 1_000, outputTokens: 200, costMicros: 2_500_000 }] })[0]).toMatchObject({ label: 'coding-fast', display: '2.5 USD', note: '1000 in · 200 out tokens' });
    expect(burnRows({ budgetBurn: [{ agentId: 'agent_1', costMicros: 4_000_000, maxCostMicros: 5_000_000 }, { agentId: 'agent_2', costMicros: 1 }] }).map((row) => row.note)).toEqual(['80% of cost limit', 'cost limit not reported']);
    expect(expiryRows({ expiring: [{ windowMinutes: 60, label: '1 h', count: 3 }] })[0]).toMatchObject({ label: '1 h', value: 3, note: 'workspaces' });
    expect(reliabilityRows({ servers: [{ serverName: 'linear', calls: 12, error: 3, p50Ms: 40, p95Ms: 120 }, { serverId: 's2', calls: 1 }] }).map((row) => [row.label, row.note])).toEqual([
      ['linear', '3 error(s), p50 40 ms, p95 120 ms'],
      ['s2', '0 error(s), p50 — ms, p95 — ms']
    ]);
  });
});

describe('serverFacts', () => {
  it('reads the server panel and keeps only https URLs', () => {
    const facts = serverFacts({
      authMode: 'cloudflare-access', version: '0.72.0', managedOAuthUrl: 'https://harness.example/mcp',
      apiKeyGateway: { enabled: true, endpoint: 'javascript:alert(1)' }, limits: { maxRequestBytes: 1_048_576, requestTimeoutMs: 30_000 },
      session: { expiresAt: null }, checkedAt: '2026-08-17T00:00:00.000Z'
    });
    expect(facts).toEqual({
      authMode: 'cloudflare-access', version: '0.72.0', managedOAuthUrl: 'https://harness.example/mcp', gateway: { enabled: true, endpoint: undefined },
      maxRequestBytes: 1_048_576, requestTimeoutSeconds: 30, sessionExpiresAt: undefined, checkedAt: '2026-08-17T00:00:00.000Z'
    });
    expect(serverFacts(undefined)).toMatchObject({ authMode: 'Unknown', version: 'Unknown', managedOAuthUrl: undefined, gateway: { enabled: false } });
  });
});
