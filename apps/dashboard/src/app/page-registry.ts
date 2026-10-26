import {
  ActivityIcon,
  BookOpenIcon,
  BoxIcon,
  CpuIcon,
  FolderKanbanIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  PackageIcon,
  PlugIcon,
  ScrollTextIcon,
  ServerIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SquareTerminalIcon,
  UserIcon,
  UsersIcon,
  VaultIcon,
  WaypointsIcon
} from 'lucide-react';

/**
 * The Dashboard page registry: the one source of page identity for the React app. The
 * sidebar, breadcrumb, `<h1>`, `document.title`, primary page action, command palette and
 * the routed page frame all read a page from here by the `pageId` its route declares in
 * `staticData`, so they cannot disagree about which page is showing.
 *
 * Ids, labels, groups and titles mirror the legacy registry
 * (`apps/api/dashboard/dashboard-pages.js`); `page-registry.test.ts` keeps the two in step
 * and checks every `path` against the route tree. Detail pages (a single workspace,
 * agent, project...) are pages of their own with a `navParent`, so their title and
 * breadcrumb are as exact as the list page's.
 */

export const PAGE_GROUPS = [
  { id: 'home', label: 'Home' },
  { id: 'operate', label: 'Operate' },
  { id: 'configure', label: 'Configure' },
  { id: 'data', label: 'Data' },
  { id: 'admin', label: 'Admin' },
  { id: 'account', label: 'Account' }
] as const;

export type PageGroupId = (typeof PAGE_GROUPS)[number]['id'];

export const PAGE_IDS = [
  'overview', 'workspaces', 'workspace', 'agents', 'agent', 'activity', 'approvals', 'packages', 'terminals', 'audit',
  'projects', 'project', 'secrets', 'models', 'skills', 'integrations', 'github', 'mcp-servers', 'mcp-server',
  'knowledge', 'knowledge-entry', 'artifacts', 'api-keys', 'settings', 'profile'
] as const;

export type PageId = (typeof PAGE_IDS)[number];

/**
 * Classic Dashboard pages that have no React page yet. They stay on the legacy shell until
 * they are ported; `docs/dashboard-parity-matrix.md` tracks them. Porting one means adding
 * it to `PAGE_IDS` and removing it here, which `page-registry.test.ts` enforces.
 */
export const LEGACY_ONLY_PAGE_IDS: readonly string[] = ['inbox', 'traces', 'automations', 'agent-policies'];

/** A BFF read under `/dashboard/api/v1`; `:name` segments are filled from route params. */
export type PageRead = { path: string; query?: Record<string, string | number> };

export type DashboardPage = {
  id: PageId;
  /** Route path relative to `/dashboard`, in TanStack Router syntax (`$param`). */
  path: string;
  label: string;
  group: PageGroupId;
  title: string;
  help: string;
  icon: LucideIcon;
  /** Shown in the sidebar. Pages without it stay reachable by URL, palette or a parent page. */
  nav: boolean;
  /** The page whose sidebar entry stays current while this page is open. */
  navParent?: PageId;
  /** Listed as a command palette page command (detail pages need an id, so they are not). */
  palette: boolean;
  paletteHint?: string;
  /** The page's main call to action, rendered in the page header. */
  primaryAction?: string;
  /** The page's main BFF read; the route body (P2 placeholder, P3/P4 content) starts from it. */
  read?: PageRead;
  /** Route param that names the resource on a detail page; shown in the breadcrumb and title. */
  detailParam?: string;
};

