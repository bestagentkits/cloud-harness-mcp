/**
 * The Overview's read shapes and the pure mappers from them to tiles, lists and chart data.
 * Shapes follow `buildOverviewProjection`, `buildMetricsProjection` and
 * `buildReliabilityProjection` in `apps/api/src/dashboard-response.ts` and the `/server`
 * handler in `apps/api/src/dashboard-router.ts`. Every field is read defensively: a
 * projection can omit a list, and a missing value renders as a fixed placeholder, never as
 * an invented number.
 */
import type { BarDatum } from '@/components/data/bar-chart';
import { arr, rec } from '@/lib/format';

/** The metrics window the classic Overview reads; the page offers no window switch. */
export const METRICS_WINDOW = '24h';

export type AttentionItem = { id: string; label: string; detail: string; href: string | undefined };
export type ExpiryBucket = { windowMinutes: number | undefined; label: string; count: number };

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback);

/**
 * The attention and workspace links the projection carries are absolute classic paths
 * (`/dashboard/workspaces/ws_1/summary`). Only a same-app path made of plain path characters
 * becomes a client link (relative to the router's `/dashboard` basepath); anything else
 * (another origin, a protocol-relative URL, a query or traversal) renders as text.
 */
export function dashboardRoute(href: unknown): string | undefined {
  if (typeof href !== 'string') return undefined;
  const match = /^\/dashboard(\/[A-Za-z0-9_.~%-]+)*\/?$/.exec(href);
  if (!match || href.includes('//') || /(^|\/)\.\.?(\/|$)/.test(href.slice('/dashboard'.length))) return undefined;
  const route = href.slice('/dashboard'.length).replace(/\/$/, '');
  return route || '/';
}

export function attentionItems(overview: unknown): AttentionItem[] {
  return arr(rec(overview).attention).map((raw, index) => {
    const item = rec(raw);
    return { id: text(item.id) || `attention-${index}`, label: text(item.label, 'Attention') || 'Attention', detail: text(item.detail), href: dashboardRoute(item.href) };
  });
}

export function expiryBuckets(overview: unknown): ExpiryBucket[] {
  return arr(rec(overview).expiring).map((raw) => {
    const bucket = rec(raw);
    const minutes = Number(bucket.windowMinutes);
    return { windowMinutes: Number.isInteger(minutes) && minutes > 0 ? minutes : undefined, label: text(bucket.label), count: num(bucket.count) };
  });
}

/** Cost as the classic tile shows it: dollars to four places, or "Not reported". */
export function tileCost(costMicros: unknown): string {
  const micros = Number(costMicros);
  return costMicros !== undefined && costMicros !== null && Number.isFinite(micros) ? `$${(micros / 1_000_000).toFixed(4)}` : 'Not reported';
}

export type DecisionTiles = {
  attention: { count: number };
  running: { agents: number; workspaces: number };
  cost: { value: string; scope: string };
  expiry: { count: number };
};

/** The four decision tiles: attention, running, cost (with its measured scope) and the hour's expiries. */
export function decisionTiles(overview: unknown): DecisionTiles {
  const source = rec(overview);
  const running = rec(source.running);
  const cost = rec(source.cost);
  const hour = expiryBuckets(source).find((bucket) => bucket.windowMinutes === 60);
  return {
    attention: { count: arr(source.attention).length },
    running: { agents: num(running.agents), workspaces: num(running.workspaces) },
    cost: { value: tileCost(cost.costMicros), scope: text(cost.scope, 'not reported') || 'not reported' },
    expiry: { count: hour?.count ?? 0 }
  };
}

const usd = (value: number) => `${Number(value.toFixed(6))} USD`;

function timeLabel(at: unknown): string {
  const date = new Date(text(at));
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString();
}

/** Retained audit events per bucket of the metrics window. */
export function metricsSeries(metrics: unknown): BarDatum[] {
  return arr(rec(metrics).series).map((raw, index) => {
    const point = rec(raw);
    return { key: `${text(point.at)}-${index}`, label: timeLabel(point.at), value: num(point.count) };
  });
}

/** Agent cost per retained-agent bucket, in dollars. */
export function costSeries(overview: unknown): BarDatum[] {
  return arr(rec(overview).costSeries).map((raw, index) => {
    const point = rec(raw);
    const value = num(point.value);
    return { key: `${text(point.at)}-${index}`, label: text(point.label) || timeLabel(point.at), value, display: usd(value) };
  });
}

/** The execution-health categories, in stacking order. Each has a visible text label. */
export const OUTCOME_CATEGORIES = [
  { key: 'succeeded', label: 'Succeeded', fill: 'fill-success', swatch: 'bg-success' },
  { key: 'attention', label: 'Failed / limit', fill: 'fill-destructive', swatch: 'bg-destructive' },
  { key: 'cancelled', label: 'Cancelled', fill: 'fill-muted-foreground', swatch: 'bg-muted-foreground' },
  { key: 'running', label: 'Running', fill: 'fill-info', swatch: 'bg-info' }
] as const;
export type OutcomeKey = (typeof OUTCOME_CATEGORIES)[number]['key'];
export type OutcomeBucket = { key: string; label: string; segments: Record<OutcomeKey, number> };

