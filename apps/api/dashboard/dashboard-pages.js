/**
 * The Dashboard page registry.
 *
 * One authoritative source for page identity, route, navigation grouping,
 * document title, page help, icon and command-palette membership. Everything
 * else derives from this module:
 *
 * - the sidebar is rendered from `navGroups()`,
 * - active navigation is resolved with `pageForPath()`,
 * - the command palette page commands come from `palettePageCommands()`,
 * - the document/page heading comes from `documentTitle()` and `applyPage()`,
 * - `apps/api/src/dashboard-assets.ts` keeps its own path list because it is
 *   compiled TypeScript and cannot import this browser module, and
 *   `apps/api/test/dashboard-pages.test.ts` asserts the two stay in parity.
 *
 * The `icon` string is trusted markup authored in this file only. It is written
 * with `insertRendered` and never contains interpolated data.
 */

/** Navigation groups, in the order the sidebar must render them. */
export const DASHBOARD_GROUPS = [
  { id: 'home', label: 'Home' },
  { id: 'operate', label: 'Operate' },
  { id: 'configure', label: 'Configure' },
  { id: 'data', label: 'Data' },
  { id: 'admin', label: 'Admin' }
];

/**
 * Every Dashboard page. `nav: false` pages stay reachable by URL, the command
 * palette, or a parent page's secondary navigation; `navParent` names the page
 * whose sidebar entry stays current while a child route is open.
 */
export const DASHBOARD_PAGES = [
  {
    id: 'overview',
    route: '/dashboard',
    label: 'Overview',
    group: 'home',
    title: 'Overview',
    help: 'Attention, running work, usage, and workspace expiry for your signed-in identity.',
    palette: true,
    paletteHint: 'Page',
    nav: true,
    icon: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>'
  },
  {
    id: 'workspaces',
    route: '/dashboard/workspaces',
    label: 'Workspaces',
    group: 'operate',
    title: 'Workspaces',
    help: 'TTL-limited coding environments available to your signed-in identity.',
    palette: true,
    paletteHint: 'Page',
    nav: true,
    icon: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>'
  },
  {
    id: 'audit',
    route: '/dashboard/audit',
    label: 'Audit',
    group: 'operate',
    title: 'Audit',
    help: 'Retained redacted control-plane events.',
    palette: true,
    paletteHint: 'Retained control-plane events',
    nav: true,
    icon: '<path d="M9 4.5h6a1 1 0 0 1 1 1V6a1 1 0 0 1-1 1H9A1 1 0 0 1 8 6v-.5a1 1 0 0 1 1-1z"/><path d="M16 5.5h2a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1h2"/><path d="M9 12h6"/><path d="M9 16h4"/>'
  },
  {
    id: 'projects',
    route: '/dashboard/projects',
    label: 'Projects',
    group: 'configure',
    title: 'Projects',
    help: 'Retained project and environment metadata for your signed-in identity.',
    palette: true,
    paletteHint: 'Page',
    nav: true,
    icon: '<path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'
  },
  {
    id: 'secrets',
    route: '/dashboard/secrets',
    label: 'Secrets',
    group: 'configure',
    title: 'Secrets',
    help: 'Write-only global secret references available to workspaces.',
    palette: true,
    paletteHint: 'Page',
    nav: true,
    icon: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
  },
  {
    id: 'models',
    route: '/dashboard/models',
    label: 'Models & Budgets',
    group: 'configure',
    title: 'Models & Budgets',
    help: 'Provider credentials, model profiles, pricing, and per-agent budget limits.',
    palette: true,
    paletteHint: 'Provider credentials, model profiles, and budget limits',
    nav: true,
    icon: '<path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L15 14h3a3 3 0 0 1 3 3v4H3v-4a3 3 0 0 1 3-3h3l2.25-4.07A4.002 4.002 0 0 1 12 2z"/>'
  },
  {
    id: 'skills',
    route: '/dashboard/skills',
    label: 'Skills',
    group: 'configure',
    title: 'Skills',
    help: 'Browse the library, inspect revisions, import from a provider, and manage skill sets.',
    palette: true,
    paletteHint: 'Manage skills, revisions, imports, and sets',
    nav: true,
    icon: '<path d="M12 3 2 8l10 5 10-5-10-5z"/><path d="M2 14l10 5 10-5"/>'
  },
  {
    id: 'integrations',
    route: '/dashboard/integrations',
    label: 'Integrations',
    group: 'configure',
    title: 'Integrations',
    help: 'GitHub authorization and downstream MCP server connections for this instance.',
    palette: true,
    paletteHint: 'GitHub and MCP server connections',
    nav: true,
    icon: '<circle cx="12" cy="12" r="3"/><path d="M12 3v6"/><path d="M12 15v6"/><path d="m5.6 5.6 4.2 4.2"/><path d="m14.2 14.2 4.2 4.2"/><path d="m18.4 5.6-4.2 4.2"/><path d="m9.8 14.2-4.2 4.2"/>'
  },
  {
    id: 'knowledge',
    route: '/dashboard/knowledge',
    label: 'Knowledge',
    group: 'data',
    title: 'Knowledge',
    help: 'Scoped memories and engineering journals for your signed-in identity.',
    palette: true,
    paletteHint: 'Search memories and journals here',
    nav: true,
    icon: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M6 6h10"/><path d="M6 10h10"/><path d="M6 14h6"/>'
  },
  {
    id: 'artifacts',
    route: '/dashboard/artifacts',
    label: 'Artifacts',
    group: 'data',
    title: 'Artifacts',
    help: 'Bounded retained snapshots created from workspace files.',
    palette: true,
    paletteHint: 'Page',
    nav: true,
    icon: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>'
  },
  {
    id: 'api-keys',
    route: '/dashboard/api-keys',
    label: 'API Access',
    group: 'admin',
    title: 'API Access',
    help: 'MCP access keys for this instance. Keys are shown once and cannot be recovered.',
    palette: true,
    paletteHint: 'MCP access keys for this instance',
    nav: true,
    icon: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 8-8"/><path d="m15.5 5.5 2 2"/><path d="m18.5 2.5 2.5 2.5"/>'
  },
  {
    id: 'settings',
    route: '/dashboard/settings',
    label: 'Settings',
    group: 'admin',
    title: 'Settings',
    help: 'Instance defaults for workspaces and network egress.',
    palette: true,
    paletteHint: 'Instance defaults for workspaces and network egress',
    nav: true,
    icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/>'
  },
  {
    id: 'profile',
    // The top-bar profile chip is the visible entry point; the sidebar must not
    // spend a slot on it, so this page is palette- and URL-reachable only.
    route: '/dashboard/profile',
    label: 'Profile',
    group: 'account',
    title: 'Profile',
    help: 'Your signed-in identity, display name, and session details.',
    palette: true,
    paletteHint: 'Your signed-in identity and session',
    nav: false,
    icon: '<circle cx="12" cy="8" r="3.5"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/>'
  }
];

