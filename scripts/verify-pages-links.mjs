import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
const urls = [...page.matchAll(/<a\b[^>]*\bhref="(https:\/\/[^"#]+)"/g)].map((match) => match[1]);
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
