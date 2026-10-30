import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';

/**
 * The Activity Center projection (`buildActivityProjection` in
 * `apps/api/src/dashboard-response.ts`): one event grammar for live runtime rows
 * (`durable: false`, they disappear with their workspace) and retained audit rows
 * (`durable: true`). The server merges, labels and caps the timeline; the page only
 * filters it by category.
 */
export type ActivityEvent = {
  at?: string;
  category?: string;
  status?: string;
  actor?: string;
  summary?: string;
  href?: string;
  durable?: boolean;
};

export const ACTIVITY_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'agents', label: 'Agents' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'mcp', label: 'MCP' },
  { id: 'deployments', label: 'Deployments' },
  { id: 'audit', label: 'Audit' }
] as const;

export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number]['id'];
export const ACTIVITY_FILTER_IDS = ACTIVITY_FILTERS.map((filter) => filter.id) as readonly ActivityFilter[];

/** The server keeps at most this many events (`.slice(0, 200)` in the projection). */
export const ACTIVITY_EVENT_CAP = 200;

/** The events array from an untrusted envelope body; anything that is not a record is dropped. */
export function activityEvents(body: unknown): ActivityEvent[] {
  const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
  const events = data && typeof data === 'object' ? (data as { events?: unknown }).events : undefined;
  return Array.isArray(events) ? events.filter((event): event is ActivityEvent => Boolean(event) && typeof event === 'object') : [];
}

export function filterEvents(events: readonly ActivityEvent[], filter: ActivityFilter): ActivityEvent[] {
  return filter === 'all' ? [...events] : events.filter((event) => event.category === filter);
}

/** Events per category, for the counts on the filter links. */
export function countByCategory(events: readonly ActivityEvent[]): Record<ActivityFilter, number> {
  const counts = Object.fromEntries(ACTIVITY_FILTER_IDS.map((id) => [id, 0])) as Record<ActivityFilter, number>;
  counts.all = events.length;
  for (const event of events) {
    const category = event.category as ActivityFilter | undefined;
    if (category && category !== 'all' && category in counts) counts[category] += 1;
  }
  return counts;
}

/** An in-app destination for an event link, or nothing. */
export type ActivityLink =
  | { to: '/agents/$agentId'; params: { agentId: string } }
  | { to: '/workspaces/$workspaceId'; params: { workspaceId: string } };

const LINK_PATTERNS = [
  { pattern: /^\/dashboard\/agents\/([^/?#]+)$/, idPattern: RESOURCE_ID_PATTERNS.agentId, build: (agentId: string): ActivityLink => ({ to: '/agents/$agentId', params: { agentId } }) },
  { pattern: /^\/dashboard\/workspaces\/([^/?#]+)$/, idPattern: RESOURCE_ID_PATTERNS.workspaceId, build: (workspaceId: string): ActivityLink => ({ to: '/workspaces/$workspaceId', params: { workspaceId } }) }
] as const;

/**
 * Turns a projection `href` (`/dashboard/agents/agent_…`) into a typed in-app route. Only
 * the known prefixes with an id that matches its resource pattern are accepted; any other
 * value (another path, a scheme, a crafted id) yields no link, so the page never renders an
 * arbitrary href from the server.
 */
export function activityLink(href: unknown): ActivityLink | undefined {
  if (typeof href !== 'string' || href.length > 512) return undefined;
  for (const { pattern, idPattern, build } of LINK_PATTERNS) {
    const match = pattern.exec(href);
    if (!match?.[1]) continue;
    let id: string;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return undefined;
    }
    return idPattern.test(id) ? build(id) : undefined;
  }
  return undefined;
}

export { grantIsActionable, type PackagePlan, pendingGrantCount, pendingPlanCount, planIsActionable, type PrivilegeGrant } from '@/lib/approvals-summary';

/** A projection field as display text: a non-empty string or a number, else `fallback`. */
export function fieldText(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback;
}
