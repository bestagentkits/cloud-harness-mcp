import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './dashboard-test-dom.js';
import {
  TRACE_STATES, buildSpanTree, createTracesView, renderAgentTracesPanel, renderTraceDetail, renderTraceKpis, renderTraceTable,
  renderTraceWaterfall, renderTracesPage, traceCost, traceCount, traceDuration, traceExportHref, traceFiltersFromSearch, traceListPath,
  tracesAvailable, tracesDisabled, traceWindowSince
} from '../dashboard/dashboard-traces.js';
import { FakeElement } from './dashboard-test-dom.js';

const traceId = `trc_${'a'.repeat(26)}`;
const agentId = `agent_${'b'.repeat(24)}`;
const workspaceId = `ws_${'c'.repeat(24)}`;
const hostile = '<img src=x onerror=alert(1)>';

const trace = (overrides: Record<string, unknown> = {}) => ({
  traceId, agentId, workspaceId, generation: 1, runId: null, parentTraceId: null, workflowId: null, profileId: 'default',
  profileRevisionId: null, state: 'COMPLETED', finishReason: 'completed', startedAt: '2026-10-19T10:00:00.000Z',
  endedAt: '2026-10-19T10:00:10.000Z', durationMs: 10_000, tokens: { prompt: 10, cacheRead: 0, cacheWrite: 0, output: 4, reasoning: null },
  requests: 1, requestsWithoutUsage: 0, costMicros: 12, costProvenance: 'estimated', coverage: 'full', spanCount: 3,
  truncated: false, reconciliationStatus: 'reconciled', expiresAt: '2026-11-02T10:00:10.000Z', ...overrides
});
const span = (seq: number, overrides: Record<string, unknown> = {}) => ({
  spanSeq: seq, spanId: `spn_${String(seq).padStart(16, '0')}`, parentSpanId: null, kind: 'model_call', name: 'model.call', state: 'OK',
  startedAt: '2026-10-19T10:00:00.000Z', endedAt: '2026-10-19T10:00:05.000Z', durationMs: 5_000, ttftMs: null,
  tokens: { prompt: null, output: null, cacheRead: null, cacheWrite: null }, costMicros: null, attributes: {}, inputDigest: null, errorClass: null,
  ...overrides
});

describe('trace formatting', () => {
  it('shows an unobserved figure as unknown instead of zero', () => {
    expect(traceCount(null)).toBe('unknown');
    expect(traceCount(0)).toBe('0');
    expect(traceCost(null)).toBe('unknown');
    expect(traceCost(12)).toBe('$0.000012');
    expect(traceDuration(undefined)).toBe('unknown');
    expect(traceDuration(1_500)).toBe('1.5 s');
    const kpis = renderTraceKpis({ traces: 2, tokens: { prompt: null, output: 3 }, costMicros: null, modelLatency: { samples: 0, p50Ms: null, p95Ms: null } });
    expect(kpis).toContain('unknown in');
    expect(kpis).not.toContain('p50');
  });

  it('shows an unknown window cost as unknown, never $0.00', () => {
    const kpis = renderTraceKpis({ traces: 2, costMicros: null, unknownCostTraces: 2 });
    expect(kpis).toContain('<span class="metric-value small">unknown</span>');
    expect(kpis).not.toContain('$0.00');
    expect(kpis).toContain('2 trace(s) with unknown cost excluded');
    // A page without a summary (a later page, or a poll) still renders.
    expect(renderTracesPage({ traces: [trace()], summary: null })).toContain(traceId);
  });

  it('shows percentiles only when timed samples exist', () => {
    const kpis = renderTraceKpis({ traces: 1, modelLatency: { samples: 2, p50Ms: 100, p95Ms: 900 }, ttft: { samples: 0, p50Ms: null, p95Ms: null } });
    expect(kpis).toContain('p50 100 ms · p95 900 ms');
    expect(kpis).toContain('0 streamed call(s)');
  });

  it('escapes every runner value it renders', () => {
    const table = renderTraceTable([trace({ profileId: hostile, reconciliationStatus: hostile })]);
    const detail = renderTraceDetail({
      trace: { ...trace({ profileId: hostile, finishReason: hostile }), reconciliation: { status: hostile, reasons: [hostile], toleranceMicros: 1, ledger: null, spans: {}, gateway: null } },
      spans: [span(0, { name: hostile, errorClass: hostile, kind: 'tool_call' })]
    });
    for (const markup of [table, detail]) {
      expect(markup).not.toContain(hostile);
      expect(markup).toContain('&lt;img');
    }
  });
});

