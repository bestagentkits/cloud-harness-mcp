import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUDGET, checkBuildOutput, classifyLazyChunk } from './build-output-check.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Random bytes do not compress, so the gzip size tracks the requested size. */
const incompressible = (bytes) => randomBytes(bytes);

function build({ entry = 1024, overview = 1024, settings = 1024, css = 1024, fonts = 2, license = true, html, lazy = {} } = {}) {
  const dist = mkdtempSync(join(tmpdir(), 'ch-dashboard-build-'));
  roots.push(dist);
  mkdirSync(join(dist, 'assets'));
  mkdirSync(join(dist, '.vite'));
  const files = {
    'assets/index-AAAAAAAA.js': entry,
    'assets/index-BBBBBBBB.js': overview,
    'assets/settings-CCCCCCCC.js': settings,
    'assets/style-DDDDDDDD.css': css
  };
  const lazyEntries = Object.entries(lazy).map(([key, { bytes, name }], index) => {
    const file = `assets/lazy${index}-FFFFFFF${index}.js`;
    files[file] = bytes;
    return [key, { file, isDynamicEntry: true, imports: ['index.html'], ...(name ? { name } : {}) }];
  });
  for (const [file, bytes] of Object.entries(files)) writeFileSync(join(dist, file), incompressible(bytes));
  const fontFiles = Array.from({ length: fonts }, (_, index) => `assets/font${index}-EEEEEEE${index}.woff2`);
  for (const file of fontFiles) writeFileSync(join(dist, file), 'font');
  if (license) writeFileSync(join(dist, 'assets', 'OFL.txt'), 'SIL Open Font License');
  writeFileSync(join(dist, '.vite', 'manifest.json'), JSON.stringify({
    'index.html': { file: 'assets/index-AAAAAAAA.js', isEntry: true, assets: fontFiles },
    'src/routes/index.tsx?tsr-split=component': { file: 'assets/index-BBBBBBBB.js', isDynamicEntry: true, imports: ['index.html'] },
    'src/routes/settings.tsx?tsr-split=component': { file: 'assets/settings-CCCCCCCC.js', isDynamicEntry: true, imports: ['index.html'] },
    'style.css': { file: 'assets/style-DDDDDDDD.css' },
    ...Object.fromEntries(lazyEntries)
  }));
  writeFileSync(join(dist, 'index.html'), html ?? [
    '<!doctype html>', '<html lang="en">',
    '<script src="/dashboard/preferences-boot.js" nonce="__CH_CSP_NONCE__"></script>',
    '<script type="module" src="/dashboard/assets/index-AAAAAAAA.js" nonce="__CH_CSP_NONCE__"></script>',
    '<link rel="stylesheet" href="/dashboard/assets/style-DDDDDDDD.css">', '</html>'
  ].join('\n'));
  return dist;
}

/**
 * Adds chunks to a built fixture: each one is `{ bytes, imports?, dynamicImports?, entry? }`,
 * with `imports` and `dynamicImports` naming other added chunks (or manifest keys).
 */
