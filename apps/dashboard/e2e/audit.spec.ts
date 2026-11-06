import { expect, type Page, type Route, test } from '@playwright/test';
import { AUDIT_PAGE_1, AUDIT_PAGE_2, EMPTY_AUDIT, FIRST_CURSOR } from './fixtures/audit';
import { answer, expectNoSeriousA11yViolations, stubReads, watchConsole } from './support';

// Audit: retained redacted history, paged forward with the opaque cursor kept in the URL.

const API = '/dashboard/api/v1';

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

function auditPages(route: Route) {
  const cursor = new URL(route.request().url()).searchParams.get('cursor');
  return answer(200, cursor === FIRST_CURSOR ? AUDIT_PAGE_2 : AUDIT_PAGE_1)(route);
}

/** Audit is not in the support page table: it sits under Activity in the nav. */
async function expectAuditPage(page: Page) {
  await expect(page.locator('[data-testid=page-frame]')).toHaveAttribute('data-page-id', 'audit');
  await expect(page.getByTestId('page-title')).toHaveText('Audit');
  await expect(page).toHaveTitle(/(^| · )Audit \| Cloud Harness$/);
}

test('cursor paging round-trips through the URL, reloads, and goes back', async ({ page }) => {
  const problems = watchConsole(page);
  const reads = recordReads(page);
  await stubReads(page, { '/audit': auditPages });
  await page.goto('/dashboard/audit');
  await expectAuditPage(page);

  const events = page.getByTestId('audit-event');
  await expect(events).toHaveCount(3);
  await expect(events.nth(0).getByRole('heading', { name: 'privilege_grant_approve' })).toBeVisible();
  await expect(page.getByText('3 most recent events')).toBeVisible();
  // Redacted details are text inside a disclosure.
  await events.nth(0).getByText('Redacted details').click();
  await expect(events.nth(0).locator('pre')).toContainText('"command": "<script>alert(1)</script>"');
  await expect(events.nth(2)).toContainText('No details recorded.');

  const pager = page.getByRole('navigation', { name: 'Audit pages' });
  await expect(pager.getByRole('button', { name: 'First page' })).toBeDisabled();
  expect(await page.getByTestId('primary-action').count()).toBeLessThanOrEqual(1);
  await expect(page.locator('main [style]')).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);
  expect(reads).toEqual(['/audit?limit=50']);

  await pager.getByRole('button', { name: 'Next page' }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/audit\\?cursor=${FIRST_CURSOR.replace(/[.]/g, '\\.')}$`));
  await expect(events).toHaveCount(1);
  await expect(events.nth(0)).toContainText('api_key_revoke');
  await expect(pager.getByRole('button', { name: 'Next page' })).toBeDisabled();
  expect(reads).toEqual(['/audit?limit=50', `/audit?limit=50&cursor=${FIRST_CURSOR}`]);

  await page.reload();
  await expectAuditPage(page);
  await expect(events).toHaveCount(1);
  await expect(events.nth(0)).toContainText('api_key_revoke');

  // Paging pushes history: Back returns to the first page.
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard\/audit$/);
  await expect(events).toHaveCount(3);

  await page.goForward();
  await expect(events).toHaveCount(1);
  await pager.getByRole('button', { name: 'First page' }).click();
  await expect(page).toHaveURL(/\/dashboard\/audit$/);
  await expect(events).toHaveCount(3);

  // Every read used the classic page size, and no page was fetched twice in one visit.
  expect(reads.every((read) => read.startsWith('/audit?limit=50'))).toBe(true);
  expect(problems).toEqual([]);
});

test('a malformed cursor in a deep link is dropped', async ({ page }) => {
  const reads = recordReads(page);
  await stubReads(page, { '/audit': auditPages });
  await page.goto('/dashboard/audit?cursor=%3Cscript%3E');
  await expectAuditPage(page);
  await expect(page.getByTestId('audit-event')).toHaveCount(3);
  // The malformed value never reaches the API.
  expect(reads).toEqual(['/audit?limit=50']);
});

test('loading, empty and error states', async ({ page }) => {
  const problems = watchConsole(page, { allow: [/Failed to load resource/] });
  let calls = 0;
  await stubReads(page, {
    '/audit': async (route) => {
      calls += 1;
      if (calls <= 3) return answer(503, { error: 'runner_unavailable', message: 'The runner is unavailable.' }, { delayMs: calls === 1 ? 600 : 0 })(route);
      return answer(200, EMPTY_AUDIT)(route);
    }
  });
  await page.goto('/dashboard/audit');
  await expectAuditPage(page);
  await expect(page.getByRole('status', { name: 'Loading audit events' })).toBeVisible();
  const alert = page.getByRole('alert').filter({ hasText: 'The server could not answer' });
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('No retained audit events')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Audit pages' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});

test('Activity links to the full audit history', async ({ page }) => {
  await stubReads(page, { '/audit': auditPages });
  await page.goto('/dashboard/activity');
  await page.getByRole('link', { name: 'Full audit history' }).click();
  await expectAuditPage(page);
  await expect(page.getByTestId('audit-event')).toHaveCount(3);
});
