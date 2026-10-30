import { StatusBadge } from '@/components/data/status-badge';
import { type Agent, agentTreeIndex, budgetUtilization, costOf, percentLabel } from './agent-model';
import { AgentLink } from './agents-table';

/** Nesting deeper than this renders flat; a malformed parent chain cannot blow the layout. */
const MAX_DEPTH = 12;

/**
 * The parent/child hierarchy as nested lists, so a screen reader announces the nesting.
 * Children render inside their parent's item; an agent whose parent is not listed stays
 * visible at the root. Each agent renders once, even if the data contains a cycle.
 */
export function AgentHierarchy({ agents }: { agents: readonly Agent[] }) {
  const byParent = agentTreeIndex(agents);
  const seen = new Set<string>();
  const render = (parentId: string, depth: number) => {
    const children = (byParent.get(parentId) ?? []).filter((agent) => {
      if (seen.has(agent.agentId)) return false;
      seen.add(agent.agentId);
      return true;
    });
    if (children.length === 0) return null;
    return (
      <ul className={depth === 0 ? 'grid gap-1.5' : 'mt-1.5 grid gap-1.5 border-l pl-4'}>
        {children.map((agent) => (
          <li key={agent.agentId}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-background px-3 py-2 transition-colors duration-(--motion-fast) hover:bg-accent/40">
              <AgentLink agent={agent} />
              <StatusBadge status={agent.status} />
              <span className="text-xs text-muted-foreground">{agent.profileId ?? 'No profile reported'}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{costOf(agent.usage?.costMicros)} · {percentLabel(budgetUtilization(agent.usage?.costMicros, agent.budget?.maxCostMicros))} of limit</span>
              {agent.outcomeUnknown === true ? <span className="text-xs font-medium">Outcome unknown</span> : null}
            </div>
            {depth + 1 < MAX_DEPTH ? render(agent.agentId, depth + 1) : null}
          </li>
        ))}
      </ul>
    );
  };
  return render('root', 0);
}
