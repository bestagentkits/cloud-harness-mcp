import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { answer, expectNoSeriousA11yViolations, expectPage, type ReadHandler, stubReads, type VisitedPage, watchConsole } from './support';

// The security and configuration pages (Secrets, API access, MCP servers, Integrations,
// GitHub, Approvals, Models) with representative data: axe-clean in light and dark, no
// horizontal page scroll at 1280, 768 and 375 px, and a screenshot of each attached to
// the report. No reveal or write-only field is open in any screenshot.

// Live-relative times so pending items render as pending, not expired.
const NOW = Date.now();
const server = { id: 'mcp_1', name: 'Docs', description: 'Product documentation', transport: 'streamable-http', endpoint: 'https://mcp.example.test/mcp', headers: [{ name: 'x-team', hasValue: true }], enabled: true, status: 'READY', toolCount: 2, permissionDefault: 'allow', generation: 3, lastConnectedAt: NOW };
const tools = [{ id: 't1', name: 'search_docs', description: 'Search the docs', permission: 'allow' }, { id: 't2', name: 'open_page', description: 'Open a page', permission: 'deny' }];

const READS: Record<string, ReadHandler> = {
  '/secrets': answer(200, { data: { secrets: [{ id: 's1', name: 'STRIPE_API_KEY', description: 'Payments', state: 'ACTIVE', version: 2, generation: 2, updatedAt: NOW }], readiness: { ready: true } } }),
  '/api-keys': answer(200, { data: { keys: [{ id: 'apk_1', name: 'CI client', displayPrefix: 'chm_key_apk_AbCd', state: 'ACTIVE', generation: 1, createdAt: NOW, expiresAt: NOW + 30 * 86_400_000, lastUsedAt: NOW, revokedAt: null }], readiness: { ready: true, publicUrl: 'https://harness.example.test/mcp' } } }),
  '/mcp-servers': answer(200, { data: { servers: [server] } }),
  '/mcp-servers/mcp_1': answer(200, { data: { server, tools } }),
  '/mcp-servers/mcp_1/oauth': answer(200, { data: { status: { configured: false } } }),
  '/mcp-gateway': answer(200, { data: { ready: true } }),
  '/github': answer(200, { data: { configured: true, installation: { installationId: 4242, accountLogin: 'example-org', status: 'ACTIVE', checkedAt: NOW }, repositories: [{ installationId: 4242, owner: 'example-org', repository: 'service', contents: 'write', status: 'ACTIVE' }] } }),
  '/privilege-grants': answer(200, { data: { grants: [{ id: 'grant_1', workspaceId: 'ws_1', command: 'apt-get install -y jq', cwd: '/workspace', commandSha256: 'a'.repeat(64), status: 'PENDING', createdAt: NOW, expiresAt: NOW + 600_000 }] } }),
  '/package-plans': answer(200, { data: { enabled: true, approvalMode: 'manual', plans: [{ planId: 'plan_1', planDigest: `sha256:${'b'.repeat(64)}`, status: 'PENDING_APPROVAL', scope: 'workspace', workspaceId: 'ws_1', ecosystem: 'npm', name: 'left-pad', version: '1.3.0', lifecycleScripts: true, binaries: [], createdAt: NOW, expiresAt: NOW + 600_000 }] } }),
  '/provider-credentials': answer(200, { data: { credentials: [{ id: 'cred_1', label: 'OpenAI production', provider: 'openai', authMode: 'bearer', status: 'ACTIVE', activeVersion: 2, generation: 2, lastVerification: { outcome: 'VERIFIED', checkedAt: NOW } }] } }),
  '/agent-model-profiles': answer(200, { data: { profiles: [{ id: 'gpt-fast', displayName: 'GPT fast', provider: 'openai', model: 'gpt-5-mini', credentialId: 'cred_1', status: 'ACTIVE', generation: 1, pricing: { inputMicrosPerMillionTokens: 250_000, outputMicrosPerMillionTokens: 2_000_000, source: 'operator' } }] } }),
  '/model-providers': answer(200, { data: { providers: [{ id: 'openai', displayName: 'OpenAI', authModes: ['bearer'], defaultAuthMode: 'bearer' }] } }),
  '/model-spend': answer(200, { data: { summary: { isEstimate: true, windows: [] } } })
};

const PAGES: Array<{ id: VisitedPage; url: string }> = [
  { id: 'secrets', url: '/dashboard/secrets' },
  { id: 'api-keys', url: '/dashboard/api-keys' },
  { id: 'mcp-servers', url: '/dashboard/mcp-servers' },
  { id: 'mcp-servers', url: '/dashboard/mcp-servers/mcp_1' },
  { id: 'integrations', url: '/dashboard/integrations' },
  { id: 'github', url: '/dashboard/integrations/github' },
  { id: 'approvals', url: '/dashboard/approvals' },
  { id: 'models', url: '/dashboard/models' }
];
const WIDTHS = [1280, 768, 375] as const;

for (const colorScheme of ['light', 'dark'] as const) {
  for (const { id, url } of PAGES) {
    test(`${url} is axe-clean and fits every width (${colorScheme})`, async ({ page }, testInfo) => {
      const problems = watchConsole(page, { allow: [/Failed to load resource/] });
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await stubReads(page, READS);
      // One load per test (the real API rate-limits shell loads); each width re-lays out the page.
      await page.setViewportSize({ width: WIDTHS[0], height: 900 });
      await page.goto(url);
      if (url.endsWith('mcp_1')) await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      else await expectPage(page, id);
      await expect(page.locator('[aria-busy=true]')).toHaveCount(0);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `horizontal page scroll at ${width}px`).toBeLessThanOrEqual(0);
        await expectNoSeriousA11yViolations(page);
        const shot = await page.screenshot({ fullPage: true });
        await testInfo.attach(`${id}-${colorScheme}-${width}`, { body: shot, contentType: 'image/png' });
        // Optional local copy for review: DASHBOARD_SCREENSHOTS=<dir>.
        if (process.env.DASHBOARD_SCREENSHOTS) writeFileSync(join(process.env.DASHBOARD_SCREENSHOTS, `${url.replace(/\W+/g, '-')}-${colorScheme}-${width}.png`), shot);
      }
      expect(problems).toEqual([]);
    });
  }
}