export const DASHBOARD_PAGES: readonly DashboardPage[] = [
  {
    id: 'overview', path: '/', label: 'Overview', group: 'home', title: 'Overview', icon: LayoutDashboardIcon, nav: true, palette: true,
    help: 'Attention, running work, usage, and workspace expiry for your signed-in identity.', paletteHint: 'Page',
    read: { path: '/overview' }
  },
  {
    id: 'workspaces', path: '/workspaces', label: 'Workspaces', group: 'operate', title: 'Workspaces', icon: BoxIcon, nav: true, palette: true,
    help: 'TTL-limited coding environments available to your signed-in identity.', paletteHint: 'Page',
    primaryAction: 'New workspace', read: { path: '/workspaces' }
  },
  {
    id: 'workspace', path: '/workspaces/$workspaceId', label: 'Workspace', group: 'operate', title: 'Workspace', icon: BoxIcon, nav: false, navParent: 'workspaces', palette: false,
    help: 'One workspace: summary, agents, runtime, files, git, automation, deploys, artifacts and activity.',
    read: { path: '/workspaces/:workspaceId' }, detailParam: 'workspaceId'
  },
  {
    id: 'agents', path: '/agents', label: 'Agents', group: 'operate', title: 'Agents', icon: UsersIcon, nav: true, palette: true,
    help: 'Coding agents across your workspaces: hierarchy, status, usage, budget and control.', paletteHint: 'Coding agents, hierarchy, usage, and control',
    read: { path: '/agents' }
  },
  {
    id: 'agent', path: '/agents/$agentId', label: 'Agent', group: 'operate', title: 'Agent', icon: UsersIcon, nav: false, navParent: 'agents', palette: false,
    help: 'One coding agent: status, usage, budget, logs and control.',
    read: { path: '/agents/:agentId' }, detailParam: 'agentId'
  },
  {
    id: 'activity', path: '/activity', label: 'Activity', group: 'operate', title: 'Activity', icon: ActivityIcon, nav: true, palette: true,
    help: 'One operational timeline across agents, tasks, MCP, deployments, and retained audit events.', paletteHint: 'Operational timeline across agents, tasks, MCP, deployments, and audit',
    read: { path: '/activity' }
  },
  {
    id: 'approvals', path: '/approvals', label: 'Approvals', group: 'operate', title: 'Approvals', icon: ShieldCheckIcon, nav: true, palette: true,
    help: 'Pending privilege grants and package plans waiting for your decision.', paletteHint: 'Pending privilege grants and package plans awaiting a decision',
    read: { path: '/privilege-grants' }
  },
  {
    id: 'packages', path: '/packages', label: 'Packages', group: 'operate', title: 'Packages', icon: PackageIcon, nav: true, palette: true,
    help: 'Managed toolbox packages: installed releases, health, applies, and rollback history.', paletteHint: 'Managed toolbox packages, releases, and rollback',
    read: { path: '/packages' }
  },
  {
    id: 'terminals', path: '/terminals', label: 'Terminals', group: 'operate', title: 'Terminals', icon: SquareTerminalIcon, nav: false, navParent: 'workspaces', palette: true,
    help: 'Every live workspace terminal, with its size, age, and idle expiry.', paletteHint: 'Live workspace terminals and their idle expiry',
    read: { path: '/terminals' }
  },
  {
    id: 'audit', path: '/audit', label: 'Audit', group: 'operate', title: 'Audit', icon: ScrollTextIcon, nav: false, navParent: 'activity', palette: true,
    help: 'Retained redacted control-plane events.', paletteHint: 'Retained control-plane events',
    read: { path: '/audit', query: { limit: 50 } }
  },
  {
    id: 'projects', path: '/projects', label: 'Projects', group: 'configure', title: 'Projects', icon: FolderKanbanIcon, nav: true, palette: true,
    help: 'Retained project and environment metadata for your signed-in identity.', paletteHint: 'Page',
    primaryAction: 'New project', read: { path: '/projects' }
  },
  {
    id: 'project', path: '/projects/$projectId', label: 'Project', group: 'configure', title: 'Project', icon: FolderKanbanIcon, nav: false, navParent: 'projects', palette: false,
    help: 'One project and its environments.',
    read: { path: '/projects/:projectId/environments' }, detailParam: 'projectId'
  },
  {
    id: 'secrets', path: '/secrets', label: 'Secrets', group: 'configure', title: 'Secrets', icon: VaultIcon, nav: true, palette: true,
    help: 'Write-only global secret references available to workspaces.', paletteHint: 'Page',
    primaryAction: 'New secret', read: { path: '/secrets' }
  },
  {
    id: 'models', path: '/models', label: 'Models & Budgets', group: 'configure', title: 'Models & Budgets', icon: CpuIcon, nav: true, palette: true,
    help: 'Provider credentials, model profiles, pricing, and per-agent budget limits.', paletteHint: 'Provider credentials, model profiles, and budget limits',
    primaryAction: 'Add credential', read: { path: '/provider-credentials' }
  },
  {
    id: 'skills', path: '/skills', label: 'Skills', group: 'configure', title: 'Skills', icon: SparklesIcon, nav: true, palette: true,
    help: 'Browse the library, inspect revisions, import from a provider, and manage skill sets.', paletteHint: 'Manage skills, revisions, imports, and sets',
    primaryAction: 'Upload skill', read: { path: '/skills' }
  },
  {
    id: 'integrations', path: '/integrations', label: 'Integrations', group: 'configure', title: 'Integrations', icon: PlugIcon, nav: true, palette: true,
    help: 'GitHub App authorization for private repository access on this instance.', paletteHint: 'GitHub App authorization',
    read: { path: '/github' }
  },
  {
    id: 'github', path: '/integrations/github', label: 'GitHub', group: 'configure', title: 'GitHub', icon: PlugIcon, nav: false, navParent: 'integrations', palette: true,
    help: 'Connect a GitHub App so workspaces can clone private repositories.', paletteHint: 'GitHub App setup',
    read: { path: '/github' }
  },
  {
    id: 'mcp-servers', path: '/mcp-servers', label: 'MCP Servers', group: 'configure', title: 'MCP Servers', icon: ServerIcon, nav: true, palette: true,
    help: 'Downstream MCP servers exposed through your Cloud Harness MCP Gateway: connections, tools, permissions, and logs.', paletteHint: 'Downstream MCP servers, tools, permissions, and logs',
    primaryAction: 'Add server', read: { path: '/mcp-servers' }
  },
  {
    id: 'mcp-server', path: '/mcp-servers/$serverId', label: 'MCP Server', group: 'configure', title: 'MCP Server', icon: ServerIcon, nav: false, navParent: 'mcp-servers', palette: false,
    help: 'One downstream MCP server: connection, tools, permissions and logs.',
    read: { path: '/mcp-servers/:serverId' }, detailParam: 'serverId'
  },
  {
    id: 'knowledge', path: '/knowledge', label: 'Knowledge', group: 'data', title: 'Knowledge', icon: BookOpenIcon, nav: true, palette: true,
    help: 'Scoped memories and engineering journals for your signed-in identity.', paletteHint: 'Search memories and journals here',
    primaryAction: 'New entry', read: { path: '/knowledge' }
  },
  {
    id: 'knowledge-entry', path: '/knowledge/$knowledgeId', label: 'Knowledge entry', group: 'data', title: 'Knowledge entry', icon: BookOpenIcon, nav: false, navParent: 'knowledge', palette: false,
    help: 'One memory or journal entry.',
    read: { path: '/knowledge/:knowledgeId' }, detailParam: 'knowledgeId'
  },
  {
    id: 'artifacts', path: '/artifacts', label: 'Artifacts', group: 'data', title: 'Artifacts', icon: WaypointsIcon, nav: true, palette: true,
    help: 'Bounded retained snapshots created from workspace files.', paletteHint: 'Page',
    primaryAction: 'Create snapshot', read: { path: '/artifacts', query: { limit: 50 } }
  },
  {
    id: 'api-keys', path: '/api-keys', label: 'API Access', group: 'admin', title: 'API Access', icon: KeyRoundIcon, nav: true, palette: true,
    help: 'MCP access keys for this instance. Keys are shown once and cannot be recovered.', paletteHint: 'MCP access keys for this instance',
    primaryAction: 'Create key', read: { path: '/api-keys' }
  },
  {
    id: 'settings', path: '/settings', label: 'Settings', group: 'admin', title: 'Settings', icon: SettingsIcon, nav: true, palette: true,
    help: 'Instance defaults for workspaces and network egress.', paletteHint: 'Instance defaults for workspaces and network egress',
    read: { path: '/settings' }
  },
  {
    id: 'profile', path: '/profile', label: 'Profile', group: 'account', title: 'Profile', icon: UserIcon, nav: false, palette: true,
    help: 'Your signed-in identity, display name, and session details.', paletteHint: 'Your signed-in identity and session',
    read: { path: '/profile' }
  }
];

