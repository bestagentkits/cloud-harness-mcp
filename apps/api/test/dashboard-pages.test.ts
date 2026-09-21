import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DASHBOARD_COMPAT_REDIRECTS, DASHBOARD_SHELL_PATHS } from '../src/dashboard-assets.js';
import {
  DASHBOARD_CHILD_ROUTES, DASHBOARD_COMPAT_REDIRECTS as REGISTRY_COMPAT_REDIRECTS, DASHBOARD_GROUPS, DASHBOARD_PAGES, documentTitle, navGroups,
  navigationPageId, pageById, pageForPath, palettePageCommands
} from '../dashboard/dashboard-pages.js';

const asset = (name: string) => readFileSync(new URL(`../dashboard/${name}`, import.meta.url), 'utf8');

const html = asset('index.html');
const script = `${asset('dashboard.js')}\n${asset('dashboard-render.js')}`;

/** One path is served as the shell for `GET /dashboard` itself. */
const shellPathFor = (route: string) => (route === '/dashboard' ? '/' : route.replace(/^\/dashboard/, ''));

describe('dashboard page registry', () => {
  it('keeps every page identity complete and unique', () => {
    const ids = DASHBOARD_PAGES.map((page) => page.id);
    expect(new Set(ids).size).toBe(ids.length);
    const routes = DASHBOARD_PAGES.map((page) => page.route);
    expect(new Set(routes).size).toBe(routes.length);

    const groupIds = DASHBOARD_GROUPS.map((group) => group.id);
    for (const page of DASHBOARD_PAGES) {
      expect(page.label, page.id).toBeTruthy();
      expect(page.title, page.id).toBeTruthy();
      expect(page.help, page.id).toBeTruthy();
      expect(page.icon, page.id).toContain('<');
      expect(page.route.startsWith('/dashboard'), page.id).toBe(true);
      if (page.group !== 'account') expect(groupIds, page.id).toContain(page.group);
      if (page.palette) expect(page.paletteHint, page.id).toBeTruthy();
    }
  });

  it('agrees with the server shell allowlist in both directions', () => {
    for (const page of DASHBOARD_PAGES) {
      expect(DASHBOARD_SHELL_PATHS, page.route).toContain(shellPathFor(page.route));
    }

    // Every literal shell path must resolve to a registry page; parameterized
    // detail routes are resolved by the client's own matchers instead.
    for (const path of DASHBOARD_SHELL_PATHS.filter((entry) => !entry.includes(':'))) {
      const requestPath = path === '/' ? '/dashboard' : `/dashboard${path}`;
      expect(pageForPath(requestPath)?.id, path).toBeTruthy();
    }

  // The store-relative keys are the same table the browser registry ships.
  expect(DASHBOARD_COMPAT_REDIRECTS).toEqual(
    JSON.parse(JSON.stringify(REGISTRY_COMPAT_REDIRECTS))
  );
  });

  it('renders the operator navigation groups in order and without a Profile slot', () => {
    const groups = navGroups();
    expect(groups.map((group) => group.label)).toEqual(['Home', 'Operate', 'Configure', 'Data', 'Admin']);
    expect(groups.flatMap((group) => group.pages.map((page) => page.id))).toEqual([
      'overview',
      'workspaces',
      'agents',
      'audit',
      'projects',
      'secrets',
      'models',
      'skills',
      'integrations',
      'knowledge',
      'artifacts',
      'api-keys',
      'settings'
    ]);
    expect(navGroups().some((group) => group.pages.some((page) => page.id === 'profile'))).toBe(false);
    expect(groups[0].pages[0].route).toBe('/dashboard');
  });

  it('resolves detail routes to the page that owns their sidebar entry', () => {
    expect(pageForPath('/dashboard')?.id).toBe('overview');
    expect(pageForPath('/dashboard/')?.id).toBe('overview');
    expect(pageForPath('/dashboard/workspaces')?.id).toBe('workspaces');
    expect(pageForPath('/dashboard/workspaces/ws_abcdefghijklmnopqrstuvwx/files')?.id).toBe('workspaces');
    expect(pageForPath('/dashboard/projects/prj_abcdefghijklmnopqrst')?.id).toBe('projects');
    expect(pageForPath('/dashboard/knowledge/kn_1234567890')?.id).toBe('knowledge');
    expect(pageForPath('/dashboard/integrations/github')?.id).toBe('integrations');
    expect(pageForPath('/dashboard/integrations/mcp-servers')?.id).toBe('integrations');
    // A live drill-down route for one MCP server keeps the Integrations entry current.
    expect(pageForPath('/dashboard/mcp-servers/mcps_abcdefghijklmnopqrstuvwx')?.id).toBe('integrations');
    expect(pageForPath('/dashboard/not-a-page')).toBeUndefined();
  });

  it('does not resolve a sibling prefix that is not a whole path segment', () => {
    expect(pageForPath('/dashboard/workspaces-archive')).toBeUndefined();
  });

  it('keeps navigation state on the parent page for child routes', () => {
    expect(navigationPageId(pageById('overview'))).toBe('overview');
    expect(navigationPageId(pageForPath('/dashboard/integrations/github'))).toBe('integrations');
    expect(DASHBOARD_CHILD_ROUTES.every((entry) => pageById(entry.page))).toBe(true);
  });

  it('derives palette destinations from the same registry', () => {
    const commands = palettePageCommands();
    const palettePages = DASHBOARD_PAGES.filter((page) => page.palette);
    expect(commands.map((command) => command.id)).toEqual(palettePages.map((page) => `page:${page.id}`));
    expect(commands.every((command) => command.group === 'Pages')).toBe(true);
    expect(commands.find((command) => command.id === 'page:overview')?.href).toBe('/dashboard');
    expect(commands.find((command) => command.id === 'page:models')?.label).toBe('Models & Budgets');
    expect(commands.find((command) => command.id === 'page:api-keys')?.label).toBe('API Access');
    expect(commands.find((command) => command.id === 'page:profile')?.href).toBe('/dashboard/profile');
    expect(commands.some((command) => command.href === '/dashboard/overview')).toBe(false);
  });

  it('titles the document from the page', () => {
    expect(documentTitle(pageById('overview'))).toBe('Overview | Cloud Harness');
    expect(documentTitle(undefined)).toBe('Dashboard | Cloud Harness');
  });

  it('leaves no page label, route or group authored in the shell markup', () => {
    for (const label of ['Runtime', 'Configuration', 'Observability']) {
      expect(html, label).not.toContain(`<p class="nav-group">${label}</p>`);
    }
    expect(html).not.toContain('data-section=');
    expect(html).toContain('<div id="sidebar-nav"></div>');
    // The shell ships the Overview title; the client rewrites it per page.
    expect(html).toContain('<title>Overview | Cloud Harness</title>');
    // No page route is authored as a rail link: the only static links left are the
    // top-bar profile chip and the in-dialog "Manage skills" shortcut.
    expect(html).not.toMatch(/<a [^>]*data-section=/);
    for (const page of DASHBOARD_PAGES.filter((candidate) => candidate.nav)) {
      expect(html, page.id).not.toContain(`data-section="${page.id}"`);
    }
  });

  it('renders the palette and navigation from the registry instead of a second list', () => {
    expect(script).toContain('export const PALETTE_PAGE_COMMANDS = palettePageCommands();');
    expect(script).toContain('renderSidebarNavMarkup');
    expect(script).toContain("insertRendered(document.querySelector('#sidebar-nav'), renderSidebarNavMarkup())");
    expect(script).not.toContain("id: 'page:overview'");
    expect(script).not.toContain("href: '/dashboard/overview'");
  });

  it('routes the client through the registry rather than a pathname chain', () => {
    expect(script).toContain('const page = pageForPath(location.pathname);');
    expect(script).toContain('PAGE_LOADERS[page.id]');
    expect(script).not.toContain("location.pathname === '/dashboard/models'");
    expect(script).not.toContain("location.pathname === '/dashboard/settings'");
  });
});
