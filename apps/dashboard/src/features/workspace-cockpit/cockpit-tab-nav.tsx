import { WORKSPACE_TABS, type WorkspaceTab } from '@/app/page-registry';
import { NavLink } from '@/components/layouts/nav-link';
import { COCKPIT_TABS } from './cockpit-tab-registry';

/** Cockpit sections as links: each tab is its own URL (`/workspaces/:id/:tab`), so Back, reload and sharing work. */
export function CockpitTabNav({ workspaceId, tab }: { workspaceId: string; tab: WorkspaceTab }) {
  return (
    <nav aria-label="Workspace sections" className="overflow-x-auto border-b">
      <ul className="flex gap-1">
        {WORKSPACE_TABS.map((value) => {
          const entry = COCKPIT_TABS[value];
          return (
            <li key={value}>
              <NavLink
                to={value === 'summary' ? `/workspaces/${workspaceId}` : `/workspaces/${workspaceId}/${value}`}
                current={value === tab}
                data-tab={value}
                onPointerEnter={() => { void entry.load(); }}
                onFocus={() => { void entry.load(); }}
                className="inline-flex h-9 items-center whitespace-nowrap border-b-2 border-transparent px-3 text-sm text-muted-foreground transition-colors duration-(--motion-fast) hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:text-foreground"
              >
                {entry.label}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
