import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, notFound } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { DASHBOARD_PAGES, documentTitle, LEGACY_ONLY_PAGE_IDS, navGroups, navOwner, PAGE_IDS, pageById, resolveReadPath } from './page-registry';
import { resolveCurrentPage } from './route-identity';
import { createAppRouter } from './router';

type LegacyPage = { id: string; label: string; group: string; title: string; nav: boolean };

// The classic Dashboard's registry stays the reference for ids, labels, titles and groups
// until cutover; a variable specifier keeps TypeScript from resolving the browser module.
const legacyUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../../../api/dashboard/dashboard-pages.js')).href;
const legacy = await import(/* @vite-ignore */ legacyUrl) as { DASHBOARD_PAGES: LegacyPage[] };

describe('page registry', () => {
  it('lists every page id exactly once', () => {
    expect(DASHBOARD_PAGES.map((page) => page.id)).toEqual([...PAGE_IDS]);
  });

  it('matches the classic Dashboard registry for every shared page', () => {
    for (const old of legacy.DASHBOARD_PAGES) {
      if (LEGACY_ONLY_PAGE_IDS.includes(old.id)) continue;
      const page = pageById(old.id as never);
      expect(page, old.id).toBeDefined();
      expect({ label: page.label, title: page.title, group: page.group, nav: page.nav }, old.id).toEqual({
        label: old.label, title: old.title, group: old.group, nav: old.nav !== false
      });
    }
  });

  it('lists only classic pages without a React page as legacy-only', () => {
    const legacyIds = new Set(legacy.DASHBOARD_PAGES.map((page) => page.id));
    for (const id of LEGACY_ONLY_PAGE_IDS) {
      expect(legacyIds.has(id), id).toBe(true);
      expect((PAGE_IDS as readonly string[]).includes(id), id).toBe(false);
    }
  });

  it('gives every path a route in the route tree, and every route a registry page', () => {
    const router = createAppRouter(new QueryClient(), createMemoryHistory({ initialEntries: ['/dashboard/'] }));
    const routePaths = new Set(Object.keys(router.routesByPath).map((path) => path.replace(/\/$/, '') || '/'));
    for (const page of DASHBOARD_PAGES) expect(routePaths.has(page.path), page.path).toBe(true);
    for (const route of Object.values(router.routesById)) {
      if (route.id === '__root__') continue;
      expect(route.options.staticData?.pageId, route.id).toBeDefined();
    }
  });

  it('builds sidebar groups from nav pages only, in group order', () => {
    const groups = navGroups();
    expect(groups.map((group) => group.id)).toEqual(['home', 'operate', 'configure', 'data', 'admin']);
    expect(groups.flatMap((group) => group.pages).every((page) => page.nav)).toBe(true);
  });

  it('keeps the parent entry current on detail and child pages', () => {
    expect(navOwner(pageById('workspace'))).toBe('workspaces');
    expect(navOwner(pageById('github'))).toBe('integrations');
    expect(navOwner(pageById('agents'))).toBe('agents');
  });

  it('formats document titles', () => {
    expect(documentTitle(pageById('agents'))).toBe('Agents | Cloud Harness');
    expect(documentTitle(pageById('workspace'), 'ws_x')).toBe('ws_x · Workspace | Cloud Harness');
    expect(documentTitle(undefined)).toBe('Page not found | Cloud Harness');
  });

  it('encodes route params into read paths', () => {
    expect(resolveReadPath({ path: '/agents/:agentId' }, { agentId: 'a/b?c' })).toBe('/agents/a%2Fb%3Fc');
  });
});

describe('resolveCurrentPage', () => {
  it('takes the deepest match that names a page', () => {
    const current = resolveCurrentPage([
      { staticData: {} },
      { staticData: { pageId: 'workspace' }, params: { workspaceId: 'ws_x', tab: 'files' } }
    ]);
    expect(current.page?.id).toBe('workspace');
    expect(current.navId).toBe('workspaces');
    expect(current.detail).toBe('ws_x');
  });

  it('reports no page when a match is not found', () => {
    expect(resolveCurrentPage([{ staticData: {} }, { staticData: { pageId: 'agent' }, status: 'notFound' }]).page).toBeUndefined();
    expect(resolveCurrentPage([{ staticData: {}, globalNotFound: true }]).page).toBeUndefined();
    expect(resolveCurrentPage([{ staticData: {}, error: notFound() }, { staticData: { pageId: 'agent' }, status: 'pending' }]).page).toBeUndefined();
  });
});
