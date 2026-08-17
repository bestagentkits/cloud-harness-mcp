const hostname = 'cloud-harness-mcp.pages.dev';
const response = await fetch(`https://${hostname}`, { redirect: 'error' });

if (!response.ok) {
  console.error(`Cloudflare Pages smoke test failed for ${hostname}: HTTP ${response.status}.`);
  process.exit(1);
}

console.log(`Cloudflare Pages smoke test passed for ${hostname}.`);
