import { accessSync, constants, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, type Request } from 'express';
import { serverVersion } from './version.js';

const directory = fileURLToPath(new URL('../dashboard/', import.meta.url));
const shellHtml = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
const assetVersion = encodeURIComponent(serverVersion);
const DASHBOARD_ASSETS = new Set([
  'dashboard.css',
  'dashboard-api.js',
  'dashboard-render.js',
  'dashboard-pages.js',
  'dashboard.js',
  'dashboard-terminal.js',
  'dashboard-models.js',
  'dashboard-policies.js',
  'dashboard-traces.js',
  'dashboard-inbox.js'
]);

/**
 * Third-party browser modules the Terminal pane loads, served from the installed packages rather than a
 * vendored copy, so the bytes the browser runs are always the pinned dependency in `package.json` (and in
 * the production image, which keeps production `node_modules`). Resolution happens once at startup: a
 * missing package fails the process instead of serving a Terminal tab that cannot load its emulator.
 * Each name maps to one fixed file; no request value reaches a filesystem path.
 */
const requirePackage = createRequire(import.meta.url);
const packageDirectory = (name: string) => dirname(requirePackage.resolve(`${name}/package.json`));
const xtermDirectory = packageDirectory('@xterm/xterm');
const xtermFitDirectory = packageDirectory('@xterm/addon-fit');
export const DASHBOARD_VENDOR_ASSETS: ReadonlyMap<string, string> = new Map([
  ['xterm.mjs', join(xtermDirectory, 'lib', 'xterm.mjs')],
  ['xterm.css', join(xtermDirectory, 'css', 'xterm.css')],
  ['xterm-addon-fit.mjs', join(xtermFitDirectory, 'lib', 'addon-fit.mjs')]
]);
for (const path of DASHBOARD_VENDOR_ASSETS.values()) accessSync(path, constants.R_OK);

/**
 * The server version, immutable asset namespace and the three theme variants are
 * constant for the process, so every shell is built once here and the request
 * path is a map lookup with no string work. `light` and `dark` both derive from
 * `versionedShell`, so neither mutates the other and the map is concurrency-safe.
 */
const versionedShell = shellHtml
  .replaceAll('__CH_VERSION__', serverVersion)
  .replaceAll('__CH_ASSET_VERSION__', assetVersion);
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
  '/workspaces/:workspaceId/terminal',
  '/agents',
  '/agents/:agentId',
  '/traces',
  '/traces/:traceId',
  '/inbox',
  '/projects',
  '/projects/:projectId',
  '/projects/:projectId/agent-policies',
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
  '/activity',
  '/approvals',
  '/packages',
  '/terminals',
  '/mcp-servers',
  '/mcp-servers/:serverId',
  '/automations',
  '/automations/rules',
  '/automations/connections',
  '/automations/deliveries',
  '/automations/runs/:workflowId',
  '/settings',
  '/settings/agent-policies',
  '/profile',
];

/**
 * Legacy paths kept working as redirects rather than as shells. `/dashboard/overview`
 * was the old Overview route; GitHub became a tab of the Integrations page; MCP
 * Servers was briefly an Integrations tab before it got its own rail entry. The
 * browser registry ships the same table, and `apps/api/test/dashboard-pages.test.ts`
 * asserts the two agree.
 */
export const DASHBOARD_COMPAT_REDIRECTS = {
  '/dashboard/overview': '/dashboard',
  '/dashboard/github': '/dashboard/integrations/github',
  '/dashboard/integrations/mcp-servers': '/dashboard/mcp-servers',
} satisfies Record<string, string>;

/**
 * A GitHub App whose Setup URL still points at the legacy `/dashboard/github` path
 * returns from installation with `state`, `installation_id` and `setup_action`. The
 * redirect carries only those keys, and only in the shapes GitHub and the runner's
 * setup flow produce, so the dashboard can complete the installation without the
 * redirect ever echoing arbitrary request input.
 */
