import { useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { DASHBOARD_PAGES, groupLabel, WORKSPACE_TABS } from '@/app/page-registry';
import { useCurrentPage } from '@/app/route-identity';
import { Combobox, type ComboboxItem } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { registeredPaletteEntries, usePageActionsVersion } from '@/lib/page-actions';
import { pageReadQuery } from '@/lib/page-read';
import { registeredPrimaryAction } from '@/lib/page-primary-action';
import { readRecentWorkspaces } from '@/lib/recent-workspaces';
import type { ThemePreference } from '@/lib/preferences';
import { chooseTheme } from '@/lib/theme-preference';

type PaletteItem = ComboboxItem & { run: () => void; section: 'Recent' | 'Pages' | 'Workspaces' | 'Actions' };

const TAB_LABELS: Record<(typeof WORKSPACE_TABS)[number], string> = {
  summary: 'Summary', agents: 'Agents', runtime: 'Runtime', terminal: 'Terminal', files: 'Files', git: 'Git', automation: 'Automation', deploy: 'Deploy', artifacts: 'Artifacts', activity: 'Activity'
};

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
 * Command palette (parity matrix D11): recent workspaces, pages, workspaces and actions in
 * one filtered list. Actions are the shell's own, the current page's primary action, the
 * open workspace's tabs, the assistant, and any palette entry a page registered through
 * `usePageActions`. Loaded lazily the first time it opens; the workspace list comes from the
 * same cached query the Workspaces page uses, so reopening it is instant (`staleTime`).
 */
export default function CommandPalette({ open, onOpenChange, onToggleSidebar, onOpenAssistant }: {
  open: boolean; onOpenChange: (open: boolean) => void; onToggleSidebar: () => void; onOpenAssistant: () => void;
}) {
  const router = useRouter();
  const { page, detail } = useCurrentPage();
  const registryVersion = usePageActionsVersion();
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
    const close = (run: () => void) => () => { onOpenChange(false); run(); };
    const recent = (open ? readRecentWorkspaces() : []).map<PaletteItem>((id) => ({
      value: `recent:${id}`, label: id, hint: 'Recent', keywords: 'workspace recent', section: 'Recent', run: () => go(`/workspaces/${id}`)
    }));
    const primary = page?.primaryAction ? registeredPrimaryAction(page.id) : undefined;
    const pageActions: PaletteItem[] = [
      ...(page?.primaryAction && primary && !primary.disabledReason
        ? [{ value: `action:primary:${page.id}`, label: page.primaryAction, hint: page.title, section: 'Actions' as const, run: close(primary.onSelect) }]
        : []),
      ...(page?.id === 'workspace' && detail
        ? WORKSPACE_TABS.map<PaletteItem>((tab) => ({
          value: `action:tab:${tab}`, label: `Open ${TAB_LABELS[tab]} tab`, hint: 'Workspace', keywords: 'workspace tab cockpit', section: 'Actions',
          run: () => go(tab === 'summary' ? `/workspaces/${detail}` : `/workspaces/${detail}/${tab}`)
        }))
        : []),
      ...registeredPaletteEntries().map<PaletteItem>((entry) => ({ value: `action:page:${entry.id}`, label: entry.label, hint: entry.hint, section: 'Actions', run: close(entry.run) }))
    ];
    const actions: PaletteItem[] = [
      ...pageActions,
      { value: 'action:assistant', label: 'Ask the assistant', hint: 'Dewee', keywords: 'chat ai agent help', section: 'Actions', run: close(onOpenAssistant) },
      { value: 'action:sidebar', label: 'Toggle sidebar', hint: '[', section: 'Actions', run: () => { onOpenChange(false); onToggleSidebar(); } },
      { value: 'action:theme-light', label: 'Use light theme', section: 'Actions', run: () => setTheme('light') },
      { value: 'action:theme-dark', label: 'Use dark theme', section: 'Actions', run: () => setTheme('dark') },
      { value: 'action:theme-system', label: 'Use system theme', section: 'Actions', run: () => setTheme('system') }
    ];
    return [...recent, ...pages, ...workspaceItems(workspaces.data, go), ...actions];
    // `registryVersion` re-reads the page registrations when a page registers or leaves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onOpenChange, onToggleSidebar, onOpenAssistant, router, workspaces.data, page, detail, open, registryVersion]);

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
