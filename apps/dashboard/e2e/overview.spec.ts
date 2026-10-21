import { expect, test, type Page } from '@playwright/test';
import { answer, expectNoSeriousA11yViolations, expectPage, type ReadHandler, stubReads, watchConsole } from './support';
import {
  AGENT_ID, emptyMetricsProjection, emptyOverviewProjection, emptyReliabilityProjection, HOSTILE, hostileOverviewProjection, metricsProjection,
  overviewProjection, reliabilityProjection, serverInfo, WORKSPACE_ID
} from './fixtures/overview';

// The Overview: decision tiles, attention and expiry lists, analytics charts, Access and Server.

const API = '/dashboard/api/v1';

const READS: Record<string, ReadHandler> = {
  '/overview': answer(200, overviewProjection),
  '/metrics': answer(200, metricsProjection),
  '/reliability': answer(200, reliabilityProjection),
  '/server': answer(200, serverInfo),
  // The sidebar approvals badge's reads: an empty inbox.
  '/privilege-grants': answer(200, { data: { grants: [] } }),
  '/package-plans': answer(200, { data: { plans: [] } })
};

/** Every GET under the BFF, as `path?query`, in order. The session handshake is the shell's, not the page's. */
function trackReads(page: Page): string[] {
  const reads: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() !== 'GET' || !url.pathname.startsWith(`${API}/`)) return;
    const path = url.pathname.slice(API.length);
    if (path !== '/session') reads.push(`${path}${url.search}`);
  });
  return reads;
}

async function openOverview(page: Page, handlers: Record<string, ReadHandler> = {}) {
  const seen = await stubReads(page, { ...READS, ...handlers });
  await page.goto('/dashboard');
  await expectPage(page, 'overview');
  return seen;
}

const main = (page: Page) => page.locator('main');

test('leads with decision tiles that link to the filtered lists, reading each endpoint once', async ({ page }) => {
  const problems = watchConsole(page);
  const reads = trackReads(page);
  await openOverview(page);
  const tiles = page.getByRole('list', { name: 'Decision metrics' });
  await expect(tiles.getByRole('link', { name: /Needs attention\s*3/ })).toHaveAttribute('href', '/dashboard/agents?attention=needs-attention');
  await expect(tiles.getByRole('link', { name: /Running now\s*2/ })).toHaveAttribute('href', '/dashboard/agents?status=RUNNING');
  await expect(tiles.getByRole('link', { name: /Cost\s*\$1\.2500/ })).toContainText('scope: running agents');
  await expect(tiles.getByRole('link', { name: /Expiring soon\s*3/ })).toHaveAttribute('href', '/dashboard/workspaces?expiring=60');
  await expect(tiles).toContainText('lease(s) within the hour');

  const attention = page.getByRole('region', { name: 'Needs attention' });
  await expect(attention.getByRole('link', { name: 'Lease expires soon' })).toHaveAttribute('href', `/dashboard/workspaces/${WORKSPACE_ID}/summary`);
  await expect(attention.getByRole('link', { name: 'Agent failed' })).toHaveAttribute('href', `/dashboard/agents/${AGENT_ID}`);
  await expect(attention.getByRole('link', { name: '2 pending approval(s)' })).toHaveAttribute('href', '/dashboard/approvals');
  const expiry = page.getByRole('region', { name: 'Expiring soon' });
  await expect(expiry.getByRole('link', { name: '15 min' })).toHaveAttribute('href', '/dashboard/workspaces?expiring=15');
  await expect(expiry).toContainText('5 workspace(s)');

  const access = page.getByRole('region', { name: 'Access' });
  await expect(access).toContainText('Signed in as');
  await expect(access).toContainText('owner@example.test');
  const server = page.getByRole('region', { name: 'Server' });
  await expect(server).toContainText('cloudflare-access');
  await expect(server).toContainText('0.72.0');
  await expect(server).toContainText('https://harness.example.test/mcp');
  await expect(server).toContainText('1.0 MB');
  await expect(server).toContainText('30s');
  await expect(server.getByRole('button', { name: 'Copy URL' })).toBeVisible();

  // Decision metrics come first, analytics next, Access and Server last.
  const text = await main(page).innerText();
  expect(text.indexOf('Needs attention')).toBeLessThan(text.indexOf('Analytics'));
  expect(text.indexOf('Analytics')).toBeLessThan(text.indexOf('Signed in as'));

  // No primary action on the Overview, and no markup style attributes.
  await expect(page.getByTestId('primary-action')).toHaveCount(0);
  await expect(page.locator('main [style]')).toHaveCount(0);

  // The classic reads, each once: /overview, /metrics?window=24h, /reliability, /server, the shared
  // /profile, and the approvals badge's two reads (`refreshApprovalsBadge` ran on every Overview load).
  await expect(page.getByRole('table', { name: 'MCP reliability by server' })).toBeVisible();
  await expect.poll(() => reads.length).toBe(7);
  expect([...reads].sort()).toEqual(['/metrics?window=24h', '/overview', '/package-plans', '/privilege-grants', '/profile', '/reliability', '/server']);
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});

