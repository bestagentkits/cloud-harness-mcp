// Checks the emitted Dashboard build (see verify-build-output.mjs, which runs it after
// `vite build`). Two concerns:
//
// - CSP: the shell must not need a weaker policy than the API sends
//   (apps/api/src/dashboard-security.ts): no inline script or style, no `data:` or external
//   URLs, the nonce placeholder present, and every asset named with a content hash.
// - Complexity budget from docs/adr/0005-dashboard-react-rewrite.md, measured from the Vite
//   manifest in gzip bytes: entry plus the Overview route at most 180 KB, every other route
//   chunk (`src/routes/*`) and every other lazy chunk at most 60 KB, the allowlisted heavy
//   lazy chunks (the xterm terminal and the Dewee widget) at most 150 KB each, CSS at most
//   40 KB, at most four WOFF2 fonts. A route chunk is charged for everything it loads beyond
//   the initial JS; any other lazy chunk only for what it adds to what every chunk that
//   imports it has already loaded, which is what opening it downloads. A breach fails the
//   build instead of raising a number silently.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export const PLACEHOLDER = '__CH_CSP_NONCE__';
export const BUDGET = Object.freeze({ initialJs: 180 * 1024, routeChunk: 60 * 1024, lazyChunk: 60 * 1024, lazyHeavy: 150 * 1024, css: 40 * 1024, fonts: 4 });
/**
 * The only lazy chunks allowed the heavy budget, by manifest key or chunk name. Anything not
 * listed here, including a new large dependency, stays at the 60 KB lazy budget.
 */
export const LAZY_HEAVY = Object.freeze([
  { id: 'xterm', key: /(?:^|\/)node_modules\/@xterm\/xterm\//, name: 'xterm' },
  { id: 'dewee-webchat', key: /(?:^|\/)dewee-webchat(?:[./]|$)/, name: 'dewee-webchat' }
]);
const ROUTE_CHUNK = /^src\/routes\//;
/** The Overview route's split component chunk, as the TanStack Router plugin names it in the manifest. */
const OVERVIEW_ROUTE = /^src\/routes\/index\.tsx(?:\?|$)/;
const HASHED = /^[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|css|woff2)$/;
/** The font licence ships next to the fonts and is the only unhashed file under assets/. */
export const FONT_LICENSE = 'OFL.txt';

function checkShell(html, failures) {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc=/.test(match[1] ?? '')) failures.push('index.html contains an inline <script>');
    if ((match[2] ?? '').trim()) failures.push('index.html <script> has inline content');
  }
  if (/<style\b/i.test(html)) failures.push('index.html contains an inline <style>');
  if (/\sstyle=/i.test(html)) failures.push('index.html contains a style attribute');
  if (/\son[a-z]+=/i.test(html)) failures.push('index.html contains an inline event handler');
  if (/(?:src|href)="(?:https?:)?\/\//i.test(html)) failures.push('index.html references an external host');
  if (!html.includes(PLACEHOLDER)) failures.push(`index.html is missing the ${PLACEHOLDER} placeholder`);
  if (!html.includes('<html lang="en">')) failures.push('index.html must open with <html lang="en"> for server theme injection');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = match[1] ?? '';
    if (!url.startsWith('/dashboard/')) failures.push(`index.html references ${url} outside /dashboard/`);
  }
}

