import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUDGET, checkBuildOutput } from './build-output-check.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Random bytes do not compress, so the gzip size tracks the requested size. */
const incompressible = (bytes) => randomBytes(bytes);

function build({ entry = 1024, overview = 1024, settings = 1024, css = 1024, fonts = 2, license = true, html } = {}) {
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
  for (const [file, bytes] of Object.entries(files)) writeFileSync(join(dist, file), incompressible(bytes));
  const fontFiles = Array.from({ length: fonts }, (_, index) => `assets/font${index}-EEEEEEE${index}.woff2`);
  for (const file of fontFiles) writeFileSync(join(dist, file), 'font');
  if (license) writeFileSync(join(dist, 'assets', 'OFL.txt'), 'SIL Open Font License');
  writeFileSync(join(dist, '.vite', 'manifest.json'), JSON.stringify({
    'index.html': { file: 'assets/index-AAAAAAAA.js', isEntry: true, assets: fontFiles },
    'src/routes/index.tsx?tsr-split=component': { file: 'assets/index-BBBBBBBB.js', isDynamicEntry: true, imports: ['index.html'] },
    'src/routes/settings.tsx?tsr-split=component': { file: 'assets/settings-CCCCCCCC.js', isDynamicEntry: true, imports: ['index.html'] },
    'style.css': { file: 'assets/style-DDDDDDDD.css' }
  }));
  writeFileSync(join(dist, 'index.html'), html ?? [
    '<!doctype html>', '<html lang="en">',
    '<script src="/dashboard/preferences-boot.js" nonce="__CH_CSP_NONCE__"></script>',
    '<script type="module" src="/dashboard/assets/index-AAAAAAAA.js" nonce="__CH_CSP_NONCE__"></script>',
    '<link rel="stylesheet" href="/dashboard/assets/style-DDDDDDDD.css">', '</html>'
  ].join('\n'));
  return dist;
}

describe('build output check', () => {
  it('passes a build inside the budget and reports what it measured', () => {
    const { failures, measured } = checkBuildOutput(build());
    expect(failures).toEqual([]);
    expect(measured.initialJs).toBeGreaterThan(1024);
    expect(measured.routes).toHaveLength(1);
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
