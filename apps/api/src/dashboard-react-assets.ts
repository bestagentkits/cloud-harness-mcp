import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, type Request, type Response } from 'express';
import type { ApiConfig } from '@cloud-harness/contracts';
import { acceptsHtml } from './auth.js';
import { DASHBOARD_COMPAT_REDIRECTS, forcedTheme } from './dashboard-assets.js';
import { reactShellContentSecurityPolicy } from './dashboard-security.js';
import { apiLogger } from './logging.js';

/** `apps/dashboard/dist`, resolved the same way from `apps/api/src` and `apps/api/dist`. */
export const DEFAULT_DASHBOARD_REACT_DIRECTORY = fileURLToPath(new URL('../../dashboard/dist/', import.meta.url));

/** Must match `CSP_NONCE_PLACEHOLDER` in `apps/dashboard/vite.config.ts`. */
const NONCE_PLACEHOLDER = '__CH_CSP_NONCE__';
export const DASHBOARD_UI_COOKIE = 'ch-dashboard-ui';
const UI_MODES = new Set(['legacy', 'react']);
/** The theme cookie is rendered onto this tag before first paint, as in the legacy shell. */
const HTML_OPEN = '<html lang="en">';
const HASHED_ASSET = /^[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|css|woff2)$/;
const PUBLIC_FILE = /^[a-z0-9][a-z0-9-]*\.js$/;
const COMPAT_REDIRECT_PATHS = new Set(Object.keys(DASHBOARD_COMPAT_REDIRECTS).map((path) => path.slice('/dashboard'.length)));

/**
 * Top-level routes the React app owns, relative to `/dashboard`. `/` matches only itself;
 * any other entry also matches its sub-paths. Keep in step with `apps/dashboard/src/routes`
 * (`apps/dashboard/src/app/server-route-allowlist.test.ts` fails when a route is missing).
 * Every other navigation gets the shell with status 404, so it renders the not-found page.
 */
export const DASHBOARD_REACT_ROUTES: readonly string[] = [
  '/', '/workspaces', '/agents', '/activity', '/approvals', '/packages', '/terminals', '/audit', '/projects', '/secrets', '/models',
  '/skills', '/integrations', '/mcp-servers', '/knowledge', '/artifacts', '/api-keys', '/settings', '/profile'
];

export type DashboardReactBundle = {
  /** `index.html` with the nonce placeholder still in place. */
  indexHtml: string;
  /** The build directory; public files are served relative to it. */
  directory: string;
  /** Content-hashed file names under `assets/`, taken from the Vite manifest. Requests only ever look names up here. */
  assets: ReadonlySet<string>;
  /** Unhashed top-level files from `public/` (the pre-paint preferences script). */
  publicFiles: ReadonlySet<string>;
};

/**
 * A usable build, or why the React shell cannot be offered. `absent` means no build was
 * shipped at all (a legacy-only deployment), as opposed to a broken one.
 */
export type DashboardReactBundleResult =
  | { bundle: DashboardReactBundle; problem?: undefined; absent?: undefined }
  | { bundle?: undefined; problem: string; absent: boolean };

function isRegularFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function publicFiles(directory: string): Set<string> {
  return new Set(readdirSync(directory).filter((name) => PUBLIC_FILE.test(name) && isRegularFile(join(directory, name))));
}

type ManifestChunk = { file?: unknown; isEntry?: unknown; css?: unknown; assets?: unknown };

/** Every output file a manifest chunk references: its own file plus its CSS and static assets. */
function chunkFiles(chunk: ManifestChunk): unknown[] {
  return [chunk.file, ...(Array.isArray(chunk.css) ? chunk.css : []), ...(Array.isArray(chunk.assets) ? chunk.assets : [])];
}

/**
 * Reads and validates the built React app once at startup. The Vite manifest is the asset
 * allowlist: every file it names must be a content-hashed regular file under `assets/`, the
 * `index.html` entry must exist, and `index.html` must load that entry and carry the CSP
 * nonce placeholder. Any gap is reported as a problem instead of a half-working shell.
 */
