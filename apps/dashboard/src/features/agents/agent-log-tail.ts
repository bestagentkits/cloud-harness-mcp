import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type BffEnvelope, bffPath } from '@/lib/bff-query';
import { apiClient } from '@/lib/api-client';
import { POLL_INTERVALS, pollingOptions } from '@/lib/query-client';
import type { AgentLogEvent, AgentLogPage } from './agent-model';

/**
 * The retained log of one agent, read forward. The runner's log cursor only moves forward
 * (`readLogs` in `apps/runner/src/agent-state-repository.ts`): the first read starts at the
 * oldest retained event, `nextCursor` continues after the last one, and `hasMore` says
 * newer events are already waiting. Each refetch reads only what follows the tail, so the
 * Follow poll and "Load newer" never re-download what the page already shows.
 */
export type AgentLogTail = {
  events: AgentLogEvent[];
  nextCursor: string | undefined;
  hasMore: boolean;
  /** The retention cap dropped events before the first one shown. */
  truncatedBefore: boolean;
  /** This page dropped its own oldest lines to stay bounded. */
  trimmed: boolean;
};

/** Lines the page keeps in memory; older ones fall off the top while following. */
export const AGENT_LOG_MAX_EVENTS = 1_000;

/** Appends one page to the tail: de-duplicated by cursor, bounded, newest kept. */
export function mergeLogPage(previous: AgentLogTail | undefined, page: AgentLogPage | undefined, max = AGENT_LOG_MAX_EVENTS): AgentLogTail {
  const known = new Set((previous?.events ?? []).map((event) => event.cursor));
  const fresh = (Array.isArray(page?.events) ? page.events : []).filter((event) => event.cursor === undefined || !known.has(event.cursor));
  const all = [...(previous?.events ?? []), ...fresh];
  const events = all.length > max ? all.slice(all.length - max) : all;
  return {
    events,
    nextCursor: typeof page?.nextCursor === 'string' ? page.nextCursor : previous?.nextCursor,
    hasMore: page?.hasMore === true,
    // A gap appears when the runner discarded events the page had not read yet.
    truncatedBefore: (previous?.truncatedBefore ?? false) || page?.truncated === true,
    trimmed: (previous?.trimmed ?? false) || all.length > max
  };
}

export function agentLogKey(agentId: string, workspaceId: string | undefined) {
  return ['agent-log-tail', agentId, workspaceId ?? null] as const;
}

/**
 * The log tail query: the page's one log reader and its only poll owner. It polls at the
 * live interval only while `follow` is on and the agent can still produce events; a
 * terminal agent, Follow off, a hidden tab or leaving the page stops it.
 */
export function useAgentLogTail(agentId: string, workspaceId: string | undefined, { poll }: { poll: boolean }) {
  const queryClient = useQueryClient();
  const key = agentLogKey(agentId, workspaceId);
  return useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const previous = queryClient.getQueryData<AgentLogTail>(key);
      const query = { ...(workspaceId ? { workspaceId } : {}), ...(previous?.nextCursor ? { cursor: previous.nextCursor } : {}) };
      const body = await apiClient.get<BffEnvelope<AgentLogPage>>(bffPath('agents', agentId, 'logs'), { query, signal });
      return mergeLogPage(previous, body.data);
    },
    ...(poll ? pollingOptions(POLL_INTERVALS.live) : { refetchInterval: false as const })
  });
}
