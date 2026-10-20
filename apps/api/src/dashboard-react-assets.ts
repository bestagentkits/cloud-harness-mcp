import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, type Request, type Response } from 'express';
import type { ApiConfig } from '@cloud-harness/contracts';
import { acceptsHtml } from './auth.js';
import { DASHBOARD_COMPAT_REDIRECTS } from './dashboard-assets.js';
import { reactShellContentSecurityPolicy } from './dashboard-security.js';
import { apiLogger } from './logging.js';

/** `apps/dashboard/dist`, resolved the same way from `apps/api/src` and `apps/api/dist`. */
export const DEFAULT_DASHBOARD_REACT_DIRECTORY = fileURLToPath(new URL('../../dashboard/dist/', import.meta.url));

/** Must match `CSP_NONCE_PLACEHOLDER` in `apps/dashboard/vite.config.ts`. */
const NONCE_PLACEHOLDER = '__CH_CSP_NONCE__';
export const DASHBOARD_UI_COOKIE = 'ch-dashboard-ui';
const UI_MODES = new Set(['legacy', 'react']);
const HASHED_ASSET = /^[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|css|woff2)$/;
const PUBLIC_FILE = /^[a-z0-9][a-z0-9-]*\.js$/;
const COMPAT_REDIRECT_PATHS = new Set(Object.keys(DASHBOARD_COMPAT_REDIRECTS).map((path) => path.slice('/dashboard'.length)));

/**
 * Top-level routes the React app owns, relative to `/dashboard`. `/` matches only itself;
 * any other entry also matches its sub-paths. Keep in step with `apps/dashboard/src/routes`
 * (`apps/dashboard/src/app/server-route-allowlist.test.ts` fails when a route is missing).
 * Every other navigation gets the shell with status 404, so it renders the not-found page.
 */
export const DASHBOARD_REACT_ROUTES: readonly string[] = ['/'];

export type DashboardReactBundle = {
  /** `index.html` with the nonce placeholder still in place. */
  indexHtml: string;
  /** Content-hashed file name -> absolute path, taken from the Vite manifest. Requests only ever look names up here. */
  assets: ReadonlyMap<string, string>;
  /** Unhashed top-level files from `public/` (the pre-paint preferences script). */
  publicFiles: ReadonlyMap<string, string>;
};

/** A usable build, or why the React shell cannot be offered. */
export type DashboardReactBundleResult =
  | { bundle: DashboardReactBundle; problem?: undefined }
  | { bundle?: undefined; problem: string };

function isRegularFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function publicFiles(directory: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (PUBLIC_FILE.test(name) && isRegularFile(path)) files.set(name, path);
  }
  return files;
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
  if (!isRegularFile(indexPath)) return { problem: `${indexPath} is missing` };
  if (!isRegularFile(manifestPath)) return { problem: `${manifestPath} is missing` };
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { problem: `${manifestPath} is not valid JSON` };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { problem: `${manifestPath} is not a manifest object` };
  const chunks = Object.values(manifest as Record<string, ManifestChunk>);
  const entry = (manifest as Record<string, ManifestChunk>)['index.html'];
  if (!entry || entry.isEntry !== true || typeof entry.file !== 'string') return { problem: `${manifestPath} has no index.html entry` };

  const assets = new Map<string, string>();
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') return { problem: `${manifestPath} has a malformed chunk` };
    for (const file of chunkFiles(chunk)) {
      const name = typeof file === 'string' && file.startsWith('assets/') ? file.slice('assets/'.length) : '';
      const path = join(directory, 'assets', name);
      if (!HASHED_ASSET.test(name) || !isRegularFile(path)) return { problem: `${manifestPath} references an invalid or missing asset ${String(file)}` };
      assets.set(name, path);
    }
  }
  const indexHtml = readFileSync(indexPath, 'utf8');
  if (!indexHtml.includes(NONCE_PLACEHOLDER)) return { problem: `${indexPath} is missing the CSP nonce placeholder` };
  if (!indexHtml.includes(`/dashboard/${entry.file}`)) return { problem: `${indexPath} does not load the manifest entry ${entry.file}` };
  return { bundle: { indexHtml, assets, publicFiles: publicFiles(directory) } };
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
  const body = bundle.indexHtml.replaceAll(NONCE_PLACEHOLDER, nonce);
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
export function createDashboardReactRouter(
  config: ApiConfig,
  loaded: DashboardReactBundleResult,
  warn: (message: string, problem: string) => void = (message, problem) => { apiLogger.warn({ problem }, message); }
): Router {
  const router = Router();
  const { bundle } = loaded;
  if (!bundle) {
    if (config.dashboardUi === 'react') {
      throw new Error(`CLOUD_HARNESS_DASHBOARD_UI=react requires a valid React Dashboard build (apps/dashboard/dist): ${loaded.problem}`);
    }
    warn('React Dashboard unavailable; ?ui= canary disabled and the legacy Dashboard keeps serving', loaded.problem);
    return router;
  }
  const defaultMode = config.dashboardUi ?? 'legacy';
  const immutable = { 'Cache-Control': 'private, max-age=31536000, immutable' };
  const revalidate = { 'Cache-Control': 'private, no-cache' };

  // Canary: `/dashboard?ui=react|legacy` pins this browser to one UI, then redirects to
  // the clean URL so the choice is not bookmarked or shared. The destination is a constant
  // path plus the request's other query parameters; no request value can change the target.
  router.get('/', (request, response, next) => {
    const requested = request.query.ui;
    if (typeof requested !== 'string' || !UI_MODES.has(requested)) { next(); return; }
    const query = new URLSearchParams(request.originalUrl.slice(request.originalUrl.indexOf('?') + 1));
    query.delete('ui');
    const rest = query.toString();
    response.setHeader('Set-Cookie', `${DASHBOARD_UI_COOKIE}=${requested}; Path=/dashboard; HttpOnly; Secure; SameSite=Strict`);
    response.redirect(302, `/dashboard${rest ? `?${rest}` : ''}`);
  });

  router.use((request, response, next) => {
    const pinned = cookieValue(request, DASHBOARD_UI_COOKIE);
    const mode = pinned && UI_MODES.has(pinned) ? pinned : defaultMode;
    if (mode !== 'react' || (request.method !== 'GET' && request.method !== 'HEAD')) { next(); return; }

    const path = request.path;
    if (path.startsWith('/assets/')) {
      const asset = bundle.assets.get(path.slice('/assets/'.length));
      if (asset) { response.sendFile(asset, { headers: immutable }); return; }
      next(); return;
    }
    const publicFile = path.lastIndexOf('/') === 0 ? bundle.publicFiles.get(path.slice(1)) : undefined;
    if (publicFile) { response.sendFile(publicFile, { headers: revalidate }); return; }
    if (isExcludedFromFallback(path)) { next(); return; }
    // The React app owns every other GET under /dashboard: legacy page paths must not
    // render the legacy shell inside a React session.
    if (!isDocumentNavigation(request)) { response.status(404).end(); return; }
    sendShell(request, response, bundle, isReactRoute(path) ? 200 : 404);
  });
  return router;
}
