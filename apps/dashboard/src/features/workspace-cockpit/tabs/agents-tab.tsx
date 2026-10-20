import { useQuery } from '@tanstack/react-query';
import { BotIcon } from 'lucide-react';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Section } from '@/components/data/section';
import { TruncationNotice } from '@/components/data/truncation-notice';
import { agentsOf } from '@/features/agents/agent-model';
import { AgentsTable } from '@/features/agents/agents-table';
import { bffPath, bffQuery } from '@/lib/bff-query';
import type { CockpitTabProps } from '../cockpit-tab-registry';

/** The workspace's agents: the same table as the Agents page, scoped by the workspace route. */
export default function AgentsTab({ workspaceId }: CockpitTabProps) {
  const read = useQuery(bffQuery<{ agents?: unknown[] }>(`${bffPath('workspaces', workspaceId)}/agents`, {}));
  return (
    <Section title="Agents" description="Agents spawned in this workspace. Open one for its log, usage, follow-up and cancel.">
      <AsyncStatus query={read} label="agents">
        {(body) => {
          const agents = agentsOf(body.data);
          return (
            <div className="grid gap-3">
              <TruncationNotice truncated={body.truncated} what="agents" />
              <AgentsTable
                agents={agents}
                caption={`${agents.length} agent(s) in this workspace`}
                empty={<EmptyState icon={BotIcon} title={body.truncated ? 'No agents in this page of results' : 'No agents in this workspace yet'} description="Agents started from an MCP client in this workspace appear here." />}
              />
            </div>
          );
        }}
      </AsyncStatus>
    </Section>
  );
}