const GITHUB_SETUP_CALLBACK_PARAMETERS: Record<string, RegExp> = {
  state: /^[A-Za-z0-9_-]{32,128}$/,
  installation_id: /^[1-9][0-9]{0,19}$/,
  setup_action: /^(?:install|update|request)$/,
};

export function githubSetupCallbackQuery(query: Record<string, unknown>): string {
  const kept = new URLSearchParams();
  for (const [name, pattern] of Object.entries(GITHUB_SETUP_CALLBACK_PARAMETERS)) {
    const value = query[name];
    if (typeof value === 'string' && pattern.test(value)) kept.set(name, value);
  }
  const encoded = kept.toString();
  return encoded ? `?${encoded}` : '';
}

export function createDashboardAssetsRouter(): Router {
  const router = Router();
  const legacyOptions = { root: directory, headers: { 'Cache-Control': 'private, no-cache' } };
  const immutableOptions = { root: directory, headers: { 'Cache-Control': 'private, max-age=31536000, immutable' } };

  // The shell references assets through a release-version namespace. Relative ESM
  // imports inherit that namespace, so every module in a release can be cached
  // indefinitely without serving stale code after the next deploy.
  router.get('/assets/:version/:asset', (request, response) => {
    if (request.params.version !== serverVersion) { response.sendStatus(404); return; }
    const vendor = DASHBOARD_VENDOR_ASSETS.get(request.params.asset);
    if (vendor) { response.sendFile(vendor, { headers: immutableOptions.headers }); return; }
    if (!DASHBOARD_ASSETS.has(request.params.asset)) { response.sendStatus(404); return; }
    response.sendFile(request.params.asset, immutableOptions);
  });

  // Keep the old unversioned paths as a revalidating compatibility surface for a
  // shell that was already open during a rolling deploy. New shells never use it.
  router.get('/assets/dashboard.css', (_request, response) => response.sendFile('dashboard.css', legacyOptions));
  router.get('/assets/dashboard-api.js', (_request, response) => response.sendFile('dashboard-api.js', legacyOptions));
  router.get('/assets/dashboard-render.js', (_request, response) => response.sendFile('dashboard-render.js', legacyOptions));
  router.get('/assets/dashboard-pages.js', (_request, response) => response.sendFile('dashboard-pages.js', legacyOptions));
  router.get('/assets/dashboard.js', (_request, response) => response.sendFile('dashboard.js', legacyOptions));
  router.get('/assets/dashboard-terminal.js', (_request, response) => response.sendFile('dashboard-terminal.js', legacyOptions));
  router.get('/assets/dashboard-models.js', (_request, response) => response.sendFile('dashboard-models.js', legacyOptions));
  router.get('/assets/dashboard-policies.js', (_request, response) => response.sendFile('dashboard-policies.js', legacyOptions));
  router.get('/assets/dashboard-traces.js', (_request, response) => response.sendFile('dashboard-traces.js', legacyOptions));
  router.get('/assets/dashboard-inbox.js', (_request, response) => response.sendFile('dashboard-inbox.js', legacyOptions));
  for (const [name, path] of DASHBOARD_VENDOR_ASSETS) {
    router.get(`/assets/${name}`, (_request, response) => response.sendFile(path, { headers: legacyOptions.headers }));
  }
  // Each redirect is registered with a literal destination rather than by looping
  // over the exported table: no request value can reach the destination path (the
  // GitHub redirect appends only the validated callback query above), and
  // `dashboard-app-mount.test.ts` asserts the behaviour of every table entry, so a
  // table edit without a matching route fails a test.
  router.get('/overview', (_request, response) => response.redirect(302, '/dashboard'));
  router.get('/github', (request, response) => response.redirect(302, `/dashboard/integrations/github${githubSetupCallbackQuery(request.query)}`));
  router.get('/integrations/mcp-servers', (_request, response) => response.redirect(302, '/dashboard/mcp-servers'));
  router.get(DASHBOARD_SHELL_PATHS, (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.type('html').send(shells[forcedTheme(request) ?? 'system']);
  });
  return router;
}