describe('trace navigation inputs', () => {
  it('builds export links only for a valid trace id and a known format', () => {
    expect(traceExportHref(traceId, 'otlp-json')).toBe(`/dashboard/api/v1/traces/${traceId}/export?format=otlp-json`);
    expect(traceExportHref('../secrets', 'json')).toBe('');
    expect(traceExportHref(traceId, 'html')).toBe('');
  });

  it('keeps only well-formed filters from the URL', () => {
    expect(traceFiltersFromSearch(`?state=FAILED&agentId=${agentId}&workspaceId=nope&window=7d&ownerId=x`))
      .toEqual({ state: 'FAILED', agentId, window: '7d' });
    expect(traceFiltersFromSearch('?state=BOGUS&window=1y')).toEqual({});
    expect(TRACE_STATES).toContain('INCOMPLETE');
  });

  it('turns a window into a since bound and carries the cursor', () => {
    const now = Date.parse('2026-10-19T12:00:00.000Z');
    const since = traceWindowSince({ window: '1h' }, now);
    expect(since).toBe('2026-10-19T11:00:00.000Z');
    expect(traceWindowSince({}, now)).toBeUndefined();
    const path = traceListPath({ state: 'RUNNING', window: '1h' }, { cursor: 'tc1.abc', limit: 10, since });
    const query = new URLSearchParams(path.split('?')[1]);
    expect(path.startsWith('/traces?')).toBe(true);
    expect(Object.fromEntries(query)).toEqual({ state: 'RUNNING', since, cursor: 'tc1.abc', limit: '10', includeSummary: 'false' });
    // Only a first page that asks for it requests the summary.
    expect(new URLSearchParams(traceListPath({}, { includeSummary: true }).split('?')[1]).has('includeSummary')).toBe(false);
    expect(new URLSearchParams(traceListPath({}, { includeSummary: true, cursor: 'tc1.x' }).split('?')[1]).get('includeSummary')).toBe('false');
  });
});

