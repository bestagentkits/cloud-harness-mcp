import { type ComponentType, lazy, type LazyExoticComponent } from 'react';
import type { WorkspaceTab } from '@/app/page-registry';
import type { Workspace } from '@/features/workspaces/workspace-model';
import { exact, flag, matching, text } from '@/lib/search-params';
import { RUNTIME_ID_PATTERN } from './runtime-model';

type RawSearch = Record<string, unknown>;

/**
 * Each tab's own search params. A validator names every key it owns (`exact`), so an invalid
 * raw value never survives the router's merge. A new tab with deep-link params adds one line
 * here and passes it to its entry below; the `$tab` route and `CockpitSearch` follow.
 */
const TAB_SEARCH = {
  /** Files: `path` (directory) and `file` (open file). */
  files: (raw: RawSearch) => exact({ path: text(raw, 'path', 1_024), file: text(raw, 'file', 1_024) }),
  /** Git: `staged` (show the staged diff). */
  git: (raw: RawSearch) => exact({ staged: flag(raw, 'staged') }),
  /** Runtime: `task` (the task whose output is open). */
  runtime: (raw: RawSearch) => exact({ task: matching(raw, 'task', RUNTIME_ID_PATTERN) })
} satisfies Partial<Record<WorkspaceTab, (raw: RawSearch) => Record<string, unknown>>>;

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;

/** Search params of every cockpit tab, as the `$tab` route validates them. */
export type CockpitSearch = UnionToIntersection<ReturnType<(typeof TAB_SEARCH)[keyof typeof TAB_SEARCH]>>;

/** The `$tab` route's validator: every tab's declared params, merged. */
export function validateCockpitSearch(raw: RawSearch): CockpitSearch {
  return Object.assign({}, ...Object.values(COCKPIT_TABS).map((entry) => entry.validateSearch?.(raw) ?? {})) as CockpitSearch;
}

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
  /** The tab's own deep-link params, if any. */
  validateSearch?: ((raw: RawSearch) => Record<string, unknown>) | undefined;
};

function tab(id: WorkspaceTab, label: string, live: boolean, load: () => Promise<TabModule>, validateSearch?: (raw: RawSearch) => Record<string, unknown>): CockpitTabEntry {
  return { id, label, live, load, component: lazy(load), validateSearch };
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
  runtime: tab('runtime', 'Runtime', true, () => import('./tabs/runtime-tab'), TAB_SEARCH.runtime),
  terminal: tab('terminal', 'Terminal', true, pending),
  files: tab('files', 'Files', true, pending, TAB_SEARCH.files),
  git: tab('git', 'Git', true, pending, TAB_SEARCH.git),
  automation: tab('automation', 'Automation', true, pending),
  deploy: tab('deploy', 'Deploy', true, pending),
  artifacts: tab('artifacts', 'Artifacts', false, pending),
  activity: tab('activity', 'Activity', false, () => import('./tabs/activity-tab'))
};
