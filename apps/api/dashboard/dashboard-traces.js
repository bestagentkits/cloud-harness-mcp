/**
 * Agent traces in the Dashboard: the Traces page (KPI strip, filters, trace list), one trace's detail
 * with its span waterfall and tree, and the Traces panel on an agent's detail page.
 *
 * Every value rendered here comes from the strict trace projection of the dashboard API, and every
 * value is escaped. A figure the runner did not observe is `null` in the contract and reads as
 * "unknown" here, never as 0. Waterfall bars are SVG geometry attributes rather than inline styles, so
 * the dashboard's `style-src 'self'` policy holds.
 */
import { api } from './dashboard-api.js';
import { escapeHtml as escape } from './dashboard-render.js';

const UNKNOWN = 'unknown';
const TRACE_ID = /^trc_[a-z2-7]{26}$/;
const AGENT_ID = /^agent_[A-Za-z0-9_-]{20,80}$/;
const WORKSPACE_ID = /^ws_[A-Za-z0-9_-]{20,80}$/;
/** States a trace can be in, in the order the filter offers them. */
export const TRACE_STATES = ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'EXPIRED', 'INCOMPLETE'];
const STATE_LABELS = {
  RUNNING: 'Running', COMPLETED: 'Completed', FAILED: 'Failed', CANCELLED: 'Cancelled',
  TIMED_OUT: 'Timed out', EXPIRED: 'Lease expired', INCOMPLETE: 'Incomplete'
};
/** Pill classes reuse the shared status palette. */
const STATE_CLASSES = {
  RUNNING: 'running', COMPLETED: 'succeeded', FAILED: 'failed', CANCELLED: 'cancelling',
  TIMED_OUT: 'timed_out', EXPIRED: 'expired', INCOMPLETE: 'degraded'
};
const SPAN_STATE_CLASSES = { OPEN: 'running', OK: 'succeeded', ERROR: 'failed', UNKNOWN: 'degraded' };
const EXPORT_FORMATS = [['json', 'JSON'], ['csv', 'CSV'], ['otlp-json', 'OTLP JSON']];
/** Spans read for one waterfall: four pages of the largest span page. */
const MAX_SPAN_PAGES = 4;
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_ATTEMPTS = 120;

const known = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));

/** A count, or "unknown" when the runner did not observe it. */
export function traceCount(value) {
  return known(value) ? Number(value).toLocaleString('en-US') : UNKNOWN;
}

/** Micro-dollars as dollars, or "unknown". */
export function traceCost(micros) {
  if (!known(micros)) return UNKNOWN;
  const dollars = Number(micros) / 1_000_000;
  return `$${dollars.toFixed(dollars !== 0 && dollars < 0.01 ? 6 : 2)}`;
}

/** Milliseconds as a short duration, or "unknown". */
export function traceDuration(ms) {
  if (!known(ms)) return UNKNOWN;
  const value = Number(ms);
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}

export function traceStateLabel(state) {
  return STATE_LABELS[state] ?? UNKNOWN;
}

function statePill(state) {
  return `<span class="status ${escape(STATE_CLASSES[state] ?? '')}">${escape(traceStateLabel(state))}</span>`;
}

function spanStatePill(state) {
  return `<span class="status ${escape(SPAN_STATE_CLASSES[state] ?? '')}">${escape(String(state ?? UNKNOWN).toLowerCase())}</span>`;
}

function time(value) {
  if (!value) return UNKNOWN;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? UNKNOWN : `<time datetime="${escape(value)}">${escape(parsed.toLocaleString())}</time>`;
}

function latency(value) {
  if (!value || !known(value.samples) || Number(value.samples) === 0) return UNKNOWN;
  return `p50 ${traceDuration(value.p50Ms)} · p95 ${traceDuration(value.p95Ms)}`;
}

function traceHref(traceId) {
  return `/dashboard/traces/${encodeURIComponent(traceId)}`;
}

/** The download URL of one export format. Only a validated trace id and a fixed format reach it. */
export function traceExportHref(traceId, format) {
  if (!TRACE_ID.test(String(traceId)) || !EXPORT_FORMATS.some(([value]) => value === format)) return '';
  return `/dashboard/api/v1/traces/${encodeURIComponent(traceId)}/export?format=${encodeURIComponent(format)}`;
}

