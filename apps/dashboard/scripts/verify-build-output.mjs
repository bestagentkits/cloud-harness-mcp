#!/usr/bin/env node
// Fails the build when the emitted shell would need a weaker CSP than the API sends
// (see apps/api/src/dashboard-security.ts): no inline script or style, no `data:` or
// external URLs, the nonce placeholder present, and every asset named with a content hash.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const PLACEHOLDER = '__CH_CSP_NONCE__';
const HASHED = /^[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|css|woff2)$/;
const failures = [];

const html = readFileSync(`${dist}index.html`, 'utf8');
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!/\bsrc=/.test(match[1] ?? '')) failures.push('index.html contains an inline <script>');
  if ((match[2] ?? '').trim()) failures.push('index.html <script> has inline content');
}
if (/<style\b/i.test(html)) failures.push('index.html contains an inline <style>');
if (/\sstyle=/i.test(html)) failures.push('index.html contains a style attribute');
if (/\son[a-z]+=/i.test(html)) failures.push('index.html contains an inline event handler');
if (/(?:src|href)="(?:https?:)?\/\//i.test(html)) failures.push('index.html references an external host');
if (!html.includes(PLACEHOLDER)) failures.push(`index.html is missing the ${PLACEHOLDER} placeholder`);
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const url = match[1] ?? '';
  if (!url.startsWith('/dashboard/')) failures.push(`index.html references ${url} outside /dashboard/`);
}

for (const name of readdirSync(`${dist}assets`)) {
  if (!HASHED.test(name)) failures.push(`assets/${name} is not content-hashed`);
  if (name.endsWith('.css') && /url\((?:["']?)(?:data:|https?:|\/\/)/i.test(readFileSync(`${dist}assets/${name}`, 'utf8'))) {
    failures.push(`assets/${name} embeds a data: or external URL`);
  }
}

if (failures.length) {
  console.error(`Dashboard build output check failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Dashboard build output check passed.');
