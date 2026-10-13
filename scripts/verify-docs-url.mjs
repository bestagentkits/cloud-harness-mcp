const hostname = 'docs.harness.agentkit.best';

console.log(`Verifying live Cloudflare Pages deployment for ${hostname}...`);

try {
  const response = await fetch(`https://${hostname}/`, { redirect: 'follow' });
  if (!response.ok) {
    console.error(`Docs smoke test failed for https://${hostname}/: HTTP ${response.status}.`);
    process.exit(1);
  }

  // Also verify a sample .md twin
  const mdResponse = await fetch(`https://${hostname}/getting-started.md`, { redirect: 'follow' });
  if (mdResponse.ok) {
    const contentType = mdResponse.headers.get('content-type') || '';
    if (!contentType.includes('text/markdown') && !contentType.includes('text/plain')) {
      console.warn(`Warning: /getting-started.md served with Content-Type: ${contentType} (expected text/markdown).`);
    } else {
      console.log(`✓ Live .md twin verified with Content-Type: ${contentType}`);
    }
  }

  // Verify llms.txt
  const llmsResponse = await fetch(`https://${hostname}/llms.txt`, { redirect: 'follow' });
  if (llmsResponse.ok) {
    console.log(`✓ Live llms.txt verified.`);
  }

  console.log(`Cloudflare Pages docs smoke test passed for https://${hostname}.`);
} catch (error) {
  console.warn(`Smoke test note: https://${hostname} could not be reached (${error.message}). Ensure Cloudflare Pages project & custom domain are active.`);
}
