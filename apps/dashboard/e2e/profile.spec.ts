import { expect, type Page, test } from '@playwright/test';
import { answer, expectNoSeriousA11yViolations, stubReads, watchConsole } from './support';
import { PROFILE_BODY, SIGNED_IN } from './fixtures/profile';

// Profile: the verified identity, the display name (real `PUT /preferences` cookie round trip
// through the test API) and the settings link.

async function expectProfilePage(page: Page) {
  await expect(page.locator('[data-testid=page-frame]')).toHaveAttribute('data-page-id', 'profile');
  await expect(page.getByTestId('page-title')).toHaveText('Profile');
  await expect(page).toHaveTitle(/(^| · )Profile \| Cloud Harness$/);
}

test('shows the verified identity, one profile read for page and chip, no primary action', async ({ page }) => {
  const problems = watchConsole(page);
  const profileReads: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/dashboard/api/v1/profile') profileReads.push(request.method()); });
  const seen = await stubReads(page);
  await page.goto('/dashboard/profile');
  await expectProfilePage(page);
  const main = page.locator('main');
  await expect(main).toContainText(SIGNED_IN.email);
  await expect(main).toContainText(SIGNED_IN.subject);
  await expect(main).toContainText(SIGNED_IN.issuer);
  await expect(main).toContainText('Single sign-on');
  await expect(page.getByRole('textbox', { name: /^Display name/ })).toHaveAttribute('placeholder', SIGNED_IN.email);
  await expect(page.getByTestId('display-name-chip')).toContainText(SIGNED_IN.email);
  await expect(page.getByTestId('primary-action')).toHaveCount(0);
  await expect(page.locator('main [style]')).toHaveCount(0);
  expect(profileReads).toEqual(['GET']);
  expect(seen).toEqual([]);
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});

test('saving the display name shows saving then saved and updates the top-bar chip', async ({ page }) => {
  const problems = watchConsole(page);
  await stubReads(page);
  const writes: Array<{ body: unknown; csrf: boolean }> = [];
  await page.route('**/dashboard/api/v1/preferences', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    writes.push({ body: route.request().postDataJSON() as unknown, csrf: Boolean(route.request().headers()['x-csrf-token']) });
    await new Promise((resolve) => setTimeout(resolve, 600));
    return route.fallback();
  });
  await page.goto('/dashboard/profile');
  await expectProfilePage(page);

  const field = page.getByRole('textbox', { name: /^Display name/ });
  await field.fill('Ops Lead');
  const save = page.getByTestId('save-display-name');
  await save.click();
  await expect(save).toHaveAttribute('data-state', 'pending');
  await expect(save).toHaveAttribute('data-state', 'success');
  await expect(page.getByTestId('display-name-status')).toHaveText('Display name updated.');
  await expect(page.getByTestId('display-name-chip')).toContainText('Ops Lead');
  await expect(field).toHaveValue('Ops Lead');

  await page.getByRole('button', { name: 'Use sign-on name' }).click();
  await expect(page.getByTestId('display-name-status')).toHaveText('Display name reset to your sign-on name.');
  await expect(page.getByTestId('display-name-chip')).toContainText(SIGNED_IN.email);
  await expect(field).toHaveValue('');

  expect(writes).toEqual([{ body: { displayName: 'Ops Lead' }, csrf: true }, { body: { displayName: '' }, csrf: true }]);
  expect(problems).toEqual([]);
});

test('an invalid display name is refused inline before any request', async ({ page }) => {
  await stubReads(page);
  let writes = 0;
  await page.route('**/dashboard/api/v1/preferences', async (route) => {
    if (route.request().method() === 'PUT') writes += 1;
    return route.fallback();
  });
  await page.goto('/dashboard/profile');
  await expectProfilePage(page);
  const field = page.getByRole('textbox', { name: /^Display name/ });
  await field.fill('<script>');
  await field.press('Enter');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('display-name-status')).toHaveText('Fix the display name before saving.');
  expect(writes).toBe(0);
});

test('the settings link opens Settings', async ({ page }) => {
  await stubReads(page);
  await page.goto('/dashboard/profile');
  await expectProfilePage(page);
  await page.locator('main').getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/settings$/);
  await expect(page.getByTestId('page-title')).toHaveText('Settings');
});

test('loading shows a skeleton and a forbidden read shows the error state', async ({ page }) => {
  const problems = watchConsole(page, { allow: [/Failed to load resource/] });
  await stubReads(page);
  let calls = 0;
  await page.route('**/dashboard/api/v1/profile', async (route) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (calls === 1) return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'forbidden' }) });
    return answer(200, PROFILE_BODY)(route);
  });
  await page.goto('/dashboard/profile');
  await expect(page.getByRole('status', { name: 'Loading profile' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Not allowed' })).toBeVisible();
  expect(problems).toEqual([]);
});
