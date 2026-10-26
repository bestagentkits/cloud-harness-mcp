import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/data/status-badge';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { type Agent, agentAge, budgetUtilization, costOf, percentLabel } from './agent-model';
import { BudgetMeter } from './budget-meter';

/**
 * A link to one agent's page. It carries the agent's workspace so the detail read is
 * workspace-scoped: the runner resolves an unscoped agent lookup to the principal's single
 * active workspace, which fails as soon as several are open.
 */
export function AgentLink({ agent, className, children }: { agent: Agent; className?: string; children?: ReactNode }) {
  return (
    <Link
      to="/agents/$agentId"
      params={{ agentId: agent.agentId }}
      search={agent.workspaceId ? { workspaceId: agent.workspaceId } : {}}
      className={className ?? 'font-mono text-xs font-medium break-all hover:underline'}
    >
      {children ?? agent.agentId}
    </Link>
  );
}

function usageCell(agent: Agent) {
  const utilization = budgetUtilization(agent.usage?.costMicros, agent.budget?.maxCostMicros);
  return (
    <div className="grid min-w-28 gap-1">
      <span className="text-xs tabular-nums">{costOf(agent.usage?.costMicros)} · {percentLabel(utilization)} of limit</span>
      <BudgetMeter utilization={utilization} label="Cost against the cost limit" />
    </div>
  );
}

const COLUMNS: DataTableColumn<Agent>[] = [
  {
    id: 'agent',
    header: 'Agent',
    cell: (agent) => (
      <div className="grid min-w-0 gap-0.5">
        <AgentLink agent={agent} />
        <span className="text-xs text-muted-foreground">{agent.profileId ?? 'No profile reported'}</span>
      </div>
    )
  },
  { id: 'status', header: 'Status', cell: (agent) => <StatusBadge status={agent.status} /> },
  { id: 'workspace', header: 'Workspace', className: 'hidden lg:table-cell', cell: (agent) => <span className="font-mono text-xs break-all">{agent.workspaceId ?? 'Not reported'}</span> },
  { id: 'parent', header: 'Parent', className: 'hidden xl:table-cell', cell: (agent) => <span className="font-mono text-xs break-all">{agent.parentAgentId ?? '—'}</span> },
  { id: 'age', header: 'Age', className: 'hidden md:table-cell whitespace-nowrap', cell: (agent) => agentAge(agent) },
  {
    id: 'tokens',
    header: 'Tokens',
    className: 'hidden md:table-cell whitespace-nowrap tabular-nums',
    cell: (agent) => `${agent.usage?.inputTokens ?? '—'} in · ${agent.usage?.outputTokens ?? '—'} out`
  },
  { id: 'budget', header: 'Cost and budget', cell: usageCell }
];

/**
 * The flat agent table: one row per agent with its status, scope, parent, age, tokens and
 * cost against its cost limit. The global Agents page and the workspace cockpit's Agents
 * tab both render it, so the two views never disagree on what an agent row shows.
 */
export function AgentsTable({ agents, caption, empty, loading }: { agents: readonly Agent[] | undefined; caption: string; empty?: ReactNode; loading?: boolean }) {
  return <DataTable caption={caption} columns={COLUMNS} rows={agents} rowKey={(agent) => agent.agentId} empty={empty} loading={loading ?? false} />;
}
