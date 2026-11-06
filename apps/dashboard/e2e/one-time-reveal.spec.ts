import { expect, type Page, test } from '@playwright/test';
import { answer, expectPage, sidebarLink, watchConsole } from './support';
import { stubBff, watchForLeaks, writesTo } from './write-support';

// The one-time API key reveal (parity matrix D3): shown once, cleared on dismiss, on
// navigation, on reload and when the dashboard session ends, and never left in the DOM,
// Web Storage, IndexedDB, cookies, the console or a response the page reads afterwards.

// Obviously fake, but in the exact shape the page accepts.
const FAKE_KEY = `chm_key_apk_${'T'.repeat(24)}.${'e2eNotARealKey'.padEnd(43, 'x')}`;
const LIST = { data: { keys: [], readiness: { ready: true, publicUrl: 'https://harness.example.test/mcp' } } };
const META = { id: 'apk_e2e', name: 'CI client', displayPrefix: 'chm_key_apk_TTTT', state: 'ACTIVE', generation: 1, createdAt: Date.now(), expiresAt: Date.now() + 86_400_000, lastUsedAt: null, revokedAt: null };
const CREATED = answer(200, { data: { key: META, apiKey: FAKE_KEY } });

async function createKey(page: Page) {
  await page.getByTestId('primary-action').click();
  const dialog = page.getByTestId('api-key-create-dialog');
  await dialog.getByLabel('Key name').fill('CI client');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Create API key' }).click();
  const reveal = page.getByTestId('api-key-reveal-dialog');
  await expect(reveal.locator('[data-reveal=api-key]')).toHaveValue(FAKE_KEY);
  return reveal;
}

test('creating a key sends the legacy body and reveals the key once', async ({ page }) => {
  const problems = watchConsole(page);
  const leaks = watchForLeaks(page);
  const writes = await stubBff(page, { reads: { '/api-keys': answer(200, LIST) }, writes: { 'POST /api-keys': CREATED } });
  await page.goto('/dashboard/api-keys');
  await expectPage(page, 'api-keys');
  const reveal = await createKey(page);
  const [create] = writesTo(writes, 'POST', '/api-keys');
  expect(create?.body).toEqual({ name: 'CI client', expiresInDays: 30 });
  expect(create?.csrf).toBeTruthy();
  // Outside clicks do not dismiss a reveal; only the explicit acknowledgement does.
  await page.mouse.click(5, 5);
  await expect(reveal).toBeVisible();
  await reveal.getByRole('button', { name: 'I have saved it' }).click();
  await expect(reveal).toBeHidden();
  await leaks.assertClean(FAKE_KEY.slice(12));
  expect(problems).toEqual([]);
});

test('navigating away clears the reveal', async ({ page }) => {
  const leaks = watchForLeaks(page);
  await stubBff(page, { reads: { '/api-keys': answer(200, LIST) }, writes: { 'POST /api-keys': CREATED } });
  await page.goto('/dashboard/secrets');
  await expectPage(page, 'secrets');
  await sidebarLink(page, 'api-keys').click();
  await expectPage(page, 'api-keys');
  await createKey(page);
  // Browser back leaves the page under the open reveal.
  await page.goBack();
  await expectPage(page, 'secrets');
  await expect(page.getByTestId('api-key-reveal-dialog')).toBeHidden();
  await sidebarLink(page, 'api-keys').click();
  await expectPage(page, 'api-keys');
  await expect(page.getByTestId('api-key-reveal-dialog')).toBeHidden();
  await leaks.assertClean(FAKE_KEY.slice(12));
});

test('a reload drops the reveal', async ({ page }) => {
  await stubBff(page, { reads: { '/api-keys': answer(200, LIST) }, writes: { 'POST /api-keys': CREATED } });
  await page.goto('/dashboard/api-keys');
  await createKey(page);
  await page.reload();
  await expectPage(page, 'api-keys');
  await expect(page.getByTestId('api-key-reveal-dialog')).toBeHidden();
  const leaks = watchForLeaks(page);
  await leaks.assertClean(FAKE_KEY.slice(12));
});

test('the reveal clears when the dashboard session ends', async ({ page }) => {
  watchConsole(page, { allow: [/Failed to load resource/] });
  // The list refetch after the create answers late with "session ended".
  await stubBff(page, {
    reads: { '/api-keys': [answer(200, LIST), answer(401, { error: 'session_ended' }, { delayMs: 1_500 })] },
    writes: { 'POST /api-keys': CREATED }
  });
  await page.goto('/dashboard/api-keys');
  await expectPage(page, 'api-keys');
  await createKey(page);
  await expect(page.getByTestId('session-ended')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('api-key-reveal-dialog')).toBeHidden();
  const leaks = watchForLeaks(page);
  await leaks.assertClean(FAKE_KEY.slice(12));
});