describe('span tree and waterfall', () => {
  it('orders children under their parent and survives cycles and missing parents', () => {
    const root = span(0, { kind: 'agent_run', name: 'agent.run' });
    const child = span(1, { parentSpanId: root.spanId, startedAt: '2026-10-19T10:00:02.000Z' });
    const orphan = span(2, { parentSpanId: 'spn_missingmissingmi' });
    const loopA = span(3, { parentSpanId: span(4).spanId });
    const loopB = span(4, { parentSpanId: loopA.spanId });
    const rows = buildSpanTree([child, orphan, loopA, loopB, root]);
    expect(rows.map((row) => row.span.spanSeq).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(rows.find((row) => row.span.spanSeq === 1)?.depth).toBe(1);
    expect(rows.find((row) => row.span.spanSeq === 2)?.depth).toBe(0);
  });

  it('draws bars as SVG geometry, never inline styles, and dashes open spans', () => {
    const markup = renderTraceWaterfall(trace(), [
      span(0, { kind: 'agent_run', endedAt: '2026-10-19T10:00:10.000Z' }),
      span(1, { startedAt: '2026-10-19T10:00:05.000Z', endedAt: null, state: 'OPEN', durationMs: null })
    ]);
    expect(markup).not.toMatch(/style=/i);
    expect(markup).toContain('<rect x="0" y="1" width="1000"');
    expect(markup).toContain('<rect x="500" y="1" width="500"');
    expect(markup).toContain('trace-bar open');
    expect(renderTraceWaterfall(trace(), [])).toContain('No spans');
  });

  it('renders the agent panel empty state and its newest waterfall', () => {
    expect(renderAgentTracesPanel()).toContain('No traces were recorded');
    expect(renderAgentTracesPanel({ traces: [trace()], latest: trace(), spans: [span(0)] })).toContain('trace-waterfall');
  });
});

type Poller = { options: any; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };

function harness(responses: (path: string) => unknown, elements: Record<string, FakeElement> = {}) {
  const pollers: Poller[] = [];
  const container = new FakeElement() as FakeElement & { querySelector: (selector: string) => FakeElement | null };
  container.querySelector = (selector: string) => elements[selector] ?? null;
  const insert = vi.fn((element: FakeElement, markup: string) => { element.markup = markup; });
  const fetcher = vi.fn(async (path: string) => {
    const value = responses(path);
    if (value instanceof Error) throw value;
    return value;
  });
  const view = createTracesView({
    insert, navigate: vi.fn(), fetcher,
    createPoller: (options: any) => { const poller = { options, start: vi.fn(async () => {}), stop: vi.fn() }; pollers.push(poller); return poller; }
  });
  return { view, container, insert, fetcher, pollers };
}

const listResponse = (traces: unknown[]) => ({ data: { traces, summary: { traces: traces.length }, nextCursor: null } });
const detailResponses = (state: string) => (path: string) => (path.includes('/spans')
  ? { data: { traceId, spans: [span(0)], nextCursor: null } }
  : { data: { trace: { ...trace({ state }), reconciliation: null } } });

describe('traces view controller', () => {
  it('polls the list only while a trace is running and stops on dispose', async () => {
    const idle = harness(() => listResponse([trace()]));
    await idle.view.loadList(idle.container, '');
    expect(idle.pollers).toHaveLength(0);
    expect(idle.container.markup).toContain(traceId);
    expect(idle.container.markup).not.toContain('trace-kpis-as-of');

    const live = harness(() => listResponse([trace({ state: 'RUNNING', endedAt: null, durationMs: null })]));
    await live.view.loadList(live.container, '?state=RUNNING');
    expect(live.pollers).toHaveLength(1);
    // The KPI strip says its figures are from page load while the rows keep refreshing.
    expect(live.container.markup).toContain('trace-kpis-as-of');
    expect(live.container.markup).toContain('(page load)');
    expect(live.pollers[0].options.intervalMs).toBe(5_000);
    expect(live.view.polling()).toBe(true);
    expect(live.pollers[0].options.isTerminal(listResponse([trace()]))).toBe(true);
    live.view.dispose();
    expect(live.pollers[0].stop).toHaveBeenCalled();
    expect(live.view.polling()).toBe(false);
  });

  it('ends polling quietly when a refresh fails', async () => {
    const { view, container, pollers, fetcher } = harness(detailResponses('RUNNING'));
    await view.loadDetail(container, traceId);
    expect(pollers).toHaveLength(1);
    fetcher.mockRejectedValue(new Error('offline'));
    const state = await pollers[0].options.fetchJob();
    expect(pollers[0].options.isTerminal(state)).toBe(true);
    const before = container.markup;
    pollers[0].options.onState(state);
    expect(container.markup).toBe(before);
  });

  it('does not poll a finished trace and refuses a malformed id before fetching', async () => {
    const { view, container, pollers, fetcher } = harness(detailResponses('COMPLETED'));
    await view.loadDetail(container, traceId);
    expect(pollers).toHaveLength(0);
    expect(container.markup).toContain('trace-waterfall');
    fetcher.mockClear();
    await expect(view.loadDetail(container, 'trc_../../x')).rejects.toMatchObject({ status: 404 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('hides the agent panel when traces are turned off', async () => {
    const disabled = Object.assign(new Error('Agent traces are turned off on this server.'), { code: 'feature_disabled', status: 409 });
    const { view } = harness(() => disabled);
    const section = new FakeElement();
    section.hidden = true;
    await view.loadAgentPanel(section, agentId);
    expect(section.hidden).toBe(true);
    const shown = harness(() => listResponse([]));
    await shown.view.loadAgentPanel(section, agentId);
    expect(section.hidden).toBe(false);
    expect(section.markup).toContain('No traces were recorded');
  });

  it('reports availability from the status route, and from the feature flag answer only', async () => {
    expect(tracesDisabled({ code: 'feature_disabled' })).toBe(true);
    const status = vi.fn(async () => ({ data: { enabled: false } }));
    expect(await tracesAvailable(status)).toBe(false);
    expect(status).toHaveBeenCalledWith('/traces/status');
    expect(await tracesAvailable(async () => ({ data: { enabled: true } }))).toBe(true);
    expect(await tracesAvailable(async () => { throw Object.assign(new Error('off'), { code: 'feature_disabled' }); })).toBe(false);
    expect(await tracesAvailable(async () => { throw Object.assign(new Error('boom'), { code: 'internal_error' }); })).toBe(true);
  });
});

describe('trace list paging and polling', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const queryOf = (path: string) => new URLSearchParams(path.split('?')[1]);

  it('reuses the window bound for "Load more" while the clock advances', async () => {
    let clock = Date.parse('2026-10-19T12:00:00.000Z');
    vi.spyOn(Date, 'now').mockImplementation(() => { clock += 7_000; return clock; });
    const more = new FakeElement();
    const rows = new FakeElement();
    const issued = new Map<string, string>();
    // A fetcher that, like the runner, accepts a cursor only with the exact filters it was issued for.
    const { view, container, fetcher } = harness((path) => {
      const query = queryOf(path);
      const cursor = query.get('cursor');
      if (cursor && issued.get(cursor) !== query.get('since')) return Object.assign(new Error('out of date'), { code: 'invalid_input' });
      const next = cursor ? null : 'tc1.next';
      if (next) issued.set(next, query.get('since') ?? '');
      return { data: { traces: [trace({ traceId: cursor ? `trc_${'d'.repeat(26)}` : traceId })], summary: cursor ? null : { traces: 2 }, nextCursor: next } };
    }, { '#trace-load-more': more, '#trace-rows': rows });
    await view.loadList(container, '?window=1h');
    more.dispatch('click', {});
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(more.disabled).toBe(false));
    const [first, second] = fetcher.mock.calls.map(([path]) => queryOf(path as string));
    expect(first!.get('since')).toBeTruthy();
    expect(second!.get('since')).toBe(first!.get('since'));
    expect(first!.has('includeSummary')).toBe(false);
    expect(second!.get('includeSummary')).toBe('false');
    expect(rows.markup).toContain(`trc_${'d'.repeat(26)}`);
    expect(more.hidden).toBe(true);
  });

  it('refreshes only the rows on a poll: no summary request and the filter form is untouched', async () => {
    const running = trace({ state: 'RUNNING', endedAt: null, durationMs: null });
    const form = new FakeElement();
    const list = new FakeElement();
    const { view, container, pollers, fetcher, insert } = harness(() => listResponse([running]), { '#trace-filters': form, '#trace-list': list });
    await view.loadList(container, '?window=24h&state=RUNNING');
    const page = container.markup;
    const since = queryOf(fetcher.mock.calls[0]![0] as string).get('since');
    await pollers[0]!.options.fetchJob();
    const polled = queryOf(fetcher.mock.calls.at(-1)![0] as string);
    expect(polled.get('includeSummary')).toBe('false');
    expect(polled.get('since')).toBe(since);
    insert.mockClear();
    pollers[0]!.options.onState({ data: { traces: [trace({ state: 'RUNNING', traceId: `trc_${'e'.repeat(26)}`, endedAt: null, durationMs: null })], summary: null, nextCursor: null } });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0]![0]).toBe(list);
    expect(list.markup).toContain(`trc_${'e'.repeat(26)}`);
    // The page (filter form and KPI strip) was not re-rendered.
    expect(container.markup).toBe(page);
  });
});

describe('dashboard wiring', () => {
  it('hides the Traces rail entry until the server confirms the feature', () => {
    const script = readFileSync(new URL('../dashboard/dashboard.js', import.meta.url), 'utf8');
    expect(script).toContain('data-feature=');
    expect(script).toContain('a[data-feature="agentTraces"]');
    expect(script).toContain('traceViews.dispose()');
  });
});
