import { expect, test, type Page } from '@playwright/test';
import { answer, expectNoSeriousA11yViolations, expectPage, stubReads, watchConsole } from './support';
import { WORKSPACE_ID, workspacesList } from './fixtures/workspaces';

// The Workspaces list: one registry read, URL-bound filters, and the empty/error states.

const API = '/dashboard/api/v1';

function trackReads(page: Page): string[] {
  const reads: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.startsWith(`${API}/`) && !['/session', '/profile', '/preferences'].includes(url.pathname.slice(API.length))) {
      reads.push(`${url.pathname.slice(API.length)}${url.search}`);
    }
  });
  return reads;
}

const table = (page: Page) => page.getByRole('table');

test('lists workspaces with state, links to each cockpit and reads the list once', async ({ page }) => {
  const problems = watchConsole(page);
  const reads = trackReads(page);
  await stubReads(page, { '/workspaces': answer(200, workspacesList) });
  await page.goto('/dashboard/workspaces');
  await expectPage(page, 'workspaces');
  await expect(table(page).locator('caption')).toHaveText('3 workspaces');
  const row = table(page).getByRole('row', { name: /acme\/rocket/ });
  await expect(row).toContainText('active');
  await expect(row.getByRole('link', { name: 'acme/rocket' })).toHaveAttribute('href', `/dashboard/workspaces/${WORKSPACE_ID}`);
  await expect(page.getByTestId('primary-action')).toHaveCount(1);
  expect(reads.filter((read) => read === '/workspaces')).toHaveLength(1);
  expect(await page.locator('main [style]').count()).toBe(0);
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});

test('search, state and expiring filters round-trip through the URL and survive reload', async ({ page }) => {
  const reads = trackReads(page);
  await stubReads(page, { '/workspaces': answer(200, workspacesList) });
  await page.goto('/dashboard/workspaces');
  await expect(table(page).locator('caption')).toHaveText('3 workspaces');

  await page.getByLabel('State').selectOption('CLOSED');
  await expect(page).toHaveURL(/status=CLOSED/);
  await expect(table(page).locator('caption')).toHaveText('1 workspaces');
  await page.getByLabel('State').selectOption('');

  await page.getByRole('searchbox', { name: 'Search workspaces' }).fill('billing');
  await expect(page).toHaveURL(/q=billing/);
  await expect(table(page).locator('caption')).toHaveText('1 workspaces');
  await page.reload();
  await expect(page.getByRole('searchbox', { name: 'Search workspaces' })).toHaveValue('billing');
  await expect(table(page).locator('caption')).toHaveText('1 workspaces');

  await page.goto('/dashboard/workspaces?expiring=60');
  await expect(page.getByText('Expiring within 60 min')).toBeVisible();
  await expect(table(page).getByRole('row', { name: /acme\/billing/ })).toBeVisible();
  await expect(table(page).getByRole('row', { name: /acme\/rocket/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).toHaveURL(/\/dashboard\/workspaces$/);
  // Filtering is client-side over the one read: no refetch per keystroke or filter.
  expect(reads.every((read) => read === '/workspaces')).toBe(true);
});

test('an invalid filter in the URL is ignored, not applied', async ({ page }) => {
  await stubReads(page, { '/workspaces': answer(200, workspacesList) });
  await page.goto('/dashboard/workspaces?status=bogus&expiring=-5');
  await expect(table(page).locator('caption')).toHaveText('3 workspaces');
  await expect(page.getByLabel('State')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
});

test('empty, no-match and error states each explain themselves', async ({ page }) => {
  let calls = 0;
  await stubReads(page, {
    '/workspaces': (route) => {
      calls += 1;
      return calls === 1 ? answer(200, { data: { workspaces: [] } })(route) : answer(500, { error: 'INTERNAL', message: 'boom' })(route);
    }
  });
  await page.goto('/dashboard/workspaces');
  await expect(page.getByText('No workspaces yet')).toBeVisible();

  await page.unroute('**/dashboard/api/v1/**');
  await stubReads(page, { '/workspaces': answer(200, workspacesList) });
  await page.goto('/dashboard/workspaces?q=nothing-matches-this');
  await expect(page.getByText('No workspaces match these filters')).toBeVisible();

  await page.unroute('**/dashboard/api/v1/**');
  await stubReads(page, { '/workspaces': answer(503, { error: 'RUNNER_UNAVAILABLE', message: 'The runner is unavailable.' }) });
  await page.goto('/dashboard/workspaces');
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('alert').getByRole('button', { name: 'Retry' })).toBeVisible();
});
