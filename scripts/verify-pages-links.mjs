import { readFile } from 'node:fs/promises';

const primaryPages = ['index.html', 'haas.html', 'terms.html', 'privacy.html', 'support.html'];
const pagesContent = await Promise.all(
  primaryPages.map((file) => readFile(new URL(`../site/${file}`, import.meta.url), 'utf8'))
);
const urls = pagesContent.flatMap((page) =>
  [...page.matchAll(/<a\b[^>]*\bhref="(https:\/\/[^"#]+)"/g)].map((match) => match[1])
);
const failures = [];

for (const url of [...new Set(urls)]) {
  try {
    let response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (response.status === 405) response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) failures.push(`${url}: HTTP ${response.status}`);
  } catch {
    failures.push(`${url}: request failed`);
  }
}

if (failures.length) {
  console.error('Cloudflare Pages link check failed.');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Cloudflare Pages link check passed (${urls.length} links).`);
