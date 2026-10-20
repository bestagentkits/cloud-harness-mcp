import { expect, type Page, test } from '@playwright/test';
import { ACTIVITY, AGENT_ID, EMPTY_ACTIVITY, GRANTS, PLANS } from './fixtures/activity';
import { answer, expectNoSeriousA11yViolations, expectPage, stubReads, watchConsole } from './support';

// Activity Center: the server-composed timeline, its URL-bound category filter, the live vs
// retained labelling, safe in-app links, and the read-only approvals summary.

const API = '/dashboard/api/v1';

/** Every BFF GET the page makes, as `path?query`, so duplicates and extra fan-out show up. */
function recordReads(page: Page): string[] {
  const reads: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.startsWith(API) && !['/session', '/profile', '/preferences'].includes(url.pathname.slice(API.length))) {
      reads.push(`${url.pathname.slice(API.length)}${url.search}`);
    }
  });
  return reads;
}

async function stubActivity(page: Page, overrides: Parameters<typeof stubReads>[1] = {}) {
  return stubReads(page, { '/activity': answer(200, ACTIVITY), '/privilege-grants': answer(200, GRANTS), '/package-plans': answer(200, PLANS), ...overrides });
}

test('labels live rows apart from retained ones, links only to known in-app routes, and reads like the classic page', async ({ page }) => {
  const problems = watchConsole(page);
  const reads = recordReads(page);
  await stubActivity(page);
  await page.goto('/dashboard/activity');
  await expectPage(page, 'activity');

  const rows = page.getByTestId('activity-event');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0).getByTestId('activity-durability')).toHaveText('Live runtime');
  await expect(rows.nth(2).getByTestId('activity-durability')).toHaveText('Retained audit');
  await expect(page.locator('[data-durable=true]')).toHaveCount(3);
  await expect(page.locator('[data-durable=false]')).toHaveCount(2);
  await expect(page.getByText('Each row says which it is.')).toBeVisible();

  // The projection href becomes the in-app agent route; a hostile href renders no link at all.
  const open = rows.nth(0).getByRole('link', { name: /^Open/ });
  await expect(open).toHaveAttribute('href', `/dashboard/agents/${AGENT_ID}`);
  await expect(rows.nth(1).getByRole('link')).toHaveCount(0);
  await expect(page.locator('main a[href^="javascript:"]')).toHaveCount(0);
  // Markup in a summary is text.
  await expect(rows.nth(4)).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('main img')).toHaveCount(0);

  // Approvals: read-only count with a link to the inbox; deciding lives on the Approvals page.
  const summary = page.getByTestId('approvals-summary');
  await expect(summary).toContainText('2 approvals are waiting.');
  await expect(summary).toContainText('1 privilege request · 1 package plan');
  await expect(page.getByRole('link', { name: 'Open approvals' })).toHaveAttribute('href', '/dashboard/approvals');
  await expect(page.getByRole('button', { name: /approve|reject/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Full audit history' })).toHaveAttribute('href', '/dashboard/audit');

  expect(await page.getByTestId('primary-action').count()).toBeLessThanOrEqual(1);
  await expect(page.locator('main [style]')).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);

  // The classic page made exactly these three reads: no duplicate, no extra fan-out.
  expect([...reads].sort()).toEqual(['/activity', '/package-plans', '/privilege-grants']);

  await open.click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/agents/${AGENT_ID}$`));
  expect(problems).toEqual([]);
});

test('the category filter round-trips through the URL, survives a reload and never refetches', async ({ page }) => {
  const problems = watchConsole(page);
  const reads = recordReads(page);
  await stubActivity(page);
  await page.goto('/dashboard/activity');
  await expectPage(page, 'activity');
  const filters = page.getByRole('navigation', { name: 'Activity filters' });
  await expect(filters.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'page');
  await expect(filters.getByRole('link', { name: 'Agents (2)' })).toBeVisible();
  await expect(filters.getByRole('link', { name: 'Audit (1)' })).toBeVisible();

  await filters.getByRole('link', { name: 'Agents (2)' }).click();
  await expect(page).toHaveURL(/\/dashboard\/activity\?filter=agents$/);
  await expect(filters.getByRole('link', { name: 'Agents (2)' })).toHaveAttribute('aria-current', 'page');
  await expect(filters.getByRole('link', { name: 'All' })).not.toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('activity-event')).toHaveCount(2);
  await expect(page.getByText('workspace_open')).toHaveCount(0);
  // Filtering is client-side over the one read.
  expect(reads.filter((read) => read === '/activity')).toHaveLength(1);

  await page.reload();
  await expectPage(page, 'activity');
  await expect(page.getByTestId('activity-event')).toHaveCount(2);
  await expect(filters.getByRole('link', { name: 'Agents (2)' })).toHaveAttribute('aria-current', 'page');

  // An empty category explains itself and offers the way back.
  await filters.getByRole('link', { name: 'Deployments (0)' }).click();
  await expect(page).toHaveURL(/\?filter=deployments$/);
  await expect(page.getByText('No events in this view yet')).toBeVisible();
  await page.getByRole('link', { name: 'Show all events' }).click();
  await expect(page).toHaveURL(/\/dashboard\/activity$/);
  await expect(page.getByTestId('activity-event')).toHaveCount(5);
  expect(problems).toEqual([]);
});

for (const search of ['?filter=bogus', '?filter=all']) {
  test(`a deep link with ${search} shows all events`, async ({ page }) => {
    const reads = recordReads(page);
    await stubActivity(page);
    await page.goto(`/dashboard/activity${search}`);
    await expectPage(page, 'activity');
    await expect(page.getByTestId('activity-event')).toHaveCount(5);
    // The param never reaches an API request.
    expect(reads.some((read) => read.includes('filter'))).toBe(false);
    await expect(page.getByRole('navigation', { name: 'Activity filters' }).getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'page');
  });
}

test('loading, empty and error states', async ({ page }) => {
  const problems = watchConsole(page, { allow: [/Failed to load resource/] });
  let failures = 0;
  await stubActivity(page, {
    '/activity': async (route) => {
      failures += 1;
      // The first answer is slow (skeleton), then the read fails with a server error twice
      // (retries), then it succeeds with an empty timeline.
      if (failures <= 3) return answer(503, { error: 'runner_unavailable', message: 'The runner is unavailable.' }, { delayMs: failures === 1 ? 600 : 0 })(route);
      return answer(200, EMPTY_ACTIVITY)(route);
    }
  });
  await page.goto('/dashboard/activity');
  await expectPage(page, 'activity');
  await expect(page.getByRole('status', { name: 'Loading activity' })).toBeVisible();
  const alert = page.getByRole('alert').filter({ hasText: 'The server could not answer' });
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('main')).not.toContainText('runner_unavailable');
  // The approvals summary is independent of the timeline.
  await expect(page.getByTestId('approvals-summary')).toContainText('2 approvals are waiting.');
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('No activity yet')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});

test('a failed approvals read says so without hiding the timeline', async ({ page }) => {
  const problems = watchConsole(page, { allow: [/Failed to load resource/] });
  await stubActivity(page, { '/privilege-grants': answer(403, { error: 'forbidden' }), '/package-plans': answer(403, { error: 'forbidden' }) });
  await page.goto('/dashboard/activity');
  await expectPage(page, 'activity');
  await expect(page.getByTestId('activity-event')).toHaveCount(5);
  await expect(page.getByTestId('approvals-summary')).toContainText('Approvals could not be checked.');
  expect(problems).toEqual([]);
});

test('works at 375px without page-level horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await stubActivity(page);
  await page.goto('/dashboard/activity');
  await expectPage(page, 'activity');
  await expect(page.getByTestId('activity-event')).toHaveCount(5);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoSeriousA11yViolations(page);
});
