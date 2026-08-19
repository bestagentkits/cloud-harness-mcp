import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const projectName = 'cloud-harness-docs';
const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

if (token && accountId) {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();
    if (data.success && data.result) {
      console.log(`Cloudflare Pages project "${projectName}" belongs to the authenticated account.`);
      process.exit(0);
    } else {
      console.error(`Cloudflare Pages project "${projectName}" was not found in account ${accountId}.`);
      process.exit(1);
    }
  } catch (error) {
    console.error('Cloudflare Pages API check failed:', error.message);
    process.exit(1);
  }
} else {
  // Fall back to wrangler CLI
  const wranglerCli = join(process.cwd(), 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  let projects;
  try {
    const output = execFileSync(process.execPath, [wranglerCli, 'pages', 'project', 'list', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    projects = JSON.parse(output);
  } catch {
    console.error('Cloudflare Pages docs project preflight failed. Authenticate the intended account and verify it can list Pages projects.');
    process.exit(1);
  }

  const exists = projects.some((project) => project.name === projectName || project.project_name === projectName || project['Project Name'] === projectName);

  if (!exists) {
    console.error(`Cloudflare Pages project "${projectName}" was not found in the authenticated account.`);
    process.exit(1);
  }

  console.log(`Cloudflare Pages project "${projectName}" belongs to the authenticated account.`);
}
