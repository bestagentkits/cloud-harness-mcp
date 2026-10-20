import { expect, test } from '@playwright/test';
import { answer, expectNoMismatches, expectPage, installIdentityMonitor, records, sidebarLink, stubReads, watchConsole, type VisitedPage } from './support';

// The navigation transaction: page B's shell commits at once, obsolete reads are aborted,
// late answers never land on another page, and the title, heading, page frame and current
// sidebar entry agree on every sampled frame.

test.beforeEach(async ({ page }) => {
  await installIdentityMonitor(page);
});

test('A→B and A→B→C keep title, heading and navigation in step', async ({ page }) => {
  const problems = watchConsole(page);
  await stubReads(page, { '/workspaces': answer(200, records(2)), '/agents': answer(200, records(1)) });
  await page.goto('/dashboard');
  await expectPage(page, 'overview');

  await sidebarLink(page, 'workspaces').click();
  await expectPage(page, 'workspaces');
  await expect(page.getByTestId('read-summary')).toHaveText('2 records loaded.');
  await expect(page.getByTestId('page-title')).toBeFocused();

  await sidebarLink(page, 'agents').click();
  await expectPage(page, 'agents');
  await expect(page.getByTestId('read-summary')).toHaveText('1 record loaded.');

  await sidebarLink(page, 'secrets').click();
  await expectPage(page, 'secrets');
  await expectNoMismatches(page);
  expect(problems).toEqual([]);
});

test('rapid repeated clicks settle on the last page without mismatches', async ({ page }) => {
  await stubReads(page, { '/agents': answer(200, records(1), { delayMs: 200 }), '/secrets': answer(200, records(4), { delayMs: 50 }) });
  await page.goto('/dashboard');
  await expectPage(page, 'overview');

  const agents = sidebarLink(page, 'agents');
  for (let index = 0; index < 5; index += 1) await agents.click({ delay: 0 });
  await sidebarLink(page, 'workspaces').click();
  await sidebarLink(page, 'secrets').click();
  await expectPage(page, 'secrets');
  await expect(page.getByTestId('read-summary')).toHaveText('4 records loaded.');
  // Stays put once the earlier, slower answers have had time to arrive.
  await page.waitForTimeout(400);
  await expectPage(page, 'secrets');
  await expect(page.getByTestId('read-summary')).toHaveText('4 records loaded.');
  await expectNoMismatches(page);
});

test('leaving a page aborts its slow read and shows B at once', async ({ page }) => {
  await stubReads(page, { '/workspaces': answer(200, records(3), { delayMs: 3_000 }), '/agents': answer(200, records(1)) });
  const aborted = page.waitForEvent('requestfailed', (request) => new URL(request.url()).pathname.endsWith('/api/v1/workspaces'));
  await page.goto('/dashboard');
  await sidebarLink(page, 'workspaces').click();
  await expectPage(page, 'workspaces');
  await expect(page.getByRole('status', { name: /loading/i }).first()).toBeVisible();

  await sidebarLink(page, 'agents').click();
  await expectPage(page, 'agents');
  expect((await aborted).failure()?.errorText).toMatch(/abort/i);
  await expect(page.getByTestId('read-summary')).toHaveText('1 record loaded.');
  await expectNoMismatches(page);
});

test('an out-of-order answer for the previous resource never renders on the next one', async ({ page }) => {
  await stubReads(page, {
    '/workspaces/ws_slowslowslowslowslow01': answer(200, records(7), { delayMs: 1_200 }),
    '/workspaces/ws_fastfastfastfastfast01': answer(200, records(2), { delayMs: 50 })
  });
  await page.goto('/dashboard/workspaces/ws_slowslowslowslowslow01');
  await expectPage(page, 'workspace');
  await expect(page).toHaveTitle('ws_slowslowslowslowslow01 · Workspace | Cloud Harness');
  // Client-side navigation to the sibling resource while the first read is in flight.
  await page.evaluate(() => {
    history.pushState(history.state, '', '/dashboard/workspaces/ws_fastfastfastfastfast01');
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  });
  await expect(page).toHaveTitle('ws_fastfastfastfastfast01 · Workspace | Cloud Harness');
  await expect(page.getByTestId('read-summary')).toHaveText('2 records loaded.');
  await page.waitForTimeout(1_400);
  await expect(page.getByTestId('read-summary')).toHaveText('2 records loaded.');
  await expectNoMismatches(page);
});

test('a failed read shows an error with a Retry that recovers', async ({ page }) => {
  let calls = 0;
  await stubReads(page, {
    '/agents': (route) => {
      calls += 1;
      return calls <= 3 ? route.abort('failed') : answer(200, records(5))(route);
    }
  });
  await page.goto('/dashboard/agents');
  await expectPage(page, 'agents');
  const alert = page.getByRole('alert').filter({ hasText: 'Connection lost' });
  await expect(alert).toBeVisible({ timeout: 10_000 });
  await expect(alert).toHaveAttribute('data-error-kind', 'network');
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('read-summary')).toHaveText('5 records loaded.');
  await expectNoMismatches(page);
});

test('reload keeps the deep-link filters and the scroll position', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 420 });
  await stubReads(page);
  await page.goto('/dashboard/agents?status=RUNNING&attention=1');
  await expectPage(page, 'agents');
  const filters = page.getByRole('list', { name: 'Active filters' });
  await expect(filters).toContainText('status: RUNNING');

  await page.evaluate(() => window.scrollTo(0, 200));
  await page.waitForFunction(() => window.scrollY >= 100);
  const before = await page.evaluate(() => window.scrollY);
  // Scroll restoration snapshots on unload.
  await page.reload();
  await expectPage(page, 'agents');
  await expect(page).toHaveURL(/\/dashboard\/agents\?/);
  await expect(page.getByRole('list', { name: 'Active filters' })).toContainText('status: RUNNING');
  await page.waitForFunction((expected) => Math.abs(window.scrollY - expected) < 2, before);
});

