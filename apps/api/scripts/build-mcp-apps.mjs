#!/usr/bin/env node
// Bundles each MCP Apps view into one self-contained HTML file under dist/mcp-apps/. Hosts render
// the view in a sandbox with no network origins, so script and styles are inlined and nothing is
// fetched at runtime.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const VIEWS = [{ source: 'workspace-explorer', output: 'workspace-explorer-v1.html' }];

async function buildView(view) {
  const directory = new URL(`../mcp-apps/${view.source}/`, import.meta.url);
  const bundled = await build({
    entryPoints: [new URL('main.js', directory).pathname],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    write: false
  });
  // An inline script ends at the first `</script`, wherever it appears; escape it inside the bundle.
  const script = bundled.outputFiles[0].text.replace(/<\/(script)/giu, '<\\/$1');
  const styles = readFileSync(new URL('styles.css', directory), 'utf8');
  const template = readFileSync(new URL('index.html', directory), 'utf8');
  return template.replace('/*__STYLES__*/', () => styles).replace('/*__SCRIPT__*/', () => script);
}

const outputDirectory = new URL('../dist/mcp-apps/', import.meta.url);
mkdirSync(outputDirectory, { recursive: true });
for (const view of VIEWS) {
  writeFileSync(new URL(view.output, outputDirectory), await buildView(view));
}
