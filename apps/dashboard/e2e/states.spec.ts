import { expect, type Page, test } from '@playwright/test';
import { answer, expectNoSeriousA11yViolations, expectPage, sidebarLink, stubReads, watchConsole } from './support';
import { stubBff, writesTo } from './write-support';

// Error classes, accessibility, reduced motion and what the Dashboard leaves in browser storage.

const ERROR_CASES = [
  { status: 401, body: { error: 'session_ended' }, kind: 'session', title: 'Your session ended' },
  { status: 403, body: { error: 'forbidden' }, kind: 'forbidden', title: 'Not allowed' },
  { status: 409, body: { error: 'conflict' }, kind: 'conflict', title: 'This changed elsewhere' },
  { status: 429, body: { error: 'rate_limited' }, kind: 'rate-limited', title: 'Too many requests', headers: { 'retry-after': '0' } },
  { status: 500, body: { error: 'internal_error' }, kind: 'server', title: 'The server could not answer' }
] as const;

for (const failure of ERROR_CASES) {
  test(`a ${failure.status} read renders the ${failure.kind} state`, async ({ page }) => {
    // The browser logs every non-2xx fetch; those are the expected answers here.
    const problems = watchConsole(page, { allow: [/Failed to load resource/] });
    await stubReads(page, { '/projects': answer(failure.status, failure.body, { headers: 'headers' in failure ? failure.headers : {} }) });
    await page.goto('/dashboard/projects');
    await expectPage(page, 'projects');
    const alert = page.getByRole('alert').filter({ hasText: failure.title });
    await expect(alert).toBeVisible({ timeout: 10_000 });
    await expect(alert).toHaveAttribute('data-error-kind', failure.kind);
    if (failure.status === 401) {
      await expect(page.getByTestId('session-ended')).toBeVisible();
      await expect(alert.getByRole('button', { name: 'Reload' })).toBeVisible();
    } else if (failure.status === 403) {
      await expect(alert.getByRole('button')).toHaveCount(0);
    } else {
      await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
    }
    // The raw server body never reaches the page.
    await expect(page.locator('main')).not.toContainText(failure.body.error);
    await expectNoSeriousA11yViolations(page);
    expect(problems).toEqual([]);
  });
}

test('the real per-principal limit answers 429 once the owner exhausts the minute, and only for that owner', async ({ page, browser }) => {
  // Nothing is stubbed for /profile: every request below goes through the API's own limiter.
  await stubReads(page);
  await page.goto('/dashboard/projects');
  await expectPage(page, 'projects');
  let limited: Awaited<ReturnType<typeof page.request.get>> | undefined;
  let sent = 0;
  while (!limited && sent < 200) {
    const response = await page.request.get('/dashboard/api/v1/profile');
    sent += 1;
    if (response.status() === 429) limited = response;
    else expect(response.status()).toBe(200);
  }
  // The page already spent part of this owner's 120-request minute; the limit then holds.
  expect(sent).toBeLessThanOrEqual(120);
  expect(limited?.headers()['retry-after']).toBe('1');
  expect(await limited?.json()).toEqual({ error: 'rate_limited' });
  expect((await page.request.get('/dashboard/api/v1/profile')).status()).toBe(429);

  // Another signed-in owner (its own context, so its own Access subject) is not affected.
  const other = await browser.newContext();
  try {
    expect((await other.request.get('/dashboard/api/v1/profile')).status()).toBe(200);
  } finally {
    await other.close();
  }
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`shell, palette and mobile drawer are axe clean (${colorScheme})`, async ({ page }) => {
    // Reduced motion: an overlay caught before its fade starts misreports contrast under load.
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await stubReads(page, { '/workspaces': answer(200, { data: { workspaces: [{ workspaceId: 'ws_statesstatesstate01', repositoryUrl: 'https://github.com/acme/demo.git', status: 'ACTIVE' }] } }) });
    await page.goto('/dashboard/workspaces?q=demo');
    await expectPage(page, 'workspaces');
    await expect(page.locator('main table caption')).toHaveText('1 workspaces');
    await expectNoSeriousA11yViolations(page);

    await page.getByRole('button', { name: 'Search pages and commands' }).click();
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Search pages and commands' })).toBeFocused();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: /open navigation/i }).click();
    const drawer = page.getByRole('dialog', { name: 'Cloud Harness' });
    await expect(drawer).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await drawer.getByRole('link', { name: 'Agents' }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByTestId('page-title')).toHaveText('Agents');
  });
}