export function loadDashboardReactBundle(directory = DEFAULT_DASHBOARD_REACT_DIRECTORY): DashboardReactBundleResult {
  const indexPath = join(directory, 'index.html');
  const manifestPath = join(directory, '.vite', 'manifest.json');
  const hasIndex = isRegularFile(indexPath);
  const hasManifest = isRegularFile(manifestPath);
  if (!hasIndex) return { problem: `${indexPath} is missing`, absent: !hasManifest };
  const invalid = (problem: string) => ({ problem, absent: false });
  if (!hasManifest) return invalid(`${manifestPath} is missing`);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return invalid(`${manifestPath} is not valid JSON`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return invalid(`${manifestPath} is not a manifest object`);
  const chunks = Object.values(manifest as Record<string, ManifestChunk>);
  const entry = (manifest as Record<string, ManifestChunk>)['index.html'];
  if (!entry || entry.isEntry !== true || typeof entry.file !== 'string') return invalid(`${manifestPath} has no index.html entry`);

  const assets = new Set<string>();
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') return invalid(`${manifestPath} has a malformed chunk`);
    for (const file of chunkFiles(chunk)) {
      const name = typeof file === 'string' && file.startsWith('assets/') ? file.slice('assets/'.length) : '';
      if (!HASHED_ASSET.test(name) || !isRegularFile(join(directory, 'assets', name))) {
        return invalid(`${manifestPath} references an invalid or missing asset ${String(file)}`);
      }
      assets.add(name);
    }
  }
  const indexHtml = readFileSync(indexPath, 'utf8');
  if (!indexHtml.includes(NONCE_PLACEHOLDER)) return invalid(`${indexPath} is missing the CSP nonce placeholder`);
  if (!indexHtml.includes(HTML_OPEN)) return invalid(`${indexPath} does not open with ${HTML_OPEN}`);
  if (!indexHtml.includes(`/dashboard/${entry.file}`)) return invalid(`${indexPath} does not load the manifest entry ${entry.file}`);
  return { bundle: { indexHtml, directory, assets, publicFiles: publicFiles(directory) } };
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index !== -1 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/**
 * Paths the SPA fallback must never answer: the BFF, the OAuth callback, every asset
 * namespace (legacy and hashed), anything that looks like a file, and the legacy
 * redirects, which still run so old bookmarks land on `/dashboard`.
 */
function isExcludedFromFallback(path: string): boolean {
  if (path === '/api' || path.startsWith('/api/')) return true;
  if (path === '/mcp-oauth' || path.startsWith('/mcp-oauth/')) return true;
  if (path === '/assets' || path.startsWith('/assets/')) return true;
  if (COMPAT_REDIRECT_PATHS.has(path)) return true;
  const last = path.slice(path.lastIndexOf('/') + 1);
  return last.includes('.');
}

function isReactRoute(path: string): boolean {
  return DASHBOARD_REACT_ROUTES.some((route) => route === '/'
    ? path === '/'
    : path === route || path.startsWith(`${route}/`));
}

function isDocumentNavigation(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const destination = request.header('sec-fetch-dest');
  if (destination && destination !== 'document') return false;
  return acceptsHtml(request.header('accept') ?? '');
}

function sendShell(request: Request, response: Response, bundle: DashboardReactBundle, status: number): void {
  const nonce = randomBytes(16).toString('base64');
  // The HTTP-only theme cookie is the theme's authority in both shells: render it before
  // first paint. `data-server-theme` tells the boot script the server's choice, including
  // `system`, so localStorage only mirrors it. The value is one of three constants.
  const theme = forcedTheme(request);
  const html = theme
    ? `<html lang="en" data-server-theme="${theme}" data-theme="${theme}">`
    : '<html lang="en" data-server-theme="system">';
  const body = bundle.indexHtml.replace(HTML_OPEN, html).replaceAll(NONCE_PLACEHOLDER, nonce);
  response.setHeader('Content-Security-Policy', reactShellContentSecurityPolicy(nonce));
  // Never stored, like the legacy shell, so a deploy is picked up at once; the nonce makes
  // each body unique, so no ETag is sent.
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Vary', 'Cookie');
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.status(status).end(request.method === 'HEAD' ? undefined : body);
}

/**
 * Serves the React Dashboard behind `CLOUD_HARNESS_DASHBOARD_UI` and the per-browser
 * `?ui=` canary. Mounted after the BFF router and before the legacy assets router. When
 * a request resolves to legacy it calls `next()` before touching the response, so the
 * legacy Dashboard stays byte-identical. An unusable build fails startup when the flag is
 * `react`; otherwise it disables the canary with one log line and legacy keeps serving.
 */
export function createDashboardReactRouter(config: ApiConfig, loaded: DashboardReactBundleResult): Router {
  const router = Router();
  const shell = config.dashboardUi ?? 'legacy';
  const { bundle } = loaded;
  if (!bundle) {
    if (shell === 'react') {
      throw new Error(`CLOUD_HARNESS_DASHBOARD_UI=react requires a valid React Dashboard build (apps/dashboard/dist): ${loaded.problem}`);
    }
    if (loaded.absent) apiLogger.info({ shell, canary: 'disabled' }, 'dashboard shell selected; no React build shipped');
    else apiLogger.warn({ shell, canary: 'disabled-invalid-manifest', problem: loaded.problem }, 'dashboard shell selected; React build invalid, canary disabled');
    return router;
  }
  apiLogger.info({ shell, canary: 'enabled' }, 'dashboard shell selected');
  const assetsDirectory = join(bundle.directory, 'assets');
  // `root` keeps the served path relative, so a build that lives under a dot-directory
  // (a worktree under `.claude/`, say) is not refused by send's dotfile rule.
  const immutable = { root: assetsDirectory, headers: { 'Cache-Control': 'private, max-age=31536000, immutable' } };
  const revalidate = { root: bundle.directory, headers: { 'Cache-Control': 'private, no-cache' } };

  router.use((request, response, next) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') { next(); return; }
    const path = request.path;

    // Canary: `?ui=react|legacy` on any Dashboard page pins this browser to one UI, then
    // redirects to the same path without the parameter so the choice is not bookmarked or
    // shared. The target is `/dashboard` plus the request's own path and remaining query;
    // no request value can leave the Dashboard. BFF, OAuth and asset paths ignore it. The
    // pin is `SameSite=Lax` so it survives the cross-site Access sign-in redirect and links
    // from other sites; it only selects a shell and grants no authority.
    const requested = request.query.ui;
    if (typeof requested === 'string' && UI_MODES.has(requested) && !isExcludedFromFallback(path)) {
      const query = new URLSearchParams(request.originalUrl.slice(request.originalUrl.indexOf('?') + 1));
      query.delete('ui');
      const rest = query.toString();
      response.append('Set-Cookie', `${DASHBOARD_UI_COOKIE}=${requested}; Path=/dashboard; HttpOnly; Secure; SameSite=Lax`);
      response.redirect(302, `/dashboard${path === '/' ? '' : path}${rest ? `?${rest}` : ''}`);
      return;
    }

    const pinned = cookieValue(request, DASHBOARD_UI_COOKIE);
    const mode = pinned && UI_MODES.has(pinned) ? pinned : shell;
    if (mode !== 'react') { next(); return; }

    if (path.startsWith('/assets/')) {
      const name = path.slice('/assets/'.length);
      if (bundle.assets.has(name)) { response.sendFile(name, immutable); return; }
      next(); return;
    }
    const publicName = path.lastIndexOf('/') === 0 ? path.slice(1) : '';
    if (bundle.publicFiles.has(publicName)) { response.sendFile(publicName, revalidate); return; }
    if (isExcludedFromFallback(path)) { next(); return; }
    // The React app owns every other GET under /dashboard: legacy page paths must not
    // render the legacy shell inside a React session.
    if (!isDocumentNavigation(request)) { response.status(404).end(); return; }
    sendShell(request, response, bundle, isReactRoute(path) ? 200 : 404);
  });
  return router;
}
