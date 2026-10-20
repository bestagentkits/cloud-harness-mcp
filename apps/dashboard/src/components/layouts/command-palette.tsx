import { useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { DASHBOARD_PAGES, groupLabel } from '@/app/page-registry';
import { Combobox, type ComboboxItem } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { pageReadQuery } from '@/lib/page-read';
import type { ThemePreference } from '@/lib/preferences';
import { chooseTheme } from '@/lib/theme-preference';

type PaletteItem = ComboboxItem & { run: () => void; section: 'Pages' | 'Workspaces' | 'Actions' };

type WorkspaceList = { data?: { workspaces?: Array<{ workspaceId?: unknown; repositoryUrl?: unknown; status?: unknown }> } };

/** Workspace ids only; repository URLs are hints for matching and display, never stored. */
function workspaceItems(body: unknown, go: (to: string) => void): PaletteItem[] {
  const list = (body as WorkspaceList | undefined)?.data?.workspaces;
  if (!Array.isArray(list)) return [];
  return list.flatMap((workspace) => {
    if (typeof workspace.workspaceId !== 'string') return [];
    const id = workspace.workspaceId;
    const hint = typeof workspace.status === 'string' ? workspace.status : undefined;
    const repository = typeof workspace.repositoryUrl === 'string' ? workspace.repositoryUrl : '';
    return [{ value: `ws:${id}`, label: id, hint, keywords: `workspace ${repository}`, section: 'Workspaces' as const, run: () => go(`/workspaces/${id}`) }];
  });
}

/**
 * Command palette (parity matrix D11): pages, workspaces and a few shell actions in one
 * filtered list. Loaded lazily the first time it opens; the workspace list comes from the
 * same cached query the Workspaces page uses, so reopening it is instant (`staleTime`).
 */
export default function CommandPalette({ open, onOpenChange, onToggleSidebar }: { open: boolean; onOpenChange: (open: boolean) => void; onToggleSidebar: () => void }) {
  const router = useRouter();
  // Set when a command navigated, so closing focuses the new page heading, not the trigger.
  const [navigated, setNavigated] = useState(false);
  const workspaces = useQuery({ ...pageReadQuery('workspaces', {}), enabled: open });
  const items = useMemo<PaletteItem[]>(() => {
    const go = (to: string) => { setNavigated(true); onOpenChange(false); void router.navigate({ to }); };
    const setTheme = (theme: ThemePreference) => {
      onOpenChange(false);
      void chooseTheme(theme);
    };
    const pages = DASHBOARD_PAGES.filter((page) => page.palette).map<PaletteItem>((page) => ({
      value: `page:${page.id}`, label: page.title, hint: groupLabel(page.group), keywords: page.paletteHint, section: 'Pages', run: () => go(page.path)
    }));
    const actions: PaletteItem[] = [
      { value: 'action:sidebar', label: 'Toggle sidebar', hint: '[', section: 'Actions', run: () => { onOpenChange(false); onToggleSidebar(); } },
      { value: 'action:theme-light', label: 'Use light theme', section: 'Actions', run: () => setTheme('light') },
      { value: 'action:theme-dark', label: 'Use dark theme', section: 'Actions', run: () => setTheme('dark') },
      { value: 'action:theme-system', label: 'Use system theme', section: 'Actions', run: () => setTheme('system') }
    ];
    return [...pages, ...workspaceItems(workspaces.data, go), ...actions];
  }, [onOpenChange, onToggleSidebar, router, workspaces.data]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[12vh] translate-y-0 gap-2 p-3 sm:max-w-xl"
        showCloseButton={false}
        // Navigation moves focus to the new page heading; do not pull it back to the trigger.
        onCloseAutoFocus={(event) => {
          if (!navigated) return;
          setNavigated(false);
          event.preventDefault();
          (document.querySelector<HTMLElement>('main h1') ?? document.getElementById('main-content'))?.focus({ preventScroll: true });
        }}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">Type to filter pages, workspaces and actions. Use the arrow keys and Enter to choose.</DialogDescription>
        <Combobox
          items={items}
          label="Search pages, workspaces and actions"
          placeholder="Search pages, workspaces and actions…"
          onSelect={(item) => item.run()}
          onEscape={() => onOpenChange(false)}
          renderItem={(item) => (
            <>
              <span className="flex min-w-0 items-center gap-2">
                <span className="w-20 shrink-0 text-[0.6875rem] text-muted-foreground uppercase">{item.section}</span>
                <span className="truncate">{item.label}</span>
              </span>
              {item.hint ? <span className="shrink-0 text-xs text-muted-foreground">{item.hint}</span> : null}
            </>
          )}
        />
        {workspaces.isPending && open ? <p className="px-2 text-xs text-muted-foreground" role="status">Loading workspaces…</p> : null}
        {workspaces.isError ? <p className="px-2 text-xs text-muted-foreground" role="status">Workspaces could not be loaded; pages and actions still work.</p> : null}
      </DialogContent>
    </Dialog>
  );
}