/** The filters the Traces page reads from its URL. Unknown or malformed values are dropped. */
export function traceFiltersFromSearch(search) {
  const params = new URLSearchParams(search ?? '');
  const filters = {};
  const state = params.get('state');
  if (state && TRACE_STATES.includes(state)) filters.state = state;
  const profileId = params.get('profileId')?.trim();
  if (profileId && profileId.length <= 128) filters.profileId = profileId;
  const agentId = params.get('agentId')?.trim();
  if (agentId && AGENT_ID.test(agentId)) filters.agentId = agentId;
  const workspaceId = params.get('workspaceId')?.trim();
  if (workspaceId && WORKSPACE_ID.test(workspaceId)) filters.workspaceId = workspaceId;
  const window = params.get('window');
  if (window && ['1h', '24h', '7d'].includes(window)) filters.window = window;
  return filters;
}

const WINDOW_MS = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 };

/**
 * The lower bound of a filter set's time window, or undefined for "any time". A list computes it once
 * and reuses it for every later page and poll: the cursor is bound to the exact filters it was issued
 * for, so a bound recomputed from a moving clock would invalidate it.
 */
export function traceWindowSince(filters = {}, now = Date.now()) {
  return filters.window && WINDOW_MS[filters.window] ? new Date(now - WINDOW_MS[filters.window]).toISOString() : undefined;
}

/**
 * The list API path for a filter set. `since` is the window bound from `traceWindowSince`; the KPI
 * summary is asked for only when `includeSummary` is true and no cursor is given.
 */
export function traceListPath(filters = {}, { cursor, limit = 50, since, includeSummary = false } = {}) {
  const query = new URLSearchParams();
  for (const key of ['state', 'profileId', 'agentId', 'workspaceId']) if (filters[key]) query.set(key, filters[key]);
  if (since) query.set('since', since);
  if (cursor) query.set('cursor', cursor);
  query.set('limit', String(limit));
  if (!includeSummary || cursor) query.set('includeSummary', 'false');
  return `/traces?${query}`;
}

/** The KPI strip over the filtered window. */
export function renderTraceKpis(summary = {}) {
  const tokens = summary.tokens ?? {};
  const unknownCost = Number(summary.unknownCostTraces ?? 0);
  const tiles = [
    ['Traces', traceCount(summary.traces), summary.sampled ? 'Most recent sample of the window' : 'In the selected window'],
    ['Errors', traceCount(summary.errorTraces), `${traceCount(summary.partialTraces)} partial · ${traceCount(summary.unreconciledTraces)} unreconciled`],
    ['Tokens', `${traceCount(tokens.prompt)} in`, `${traceCount(tokens.output)} out`],
    ['Cost', traceCost(summary.costMicros), unknownCost > 0 ? `${traceCount(unknownCost)} trace(s) with unknown cost excluded` : 'Estimated from reported usage'],
    ['Model latency', latency(summary.modelLatency), `${traceCount(summary.modelLatency?.samples)} timed call(s)`],
    ['Time to first token', latency(summary.ttft), `${traceCount(summary.ttft?.samples)} streamed call(s)`]
  ];
  return `<ul class="metric-grid trace-kpis" aria-label="Trace summary">${tiles.map(([label, value, note]) => (
    `<li class="metric"><span class="metric-label">${escape(label)}</span><span class="metric-value small">${escape(value)}</span><span class="metric-note">${escape(note)}</span></li>`
  )).join('')}</ul>`;
}