test('reduced motion turns off transitions and the progress sweep', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await stubReads(page);
  await page.goto('/dashboard');
  await expectPage(page, 'overview');
  await page.getByRole('button', { name: 'Search pages and commands' }).click();
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  // Nothing is left animating a frame after the dialog opens.
  const running = await page.evaluate(() => new Promise<number>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.getAnimations().filter((animation) => {
      const timing = animation.effect?.getComputedTiming();
      return animation.playState === 'running' && Number(timing?.duration ?? 0) > 1 && timing?.iterations !== Infinity;
    }).length)));
  }));
  expect(running).toBe(0);
  const sweep = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'progress-indeterminate';
    document.body.append(probe);
    const name = getComputedStyle(probe).animationName;
    probe.remove();
    return name;
  });
  expect(sweep).toBe('none');
});

test('browser storage holds only display preferences and scroll positions', async ({ page }) => {
  await stubReads(page, { '/github': answer(200, { data: { installations: [] } }) });
  let csrfToken = '';
  page.on('response', async (response) => {
    if (response.url().endsWith('/api/v1/session') && response.ok()) csrfToken = String((await response.json() as { csrfToken?: string }).csrfToken ?? '');
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/dashboard/integrations/github');
  await expectPage(page, 'github');

  // Exercise every writer: a mutation (CSRF bootstrap), sidebar, display preferences, navigation.
  await page.getByRole('button', { name: 'Dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: /collapse sidebar/i }).click();
  await expect(page.locator('html')).toHaveAttribute('data-sidebar', 'collapsed');
  await sidebarLink(page, 'agents').click();
  await expectPage(page, 'agents');
  await page.goBack();
  await expectPage(page, 'github');
  await expect.poll(() => csrfToken).not.toBe('');

  const storage = await page.evaluate(() => {
    const dump = (area: Storage) => Object.fromEntries(Array.from({ length: area.length }, (_, index) => {
      const key = area.key(index)!;
      return [key, area.getItem(key) ?? ''];
    }));
    return { local: dump(localStorage), session: dump(sessionStorage) };
  });
  expect(Object.keys(storage.local).sort()).toEqual(['ch-dashboard-preferences']);
  expect(Object.keys(JSON.parse(storage.local['ch-dashboard-preferences']!)).sort()).toEqual(['contrast', 'density', 'fontScale', 'sidebar', 'theme']);
  expect(Object.keys(storage.session).every((key) => key.startsWith('tsr-scroll-restoration'))).toBe(true);
  // No other browser store is used at all.
  const stores = await page.evaluate(async () => ({
    databases: (await indexedDB.databases()).map((database) => database.name ?? ''),
    caches: await caches.keys()
  }));
  expect(stores).toEqual({ databases: [], caches: [] });
  const everything = JSON.stringify(storage);
  for (const forbidden of [csrfToken, 'owner@example.test', 'e2e-owner']) {
    expect(everything.includes(forbidden), `storage must not contain ${forbidden === csrfToken ? 'the CSRF token' : forbidden}`).toBe(false);
  }
});

const GITHUB_STATUS = { '/github': answer(200, { data: { configured: true, installation: null, repositories: [] } }) };
const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize?client_id=e2e&state=server-bound';
const CANONICAL_GITHUB = (url: URL) => url.pathname === '/dashboard/integrations/github' && url.search === '';

/** Fulfils GitHub's own pages so a navigation away from the Dashboard stays inside the test. */
async function stubGitHubSite(page: Page) {
  await page.route('https://github.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>GitHub</title>' }));
}

async function expectNoCallbackInStorage(page: Page, values: string[]) {
  const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]));
  for (const value of values) expect(stored.includes(value), `storage must not contain ${value}`).toBe(false);
}

