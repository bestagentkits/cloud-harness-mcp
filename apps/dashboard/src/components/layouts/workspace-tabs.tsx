import { WORKSPACE_TABS, type WorkspaceTab } from '@/app/page-registry';
import { NavLink } from './nav-link';

const LABELS: Record<WorkspaceTab, string> = {
  summary: 'Summary', agents: 'Agents', runtime: 'Runtime', terminal: 'Terminal', files: 'Files',
  git: 'Git', automation: 'Automation', deploy: 'Deploy', artifacts: 'Artifacts', activity: 'Activity'
};

/** Cockpit sections as links: each tab is its own URL (`/workspaces/:id/:tab`), so Back, reload and sharing work. */
export function WorkspaceTabs({ workspaceId, tab }: { workspaceId: string; tab: WorkspaceTab }) {
  return (
    <nav aria-label="Workspace sections" className="overflow-x-auto border-b">
      <ul className="flex gap-1">
        {WORKSPACE_TABS.map((value) => (
          <li key={value}>
            <NavLink
              to={value === 'summary' ? `/workspaces/${workspaceId}` : `/workspaces/${workspaceId}/${value}`}
              current={value === tab}
              data-tab={value}
              className="inline-flex h-9 items-center border-b-2 border-transparent px-3 text-sm text-muted-foreground hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:text-foreground"
            >
              {LABELS[value]}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
