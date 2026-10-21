/**
 * The agent projection the BFF returns (`agentProjection` in
 * `apps/api/src/dashboard-response.ts`) and the display helpers the list, the hierarchy
 * and the detail page share. Owner ids, credentials, prompts and raw transcripts never
 * reach this projection; log content arrives already bounded and redacted.
 */
import { formatCostMicros, formatNumber } from '@/lib/format';

export const AGENT_STATUSES = ['SPAWNING', 'RUNNING', 'CANCELLING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** The attention filter values the BFF understands (`agentNeedsAttention` in the router). */
export const AGENT_ATTENTION = ['needs-attention', 'clear'] as const;

/** Profile ids are short slugs; the route bounds the param to the same length. */
export const PROFILE_FILTER_MAX = 120;
export type AgentAttention = (typeof AGENT_ATTENTION)[number];

export type AgentBudget = { ttlSeconds?: number; maxOutputBytes?: number; maxInputTokens?: number; maxOutputTokens?: number; maxCostMicros?: number };
export type AgentUsage = { inputTokens?: number; outputTokens?: number; costMicros?: number; outputBytes?: number; eventCount?: number; toolTimeMs?: number; wallTimeMs?: number };

export type Agent = {
  agentId: string;
  workspaceId?: string;
  parentAgentId?: string | null;
  profileId?: string | null;
  status?: string;
  generation?: number;
  createdAt?: string;
  startedAt?: string | null;
  terminalAt?: string | null;
  expiresAt?: string | null;
  terminalReason?: string | null;
  outcomeUnknown?: boolean;
  proxyOperations?: string[];
  budget?: AgentBudget;
  usage?: AgentUsage;
};

export type AgentLogEvent = { cursor?: string; timestamp?: number | string; type?: string; content?: string };
export type AgentLogPage = {
  cursor?: string;
  nextCursor?: string;
  retainedBaseCursor?: string;
  truncated?: boolean;
  hasMore?: boolean;
  events?: AgentLogEvent[];
};

export type AgentFilters = {
  status?: AgentStatus | undefined;
  workspaceId?: string | undefined;
  profileId?: string | undefined;
  parentAgentId?: string | undefined;
  attention?: AgentAttention | undefined;
};

const STATUS_LABELS: Record<AgentStatus, string> = {
  SPAWNING: 'Spawning', RUNNING: 'Running', CANCELLING: 'Cancelling', SUCCEEDED: 'Succeeded',
  FAILED: 'Failed', CANCELLED: 'Cancelled', TIMED_OUT: 'Timed out', LIMIT_EXCEEDED: 'Limit exceeded', INTERRUPTED: 'Interrupted'
};

export function agentStatusLabel(status: unknown): string {
  return STATUS_LABELS[status as AgentStatus] ?? 'Unknown';
}

/** States the runner can still move on its own; only these are worth polling. */
const LIVE_STATUSES = new Set<string>(['SPAWNING', 'RUNNING', 'CANCELLING']);
export function isLiveAgent(status: unknown): boolean {
  return LIVE_STATUSES.has(String(status));
}

/** States that accept a steering message or a cancel (a cancelling agent is already stopping). */
export function isControllableAgent(status: unknown): boolean {
  return status === 'SPAWNING' || status === 'RUNNING';
}

/**
 * The `/agents` query for a set of filters, exactly the keys the legacy loader sent.
 * Without a filter it is `{}`, the registry read the route warms.
 */
export function agentListQuery(filters: AgentFilters): Record<string, string> {
  const query: Record<string, string> = {};
  for (const key of ['status', 'workspaceId', 'profileId', 'parentAgentId', 'attention'] as const) {
    const value = filters[key];
    if (value) query[key] = value;
  }
  return query;
}

export type BudgetUtilization = { state: 'unknown' | 'ok' | 'close' | 'exhausted'; percent: number | undefined };

/**
 * Usage against a limit. A missing or unlimited budget is "unknown" rather than 0%, because
 * a zero would read as a measurement the runner never made. Over-spend clamps at 100%.
 */
export function budgetUtilization(used: unknown, max: unknown): BudgetUtilization {
  if (typeof used !== 'number' || typeof max !== 'number' || !Number.isFinite(used) || !Number.isFinite(max) || max <= 0) return { state: 'unknown', percent: undefined };
  const percent = Math.min(100, Math.round((used / max) * 100));
  return { state: percent >= 100 ? 'exhausted' : percent >= 80 ? 'close' : 'ok', percent };
}

export function percentLabel(utilization: BudgetUtilization): string {
  return utilization.percent === undefined ? 'Not reported' : `${utilization.percent}%`;
}

/** "1,000 of 200,000" with "Not reported" for a side the runner did not send. */
export function usageOf(used: unknown, max: unknown, format: (value: unknown) => string = formatNumber): string {
  const show = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? format(value) : 'Not reported');
  return `${show(used)} of ${show(max)}`;
}

export function costOf(micros: unknown): string {
  return typeof micros === 'number' && Number.isFinite(micros) ? formatCostMicros(micros) : 'Not reported';
}

/** Age since start (or creation), as the legacy list reports it. */
export function agentAge(agent: Agent, now = Date.now()): string {
  const started = Date.parse(agent.startedAt ?? agent.createdAt ?? '');
  if (!Number.isFinite(started)) return 'Not reported';
  const minutes = Math.max(0, Math.round((now - started) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
}

export function agentTtl(agent: Agent, now = Date.now()): string {
  const expiresAt = Date.parse(agent.expiresAt ?? '');
  if (!Number.isFinite(expiresAt)) return 'Not reported';
  const remaining = expiresAt - now;
  return remaining <= 0 ? 'Expired' : `${Math.round(remaining / 60_000)} min`;
}

/**
 * The parent/child index. An agent whose parent is not in this list hangs off the root,
 * so a bounded or filtered page can never hide it from the hierarchy.
 */
export function agentTreeIndex(agents: readonly Agent[]): Map<string, Agent[]> {
  const known = new Set(agents.map((agent) => agent.agentId));
  const byParent = new Map<string, Agent[]>();
  for (const agent of agents) {
    const parent = agent.parentAgentId && known.has(agent.parentAgentId) && agent.parentAgentId !== agent.agentId ? agent.parentAgentId : 'root';
    const siblings = byParent.get(parent) ?? [];
    siblings.push(agent);
    byParent.set(parent, siblings);
  }
  return byParent;
}

/** The agents of a list response; a projection without the list reads as empty. */
export function agentsOf(data: unknown): Agent[] {
  const agents = data && typeof data === 'object' ? (data as { agents?: unknown }).agents : undefined;
  return Array.isArray(agents) ? agents.filter((agent): agent is Agent => Boolean(agent) && typeof (agent as Agent).agentId === 'string') : [];
}

/** The steering message bound: `boundedUtf8Text(65_536)` in the runner contract counts UTF-8 bytes. */
export const AGENT_MESSAGE_MAX_BYTES = 65_536;
/** `agent_cancel.reason` is at most 2,000 characters. */
export const AGENT_CANCEL_REASON_MAX = 2_000;

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