export function outcomeBuckets(overview: unknown): OutcomeBucket[] {
  return arr(rec(overview).agentOutcomes).map((raw, index) => {
    const point = rec(raw);
    const segments = rec(point.segments);
    return {
      key: `${text(point.at)}-${index}`,
      label: text(point.label) || timeLabel(point.at),
      segments: { succeeded: num(segments.succeeded), attention: num(segments.attention), cancelled: num(segments.cancelled), running: num(segments.running) }
    };
  });
}

/** "10:00: Succeeded 3, Failed / limit 1, …": every count in words, so no bar relies on colour or height. */
export function outcomeDescription(bucket: OutcomeBucket): string {
  return `${bucket.label}: ${OUTCOME_CATEGORIES.map((category) => `${category.label} ${bucket.segments[category.key]}`).join(', ')}`;
}

/** The scope the agent series measured; the projection names it so the UI never claims a longer history. */
export function agentSeriesScope(overview: unknown): string {
  return text(rec(overview).agentSeriesScope) || 'retained agents';
}

export type RowDatum = { key: string; label: string; value: number; display: string; note: string };

export function profileRows(overview: unknown): RowDatum[] {
  return arr(rec(overview).usageByProfile).map((raw, index) => {
    const entry = rec(raw);
    const value = num(entry.costMicros) / 1_000_000;
    return { key: `${text(entry.profileId)}-${index}`, label: text(entry.profileId) || 'unprofiled', value, display: usd(value), note: `${num(entry.inputTokens)} in · ${num(entry.outputTokens)} out tokens` };
  });
}

export function burnRows(overview: unknown): RowDatum[] {
  return arr(rec(overview).budgetBurn).map((raw, index) => {
    const entry = rec(raw);
    const used = num(entry.costMicros);
    const max = num(entry.maxCostMicros);
    const value = used / 1_000_000;
    return { key: `${text(entry.agentId)}-${index}`, label: text(entry.agentId).slice(0, 18) || 'agent', value, display: usd(value), note: max > 0 ? `${Math.round((used / max) * 100)}% of cost limit` : 'cost limit not reported' };
  });
}

export function expiryRows(overview: unknown): RowDatum[] {
  return expiryBuckets(overview).map((bucket, index) => ({ key: `${bucket.label}-${index}`, label: bucket.label, value: bucket.count, display: String(bucket.count), note: 'workspaces' }));
}

export function reliabilityRows(reliability: unknown): RowDatum[] {
  return arr(rec(reliability).servers).map((raw, index) => {
    const server = rec(raw);
    const p50 = server.p50Ms === undefined || server.p50Ms === null ? '—' : text(server.p50Ms, '—');
    const p95 = server.p95Ms === undefined || server.p95Ms === null ? '—' : text(server.p95Ms, '—');
    const calls = num(server.calls);
    return { key: `${text(server.serverId)}-${index}`, label: text(server.serverName) || text(server.serverId) || 'server', value: calls, display: String(calls), note: `${num(server.error)} error(s), p50 ${p50} ms, p95 ${p95} ms` };
  });
}

/** The `/server` panel facts. */
export type ServerFacts = {
  authMode: string;
  version: string;
  managedOAuthUrl: string | undefined;
  gateway: { enabled: boolean; endpoint: string | undefined };
  maxRequestBytes: number | undefined;
  requestTimeoutSeconds: number | undefined;
  sessionExpiresAt: string | undefined;
  checkedAt: string | undefined;
};

const httpsUrl = (value: unknown): string | undefined => (typeof value === 'string' && /^https:\/\/[^\s]+$/.test(value) ? value : undefined);
const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const optionalText = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export function serverFacts(server: unknown): ServerFacts {
  const source = rec(server);
  const gateway = rec(source.apiKeyGateway);
  const limits = rec(source.limits);
  const timeout = finite(limits.requestTimeoutMs);
  return {
    authMode: text(source.authMode) || 'Unknown',
    version: text(source.version) || 'Unknown',
    managedOAuthUrl: httpsUrl(source.managedOAuthUrl),
    gateway: { enabled: gateway.enabled === true, endpoint: httpsUrl(gateway.endpoint) },
    maxRequestBytes: finite(limits.maxRequestBytes),
    requestTimeoutSeconds: timeout === undefined ? undefined : Math.round(timeout / 1_000),
    sessionExpiresAt: optionalText(rec(source.session).expiresAt),
    checkedAt: optionalText(source.checkedAt)
  };
}
