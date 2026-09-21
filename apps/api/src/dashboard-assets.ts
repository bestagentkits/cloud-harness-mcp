import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Router, type Request } from 'express';
import { serverVersion } from './version.js';

const directory = fileURLToPath(new URL('../dashboard/', import.meta.url));
const shellHtml = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');

/**
 * The server version and the three theme variants are constant for the process,
 * so every shell is built once here and the request path is a map lookup with no
 * string work. `light` and `dark` both derive from `versionedShell`, so neither
 * mutates the other and the map is concurrency-safe.
 */
const versionedShell = shellHtml.replaceAll('__CH_VERSION__', serverVersion);
const shells = {
  system: versionedShell,
  light: versionedShell.replace('<html lang="en">', '<html lang="en" data-theme="light">'),
  dark: versionedShell.replace('<html lang="en">', '<html lang="en" data-theme="dark">')
} as const;

function forcedTheme(request: Request): 'light' | 'dark' | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== 'ch-dashboard-theme') continue;
    const value = part.slice(index + 1).trim();
    return value === 'light' || value === 'dark' ? value : undefined;
  }
  return undefined;
}

/**
 * Every path that serves the Dashboard shell. Exported because the browser page
 * registry (`apps/api/dashboard/dashboard-pages.js`) cannot be imported by
 * compiled TypeScript; `apps/api/test/dashboard-pages.test.ts` asserts the two
 * lists agree, with `DASHBOARD_COMPAT_REDIRECTS` and the detail routes as the
 * only documented exceptions.
 */
export const DASHBOARD_SHELL_PATHS: string[] = [
  '/',
  '/workspaces',
  '/workspaces/:workspaceId',
  '/workspaces/:workspaceId/summary',
  '/workspaces/:workspaceId/agents',
  '/workspaces/:workspaceId/runtime',
  '/workspaces/:workspaceId/files',
  '/workspaces/:workspaceId/git',
  '/workspaces/:workspaceId/automation',
  '/workspaces/:workspaceId/deploy',
  '/workspaces/:workspaceId/artifacts',
  '/workspaces/:workspaceId/activity',
  '/agents',
  '/agents/:agentId',
  '/projects',
  '/projects/:projectId',
  '/secrets',
  '/models',
  '/artifacts',
  '/audit',
  '/api-keys',
  '/knowledge',
  '/knowledge/:id',
  '/skills',
  '/integrations',
  '/integrations/github',
  '/integrations/mcp-servers',
  '/mcp-servers/:serverId',
  '/settings',
  '/profile',
];

/**
 * Legacy paths kept working as redirects rather than as shells. `/dashboard/overview`
 * was the old Overview route; GitHub and MCP Servers became tabs of the single
 * Integrations page. `/dashboard/mcp-servers/:serverId` stays a live drill-down
 * route so existing links to a server keep resolving. The browser registry ships
 * the same table, and `apps/api/test/dashboard-pages.test.ts` asserts the two agree.
 */
export const DASHBOARD_COMPAT_REDIRECTS = {
  '/dashboard/overview': '/dashboard',
  '/dashboard/github': '/dashboard/integrations/github',
  '/dashboard/mcp-servers': '/dashboard/integrations/mcp-servers',
} satisfies Record<string, string>;

export function createDashboardAssetsRouter(): Router {
  const router = Router();
  const options = { root: directory, headers: { 'Cache-Control': 'no-store' } };
  router.get('/assets/dashboard.css', (_request, response) => response.sendFile('dashboard.css', options));
  router.get('/assets/dashboard-api.js', (_request, response) => response.sendFile('dashboard-api.js', options));
  router.get('/assets/dashboard-render.js', (_request, response) => response.sendFile('dashboard-render.js', options));
  router.get('/assets/dashboard-pages.js', (_request, response) => response.sendFile('dashboard-pages.js', options));
  router.get('/assets/dashboard.js', (_request, response) => response.sendFile('dashboard.js', options));
  // Each redirect is registered with a literal destination rather than by looping
  // over the exported table: no request value can reach the destination, and
  // `dashboard-app-mount.test.ts` asserts the behaviour of every table entry, so a
  // table edit without a matching route fails a test.
  router.get('/overview', (_request, response) => response.redirect(302, '/dashboard'));
  router.get('/github', (_request, response) => response.redirect(302, '/dashboard/integrations/github'));
  router.get('/mcp-servers', (_request, response) => response.redirect(302, '/dashboard/integrations/mcp-servers'));
  router.get(DASHBOARD_SHELL_PATHS, (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.type('html').send(shells[forcedTheme(request) ?? 'system']);
  });
  return router;
}
