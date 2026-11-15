import { cn } from '@/lib/utils';
import { NavLink } from './nav-link';

/**
 * The running server version the API writes into `<meta name="ch-server-version">` when it
 * serves the shell (`apps/api/src/dashboard-react-assets.ts`), the same injection the classic
 * shell uses, so showing it costs no BFF read. An unfilled placeholder (the Vite dev server)
 * or a missing tag reads as no version.
 */
export function serverVersionFrom(doc: Pick<Document, 'querySelector'> = document): string | undefined {
  const value = doc.querySelector<HTMLMetaElement>('meta[name="ch-server-version"]')?.content ?? '';
  return /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(value) ? value : undefined;
}

/**
 * The server version at the foot of the sidebar, linking to the Changelog. Labelled "Server
 * version" because production runs the pre-version-bump commit. Hidden while the rail is
 * collapsed; the Changelog nav entry stays reachable there.
 */
export function SidebarVersion({ collapsed = false, onNavigate, className }: { collapsed?: boolean; onNavigate?: () => void; className?: string }) {
  const version = serverVersionFrom();
  if (collapsed || !version) return null;
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
