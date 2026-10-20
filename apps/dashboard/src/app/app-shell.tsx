import { Link, useRouterState } from '@tanstack/react-router';
import { LayoutDashboardIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { DisplayPreferencesDialog } from '@/components/layouts/display-preferences-dialog';
import { ThemeToggle } from '@/components/layouts/theme-toggle';

type NavItem = { to: '/'; label: string; icon: typeof LayoutDashboardIcon };

/** Pages join this list as they migrate from the legacy Dashboard. */
const NAV_ITEMS: readonly NavItem[] = [{ to: '/', label: 'Overview', icon: LayoutDashboardIcon }];

/**
 * Persistent frame: skip link, sidebar navigation, top bar and the routed page. The
 * page title and active navigation item both derive from the current route match.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <div className="flex min-h-dvh bg-background">
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <aside className="hidden w-60 shrink-0 border-r bg-surface md:flex md:flex-col">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <span aria-hidden="true" className="grid size-6 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">CH</span>
          <span className="text-sm font-semibold tracking-tight">Cloud Harness</span>
        </div>
        <nav aria-label="Primary" className="flex-1 p-2">
          <ul className="grid gap-0.5">
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  className="flex h-9 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-accent hover:text-accent-foreground aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground"
                  activeOptions={{ exact: true }}
                >
                  <item.icon className="size-4" aria-hidden="true" />
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="border-t p-3 text-xs text-muted-foreground">
          <a className="underline-offset-4 hover:text-foreground hover:underline" href="/dashboard?ui=legacy">Use classic Dashboard</a>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-2 border-b bg-background/95 px-gutter backdrop-blur">
          <span className="text-sm font-semibold md:hidden">Cloud Harness</span>
          <span className="hidden text-sm text-muted-foreground md:block" data-testid="current-path">{pathname}</span>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <DisplayPreferencesDialog />
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="flex-1 px-gutter py-6 outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}
