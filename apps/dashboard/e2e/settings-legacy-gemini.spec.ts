import { expect, type Page, test } from '@playwright/test';
import { answer, stubReads } from './support';
import { oauthBody, settingsBody, TYPESAFE_CREDENTIALS, TYPESAFE_STATUS } from './fixtures/settings';

// The legacy shell's Connect Gemini panel: one-time credentials live only in two inputs and
// are wiped on dismiss and on every Settings re-render; an answer that arrives after a
// re-render is dropped.

const REDIRECT_URI = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-abc123';
const SECRET = 'legacy-gemini-secret-value';

async function openLegacySettings(page: Page, delayMs = 0) {
  await stubReads(page, {
    '/settings': answer(200, settingsBody()),
    '/settings/oauth': answer(200, oauthBody()),
    '/typesafe/status': answer(200, TYPESAFE_STATUS),
    '/integration-credentials': answer(200, TYPESAFE_CREDENTIALS)
  });
  const writes: unknown[] = [];
  await page.route('**/dashboard/api/v1/settings/oauth/clients', async (route) => {
    writes.push(route.request().postDataJSON());
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { client: 'gemini', clientId: 'client-9', clientSecret: SECRET, clientName: 'x', redirectUri: REDIRECT_URI, tokenEndpointAuthMethod: 'client_secret_post' }, truncated: false })
    }).catch(() => undefined);
  });
  await page.goto('/dashboard/settings?ui=legacy');
  await page.waitForURL(/\/dashboard\/settings$/);
  return writes;
}

test('legacy shell: Connect Gemini validates, shows credentials once, and clears them on dismiss and re-render', async ({ page }) => {
  const writes = await openLegacySettings(page);
  await page.locator('#settings-oauth-gemini-uri').fill('https://bad.example/r/x');
  await page.locator('#create-settings-oauth-gemini').click();
  await expect(page.locator('#settings-oauth-status')).toContainText('Paste the redirect URI from Gemini');
  expect(writes).toHaveLength(0);

  await page.locator('#settings-oauth-gemini-uri').fill(REDIRECT_URI);
  await page.locator('#create-settings-oauth-gemini').click();
  await expect(page.locator('#settings-oauth-gemini-secret')).toHaveValue(SECRET);
  await page.locator('#dismiss-settings-oauth-gemini').click();
  await expect(page.locator('#settings-oauth-gemini-result')).toBeHidden();
  await expect(page.locator('#settings-oauth-gemini-secret')).toHaveValue('');

  await page.locator('#settings-oauth-gemini-uri').fill(REDIRECT_URI);
  await page.locator('#create-settings-oauth-gemini').click();
  await expect(page.locator('#settings-oauth-gemini-secret')).toHaveValue(SECRET);
  await page.locator('#reload-settings-oauth').click();
  await expect(page.locator('#settings-oauth-status')).toHaveText('Reloaded from the provider.');
  await expect(page.locator('#settings-oauth-gemini-result')).toBeHidden();
  await expect(page.locator('#settings-oauth-gemini-secret')).toHaveValue('');
  expect(await page.content()).not.toContain(SECRET);
  expect(writes).toEqual([{ client: 'gemini', redirectUri: REDIRECT_URI }, { client: 'gemini', redirectUri: REDIRECT_URI }]);
});

test('legacy shell: an answer that arrives after Settings re-rendered is dropped', async ({ page }) => {
  const writes = await openLegacySettings(page, 1_500);
  await page.locator('#settings-oauth-gemini-uri').fill(REDIRECT_URI);
  await page.locator('#create-settings-oauth-gemini').click();
  await page.locator('#reload-settings-oauth').click();
  await expect(page.locator('#settings-oauth-status')).toHaveText('Reloaded from the provider.');
  await expect.poll(() => writes.length).toBe(1);
  await page.waitForTimeout(2_000);
  await expect(page.locator('#settings-oauth-gemini-result')).toBeHidden();
  await expect(page.locator('#settings-oauth-gemini-secret')).toHaveValue('');
  expect(await page.content()).not.toContain(SECRET);
});

test('legacy shell: an answer that arrives after navigation starts, while Settings is still on screen, is dropped', async ({ page }) => {
  const registration = Promise.withResolvers<void>();
  const destination = Promise.withResolvers<void>();
  await stubReads(page, {
    '/settings': answer(200, settingsBody()),
    '/settings/oauth': answer(200, oauthBody()),
    '/typesafe/status': answer(200, TYPESAFE_STATUS),
    '/integration-credentials': answer(200, TYPESAFE_CREDENTIALS)
  });
  let posted = false;
  await page.route('**/dashboard/api/v1/settings/oauth/clients', async (route) => {
    posted = true;
    await registration.promise;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { client: 'gemini', clientId: 'client-9', clientSecret: SECRET, clientName: 'x', redirectUri: REDIRECT_URI, tokenEndpointAuthMethod: 'client_secret_post' }, truncated: false })
    }).catch(() => undefined);
  });
  // The Audit page replaces Settings only after its read returns; hold that read open.
  await page.route('**/dashboard/api/v1/audit**', async (route) => {
    await destination.promise;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { events: [] }, truncated: false }) }).catch(() => undefined);
  });
  await page.goto('/dashboard/settings?ui=legacy');
  await page.waitForURL(/\/dashboard\/settings$/);
  await page.locator('#settings-oauth-gemini-uri').fill(REDIRECT_URI);
  await page.locator('#create-settings-oauth-gemini').click();
  await expect.poll(() => posted).toBe(true);
  // In-page navigation to Audit, which replaces Settings only after its own read returns.
  await page.evaluate(() => { history.pushState({}, '', '/dashboard/audit'); dispatchEvent(new PopStateEvent('popstate')); });
  await page.waitForURL(/\/dashboard\/audit/);
  await expect(page.locator('#settings-oauth-gemini-form')).toHaveCount(1);
  // Settings is still rendered while the Audit read is pending; the registration answers now.
  registration.resolve();
  await page.waitForTimeout(500);
  await expect(page.locator('#settings-oauth-gemini-result')).toBeHidden();
  await expect(page.locator('#settings-oauth-gemini-secret')).toHaveValue('');
  expect(await page.content()).not.toContain(SECRET);
  destination.resolve();
  await expect(page.locator('#settings-oauth-gemini-form')).toHaveCount(0);
  expect(await page.content()).not.toContain(SECRET);
});
