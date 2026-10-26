import { expect, type Page, test } from '@playwright/test';
import { answer, expectPage, watchConsole } from './support';
import { watchForLeaks } from './write-support';

// Negative security checks against the real in-process BFF: reads are stubbed so the page
// renders, but every write goes to the real API, whose session, CSRF and Origin checks run
// before any handler. The runner is unreachable on purpose, so a write that passes them
// fails later with a server error, never a 401 or 403.

const API = '/dashboard/api/v1';
const CANARY = 'sk-e2e-canary-not-a-real-key-7f3a';
const CREDENTIAL = { label: 'Canary', provider: 'openai', authMode: 'bearer', apiKey: CANARY };

async function realWrites(page: Page, { sessionAnswer }: { sessionAnswer?: () => boolean } = {}) {
  const seen = { sessions: 0, writes: 0 };
  await page.route(`**${API}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice(API.length);
    if (path === '/session') {
      seen.sessions += 1;
      if (sessionAnswer?.()) return answer(401, { error: 'session_ended' })(route);
      return route.fallback();
    }
    if (path === '/profile' || path === '/preferences') return route.fallback();
    if (request.method() === 'GET') {
      if (path === '/provider-credentials') return answer(200, { data: { credentials: [] } })(route);
      if (path === '/agent-model-profiles') return answer(200, { data: { profiles: [] } })(route);
      if (path === '/model-spend') return answer(200, { data: { summary: { isEstimate: true, windows: [] } } })(route);
      return answer(200, { data: {} })(route);
    }
    seen.writes += 1;
    return route.fallback();
  });
  return seen;
}

/** A write sent from the page itself, so it carries the page's session cookie. */
function pageWrite(page: Page, headers: Record<string, string>) {
  return page.evaluate(async ({ url, body, headers: extra }) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...extra }, body: JSON.stringify(body) });
    return { status: response.status, text: await response.text() };
  }, { url: `${API}/provider-credentials`, body: CREDENTIAL, headers });
}

test.beforeEach(async ({ page }) => {
  watchConsole(page, { allow: [/Failed to load resource/] });
});

test('a write without the CSRF token, or with a wrong one, is refused with 403', async ({ page }) => {
  await realWrites(page);
  await page.goto('/dashboard/models');
  await expectPage(page, 'models');
  const session = await page.evaluate(async (url) => (await fetch(url)).status, `${API}/session`);
  expect(session).toBe(200);
  for (const headers of [{}, { 'x-csrf-token': 'not-the-session-token' }]) {
    const result = await pageWrite(page, headers);
    expect(result.status).toBe(403);
    expect(JSON.parse(result.text)).toEqual({ error: 'csrf_failed' });
    expect(result.text).not.toContain(CANARY);
  }
  // The same write with the session's own token passes the checks and fails only at the runner.
  const token = await page.evaluate(async (url) => ((await (await fetch(url)).json()) as { csrfToken: string }).csrfToken, `${API}/session`);
  const accepted = await pageWrite(page, { 'x-csrf-token': token });
  expect([401, 403]).not.toContain(accepted.status);
  expect(accepted.text).not.toContain(CANARY);
});

test('a write from another Origin is refused with 403 before any session check', async ({ page }) => {
  await realWrites(page);
  await page.goto('/dashboard/models');
  await expectPage(page, 'models');
  const response = await page.request.post(`${API}/provider-credentials`, {
    headers: { origin: 'https://attacker.example.test', 'content-type': 'application/json' },
    data: CREDENTIAL
  });
  expect(response.status()).toBe(403);
  expect(await response.json()).toEqual({ error: 'forbidden_origin' });
  expect(await response.text()).not.toContain(CANARY);
});

test('a write whose session expired re-authenticates once and is sent once more', async ({ page, context }) => {
  const seen = await realWrites(page);
  const leaks = watchForLeaks(page);
  await page.goto('/dashboard/models');
  await expectPage(page, 'models');
  await page.getByTestId('primary-action').click();
  const dialog = page.getByTestId('credential-dialog');
  await dialog.getByLabel('Label').fill('Canary');
  // A first save opens the session (it fails at the unreachable runner).
  await dialog.getByLabel('API key (write-only)').fill(CANARY);
  await dialog.getByRole('button', { name: 'Save credential' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible({ timeout: 15_000 });
  // Then the session cookie disappears (expiry) before the next save.
  await dialog.getByLabel('API key (write-only)').fill(CANARY);
  const before = { ...seen };
  await context.clearCookies();
  await dialog.getByRole('button', { name: 'Save credential' }).click();
  await expect.poll(() => seen.writes - before.writes).toBe(2);
  // The runner is unreachable, so the save fails visibly after the re-authenticated retry.
  await expect(dialog.getByRole('alert')).toBeVisible({ timeout: 15_000 });
  expect(seen.sessions - before.sessions).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId('session-ended')).toBeHidden();
  // The key left the field when it was sent.
  await expect(dialog.getByLabel('API key (write-only)')).toHaveValue('');
  await leaks.assertClean(CANARY);
});

test('a write whose session cannot be renewed shows the sign-in path and keeps no key', async ({ page, context }) => {
  let ended = false;
  await realWrites(page, { sessionAnswer: () => ended });
  const leaks = watchForLeaks(page);
  await page.goto('/dashboard/models');
  await expectPage(page, 'models');
  await page.getByTestId('primary-action').click();
  const dialog = page.getByTestId('credential-dialog');
  await dialog.getByLabel('Label').fill('Canary');
  await dialog.getByLabel('API key (write-only)').fill(CANARY);
  await dialog.getByRole('button', { name: 'Save credential' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible({ timeout: 15_000 });
  await dialog.getByLabel('API key (write-only)').fill(CANARY);
  await context.clearCookies();
  ended = true;
  await dialog.getByRole('button', { name: 'Save credential' }).click();
  await expect(page.getByTestId('session-ended')).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByLabel('API key (write-only)')).toHaveValue('');
  await leaks.assertClean(CANARY);
});