test('the expiring tile opens the workspace list filtered to the hour', async ({ page }) => {
  const problems = watchConsole(page);
  await openOverview(page, { '/workspaces': answer(200, { data: { workspaces: [] } }) });
  await page.getByRole('link', { name: /Expiring soon\s*3/ }).click();
  await expectPage(page, 'workspaces');
  await expect(page).toHaveURL(/\/dashboard\/workspaces\?expiring=60$/);
  await page.goBack();
  await expectPage(page, 'overview');
  await expect(page.getByRole('list', { name: 'Decision metrics' })).toBeVisible();
  expect(problems).toEqual([]);
});

test('charts have an accessible table fallback by caption and render under the CSP', async ({ page }) => {
  const problems = watchConsole(page);
  await openOverview(page);
  const analytics = page.getByRole('region', { name: 'Analytics' });
  // The scope the projection measured is stated, not a longer window.
  await expect(analytics).toContainText('retained agents, bucketed by start time');
  await expect(analytics).toContainText('keeps agent state and per-agent usage');
  await expect(analytics).toContainText('Scope: retained audit events in the last 24h');

  for (const caption of ['Retained audit events per bucket (24h)', 'Execution health over retained agents (retained agents, bucketed by start time)', 'Cost over retained agents (retained agents, bucketed by start time)']) {
    const figure = analytics.getByRole('figure', { name: caption });
    await expect(figure).toBeVisible();
    await figure.getByText('Show as table').click();
    await expect(figure.getByRole('table', { name: caption })).toBeVisible();
  }
  const cost = analytics.getByRole('table', { name: /^Cost over retained agents/ });
  await expect(cost.getByRole('row', { name: /08:00\s*1\.5 USD/ })).toBeVisible();

  for (const caption of ['Cost by model profile', 'Budget burn of running agents', 'Workspace expiry buckets', 'MCP reliability by server']) {
    await expect(analytics.getByRole('table', { name: caption })).toBeVisible();
  }
  await expect(analytics.getByRole('table', { name: 'Cost by model profile' })).toContainText('2.5 USD');
  await expect(analytics.getByRole('table', { name: 'Budget burn of running agents' })).toContainText('80% of cost limit');
  await expect(analytics.getByRole('table', { name: 'MCP reliability by server' })).toContainText('3 error(s), p50 40 ms, p95 120 ms');
  await expect(page.locator('main [style]')).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});

test('execution health names its categories in text, not colour only', async ({ page }) => {
  await openOverview(page);
  const figure = page.getByRole('figure', { name: /^Execution health over retained agents/ });
  const legend = figure.getByRole('list', { name: 'Legend' });
  for (const label of ['Succeeded', 'Failed / limit', 'Cancelled', 'Running']) await expect(legend.getByText(label, { exact: true })).toBeVisible();
  await figure.getByText('Show as table').click();
  const table = figure.getByRole('table');
  for (const label of ['Bucket', 'Succeeded', 'Failed / limit', 'Cancelled', 'Running']) await expect(table.getByRole('columnheader', { name: label, exact: true })).toBeVisible();
  await expect(table.getByRole('row', { name: /08:00\s*3\s*1\s*0\s*0/ })).toBeVisible();
});