test('a fresh GitHub install authorizes once with its state and leaves for the returned GitHub URL', async ({ page, context }) => {
  const state = 'one-time-state-value-0123456789abcdef';
  await stubGitHubSite(page);
  const writes = await stubBff(page, { reads: GITHUB_STATUS, writes: { 'POST /github/authorize': answer(200, { data: { url: AUTHORIZE_URL, expiresAt: '2030-01-01T00:00:00.000Z' } }) } });
  await page.goto(`/dashboard/integrations/github?installation_id=4242&setup_action=install&state=${state}`);
  await page.waitForURL(AUTHORIZE_URL);
  expect(writesTo(writes, 'POST', '/github/authorize')).toHaveLength(1);
  expect(writesTo(writes, 'POST', '/github/authorize')[0]?.body).toEqual({ installationId: '4242', state });
  expect(writesTo(writes, 'POST', '/github/complete')).toHaveLength(0);
  // No hand-off: the browser is not pinned to the classic shell.
  expect((await context.cookies()).find((cookie) => cookie.name === 'ch-dashboard-ui')).toBeUndefined();
});

test('a GitHub install callback without a state asks to verify, then authorizes with the installation only', async ({ page }) => {
  await stubGitHubSite(page);
  const writes = await stubBff(page, { reads: GITHUB_STATUS, writes: { 'POST /github/authorize': answer(200, { data: { url: AUTHORIZE_URL, expiresAt: '2030-01-01T00:00:00.000Z' } }) } });
  await page.goto('/dashboard/integrations/github?installation_id=4242&setup_action=update');
  await page.waitForURL(CANONICAL_GITHUB);
  await expectPage(page, 'github');
  await expect(page.getByText('GitHub returned installation 4242 without a connection state.')).toBeVisible();
  expect(writesTo(writes, 'POST', '/github/authorize')).toHaveLength(0);
  await expectNoCallbackInStorage(page, ['4242']);
  await page.getByRole('button', { name: 'Verify with GitHub' }).click();
  await page.waitForURL(AUTHORIZE_URL);
  expect(writesTo(writes, 'POST', '/github/authorize')).toHaveLength(1);
  expect(writesTo(writes, 'POST', '/github/authorize')[0]?.body).toEqual({ installationId: '4242' });
});

test('an operator-actionable authorize failure is shown on the page', async ({ page }) => {
  const message = 'Finish the GitHub authorization in the browser that started it. Start the connection again.';
  const writes = await stubBff(page, { reads: GITHUB_STATUS, writes: { 'POST /github/authorize': answer(403, { error: 'forbidden', message }) } });
  await page.goto('/dashboard/integrations/github?installation_id=4242');
  await page.getByRole('button', { name: 'Verify with GitHub' }).click();
  await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible();
  expect(writesTo(writes, 'POST', '/github/authorize')).toHaveLength(1);
});

test('a GitHub OAuth return completes once with the state and code, and leaves nothing in the URL or storage', async ({ page, context }) => {
  const state = 'one-time-state-value-0123456789abcdef';
  const code = 'oauth-code-4242';
  const writes = await stubBff(page, { reads: GITHUB_STATUS, writes: { 'POST /github/complete': answer(200, { data: { ok: true } }) } });
  await page.goto(`/dashboard/integrations/github?code=${code}&state=${state}`);
  await page.waitForURL(CANONICAL_GITHUB);
  await expectPage(page, 'github');
  await expect.poll(() => writesTo(writes, 'POST', '/github/complete').length).toBe(1);
  expect(writesTo(writes, 'POST', '/github/complete')[0]?.body).toEqual({ state, code });
  expect(writesTo(writes, 'POST', '/github/authorize')).toHaveLength(0);
  expect((await context.cookies()).find((cookie) => cookie.name === 'ch-dashboard-ui')).toBeUndefined();
  await expectNoCallbackInStorage(page, [state, code]);
  expect(writesTo(writes, 'POST', '/github/complete')).toHaveLength(1);
});