function renderCohorts(cohorts = []) {
  if (!Array.isArray(cohorts) || !cohorts.length) return '';
  const rows = cohorts.map((cohort) => `<tr><th scope="row">${escape(cohort.profileId ?? UNKNOWN)}</th><td>${escape(traceCount(cohort.traces))}</td><td>${cohort.status === 'ok'
    ? `${escape(latency(cohort.modelLatency))}</td><td>${escape(latency(cohort.ttft))}`
    : 'Too few traces to compare</td><td>—'}</td></tr>`).join('');
  return `<section aria-labelledby="trace-cohorts-heading"><h2 id="trace-cohorts-heading">By profile</h2><div class="desktop-table"><table><caption>Percentiles are shown for profiles with at least 20 traces.</caption><thead><tr><th>Profile</th><th>Traces</th><th>Model latency</th><th>Time to first token</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

/** The filter form. Values are re-escaped; the form submits as a GET navigation. */
export function renderTraceFilters(filters = {}) {
  const stateOptions = ['<option value="">All states</option>', ...TRACE_STATES.map((state) => (
    `<option value="${escape(state)}"${filters.state === state ? ' selected' : ''}>${escape(traceStateLabel(state))}</option>`
  ))].join('');
  const windowOptions = [['', 'Any time'], ['1h', 'Last hour'], ['24h', 'Last 24 hours'], ['7d', 'Last 7 days']]
    .map(([value, label]) => `<option value="${value}"${(filters.window ?? '') === value ? ' selected' : ''}>${label}</option>`).join('');
  return '<form id="trace-filters" role="search" aria-label="Filter traces">'
    + `<label for="trace-state-filter">State</label><select id="trace-state-filter" name="state">${stateOptions}</select>`
    + `<label for="trace-window-filter">Window</label><select id="trace-window-filter" name="window">${windowOptions}</select>`
    + `<label for="trace-profile-filter">Profile</label><input id="trace-profile-filter" name="profileId" maxlength="128" value="${escape(filters.profileId ?? '')}" placeholder="coding-fast">`
    + `<label for="trace-agent-filter">Agent</label><input id="trace-agent-filter" name="agentId" value="${escape(filters.agentId ?? '')}" placeholder="agent_…" pattern="agent_[A-Za-z0-9_-]{20,80}">`
    + `<label for="trace-workspace-filter">Workspace</label><input id="trace-workspace-filter" name="workspaceId" value="${escape(filters.workspaceId ?? '')}" placeholder="ws_…" pattern="ws_[A-Za-z0-9_-]{20,80}">`
    + '<button type="submit">Apply filters</button></form>';
}

function traceRow(trace) {
  return `<tr><th scope="row"><a href="${escape(traceHref(trace.traceId))}" class="mono">${escape(trace.traceId)}</a><small class="mono">${escape(trace.agentId)} · gen ${escape(trace.generation)}${trace.parentTraceId ? ' · child' : ''}</small></th>`
    + `<td>${statePill(trace.state)}${trace.coverage === 'partial' ? ' <span class="status degraded">partial</span>' : ''}</td>`
    + `<td>${escape(trace.profileId ?? UNKNOWN)}</td>`
    + `<td>${time(trace.startedAt)}</td>`
    + `<td>${escape(traceDuration(trace.durationMs))}</td>`
    + `<td>${escape(traceCount(trace.tokens?.prompt))} in · ${escape(traceCount(trace.tokens?.output))} out</td>`
    + `<td>${escape(traceCost(trace.costMicros))}</td>`
    + `<td>${escape(trace.reconciliationStatus ?? UNKNOWN)}</td></tr>`;
}

/** The trace table; `append` renders rows only, for "Load more". */
export function renderTraceRows(traces = []) {
  return traces.map(traceRow).join('');
}

export function renderTraceTable(traces = [], { nextCursor = null, caption = '' } = {}) {
  if (!traces.length) {
    return '<div class="empty"><h3>No traces match.</h3><p>A trace is recorded for every coding agent run while traces are enabled.</p></div>';
  }
  return `<div class="desktop-table"><table id="trace-table"><caption>${escape(caption || `${traces.length} trace(s)`)}</caption><thead><tr><th>Trace</th><th>State</th><th>Profile</th><th>Started</th><th>Duration</th><th>Tokens</th><th>Cost</th><th>Reconciliation</th></tr></thead><tbody id="trace-rows">${renderTraceRows(traces)}</tbody></table></div>`
    + `<div class="row-actions"><button id="trace-load-more" type="button"${nextCursor ? '' : ' hidden'}>Load more</button></div>`;
}

/** The whole Traces page body for one list response. */
export function renderTracesPage({ traces = [], summary = {}, filters = {}, nextCursor = null } = {}) {
  return `<div class="page-note"><strong>Agent traces.</strong> One trace per coding agent run: model calls, tool calls, budget events and the gateway settlement, with identifiers, timings, tokens and cost. Prompts and model output are never recorded; tool arguments are recorded only as a digest, unless the operator turns on a bounded, redacted preview.</div>`
    + `<div class="resource-filters">${renderTraceFilters(filters)}</div>`
    + `<div class="resource-body traces">${renderTraceKpis(summary ?? {})}<section aria-labelledby="trace-list-heading"><h2 id="trace-list-heading">Traces</h2><div id="trace-list">${renderTraceTable(traces, { nextCursor })}</div></section>${renderCohorts(summary?.cohorts)}</div>`;
}

/**
 * Orders spans as a tree: each span follows its parent, children by start time. A span whose parent
 * is missing (truncated or not yet written) is placed at the root, and a cycle cannot loop.
 */
export function buildSpanTree(spans = []) {
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const children = new Map();
  const roots = [];
  for (const span of spans) {
    const parent = span.parentSpanId && span.parentSpanId !== span.spanId && byId.has(span.parentSpanId) ? span.parentSpanId : null;
    if (parent === null) roots.push(span);
    else children.set(parent, [...(children.get(parent) ?? []), span]);
  }
  const order = (list) => [...list].sort((left, right) => String(left.startedAt).localeCompare(String(right.startedAt)) || left.spanSeq - right.spanSeq);
  const rows = [];
  const seen = new Set();
  const visit = (span, depth) => {
    if (seen.has(span.spanId)) return;
    seen.add(span.spanId);
    rows.push({ span, depth });
    for (const child of order(children.get(span.spanId) ?? [])) visit(child, Math.min(depth + 1, 6));
  };
  for (const root of order(roots)) visit(root, 0);
  // Anything left (only reachable through a cycle) is still listed, at the root.
  for (const span of spans) if (!seen.has(span.spanId)) visit(span, 0);
  return rows;
}

function spanFacts(span) {
  const facts = [];
  if (span.kind === 'model_call' || span.kind === 'gateway') {
    facts.push(`${traceCount(span.tokens?.prompt)} in · ${traceCount(span.tokens?.output)} out`);
    facts.push(traceCost(span.costMicros));
    if (span.kind === 'model_call') facts.push(`TTFT ${traceDuration(span.ttftMs)}`);
  }
  if (span.attributes?.retry_count) facts.push(`${traceCount(span.attributes.retry_count)} retry`);
  if (span.attributes?.usage_missing) facts.push('usage missing');
  if (span.errorClass) facts.push(`error: ${span.errorClass}`);
  if (span.inputDigest) facts.push(`input ${String(span.inputDigest).slice(0, 19)}…`);
  return facts.map((fact) => escape(fact)).join(' · ');
}

/**
 * The waterfall: one row per span in tree order, with a bar placed on the trace's time axis. A span
 * without an end (open or unknown) draws to the end of the axis with a dashed outline.
 */
export function renderTraceWaterfall(trace, spans = []) {
  if (!spans.length) return '<p class="empty-note">No spans were recorded for this trace.</p>';
  const rows = buildSpanTree(spans);
  const starts = spans.map((span) => Date.parse(span.startedAt)).filter(Number.isFinite);
  const ends = spans.map((span) => Date.parse(span.endedAt ?? '')).filter(Number.isFinite);
  const traceStart = Math.min(...starts, Date.parse(trace?.startedAt ?? '') || Infinity);
  const traceEnd = Math.max(...ends, ...starts, Date.parse(trace?.endedAt ?? '') || -Infinity);
  const span = Math.max(1, traceEnd - traceStart);
  const position = (value) => Math.max(0, Math.min(1000, Math.round(((value - traceStart) / span) * 1000)));
  const items = rows.map(({ span: item, depth }) => {
    const start = Date.parse(item.startedAt);
    const end = Date.parse(item.endedAt ?? '');
    const from = Number.isFinite(start) ? position(start) : 0;
    const open = !Number.isFinite(end);
    const width = Math.max(4, (open ? 1000 : position(end)) - from);
    const x = Math.min(from, 1000 - width);
    return `<li class="trace-span depth-${depth} kind-${escape(item.kind)}" data-span-id="${escape(item.spanId)}">`
      + `<div class="trace-span-label"><span class="mono">${escape(item.name)}</span> ${spanStatePill(item.state)}<small>${escape(item.kind.replace('_', ' '))} · ${escape(traceDuration(item.durationMs))}</small></div>`
      + `<svg class="trace-bar${open ? ' open' : ''}" viewBox="0 0 1000 12" preserveAspectRatio="none" role="img" aria-label="${escape(`${item.name}: ${traceDuration(item.durationMs)}`)}"><rect x="${x}" y="1" width="${width}" height="10" rx="2"/></svg>`
      + `<p class="trace-span-facts">${spanFacts(item)}</p></li>`;
  }).join('');
  return `<ol class="trace-waterfall" aria-label="Span waterfall">${items}</ol>`;
}

function renderReconciliation(reconciliation) {
  if (!reconciliation) return '';
  const reasons = Array.isArray(reconciliation.reasons) && reconciliation.reasons.length
    ? reconciliation.reasons.map((reason) => `<li class="mono">${escape(reason)}</li>`).join('')
    : '<li>None</li>';
  const ledger = reconciliation.ledger;
  const gateway = reconciliation.gateway;
  return `<section class="panel" aria-labelledby="trace-reconciliation-heading"><h2 id="trace-reconciliation-heading">Reconciliation</h2>`
    + `<p>${escape(reconciliation.status)} — span sums compared with the agent usage ledger. Tokens must match exactly; cost may differ by ${escape(traceCount(reconciliation.toleranceMicros))} micro-dollar(s) of rounding.</p>`
    + `<dl class="facts"><dt>Spans</dt><dd>${escape(traceCount(reconciliation.spans?.inputTokens))} in · ${escape(traceCount(reconciliation.spans?.outputTokens))} out · ${escape(traceCost(reconciliation.spans?.costMicros))}</dd>`
    + `<dt>Usage ledger</dt><dd>${ledger ? `${escape(traceCount(ledger.inputTokens))} in · ${escape(traceCount(ledger.outputTokens))} out · ${escape(traceCost(ledger.costMicros))}` : UNKNOWN}</dd>`
    + `<dt>Gateway settlement</dt><dd>${gateway ? `${escape(traceCount(gateway.promptTokens))} in · ${escape(traceCount(gateway.outputTokens))} out · ${escape(traceCount(gateway.requests))} request(s), ${escape(traceCount(gateway.requestsWithoutUsage))} without usage · ${escape(traceCost(gateway.costMicros))}` : UNKNOWN}</dd>`
    + `<dt>Reasons</dt><dd><ul class="trace-list">${reasons}</ul></dd></dl></section>`;
}

/** One trace: facts, reconciliation, export links and the span waterfall. */
export function renderTraceDetail({ trace, spans = [], spansTruncated = false } = {}) {
  if (!trace) return '<div class="empty"><h3>Trace not found.</h3><p>It may have passed its retention period or belong to another identity.</p></div>';
  const exports = EXPORT_FORMATS.map(([format, label]) => `<a class="trace-export-link" href="${escape(traceExportHref(trace.traceId, format))}" download>${escape(label)}</a>`).join('');
  return `<nav aria-label="Breadcrumb"><a href="/dashboard/traces">Traces</a><span class="mono">${escape(trace.traceId)}</span></nav>`
    + `<div class="record-heading"><div><h2 id="trace-heading">${statePill(trace.state)} ${trace.coverage === 'partial' ? '<span class="status degraded">partial</span>' : ''}</h2><p><a href="/dashboard/agents/${encodeURIComponent(trace.agentId)}?workspaceId=${encodeURIComponent(trace.workspaceId)}" class="mono">${escape(trace.agentId)}</a> · generation ${escape(trace.generation)}</p></div><div class="row-actions trace-exports" aria-label="Export trace">${exports}</div></div>`
    + `<section class="panel" aria-labelledby="trace-facts-heading"><h2 id="trace-facts-heading">Trace</h2><dl class="facts">`
    + `<dt>Profile</dt><dd>${escape(trace.profileId ?? UNKNOWN)}${trace.profileRevisionId ? ` <span class="mono">(${escape(trace.profileRevisionId)})</span>` : ''}</dd>`
    + `<dt>Parent trace</dt><dd>${trace.parentTraceId ? `<a class="mono" href="${escape(traceHref(trace.parentTraceId))}">${escape(trace.parentTraceId)}</a>` : 'None'}</dd>`
    + `<dt>Started</dt><dd>${time(trace.startedAt)}</dd><dt>Ended</dt><dd>${trace.endedAt ? time(trace.endedAt) : 'Still running'}</dd>`
    + `<dt>Duration</dt><dd>${escape(traceDuration(trace.durationMs))}</dd><dt>Finish reason</dt><dd>${escape(trace.finishReason ?? UNKNOWN)}</dd>`
    + `<dt>Model calls</dt><dd>${escape(traceCount(trace.modelCalls))} · ${escape(latency(trace.modelLatency))}</dd>`
    + `<dt>Time to first token</dt><dd>${escape(latency(trace.ttft))}</dd>`
    + `<dt>Tool calls</dt><dd>${escape(traceCount(trace.toolCalls))}</dd><dt>Errors</dt><dd>${escape(traceCount(trace.errors))}</dd>`
    + `<dt>Tokens</dt><dd>${escape(traceCount(trace.tokens?.prompt))} in · ${escape(traceCount(trace.tokens?.output))} out · ${escape(traceCount(trace.tokens?.cacheRead))} cache read · ${escape(traceCount(trace.tokens?.reasoning))} reasoning</dd>`
    + `<dt>Cost</dt><dd>${escape(traceCost(trace.costMicros))} (${escape(trace.costProvenance ?? UNKNOWN)})</dd>`
    + `<dt>Spans</dt><dd>${escape(traceCount(trace.spanCount))}${trace.truncated ? ' (truncated at the span cap)' : ''}</dd>`
    + `<dt>Expires</dt><dd>${time(trace.expiresAt)}</dd></dl></section>`
    + renderReconciliation(trace.reconciliation)
    + `<section class="panel" aria-labelledby="trace-spans-heading"><h2 id="trace-spans-heading">Spans</h2>${spansTruncated ? '<p class="page-note">Only the first spans are drawn; export the trace for every span.</p>' : ''}${renderTraceWaterfall(trace, spans)}</section>`;
}

/** The Traces panel on an agent detail page: the agent's runs and the newest run's waterfall. */
export function renderAgentTracesPanel({ traces = [], latest = null, spans = [] } = {}) {
  if (!traces.length) return '<h2 id="agent-traces-heading">Traces</h2><p class="empty-note">No traces were recorded for this agent.</p>';
  const list = traces.map((trace) => `<li><a class="mono" href="${escape(traceHref(trace.traceId))}">${escape(trace.traceId)}</a> ${statePill(trace.state)} <small>gen ${escape(trace.generation)} · ${escape(traceDuration(trace.durationMs))} · ${escape(traceCost(trace.costMicros))}</small></li>`).join('');
  return `<h2 id="agent-traces-heading">Traces</h2><ul class="trace-list trace-runs">${list}</ul>${latest ? renderTraceWaterfall(latest, spans) : ''}`;
}

/** True when an API error says traces are turned off on this server. */
export function tracesDisabled(error) {
  return error?.code === 'feature_disabled' || (error?.status === 409 && /turned off/i.test(String(error?.message ?? '')));
}

async function readSpans(traceId, fetcher, signal) {
  const spans = [];
  let cursor;
  for (let page = 0; page < MAX_SPAN_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: '500' });
    if (cursor) query.set('cursor', cursor);
    const result = await fetcher(`/traces/${encodeURIComponent(traceId)}/spans?${query}`, signal ? { signal } : {});
    spans.push(...(result?.data?.spans ?? []));
    cursor = result?.data?.nextCursor ?? undefined;
    if (!cursor) return { spans, truncated: false };
  }
  return { spans, truncated: true };
}

/**
 * The trace views' controller. The Dashboard injects its shell helpers and its one polling controller
 * factory; this module never starts a second poller. Polling runs only while a shown trace is RUNNING
 * and stops on navigation (`dispose`).
 */
export function createTracesView({ insert, navigate, createPoller, announce = () => {}, fetcher = api }) {
  let poller;
  const stopPolling = () => { poller?.stop(); poller = undefined; };

  function poll(fetchState, onState, isTerminal) {
    stopPolling();
    if (!createPoller) return;
    const failed = Symbol('failed');
    // A failed read ends polling quietly: the page already shows the last good state, and a timer
    // callback must never reject unhandled.
    poller = createPoller({
      fetchJob: async () => { try { return await fetchState(); } catch { return failed; } },
      onState: (state) => { if (state !== failed) onState(state); },
      isTerminal: (state) => state === failed || isTerminal(state),
      intervalMs: POLL_INTERVAL_MS,
      maxAttempts: POLL_MAX_ATTEMPTS
    });
    void poller.start();
  }

  async function loadList(container, search) {
    stopPolling();
    const filters = traceFiltersFromSearch(search);
    // The window bound is fixed for this list: every later page and poll reuses it.
    const since = traceWindowSince(filters);
    const result = await fetcher(traceListPath(filters, { since, includeSummary: true }));
    const data = result?.data ?? {};
    const state = { traces: data.traces ?? [], nextCursor: data.nextCursor ?? null, since };
    insert(container, renderTracesPage({ ...state, summary: data.summary ?? {}, filters }));
    bindFilters(container);
    bindMore(container, filters, state);
    if (state.traces.some((trace) => trace.state === 'RUNNING')) {
      poll(
        // A poll refreshes the rows only: the KPI summary is not recomputed, and the filter form keeps
        // whatever the user is typing.
        () => fetcher(traceListPath(filters, { since })),
        (next) => {
          // Only the first page refreshes in place; "Load more" stops polling before it pages further.
          const fresh = next?.data ?? {};
          Object.assign(state, { traces: fresh.traces ?? [], nextCursor: fresh.nextCursor ?? null });
          const list = container.querySelector?.('#trace-list');
          if (!list) return;
          insert(list, renderTraceTable(state.traces, { nextCursor: state.nextCursor }));
          bindMore(container, filters, state);
        },
        (next) => !(next?.data?.traces ?? []).some((trace) => trace.state === 'RUNNING')
      );
    }
  }

  function bindFilters(container) {
    const form = container.querySelector?.('#trace-filters');
    form?.addEventListener?.('submit', (event) => {
      event.preventDefault();
      const next = new URLSearchParams();
      for (const [key, value] of new FormData(event.currentTarget)) if (String(value).trim()) next.set(key, String(value).trim());
      navigate(`/dashboard/traces${next.size ? `?${next}` : ''}`);
    });
  }

  function bindMore(container, filters, state) {
    const more = container.querySelector?.('#trace-load-more');
    more?.addEventListener?.('click', async () => {
      if (!state.nextCursor) return;
      stopPolling();
      more.disabled = true;
      try {
        const page = await fetcher(traceListPath(filters, { cursor: state.nextCursor, since: state.since }));
        const rows = page?.data?.traces ?? [];
        state.traces.push(...rows);
        state.nextCursor = page?.data?.nextCursor ?? null;
        const body = container.querySelector('#trace-rows');
        if (body) insert(body, renderTraceRows(state.traces));
        more.hidden = !state.nextCursor;
        announce(`${rows.length} more trace(s) loaded.`);
      } catch (error) {
        announce(error?.code === 'trace_expired' ? 'Older traces were removed by retention. Reload the list.' : 'More traces could not load.');
      } finally {
        more.disabled = false;
      }
    });
  }

  async function readTrace(traceId) {
    const [detail, spans] = await Promise.all([
      fetcher(`/traces/${encodeURIComponent(traceId)}`),
      readSpans(traceId, fetcher)
    ]);
    return { trace: detail?.data?.trace ?? null, spans: spans.spans, spansTruncated: spans.truncated };
  }

  async function loadDetail(container, traceId) {
    stopPolling();
    if (!TRACE_ID.test(String(traceId))) throw Object.assign(new Error('Trace not found.'), { status: 404 });
    const view = await readTrace(traceId);
    insert(container, renderTraceDetail(view));
    if (view.trace?.state === 'RUNNING') {
      poll(
        () => readTrace(traceId),
        (next) => insert(container, renderTraceDetail(next)),
        (next) => next?.trace?.state !== 'RUNNING'
      );
    }
  }

  /** Fills the agent detail page's Traces panel. A disabled feature hides the panel. */
  async function loadAgentPanel(section, agentId) {
    stopPolling();
    if (!section || !AGENT_ID.test(String(agentId))) return;
    try {
      const result = await fetcher(traceListPath({ agentId }, { limit: 10 }));
      const traces = result?.data?.traces ?? [];
      const latest = traces[0] ?? null;
      const spans = latest ? (await readSpans(latest.traceId, fetcher)).spans : [];
      insert(section, renderAgentTracesPanel({ traces, latest, spans }));
      section.hidden = false;
    } catch (error) {
      if (tracesDisabled(error)) { section.hidden = true; return; }
      insert(section, '<h2 id="agent-traces-heading">Traces</h2><p class="empty-note">Traces could not load.</p>');
      section.hidden = false;
    }
  }

  return { loadList, loadDetail, loadAgentPanel, dispose: stopPolling, polling: () => poller !== undefined };
}

/**
 * Whether this server records traces, from the cheap status route. Only an answer that the feature is
 * off hides the Traces views; any other failure keeps them, so a transient error never hides the page.
 */
export async function tracesAvailable(fetcher = api) {
  try {
    const result = await fetcher('/traces/status');
    return result?.data?.enabled !== false;
  } catch (error) {
    return !tracesDisabled(error);
  }
}
