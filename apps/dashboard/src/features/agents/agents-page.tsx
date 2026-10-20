import { useQuery } from '@tanstack/react-query';
import { SearchXIcon, UsersIcon } from 'lucide-react';
import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';
import { FilterBar, SelectFilter } from '@/components/data/filter-bar';
import { Section } from '@/components/data/section';
import { TruncationNotice } from '@/components/data/truncation-notice';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { type BffEnvelope, bffQuery } from '@/lib/bff-query';
import { AgentHierarchy } from './agent-hierarchy';
import { AGENT_STATUSES, agentListQuery, agentsOf, agentStatusLabel, type AgentFilters } from './agent-model';
import { AgentsTable } from './agents-table';
import { IdFilter } from './id-filter';

export type AgentsSearch = AgentFilters;

/** Profile ids are short slugs; the route bounds the param to the same length. */
export const PROFILE_FILTER_MAX = 120;

const ATTENTION_OPTIONS = [{ value: 'needs-attention', label: 'Needs attention' }, { value: 'clear', label: 'Clear' }] as const;

/**
 * The Agents page: the parent/child hierarchy and the flat table over one `/agents` read.
 * Every filter is a URL search param and is sent to the BFF exactly as the classic page did
 * (the runner filters workspace, parent and status; the BFF derives profile and attention),
 * so a shared URL and the rows it shows can never disagree. The unfiltered read is the
 * registry read the route warms. Without a workspace the BFF fans out across workspaces, so
 * the page makes that one request per filter change and never polls.
 */
export function AgentsPage({ search, onSearch }: { search: AgentsSearch; onSearch: (next: AgentsSearch) => void }) {
  const read = useQuery(bffQuery<{ agents?: unknown }>('/agents', agentListQuery(search)));
  const active = Object.keys(agentListQuery(search)).length > 0;
  return (
    <div className="grid gap-(--stack-gap)">
      <p className="text-sm text-muted-foreground">
        Every agent runs as your identity in an isolated executor with its own TTL, token, output and cost budgets. Child agents appear under the agent that spawned them.
      </p>
      <FilterBar active={active} onClear={() => onSearch({})} label="Agent filters">
        <SelectFilter label="Status" allLabel="All statuses" value={search.status} options={AGENT_STATUSES.map((value) => ({ value, label: agentStatusLabel(value) }))} onChange={(status) => onSearch({ ...search, status })} />
        <SelectFilter label="Attention" allLabel="Any attention state" value={search.attention} options={ATTENTION_OPTIONS} onChange={(attention) => onSearch({ ...search, attention })} />
        <IdFilter label="Workspace" placeholder="ws_…" maxLength={83} pattern={RESOURCE_ID_PATTERNS.workspaceId} invalidMessage="A workspace id looks like ws_ followed by 20 to 80 letters, digits, - or _." value={search.workspaceId} onChange={(workspaceId) => onSearch({ ...search, workspaceId })} />
        <IdFilter label="Parent agent" placeholder="agent_…" maxLength={86} pattern={RESOURCE_ID_PATTERNS.agentId} invalidMessage="An agent id looks like agent_ followed by 20 to 80 letters, digits, - or _." value={search.parentAgentId} onChange={(parentAgentId) => onSearch({ ...search, parentAgentId })} />
        <IdFilter label="Profile" placeholder="coding-fast" maxLength={PROFILE_FILTER_MAX} value={search.profileId} onChange={(profileId) => onSearch({ ...search, profileId })} />
      </FilterBar>
      <AsyncStatus query={read} label="agents">
        {(body) => {
          const envelope = body as BffEnvelope<{ agents?: unknown }>;
          const agents = agentsOf(envelope.data);
          const truncated = envelope.truncated === true;
          const empty = active
            ? <EmptyState icon={SearchXIcon} title={truncated ? 'No agents match these filters in the returned window' : 'No agents match these filters'} action={<Button variant="outline" size="sm" onClick={() => onSearch({})}>Clear filters</Button>} />
            : <EmptyState icon={UsersIcon} title={truncated ? 'No agents in the returned window' : 'No agents yet'} description="An agent appears here when an MCP client spawns one in a workspace." />;
          return (
            <div className="grid gap-(--stack-gap) animate-in fade-in-0 duration-(--motion-base)">
              <TruncationNotice truncated={truncated} what="agents" />
              {agents.length === 0 ? empty : (
                <>
                  <Section title="Hierarchy" id="agent-hierarchy" description="Parents with the agents they spawned nested beneath them.">
                    <AgentHierarchy agents={agents} />
                  </Section>
                  <Section title="All agents" id="agent-table" description="One row per agent, with its parent named.">
                    <AgentsTable agents={agents} caption={`${agents.length} agents`} empty={empty} />
                  </Section>
                </>
              )}
            </div>
          );
        }}
      </AsyncStatus>
    </div>
  );
}
