import { useQuery } from '@tanstack/react-query';
import { bffQuery } from '@/lib/bff-query';
import { cn } from '@/lib/utils';
import { NavLink } from './nav-link';

/**
 * The running server version at the foot of the sidebar, linking to the Changelog. It shares
 * the `/server` read (and its cache entry) with the Overview. Labelled "Server version"
 * because production runs the pre-version-bump commit. Hidden while the rail is collapsed;
 * the Changelog nav entry stays reachable there.
 */
export function SidebarVersion({ collapsed = false, onNavigate, className }: { collapsed?: boolean; onNavigate?: () => void; className?: string }) {
  const query = useQuery(bffQuery<{ version?: unknown }>('/server'));
  const version = query.data?.data?.version;
  if (collapsed || typeof version !== 'string' || !version) return null;
  return (
    <NavLink
      to="/changelog"
      current={false}
      onClick={onNavigate}
      title="View the changelog"
      data-testid="sidebar-version"
      className={cn('inline-flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground tabular-nums hover:text-foreground', className)}
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success" />
      <span className="sr-only">Server version </span>
      <span className="truncate font-mono">v{version}</span>
      <span className="sr-only">, view the changelog</span>
    </NavLink>
  );
}