function checkAssets(dist, failures) {
  const names = readdirSync(join(dist, 'assets'));
  for (const name of names) {
    if (name === FONT_LICENSE) continue;
    if (!HASHED.test(name)) failures.push(`assets/${name} is not content-hashed`);
    if (name.endsWith('.css') && /url\((?:["']?)(?:data:|https?:|\/\/)/i.test(readFileSync(join(dist, 'assets', name), 'utf8'))) {
      failures.push(`assets/${name} embeds a data: or external URL`);
    }
  }
  const fonts = names.filter((name) => name.endsWith('.woff2'));
  if (fonts.length && !names.includes(FONT_LICENSE)) failures.push(`assets/${FONT_LICENSE} must ship next to the fonts`);
  if (fonts.length > BUDGET.fonts) failures.push(`${fonts.length} WOFF2 fonts exceed the budget of ${BUDGET.fonts}`);
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

/** `routeChunk` for `src/routes/*`, `lazyHeavy` for an allowlisted chunk, `lazyChunk` otherwise. */
export function classifyLazyChunk(key, chunk = {}) {
  if (ROUTE_CHUNK.test(key)) return 'routeChunk';
  if (LAZY_HEAVY.some((heavy) => heavy.key.test(key) || chunk.name === heavy.name)) return 'lazyHeavy';
  return 'lazyChunk';
}

const LABEL = { routeChunk: 'route chunk', lazyChunk: 'lazy chunk', lazyHeavy: 'heavy lazy chunk' };

/** Gzip sizes of the initial JS, each other lazy chunk and the CSS, from the Vite manifest. */
export function measureBudget(dist) {
  const manifest = JSON.parse(readFileSync(join(dist, '.vite', 'manifest.json'), 'utf8'));
  const gzipped = new Map();
  const size = (file) => {
    if (!gzipped.has(file)) gzipped.set(file, gzipSync(readFileSync(join(dist, file)), { level: 9 }).length);
    return gzipped.get(file);
  };
  /** A chunk's file plus every chunk it imports statically, transitively. */
  const closure = (key, into = new Set()) => {
    const chunk = manifest[key];
    if (!chunk || into.has(chunk.file)) return into;
    into.add(chunk.file);
    for (const imported of chunk.imports ?? []) closure(imported, into);
    return into;
  };
  const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry);
  const overviewKey = Object.keys(manifest).find((key) => manifest[key].isDynamicEntry && OVERVIEW_ROUTE.test(key));
  if (!entryKey) throw new Error('the Vite manifest has no entry chunk');
  if (!overviewKey) throw new Error('the Vite manifest has no Overview route chunk');
  const initial = closure(overviewKey, closure(entryKey));
  const importers = (key) => Object.keys(manifest).filter((other) => (manifest[other].dynamicImports ?? []).includes(key));
  /**
   * The files already in memory whenever `key` can load: the initial JS plus what every one
   * of its dynamic importers loaded (their intersection, since any one of them may be the
   * one that opened it). A route chunk is loaded from the shell, so it gets the initial JS only.
   */
  const loadedBefore = (key, seen = new Set()) => {
    const from = importers(key).filter((other) => !seen.has(other));
    if (ROUTE_CHUNK.test(key) || from.length === 0) return initial;
    const next = new Set([...seen, key]);
    const sets = from.map((other) => new Set([...loadedBefore(other, next), ...closure(other)]));
    return new Set([...initial, ...[...sets[0]].filter((file) => sets.every((set) => set.has(file)))]);
  };
  const chunks = Object.keys(manifest)
    .filter((key) => manifest[key].isDynamicEntry && key !== overviewKey)
    .map((key) => {
      const loaded = loadedBefore(key);
      const files = [...closure(key)].filter((file) => !loaded.has(file));
      const kind = classifyLazyChunk(key, manifest[key]);
      return { chunk: key, kind, limit: BUDGET[kind], bytes: files.reduce((total, file) => total + size(file), 0) };
    });
  const cssFiles = new Set(Object.values(manifest).flatMap((chunk) => [
    ...(chunk.css ?? []),
    ...(typeof chunk.file === 'string' && chunk.file.endsWith('.css') ? [chunk.file] : [])
  ]));
  return {
    initialJs: [...initial].filter((file) => file.endsWith('.js')).reduce((total, file) => total + size(file), 0),
    chunks,
    css: [...cssFiles].reduce((total, file) => total + size(file), 0)
  };
}

function checkBudget(dist, failures) {
  let measured;
  try { measured = measureBudget(dist); } catch (error) { failures.push(`budget: ${error.message}`); return undefined; }
  if (measured.initialJs > BUDGET.initialJs) failures.push(`initial route JS is ${kb(measured.initialJs)} gzip, over the ${kb(BUDGET.initialJs)} budget`);
  for (const { chunk, kind, limit, bytes } of measured.chunks) {
    if (bytes > limit) failures.push(`${LABEL[kind]} ${chunk} is ${kb(bytes)} gzip, over the ${kb(limit)} budget`);
  }
  if (measured.css > BUDGET.css) failures.push(`CSS is ${kb(measured.css)} gzip, over the ${kb(BUDGET.css)} budget`);
  return measured;
}

/** Returns every failure found in `dist`, plus the measured budget for reporting. */
export function checkBuildOutput(dist) {
  const failures = [];
  const indexPath = join(dist, 'index.html');
  if (!existsSync(indexPath)) return { failures: ['index.html is missing'], measured: undefined };
  checkShell(readFileSync(indexPath, 'utf8'), failures);
  checkAssets(dist, failures);
  const measured = checkBudget(dist, failures);
  return { failures, measured };
}

export function formatBudget(measured) {
  return [
    `initial JS ${kb(measured.initialJs)} / ${kb(BUDGET.initialJs)}`,
    ...measured.chunks.map(({ chunk, limit, bytes }) => `${chunk} ${kb(bytes)} / ${kb(limit)}`),
    `CSS ${kb(measured.css)} / ${kb(BUDGET.css)}`
  ].join(', ');
}
