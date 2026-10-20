import { useRouterState } from '@tanstack/react-router';
import { CommandIcon, LogOutIcon, MenuIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ClassicDashboardLink } from '@/components/feedback/classic-dashboard-link';
import { NavProgress } from '@/components/feedback/nav-progress';
import { DisplayNameChip } from '@/components/layouts/display-name-chip';
import { DisplayPreferencesDialog } from '@/components/layouts/display-preferences-dialog';
import { PageHeader } from '@/components/layouts/page-header';
import { SessionEndedBanner } from '@/components/layouts/session-ended-banner';
import { SidebarNav } from '@/components/layouts/sidebar-nav';
import { ThemeToggle } from '@/components/layouts/theme-toggle';
import { WorkspaceFilter } from '@/components/layouts/workspace-filter';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/components/ui/drawer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePreferences } from '@/lib/preferences';
import { cn } from '@/lib/utils';
import { documentTitle, PRODUCT_NAME } from './page-registry';
import { useCurrentPage } from './route-identity';
import { useGlobalShortcuts } from './use-global-shortcuts';

const CommandPalette = lazy(() => import('@/components/layouts/command-palette'));

/**
 * Persistent frame: skip link, collapsible sidebar (a drawer on small screens), top bar,
 * page header, routed content and footer. Every piece of page identity — `aria-current`,
 * breadcrumb, `<h1>`, primary action, `document.title` and the content frame's
 * `data-page-id` — comes from one `useCurrentPage()` read of the committed route match.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const current = useCurrentPage();
  const { page, navId, detail } = current;
  const [preferences, updatePreferences] = usePreferences();
  const collapsed = preferences.sidebar === 'collapsed';
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteLoaded, setPaletteLoaded] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pathname = useRouterState({ select: (state) => state.matches[state.matches.length - 1]?.pathname ?? '' });

  useLayoutEffect(() => { document.title = documentTitle(page, detail); }, [page, detail]);

  // Move focus to the new page's heading after an in-app navigation (not on first load and
  // not for search-param-only changes such as typing in a filter).
  const previousPath = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previous = previousPath.current;
    previousPath.current = pathname;
    if (previous === undefined || previous === pathname) return;
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.closest('[role="dialog"]')) return;
    (headingRef.current ?? document.getElementById('main-content'))?.focus({ preventScroll: true });
  }, [pathname]);

  const toggleSidebar = useCallback(() => updatePreferences({ sidebar: collapsed ? 'expanded' : 'collapsed' }), [collapsed, updatePreferences]);
  const openPalette = useCallback((open: boolean) => { if (open) setPaletteLoaded(true); setPaletteOpen(open); }, []);
  const shortcuts = useMemo(() => ({
    togglePalette: () => { setPaletteLoaded(true); setPaletteOpen((open) => !open); },
    toggleSidebar,
    focusSearch: () => searchRef.current?.focus()
  }), [toggleSidebar]);
  useGlobalShortcuts(shortcuts);

  return (
    <div className="flex min-h-dvh bg-background">
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <aside
        aria-label="Sidebar"
        data-collapsed={collapsed || undefined}
        className={cn('sticky top-0 hidden h-dvh shrink-0 border-r bg-surface transition-[width] duration-(--motion-base) md:flex md:flex-col', collapsed ? 'w-14' : 'w-60')}
      >
        <div className={cn('flex h-14 items-center gap-2 border-b px-4', collapsed && 'justify-center px-0')}>
          <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">CH</span>
          <span className={cn('text-sm font-semibold tracking-tight', collapsed && 'sr-only')}>{PRODUCT_NAME}</span>
        </div>
        <SidebarNav currentId={navId} collapsed={collapsed} />
        <div className={cn('flex items-center border-t p-2', collapsed ? 'justify-center' : 'justify-end')}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-keyshortcuts="[" aria-expanded={!collapsed} onClick={toggleSidebar}>
                {collapsed ? <PanelLeftOpenIcon aria-hidden="true" /> : <PanelLeftCloseIcon aria-hidden="true" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{collapsed ? 'Expand sidebar' : 'Collapse sidebar'} ([)</TooltipContent>
          </Tooltip>
        </div>
      </aside>
      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
        <DrawerContent aria-describedby="mobile-nav-description" className="md:hidden">
          <div className="flex h-14 items-center gap-2 border-b px-4">
            <DrawerTitle className="text-sm font-semibold">{PRODUCT_NAME}</DrawerTitle>
            <DrawerDescription id="mobile-nav-description" className="sr-only">Dashboard navigation</DrawerDescription>
          </div>
          <SidebarNav currentId={navId} onNavigate={() => setDrawerOpen(false)} />
        </DrawerContent>
      </Drawer>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-2 border-b bg-background/95 px-gutter backdrop-blur">
          <div className="flex min-w-0 items-center gap-2">
            <Button variant="ghost" size="icon" className="size-8 md:hidden" aria-label="Open navigation" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}>
              <MenuIcon aria-hidden="true" />
            </Button>
            <span className="truncate text-sm font-semibold md:hidden">{PRODUCT_NAME}</span>
            <WorkspaceFilter inputRef={searchRef} />
          </div>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" className="gap-1.5 text-muted-foreground" aria-keyshortcuts="Control+K Meta+K" aria-haspopup="dialog" onClick={() => openPalette(true)}>
              <CommandIcon aria-hidden="true" />
              <span className="sr-only lg:not-sr-only">Search</span><span className="sr-only"> pages and commands</span>
              <kbd aria-hidden="true" className="hidden rounded border px-1 font-mono text-[0.625rem] lg:inline">Ctrl K</kbd>
            </Button>
            <ThemeToggle />
            <DisplayPreferencesDialog />
            <DisplayNameChip current={page?.id === 'profile'} />
          </div>
          <NavProgress />
        </header>
        <SessionEndedBanner />
        <main id="main-content" tabIndex={-1} className="flex-1 px-gutter py-6 outline-none">
          <div className="mx-auto grid max-w-6xl gap-(--stack-gap)" data-page-id={page?.id ?? 'not-found'} data-testid="page-frame">
            {page ? <PageHeader current={{ ...current, page }} headingRef={headingRef} /> : null}
            {children}
          </div>
        </main>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t px-gutter py-3 text-xs text-muted-foreground">
          <ClassicDashboardLink className="underline-offset-4 hover:text-foreground hover:underline">Use classic Dashboard</ClassicDashboardLink>
          <a href="/cdn-cgi/access/logout" className="inline-flex items-center gap-1 underline-offset-4 hover:text-foreground hover:underline">
            <LogOutIcon className="size-3.5" aria-hidden="true" />Sign out
          </a>
        </footer>
      </div>
      {paletteLoaded ? (
        <Suspense fallback={null}>
          <CommandPalette open={paletteOpen} onOpenChange={openPalette} onToggleSidebar={toggleSidebar} />
        </Suspense>
      ) : null}
    </div>
  );
}
