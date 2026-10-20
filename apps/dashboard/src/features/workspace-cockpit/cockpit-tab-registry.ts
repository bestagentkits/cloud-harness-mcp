import { type ComponentType, lazy, type LazyExoticComponent } from 'react';
import type { WorkspaceTab } from '@/app/page-registry';
import type { Workspace } from '@/features/workspaces/workspace-model';

/** Search params the cockpit tabs share (validated by the `$tab` route). */
export type CockpitSearch = { path?: string | undefined; file?: string | undefined; staged?: true | undefined; task?: string | undefined };

/** What every cockpit tab receives. The workspace record is the shell's read, already loaded. */
export type CockpitTabProps = {
  workspaceId: string;
  workspace: Workspace;
  search: CockpitSearch;
  onSearch: (next: CockpitSearch) => void;
};

type TabModule = { default: ComponentType<CockpitTabProps> };

export type CockpitTabEntry = {
  id: WorkspaceTab;
  label: string;
  /** Backed by executor or filesystem operations: only meaningful while the workspace is ACTIVE. */
  live: boolean;
  /** Loads the tab's chunk; also called on hover/focus of its link so the click renders at once. */
  load: () => Promise<TabModule>;
  component: LazyExoticComponent<ComponentType<CockpitTabProps>>;
};

function tab(id: WorkspaceTab, label: string, live: boolean, load: () => Promise<TabModule>): CockpitTabEntry {
  return { id, label, live, load, component: lazy(load) };
}

/** A tab whose content has not moved from the classic Dashboard yet. */
const pending = () => import('./tabs/pending-tab');

/**
 * The cockpit's tabs, in display order. Each tab is its own lazy chunk under its feature
 * folder; moving a tab to React is one `load` line here. The record is keyed by
 * `WorkspaceTab`, so a tab id added to `WORKSPACE_TABS` without an entry fails typecheck.
 */
export const COCKPIT_TABS: Record<WorkspaceTab, CockpitTabEntry> = {
  summary: tab('summary', 'Summary', false, () => import('./tabs/summary-tab')),
  agents: tab('agents', 'Agents', false, () => import('./tabs/agents-tab')),
  runtime: tab('runtime', 'Runtime', true, () => import('./tabs/runtime-tab')),
  terminal: tab('terminal', 'Terminal', true, pending),
  files: tab('files', 'Files', true, pending),
  git: tab('git', 'Git', true, pending),
  automation: tab('automation', 'Automation', true, pending),
  deploy: tab('deploy', 'Deploy', true, pending),
  artifacts: tab('artifacts', 'Artifacts', false, pending),
  activity: tab('activity', 'Activity', false, () => import('./tabs/activity-tab'))
};