const BY_ID = new Map(DASHBOARD_PAGES.map((page) => [page.id, page]));

export function pageById(id: PageId): DashboardPage {
  const page = BY_ID.get(id);
  if (!page) throw new Error(`Unknown Dashboard page ${id}`);
  return page;
}

export function groupLabel(id: PageGroupId): string {
  return PAGE_GROUPS.find((group) => group.id === id)?.label ?? id;
}

/** Sidebar sections in render order, each with its nav pages; empty groups are dropped. */
export function navGroups(): Array<{ id: PageGroupId; label: string; pages: DashboardPage[] }> {
  return PAGE_GROUPS
    .map((group) => ({ id: group.id, label: group.label, pages: DASHBOARD_PAGES.filter((page) => page.nav && page.group === group.id) }))
    .filter((group) => group.pages.length > 0);
}

/** The sidebar entry that is current while `page` is open. */
export function navOwner(page: DashboardPage): PageId {
  return page.nav ? page.id : page.navParent ?? page.id;
}

export const PRODUCT_NAME = 'Cloud Harness';

/** `document.title`, matching the legacy `documentTitle()`; detail pages lead with the resource id. */
export function documentTitle(page: DashboardPage | undefined, detail?: string): string {
  if (!page) return `Page not found | ${PRODUCT_NAME}`;
  return detail ? `${detail} · ${page.title} | ${PRODUCT_NAME}` : `${page.title} | ${PRODUCT_NAME}`;
}

/** Fills `:name` segments of a read path from route params, encoding each value. */
export function resolveReadPath(read: PageRead, params: Record<string, string>): string {
  return read.path.replace(/:([A-Za-z]+)/g, (_, name: string) => encodeURIComponent(params[name] ?? ''));
}

/** Resource id patterns the legacy loader accepted (`performLoad` in dashboard.js). */
export const RESOURCE_ID_PATTERNS = {
  workspaceId: /^ws_[A-Za-z0-9_-]{20,80}$/,
  agentId: /^agent_[A-Za-z0-9_-]{20,80}$/,
  projectId: /^prj_[A-Za-z0-9_-]{20,80}$/,
  serverId: /^mcps_[A-Za-z0-9_-]{20,80}$/,
  knowledgeId: /^kn_[A-Za-z0-9_-]{10,80}$/
} as const;

/** Workspace cockpit tabs, in display order; `summary` is the bare workspace URL. */
export const WORKSPACE_TABS = ['summary', 'agents', 'runtime', 'terminal', 'files', 'git', 'automation', 'deploy', 'artifacts', 'activity'] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
