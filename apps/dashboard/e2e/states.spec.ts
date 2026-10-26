import { expect, test } from '@playwright/test';
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

test('a GitHub App callback completes once in the new Dashboard and cleans the URL', async ({ page, context }) => {
  const state = 'one-time-state-value-0123456789abcdef';
  const writes = await stubBff(page, { reads: { '/github': answer(200, { data: { configured: true, installation: null, repositories: [] } }) }, writes: { 'POST /github/complete': answer(200, { data: { ok: true } }) } });
  await page.goto(`/dashboard/integrations/github?installation_id=4242&setup_action=install&state=${state}`);
  // The React page answers the callback itself and replaces the URL with the canonical page.
  await page.waitForURL((url) => url.pathname === '/dashboard/integrations/github' && url.search === '');
  await expectPage(page, 'github');
  await expect.poll(() => writesTo(writes, 'POST', '/github/complete').length).toBe(1);
  expect(writesTo(writes, 'POST', '/github/complete')[0]?.body).toEqual({ state, installationId: '4242' });
  // No hand-off: the browser is not pinned to the classic shell.
  const cookies = await context.cookies();
  expect(cookies.find((cookie) => cookie.name === 'ch-dashboard-ui')).toBeUndefined();
  // The callback's one-time values never reach browser storage, and it is sent only once.
  const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
  expect(stored.includes(state)).toBe(false);
  expect(stored.includes('4242')).toBe(false);
  expect(writesTo(writes, 'POST', '/github/complete')).toHaveLength(1);
});

for (const query of ['installation_id=4242&setup_action=install', 'state=short&installation_id=4242', 'setup_action=update']) {
  test(`an invalid or incomplete GitHub callback (${query}) is cleared from the URL and never sent`, async ({ page }) => {
    const writes = await stubBff(page, { reads: { '/github': answer(200, { data: { configured: true, installation: null, repositories: [] } }) } });
    await page.goto(`/dashboard/integrations/github?${query}`);
    await page.waitForURL((url) => url.pathname === '/dashboard/integrations/github' && url.search === '');
    await expectPage(page, 'github');
    expect(writesTo(writes, 'POST', '/github/complete')).toHaveLength(0);
  });
}

test('the classic Dashboard link keeps the page query', async ({ page }) => {
  await stubReads(page);
  await page.goto('/dashboard/artifacts?cursor=c_42');
  await expectPage(page, 'artifacts');
  await expect(page.getByRole('link', { name: 'Use classic Dashboard' })).toHaveAttribute('href', '/dashboard/artifacts?cursor=c_42&ui=legacy');
});
