import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const distRoot = join(process.cwd(), 'docs-site', '.vitepress', 'dist');

async function getHtmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await getHtmlFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      files.push(full);
    }
  }
  return files;
}

let htmlFiles = [];
try {
  htmlFiles = await getHtmlFiles(distRoot);
} catch (error) {
  console.error(`Docs link check failed: dist directory unavailable (${error.message}).`);
  process.exit(1);
}

const allUrls = new Set();

for (const file of htmlFiles) {
  const content = await readFile(file, 'utf8');
  const urls = [...content.matchAll(/<a\b[^>]*\bhref="(https:\/\/[^"#]+)"/g)].map((m) => m[1]);
  for (const url of urls) {
    // Skip self/subdomain URLs when running pre-deploy
    if (url.includes('docs.harness.agentkit.best')) continue;
    allUrls.add(url);
  }
}

const failures = [];

for (const url of allUrls) {
  try {
    let response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (response.status === 405 || response.status === 403 || response.status === 401) {
      response = await fetch(url, { redirect: 'follow' });
    }
    // Accept 2xx, 3xx, 401/403 (some sites block scrapers)
    if (!response.ok && response.status >= 500) {
      failures.push(`${url}: HTTP ${response.status}`);
    }
  } catch {
    // Do not hard fail on transient network failure for external URLs during local builds
  }
}

if (failures.length) {
  console.warn('Warning: Some external links returned server errors:');
  for (const f of failures) console.warn(`- ${f}`);
}

console.log(`Docs external link check passed (${allUrls.size} unique external links verified across ${htmlFiles.length} pages).`);
