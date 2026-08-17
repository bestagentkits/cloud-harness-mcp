import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const projectName = 'cloud-harness-mcp';
const wranglerCli = join(process.cwd(), 'node_modules', 'wrangler', 'bin', 'wrangler.js');
let projects;
try {
  const output = execFileSync(process.execPath, [wranglerCli, 'pages', 'project', 'list', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  projects = JSON.parse(output);
} catch {
  console.error('Cloudflare Pages project preflight failed. Authenticate the intended account and verify it can list Pages projects.');
  process.exit(1);
}

if (!projects.some((project) => project.name === projectName || project.project_name === projectName || project['Project Name'] === projectName)) {
  console.error(`Cloudflare Pages project "${projectName}" was not found in the authenticated account.`);
  process.exit(1);
}

console.log(`Cloudflare Pages project "${projectName}" belongs to the authenticated account.`);