function withChunks(dist, chunks) {
  const manifestPath = join(dist, '.vite', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  Object.entries(chunks).forEach(([key, { bytes, imports = [], dynamicImports = [], entry = false }], index) => {
    const file = `assets/chunk${index}-GGGGGGG${index}.js`;
    writeFileSync(join(dist, file), incompressible(bytes));
    manifest[key] = { file, imports, dynamicImports, ...(entry ? { isDynamicEntry: true } : {}) };
  });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return dist;
}

const measuredBytes = (measured, key) => measured.chunks.find((chunk) => chunk.chunk === key).bytes;

describe('build output check', () => {
  it('passes a build inside the budget and reports what it measured', () => {
    const { failures, measured } = checkBuildOutput(build());
    expect(failures).toEqual([]);
    expect(measured.initialJs).toBeGreaterThan(1024);
    expect(measured.chunks).toEqual([expect.objectContaining({ chunk: 'src/routes/settings.tsx?tsr-split=component', kind: 'routeChunk' })]);
  });

  it('counts the entry and the Overview route together against the initial budget', () => {
    const half = BUDGET.initialJs / 2 + 4096;
    const { failures } = checkBuildOutput(build({ entry: half, overview: half }));
    expect(failures.join('\n')).toMatch(/initial route JS .* over the 180\.0 KB budget/);
  });

  it('fails a route chunk over 60 KB, CSS over 40 KB and more than four fonts', () => {
    const { failures } = checkBuildOutput(build({ settings: BUDGET.routeChunk + 4096, css: BUDGET.css + 4096, fonts: 5 }));
    const report = failures.join('\n');
    expect(report).toMatch(/route chunk src\/routes\/settings\.tsx\?tsr-split=component .* over the 60\.0 KB budget/);
    expect(report).toMatch(/CSS .* over the 40\.0 KB budget/);
    expect(report).toMatch(/5 WOFF2 fonts exceed the budget of 4/);
  });

  it('classifies route, heavy allowlisted and other lazy chunks', () => {
    expect(classifyLazyChunk('src/routes/agents.index.tsx?tsr-split=component')).toBe('routeChunk');
    expect(classifyLazyChunk('../../node_modules/@xterm/xterm/lib/xterm.mjs')).toBe('lazyHeavy');
    expect(classifyLazyChunk('src/features/chat/load.ts', { name: 'dewee-webchat' })).toBe('lazyHeavy');
    expect(classifyLazyChunk('src/components/layouts/command-palette.tsx')).toBe('lazyChunk');
    expect(classifyLazyChunk('src/vendor/xterm-lookalike.ts', { name: 'xterm-addon' })).toBe('lazyChunk');
  });

  it('allows an allowlisted heavy chunk up to 150 KB and fails it above', () => {
    const inside = checkBuildOutput(build({ lazy: { '../../node_modules/@xterm/xterm/lib/xterm.mjs': { bytes: 120 * 1024 } } }));
    expect(inside.failures).toEqual([]);
    const over = checkBuildOutput(build({ lazy: { 'src/features/chat/load.ts': { bytes: BUDGET.lazyHeavy + 4096, name: 'dewee-webchat' } } }));
    expect(over.failures.join('\n')).toMatch(/heavy lazy chunk src\/features\/chat\/load\.ts .* over the 150\.0 KB budget/);
  });

  it('keeps every other lazy chunk at 60 KB', () => {
    const { failures } = checkBuildOutput(build({ lazy: { 'src/components/layouts/command-palette.tsx': { bytes: 100 * 1024 } } }));
    expect(failures.join('\n')).toMatch(/^lazy chunk src\/components\/layouts\/command-palette\.tsx .* over the 60\.0 KB budget/m);
  });
  it('charges a lazy chunk only for what it adds to the route that opens it', () => {
    const route = 'src/routes/skills.tsx?tsr-split=component';
    const dialog = 'src/features/skills/skill-editor-dialog.tsx';
    const { failures, measured } = checkBuildOutput(withChunks(build(), {
      // Shared by the route and its dialog, so the dialog imports it statically.
      _shared: { bytes: 40 * 1024 },
      [route]: { bytes: 10 * 1024, entry: true, imports: ['index.html', '_shared'], dynamicImports: [dialog] },
      // The dialog's own dependency, which only it loads.
      _forms: { bytes: 30 * 1024 },
      [dialog]: { bytes: 5 * 1024, entry: true, imports: ['index.html', '_shared', '_forms'] }
    }));
    expect(failures).toEqual([]);
    // The route still pays for everything beyond the initial JS, shared code included.
    expect(measuredBytes(measured, route)).toBeGreaterThan(50 * 1024);
    // The dialog pays for its own file and its own dependency, not for the route's shared chunk.
    const bytes = measuredBytes(measured, dialog);
    expect(bytes).toBeGreaterThan(35 * 1024);
    expect(bytes).toBeLessThan(40 * 1024);
  });

  it('still fails a lazy chunk whose own dependencies are over 60 KB', () => {
    const route = 'src/routes/skills.tsx?tsr-split=component';
    const dialog = 'src/features/skills/skill-editor-dialog.tsx';
    const { failures } = checkBuildOutput(withChunks(build(), {
      [route]: { bytes: 10 * 1024, entry: true, imports: ['index.html'], dynamicImports: [dialog] },
      _forms: { bytes: 70 * 1024 },
      [dialog]: { bytes: 1024, entry: true, imports: ['index.html', '_forms'] }
    }));
    expect(failures.join('\n')).toMatch(/^lazy chunk src\/features\/skills\/skill-editor-dialog\.tsx .* over the 60\.0 KB budget/m);
  });

  it('charges a chunk opened from several places against what all of them loaded', () => {
    const dialog = 'src/components/shared-dialog.tsx';
    const { measured } = checkBuildOutput(withChunks(build(), {
      _both: { bytes: 20 * 1024 },
      _onlyA: { bytes: 20 * 1024 },
      'src/routes/a.tsx?tsr-split=component': { bytes: 1024, entry: true, imports: ['index.html', '_both', '_onlyA'], dynamicImports: [dialog] },
      'src/routes/b.tsx?tsr-split=component': { bytes: 1024, entry: true, imports: ['index.html', '_both'], dynamicImports: [dialog] },
      [dialog]: { bytes: 1024, entry: true, imports: ['index.html', '_both', '_onlyA'] }
    }));
    // Route B may open it without `_onlyA`, so that chunk counts; `_both` is loaded either way.
    const bytes = measuredBytes(measured, dialog);
    expect(bytes).toBeGreaterThan(21 * 1024);
    expect(bytes).toBeLessThan(25 * 1024);
  });

  it('requires the font licence next to the fonts', () => {
    expect(checkBuildOutput(build({ license: false })).failures).toContain('assets/OFL.txt must ship next to the fonts');
  });

  it('rejects inline script, external hosts and a missing nonce placeholder', () => {
    const { failures } = checkBuildOutput(build({ html: '<html lang="en"><script>alert(1)</script><script src="https://cdn.example/x.js"></script></html>' }));
    const report = failures.join('\n');
    expect(report).toContain('index.html contains an inline <script>');
    expect(report).toContain('index.html references an external host');
    expect(report).toContain('index.html is missing the __CH_CSP_NONCE__ placeholder');
  });
});