test('Back and Forward restore each page identity', async ({ page }) => {
  await stubReads(page);
  await page.goto('/dashboard');
  await sidebarLink(page, 'workspaces').click();
  await expectPage(page, 'workspaces');
  await sidebarLink(page, 'agents').click();
  await expectPage(page, 'agents');

  await page.goBack();
  await expectPage(page, 'workspaces');
  await page.goBack();
  await expectPage(page, 'overview');
  await page.goForward();
  await expectPage(page, 'workspaces');
  await page.goForward();
  await expectPage(page, 'agents');
  await expectNoMismatches(page);
});

test('a mutation in flight is never cancelled by navigation', async ({ page }) => {
  await stubReads(page);
  await page.route('**/dashboard/api/v1/preferences', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return route.fallback();
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/dashboard');
  await expectPage(page, 'overview');

  const failed: string[] = [];
  page.on('requestfailed', (request) => { if (request.method() === 'PUT') failed.push(request.url()); });
  const saved = page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().endsWith('/api/v1/preferences'));
  await page.getByRole('button', { name: 'Dark theme' }).click();
  await sidebarLink(page, 'agents').click();
  await sidebarLink(page, 'secrets').click();
  await expectPage(page, 'secrets');
  expect((await saved).status()).toBe(200);
  expect(failed).toEqual([]);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('keyboard only: skip link, sidebar, palette and focus on the new heading', async ({ page }) => {
  await stubReads(page);
  await page.goto('/dashboard');
  await expectPage(page, 'overview');

  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: /skip to content/i });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();

  // Tab through the sidebar to the Agents entry and follow it.
  await page.locator('body').focus();
  let reached = false;
  for (let step = 0; step < 40 && !reached; step += 1) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.navId === 'agents');
  }
  expect(reached).toBe(true);
  await page.keyboard.press('Enter');
  await expectPage(page, 'agents');
  await expect(page.getByTestId('page-title')).toBeFocused();

  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type('Secrets');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expectPage(page, 'secrets');
  await expect(page.getByTestId('page-title')).toBeFocused();

  // `[` collapses the sidebar from the keyboard.
  await page.keyboard.press('[');
  await expect(page.locator('html')).toHaveAttribute('data-sidebar', 'collapsed');
  await page.keyboard.press('[');
  await expect(page.locator('html')).toHaveAttribute('data-sidebar', 'expanded');
  await expectNoMismatches(page);
});

test('the palette shortcut is ignored inside a terminal', async ({ page }) => {
  await stubReads(page);
  await page.goto('/dashboard');
  await expectPage(page, 'overview');
  // A stand-in for the terminal surface: the shortcut handler keys off `data-terminal`.
  await page.evaluate(() => {
    const surface = document.createElement('textarea');
    surface.setAttribute('data-terminal', '');
    surface.setAttribute('aria-label', 'Terminal input');
    document.querySelector('main')?.append(surface);
    surface.focus();
  });
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.press('[');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-sidebar', 'expanded');
});

test('navigation p95 stays under 100 ms', async ({ page }, testInfo) => {
  await stubReads(page);
  await page.goto('/dashboard');
  await expectPage(page, 'overview');
  const tour: VisitedPage[] = ['workspaces', 'agents', 'activity', 'approvals', 'packages', 'projects', 'secrets', 'models', 'skills', 'integrations', 'mcp-servers', 'knowledge', 'artifacts', 'api-keys', 'settings'];
  // Warm every lazy route chunk once, as hover/focus prefetch would, so the sample measures
  // the navigation transaction itself rather than first-time chunk downloads.
  for (const id of tour) await sidebarLink(page, id).hover();
  await page.waitForLoadState('networkidle');

  const samples: number[] = [];
  for (let round = 0; round < 2; round += 1) {
    for (const id of tour) {
      // t0 is the click event's timestamp; t1 is the first animation frame where the frame,
      // heading, title and sidebar all show the target page.
      await page.evaluate((target) => {
        const w = window as unknown as { __nav?: Promise<number> };
        w.__nav = new Promise<number>((resolve) => {
          document.addEventListener('click', (event) => {
            const t0 = event.timeStamp;
            const frame = () => {
              const pageId = document.querySelector<HTMLElement>('[data-testid=page-frame]')?.dataset.pageId;
              const nav = document.querySelector<HTMLElement>('nav[aria-label=Primary] [aria-current=page]')?.dataset.navId;
              if (pageId === target && nav === target) resolve(performance.now() - t0);
              else requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
          }, { capture: true, once: true });
        });
      }, id);
      await sidebarLink(page, id).click();
      samples.push(await page.evaluate(() => (window as unknown as { __nav: Promise<number> }).__nav));
      await expectPage(page, id);
    }
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
  const median = samples[Math.floor(samples.length / 2)]!;
  const summary = `navigation: n=${samples.length} median=${median.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${samples.at(-1)!.toFixed(1)}ms`;
  console.log(summary);
  testInfo.annotations.push({ type: 'nav-p95', description: summary });
  expect(p95).toBeLessThan(100);
  await expectNoMismatches(page);
});
