import { createFileRoute } from '@tanstack/react-router';
import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';
import { AGENT_ATTENTION, AGENT_STATUSES, type AgentAttention, agentListQuery } from '@/features/agents/agent-model';
import { AgentsPage, PROFILE_FILTER_MAX } from '@/features/agents/agents-page';
import { bffQuery } from '@/lib/bff-query';
import { compact, exact, flag, matching, oneOf, text } from '@/lib/search-params';

/** `needs-attention` / `clear` as the BFF filters them; an older boolean link means "needs attention". */
function attention(raw: Record<string, unknown>): AgentAttention | undefined {
  return oneOf(raw, 'attention', AGENT_ATTENTION) ?? (flag(raw, 'attention') ? 'needs-attention' : undefined);
}

export const Route = createFileRoute('/agents/')({
  staticData: { pageId: 'agents' },
  validateSearch: (raw: Record<string, unknown>) => exact({
    status: oneOf(raw, 'status', AGENT_STATUSES),
    workspaceId: matching(raw, 'workspaceId', RESOURCE_ID_PATTERNS.workspaceId),
    profileId: text(raw, 'profileId', PROFILE_FILTER_MAX),
    parentAgentId: matching(raw, 'parentAgentId', RESOURCE_ID_PATTERNS.agentId),
    attention: attention(raw)
  }),
  loaderDeps: ({ search }) => search,
  // Preload warms the filtered list the page reads (`agentListQuery`), not the unfiltered fan-out.
  loader: ({ context, deps, preload }) => {
    if (preload) void context.queryClient.prefetchQuery(bffQuery<{ agents?: unknown }>('/agents', agentListQuery(deps)));
  },
  component: AgentsRoute
});

function AgentsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <AgentsPage search={search} onSearch={(next) => { void navigate({ search: compact(next), replace: true }); }} />;
}