/** Child routes that belong to a registered page without owning a sidebar entry. */
export const DASHBOARD_CHILD_ROUTES = [
  { route: '/dashboard/integrations/github', page: 'integrations' },
  { route: '/dashboard/integrations/mcp-servers', page: 'integrations' }
];

/**
 * Legacy paths kept alive for bookmarks. `/dashboard/mcp-servers/:serverId` is a
 * live drill-down route, so the alias matches its prefix as well.
 */
export const DASHBOARD_ALIASES = [
  { prefix: '/dashboard/mcp-servers', page: 'integrations' }
];

/** Paths the server answers with a redirect rather than the shell. */
export const DASHBOARD_COMPAT_REDIRECTS = {
  '/dashboard/overview': '/dashboard',
  '/dashboard/github': '/dashboard/integrations/github',
  '/dashboard/mcp-servers': '/dashboard/integrations/mcp-servers'
};

const PAGES_BY_ID = new Map(DASHBOARD_PAGES.map((page) => [page.id, page]));

/** Resolve one registry page by id, or `undefined` for an unknown id. */
export function pageById(id) {
  return PAGES_BY_ID.get(id);
}

/**
 * Resolve a pathname to its registry page.
 *
 * Resolution order: exact route, then the longest whole-segment route prefix (so
 * a detail route stays on its parent page), then an explicit legacy alias.
 */
export function pageForPath(pathname) {
  const path = typeof pathname === 'string' ? pathname : '/';
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const exact = DASHBOARD_PAGES.find((page) => page.route === normalized);
  if (exact) return exact;
  const child = DASHBOARD_CHILD_ROUTES.find((entry) => entry.route === normalized);
  if (child) return pageById(child.page);
  let best;
  for (const page of DASHBOARD_PAGES) {
    // The home route is exact-only: every other Dashboard path starts with it, so a
    // prefix match would make `/dashboard/anything` resolve to the Overview.
    if (page.route === '/dashboard') continue;
    if (normalized.startsWith(`${page.route}/`)) {
      if (!best || page.route.length > best.route.length) best = page;
    }
  }
  if (best) return best;
  for (const alias of DASHBOARD_ALIASES) {
    if (normalized === alias.prefix || normalized.startsWith(`${alias.prefix}/`)) return pageById(alias.page);
  }
  return undefined;
}

/** Sidebar groups in `DASHBOARD_GROUPS` order, with empty groups dropped. */
export function navGroups() {
  return DASHBOARD_GROUPS
    .map((group) => ({
      id: group.id,
      label: group.label,
      pages: DASHBOARD_PAGES.filter((page) => page.nav && page.group === group.id)
    }))
    .filter((group) => group.pages.length > 0);
}

/** The page whose sidebar entry must be marked current for `page`. */
export function navigationPageId(page) {
  return (page && (page.navParent ?? page.id)) || '';
}

/** Document title for a registry page. */
export function documentTitle(page) {
  return `${(page && page.title) || 'Dashboard'} | Cloud Harness`;
}

/**
 * Command-palette page commands, in registry order. The shape matches what the
 * palette renderer and `rankPaletteMatches` already consume.
 */
export function palettePageCommands() {
  return DASHBOARD_PAGES
    .filter((page) => page.palette)
    .map((page) => ({
      id: `page:${page.id}`,
      group: 'Pages',
      label: page.label,
      hint: page.paletteHint ?? 'Page',
      href: page.route
    }));
}