test('empty projections explain themselves instead of inventing numbers', async ({ page }) => {
  const problems = watchConsole(page);
  await openOverview(page, {
    '/overview': answer(200, emptyOverviewProjection),
    '/metrics': answer(200, emptyMetricsProjection),
    '/reliability': answer(200, emptyReliabilityProjection)
  });
  await expect(page.getByText('Nothing needs attention right now.')).toBeVisible();
  await expect(page.getByText('Nothing needs action right now.')).toBeVisible();
  for (const note of ['No workspaces are close to expiry.', 'No retained events in this window.', 'No agents are on record yet.', 'No agent usage is on record yet.', 'No agent usage reported yet.', 'No running agents report a budget.', 'No gateway traces reported yet.']) {
    await expect(main(page).getByText(note).first()).toBeVisible();
  }
  await expect(page.getByRole('region', { name: 'Analytics' })).toContainText('no agents on record');
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});

test('a missing cost renders "Not reported"', async ({ page }) => {
  await openOverview(page, { '/overview': answer(200, { data: { attention: [], expiring: [] } }) });
  await expect(page.getByRole('link', { name: /Cost\s*Not reported/ })).toContainText('scope: not reported');
});

test('shows a skeleton while the overview loads, then the content', async ({ page }) => {
  await openOverview(page, { '/overview': answer(200, overviewProjection, { delayMs: 800 }) });
  await expect(page.getByRole('status', { name: 'Loading overview' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Decision metrics' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('status', { name: 'Loading overview' })).toHaveCount(0);
});

test('a failed overview read offers Retry while Access and Server still render', async ({ page }) => {
  const problems = watchConsole(page, { allow: [/Failed to load resource/] });
  // Reads retry 5xx on their own, so the read keeps failing until the operator retries.
  let healthy = false;
  await openOverview(page, {
    '/overview': (route) => answer(healthy ? 200 : 500, healthy ? overviewProjection : { error: 'internal_error' })(route)
  });
  const alert = page.getByRole('alert').filter({ hasText: 'The server could not answer' });
  await expect(alert).toBeVisible({ timeout: 10_000 });
  await expect(main(page)).not.toContainText('internal_error');
  await expect(page.getByRole('region', { name: 'Server' })).toContainText('0.72.0');
  await expect(page.getByRole('region', { name: 'Access' })).toContainText('owner@example.test');
  healthy = true;
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('list', { name: 'Decision metrics' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});

test('a failed metrics or reliability read fails only its own chart', async ({ page }) => {
  const problems = watchConsole(page, { allow: [/Failed to load resource/] });
  await openOverview(page, {
    '/metrics': answer(503, { error: 'unavailable', message: 'unavailable' }),
    '/reliability': answer(500, { error: 'internal_error' }),
    '/server': answer(500, { error: 'internal_error' })
  });
  const analytics = page.getByRole('region', { name: 'Analytics' });
  await expect(analytics.getByRole('alert')).toHaveCount(2, { timeout: 10_000 });
  await expect(analytics.getByRole('table', { name: 'Cost by model profile' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Server' }).getByRole('alert')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Decision metrics' })).toBeVisible();
  expect(problems).toEqual([]);
});

test('renders hostile projection fields as text', async ({ page }) => {
  const problems = watchConsole(page);
  await openOverview(page, { '/overview': answer(200, hostileOverviewProjection) });
  const attention = page.getByRole('region', { name: 'Needs attention' });
  await expect(attention.getByText(HOSTILE).first()).toBeVisible();
  // An unsafe link target is rendered as plain text, never as a link.
  await expect(attention.getByRole('link')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Cost/ })).toContainText(`scope: ${HOSTILE}`);
  await expect(page.getByRole('region', { name: 'Analytics' })).toContainText(HOSTILE);
  await expect(main(page).locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(problems).toEqual([]);
});

test('fits a 375px viewport without page-level horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openOverview(page);
  await expect(page.getByRole('table', { name: 'MCP reliability by server' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoSeriousA11yViolations(page);
});
