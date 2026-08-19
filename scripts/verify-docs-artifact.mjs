import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const distRoot = join(process.cwd(), 'docs-site', '.vitepress', 'dist');
const forbiddenNames = /(^|\/)(?:\.env(?:\..*)?|\.envrc|.*\.(?:pem|key|p12|db|sqlite|log))$/i;

// In documentation, we prohibit actual secret values, real tokens, and private keys (not bare documentation mentions).
const forbiddenValues = /(?:(?:MCP_BEARER_TOKEN|RUNNER_TOKEN|CLOUDFLARE_API_TOKEN)\s*=\s*(?!change-me)[A-Za-z0-9._-]{20,}|(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Authorization\s*:\s*Bearer\s+(?!<|\$|YOUR_)[A-Za-z0-9._-]{25,})/i;

async function files(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const file = join(root, entry.name);
    return entry.isDirectory() ? await files(file) : [file];
  }))).flat();
}

let artifact;
try {
  artifact = await files(distRoot);
} catch (error) {
  console.error(`Cloudflare Pages docs artifact check failed: docs-site/.vitepress/dist is unavailable (${error.code ?? error.message}).`);
  console.error('Run "npm run docs:build" first.');
  process.exit(1);
}

const invalid = [];

for (const file of artifact) {
  const display = relative(process.cwd(), file).replaceAll('\\', '/');
  if (forbiddenNames.test(display)) invalid.push(`${display}: forbidden artifact filename`);
  if ((await stat(file)).size > 25 * 1024 * 1024) invalid.push(`${display}: exceeds the 25 MiB Pages upload limit`);
  const content = await readFile(file);
  const text = content.toString('utf8');
  if (!text.includes('\uFFFD') && forbiddenValues.test(text)) {
    invalid.push(`${display}: contains a forbidden credential marker`);
  }
}

if (invalid.length) {
  console.error('Cloudflare Pages docs artifact check failed.');
  for (const message of invalid) console.error(`- ${message}`);
  process.exit(1);
}

console.log(`Cloudflare Pages docs artifact check passed (${artifact.length} files in dist).`);