test('a GitHub OAuth refusal shows a persistent message and sends nothing', async ({ page }) => {
  const writes = await stubBff(page, { reads: GITHUB_STATUS });
  await page.goto(`/dashboard/integrations/github?error=access_denied&error_description=Evil%20text&state=${'A'.repeat(43)}`);
  await page.waitForURL(CANONICAL_GITHUB);
  await expectPage(page, 'github');
  await expect(page.getByRole('alert').filter({ hasText: 'GitHub authorization was cancelled. The installation was not connected.' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Evil text');
  expect(writes).toEqual([]);
});

for (const query of ['state=short', 'setup_action=update', 'code=abc&state=short']) {
  test(`a GitHub callback with nothing valid to act on (${query}) is cleared from the URL and never sent`, async ({ page }) => {
    const writes = await stubBff(page, { reads: GITHUB_STATUS });
    await page.goto(`/dashboard/integrations/github?${query}`);
    await page.waitForURL(CANONICAL_GITHUB);
    await expectPage(page, 'github');
    expect(writesTo(writes, 'POST', '/github/complete')).toHaveLength(0);
    expect(writesTo(writes, 'POST', '/github/authorize')).toHaveLength(0);
  });
}

// The person's own GitHub user authorization card (#642).
const RENEWS_AT = 1_893_499_200_000; // 2030-01-01T12:00:00Z
const userStatus = (userAuthorization: unknown, extra: Record<string, unknown> = {}) => answer(200, { data: { configured: true, userAuthorizationConfigured: true, installation: null, repositories: [], userAuthorization, ...extra } });
const connectedUser = { status: 'connected', login: 'octo-cat', githubUserId: '583231', refreshExpiresAt: RENEWS_AT, reasonCode: null };
const revokedUser = (reasonCode: string) => ({ status: 'revoked', login: 'octo-cat', githubUserId: '583231', refreshExpiresAt: null, reasonCode });

test('a user who never connected connects as a GitHub user with exactly the user purpose', async ({ page, context }) => {
  await stubGitHubSite(page);
  const writes = await stubBff(page, { reads: { '/github': userStatus(null) }, writes: { 'POST /github/authorize': answer(200, { data: { url: AUTHORIZE_URL, expiresAt: '2030-01-01T00:00:00.000Z' } }) } });
  await page.goto('/dashboard/integrations/github');
  await expectPage(page, 'github');
  await expect(page.getByTestId('github-user').getByRole('button', { name: 'Connect as GitHub user' })).toBeEnabled();
  await page.getByRole('button', { name: 'Connect as GitHub user' }).click();
  await page.waitForURL(AUTHORIZE_URL);
  expect(writesTo(writes, 'POST', '/github/authorize')).toHaveLength(1);
  expect(writesTo(writes, 'POST', '/github/authorize')[0]?.body).toEqual({ purpose: 'user' });
  expect(writesTo(writes, 'POST', '/github/authorize')[0]?.csrf).toBeTruthy();
  expect((await context.cookies()).find((cookie) => cookie.name === 'ch-dashboard-ui')).toBeUndefined();
});

test('a disconnected user authorization offers Connect again', async ({ page }) => {
  await stubBff(page, { reads: { '/github': userStatus({ status: 'disconnected', login: 'octo-cat', githubUserId: '583231', refreshExpiresAt: null, reasonCode: null }) } });
  await page.goto('/dashboard/integrations/github');
  await expectPage(page, 'github');
  await expect(page.getByRole('button', { name: 'Connect as GitHub user' })).toBeVisible();
  await expect(page.getByTestId('github-user')).not.toContainText('@octo-cat');
});

test('a connected GitHub user shows the login and renewal date, and disconnects after a confirmation', async ({ page }) => {
  const writes = await stubBff(page, { reads: { '/github': [userStatus(connectedUser), userStatus(null)] }, writes: { 'POST /github/user/disconnect': userStatus(null) } });
  await page.goto('/dashboard/integrations/github');
  await expectPage(page, 'github');
  const card = page.getByTestId('github-user');
  await expect(card.getByTestId('github-user-connected')).toContainText('@octo-cat');
  await expect(card).toContainText('2030');
  await expect(card.getByRole('button', { name: 'Connect as GitHub user' })).toHaveCount(0);
  await card.getByRole('button', { name: 'Disconnect GitHub user @octo-cat' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('@octo-cat');
  expect(writesTo(writes, 'POST', '/github/user/disconnect')).toHaveLength(0);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Disconnect' }).click();
  await expect.poll(() => writesTo(writes, 'POST', '/github/user/disconnect').length).toBe(1);
  expect(writesTo(writes, 'POST', '/github/user/disconnect')[0]?.body).toEqual({});
  expect(writesTo(writes, 'POST', '/github/user/disconnect')[0]?.csrf).toBeTruthy();
  await expect(card.getByRole('button', { name: 'Connect as GitHub user' })).toBeVisible();
});

for (const [reasonCode, text] of [['bad_refresh_token', 'GitHub rejected the stored authorization'], ['refresh_token_expired', 'was not renewed in time']] as const) {
  test(`a revoked GitHub user (${reasonCode}) shows why, with Reconnect and Disconnect`, async ({ page }) => {
    await stubGitHubSite(page);
    const writes = await stubBff(page, { reads: { '/github': userStatus(revokedUser(reasonCode)) }, writes: { 'POST /github/authorize': answer(200, { data: { url: AUTHORIZE_URL, expiresAt: '2030-01-01T00:00:00.000Z' } }) } });
    await page.goto('/dashboard/integrations/github');
    await expectPage(page, 'github');
    const card = page.getByTestId('github-user');
    await expect(card.getByTestId('github-user-revoked-reason')).toContainText(text);
    await expect(card.getByRole('button', { name: 'Disconnect GitHub user @octo-cat' })).toBeVisible();
    await card.getByRole('button', { name: 'Reconnect' }).click();
    await page.waitForURL(AUTHORIZE_URL);
    expect(writesTo(writes, 'POST', '/github/authorize')[0]?.body).toEqual({ purpose: 'user' });
  });
}

test('without GitHub App client credentials the user card explains why Connect is disabled', async ({ page }) => {
  const writes = await stubBff(page, { reads: { '/github': userStatus(null, { userAuthorizationConfigured: false }) } });
  await page.goto('/dashboard/integrations/github');
  await expectPage(page, 'github');
  await expect(page.getByTestId('github-user').getByRole('button', { name: 'Connect as GitHub user' })).toBeDisabled();
  await expect(page.getByTestId('github-user-card-unconfigured')).toContainText('GITHUB_APP_CLIENT_ID');
  expect(writes).toEqual([]);
});

test('a user-purpose OAuth return renders the updated card without the page naming a purpose', async ({ page }) => {
  const state = 'one-time-state-value-0123456789abcdef';
  const code = 'oauth-code-4242';
  const writes = await stubBff(page, {
    reads: { '/github': [userStatus(null), userStatus(connectedUser)] },
    writes: { 'POST /github/complete': userStatus(connectedUser) }
  });
  await page.goto(`/dashboard/integrations/github?code=${code}&state=${state}`);
  await page.waitForURL(CANONICAL_GITHUB);
  await expect(page.getByTestId('github-user-connected')).toContainText('@octo-cat');
  expect(writesTo(writes, 'POST', '/github/complete')).toHaveLength(1);
  expect(writesTo(writes, 'POST', '/github/complete')[0]?.body).toEqual({ state, code });
  await expectNoCallbackInStorage(page, [state, code, '583231']);
});

test('a missing GitHub user authorization is shown with where to reconnect, on a read and on a write', async ({ page }) => {
  const required = { error: 'github_user_authorization_required', message: 'Your GitHub user authorization is required. Reconnect it in Integrations → GitHub → GitHub user.' };
  const problems = watchConsole(page, { allow: [/Failed to load resource/] });
  await stubReads(page, { '/projects': answer(403, required) });
  await page.goto('/dashboard/projects');
  await expectPage(page, 'projects');
  const alert = page.getByRole('alert').filter({ hasText: 'GitHub authorization required' });
  await expect(alert).toBeVisible({ timeout: 10_000 });
  await expect(alert).toHaveAttribute('data-error-kind', 'github-authorization');
  await expect(alert).toContainText('Integrations → GitHub → GitHub user');
  await expect(page.locator('main')).not.toContainText('github_user_authorization_required');
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);

  const writes = await stubBff(page, { reads: { '/github': userStatus(connectedUser) }, writes: { 'POST /github/user/disconnect': answer(403, required) } });
  await page.goto('/dashboard/integrations/github');
  await page.getByRole('button', { name: 'Disconnect GitHub user @octo-cat' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByText(required.message).first()).toBeVisible();
  expect(writesTo(writes, 'POST', '/github/user/disconnect')).toHaveLength(1);
});

test('the classic Dashboard link keeps the page query', async ({ page }) => {
  await stubReads(page);
  await page.goto('/dashboard/artifacts?cursor=c_42');
  await expectPage(page, 'artifacts');
  await expect(page.getByRole('link', { name: 'Use classic Dashboard' })).toHaveAttribute('href', '/dashboard/artifacts?cursor=c_42&ui=legacy');
});
