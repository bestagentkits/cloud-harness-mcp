import { expect, test, type Page } from '@playwright/test';
import { answer, expectNoMismatches, expectPage, installIdentityMonitor, PAGES, sidebarLink, stubReads, watchConsole, type VisitedPage } from './support';

/** List projections the migrated pages read; each page states its row count in its table caption. */
const workspaceList = (count: number) => ({ data: { workspaces: Array.from({ length: count }, (_, index) => ({ workspaceId: `ws_navigation${String(index).padStart(10, '0')}`, repositoryUrl: `https://github.com/acme/repo-${index}.git`, status: 'ACTIVE' })) } });
const agentList = (count: number) => ({ data: { agents: Array.from({ length: count }, (_, index) => ({ agentId: `agent_navigation${String(index).padStart(10, '0')}`, status: 'RUNNING' })) } });
const artifactList = (count: number) => ({ data: { artifacts: Array.from({ length: count }, (_, index) => ({ artifactId: `art_navigation${String(index).padStart(10, '0')}`, logicalName: `snapshot-${index}`, sha256: 'a'.repeat(64), sizeBytes: 10, generation: 1 })) } });
const workspaceRecord = (workspaceId: string, repository: string) => ({ data: { workspaceId, repositoryUrl: `https://github.com/acme/${repository}.git`, status: 'CLOSED' } });
const caption = (page: Page) => page.locator('main table caption').first();

// The navigation transaction: page B's shell commits at once, obsolete reads are aborted,
// late answers never land on another page, and the title, heading, page frame and current
// sidebar entry agree on every sampled frame.

test.beforeEach(async ({ page }) => {
  await installIdentityMonitor(page);
});

test('A→B and A→B→C keep title, heading and navigation in step', async ({ page }) => {
  const problems = watchConsole(page);
  await stubReads(page, { '/workspaces': answer(200, workspaceList(2)), '/agents': answer(200, agentList(1)) });
  await page.goto('/dashboard');
  await expectPage(page, 'overview');

  await sidebarLink(page, 'workspaces').click();
  await expectPage(page, 'workspaces');
  await expect(caption(page)).toHaveText('2 workspaces');
  await expect(page.getByTestId('page-title')).toBeFocused();

  await sidebarLink(page, 'agents').click();
  await expectPage(page, 'agents');
  await expect(caption(page)).toHaveText('1 agents');

  await sidebarLink(page, 'artifacts').click();
  await expectPage(page, 'artifacts');
  await expectNoMismatches(page);
  expect(problems).toEqual([]);
});

test('rapid repeated clicks settle on the last page without mismatches', async ({ page }) => {
  await stubReads(page, { '/agents': answer(200, agentList(1), { delayMs: 200 }), '/artifacts': answer(200, artifactList(4), { delayMs: 50 }) });
  await page.goto('/dashboard');
  await expectPage(page, 'overview');

  const agents = sidebarLink(page, 'agents');
  for (let index = 0; index < 5; index += 1) await agents.click({ delay: 0 });
  await sidebarLink(page, 'workspaces').click();
  await sidebarLink(page, 'artifacts').click();
  await expectPage(page, 'artifacts');
  await expect(caption(page)).toHaveText('4 snapshots');
  // Stays put once the earlier, slower answers have had time to arrive.
  await page.waitForTimeout(400);
  await expectPage(page, 'artifacts');
  await expect(caption(page)).toHaveText('4 snapshots');
  await expectNoMismatches(page);
});

test('leaving a page aborts its slow read and shows B at once', async ({ page }) => {
  await stubReads(page, { '/workspaces': answer(200, workspaceList(3), { delayMs: 3_000 }), '/agents': answer(200, agentList(1)) });
  const aborted = page.waitForEvent('requestfailed', (request) => new URL(request.url()).pathname.endsWith('/api/v1/workspaces'));
  await page.goto('/dashboard');
  await sidebarLink(page, 'workspaces').click();
  await expectPage(page, 'workspaces');
  await expect(page.getByRole('status', { name: /loading/i }).first()).toBeVisible();

  await sidebarLink(page, 'agents').click();
  await expectPage(page, 'agents');
  expect((await aborted).failure()?.errorText).toMatch(/abort/i);
  await expect(caption(page)).toHaveText('1 agents');
  await expectNoMismatches(page);
});

test('an out-of-order answer for the previous resource never renders on the next one', async ({ page }) => {
  await stubReads(page, {
    '/workspaces/ws_slowslowslowslowslow01': answer(200, workspaceRecord('ws_slowslowslowslowslow01', 'slow'), { delayMs: 1_200 }),
    '/workspaces/ws_fastfastfastfastfast01': answer(200, workspaceRecord('ws_fastfastfastfastfast01', 'fast'), { delayMs: 50 })
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
  await expect(page.getByRole('heading', { name: 'acme/fast' })).toBeVisible();
  await page.waitForTimeout(1_400);
  await expect(page.getByRole('heading', { name: 'acme/fast' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'acme/slow' })).toHaveCount(0);
  await expectNoMismatches(page);
});

test('a late answer that is fulfilled lands under its own key, never on the page shown', async ({ page }) => {
  await stubReads(page, {
    '/workspaces': answer(200, workspaceList(7), { delayMs: 1_200 }),
    '/agents': answer(200, agentList(2))
  });
  const failed: string[] = [];
  page.on('requestfailed', (request) => failed.push(new URL(request.url()).pathname));
  await page.goto('/dashboard');
  await expectPage(page, 'overview');
  // Hover prefetches the Workspaces read; a prefetch has no observer, so leaving the link
  // does not abort it and its answer arrives after the operator is on another page.
  const late = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/api/v1/workspaces'));
  const requested = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith('/api/v1/workspaces'));
  await sidebarLink(page, 'workspaces').hover();
  await requested;
  await sidebarLink(page, 'agents').click();
  await expectPage(page, 'agents');
  await expect(caption(page)).toHaveText('2 agents');

  expect((await late).status()).toBe(200);
  await page.waitForTimeout(200);
  expect(failed).toEqual([]);
  await expectPage(page, 'agents');
  await expect(caption(page)).toHaveText('2 agents');

  // The late body is cached under the Workspaces key: that page renders it at once, from
  // the cache, without asking again.
  let refetched = false;
  page.on('request', (request) => { if (new URL(request.url()).pathname.endsWith('/api/v1/workspaces')) refetched = true; });
  await sidebarLink(page, 'workspaces').click();
  await expectPage(page, 'workspaces');
  await expect(caption(page)).toHaveText('7 workspaces');
  expect(refetched).toBe(false);
  await expectNoMismatches(page);
});

test('a failed read shows an error with a Retry that recovers', async ({ page }) => {
  let calls = 0;
  await stubReads(page, {
    '/agents': (route) => {
      calls += 1;
      return calls <= 3 ? route.abort('failed') : answer(200, agentList(5))(route);
    }
  });
  await page.goto('/dashboard/agents');
  await expectPage(page, 'agents');
  const alert = page.getByRole('alert').filter({ hasText: 'Connection lost' });
  await expect(alert).toBeVisible({ timeout: 10_000 });
  await expect(alert).toHaveAttribute('data-error-kind', 'network');
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(caption(page)).toHaveText('5 agents');
  await expectNoMismatches(page);
});

test('reload keeps the deep-link filters', async ({ page }) => {
  await stubReads(page);
  await page.goto('/dashboard/agents?status=RUNNING&attention=needs-attention');
  await expectPage(page, 'agents');
  await expect(page.getByLabel('Status')).toHaveValue('RUNNING');
  await expect(page.getByLabel('Attention')).toHaveValue('needs-attention');
  await page.reload();
  await expectPage(page, 'agents');
  await expect(page).toHaveURL(/\/dashboard\/agents\?/);
  await expect(page.getByLabel('Status')).toHaveValue('RUNNING');
  await expect(page.getByLabel('Attention')).toHaveValue('needs-attention');
});

// A data page renders a skeleton first after a reload, so the restored offset needs a
// page whose height does not wait for a read.
test('reload keeps the scroll position', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 240 });
  await stubReads(page);
  await page.goto('/dashboard/secrets');
  await expectPage(page, 'secrets');
  await page.evaluate(() => window.scrollTo(0, 120));
  await page.waitForFunction(() => window.scrollY >= 60);
  const before = await page.evaluate(() => window.scrollY);
  // Scroll restoration snapshots on unload.
  await page.reload();
  await expectPage(page, 'secrets');
  // The router snapshots the offset from a throttled scroll event, so allow a few pixels.
  await page.waitForFunction((expected) => Math.abs(window.scrollY - expected) <= 4, before);
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

/**
 * Installs a one-shot timer for the next click: t0 is the click event's timestamp, t1 the
 * first animation frame where the page frame, sidebar entry, h1 and document title all show
 * `target`. Resolves with t1 - t0 in milliseconds.
 */
async function armNavigationTimer(page: Page, target: VisitedPage): Promise<void> {
  await page.evaluate(({ target, title, nav }) => {
    const w = window as unknown as { __nav?: Promise<number> };
    w.__nav = new Promise<number>((resolve) => {
      document.addEventListener('click', (event) => {
        const t0 = event.timeStamp;
        const frame = () => {
          const pageId = document.querySelector<HTMLElement>('[data-testid=page-frame]')?.dataset.pageId;
          const current = document.querySelector<HTMLElement>('nav[aria-label=Primary] [aria-current=page]')?.dataset.navId;
          const heading = document.querySelector('[data-testid=page-title]')?.textContent?.trim();
          if (pageId === target && current === nav && heading === title && document.title === `${title} | Cloud Harness`) resolve(performance.now() - t0);
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }, { capture: true, once: true });
    });
  }, { target, ...PAGES[target] });
}

const readNavigationTimer = (page: Page) => page.evaluate(() => (window as unknown as { __nav: Promise<number> }).__nav);

function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]!;
  return { n: sorted.length, median: pick(0.5), p95: pick(0.95), max: sorted.at(-1)! };
}

const formatSummary = (label: string, { n, median, p95, max }: ReturnType<typeof summarize>) =>
  `${label}: n=${n} median=${median.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms`;

const TOUR: VisitedPage[] = ['workspaces', 'agents', 'activity', 'approvals', 'packages', 'projects', 'secrets', 'models', 'skills', 'integrations', 'mcp-servers', 'knowledge', 'artifacts', 'api-keys', 'settings'];

test('navigation p95 stays under 100 ms (warm route chunks)', async ({ page }, testInfo) => {
  await stubReads(page);
  await page.goto('/dashboard');
  await expectPage(page, 'overview');
  // Warm every lazy route chunk once, as hover/focus prefetch would, so the sample measures
  // the navigation transaction itself rather than first-time chunk downloads.
  for (const id of TOUR) await sidebarLink(page, id).hover();
  await page.waitForLoadState('networkidle');

  const samples: number[] = [];
  for (let round = 0; round < 2; round += 1) {
    for (const id of TOUR) {
      await armNavigationTimer(page, id);
      await sidebarLink(page, id).click();
      samples.push(await readNavigationTimer(page));
      await expectPage(page, id);
    }
  }
  const summary = summarize(samples);
  const line = formatSummary('navigation (warm)', summary);
  console.log(line);
  testInfo.annotations.push({ type: 'nav-p95', description: line });
  expect(summary.p95).toBeLessThan(100);
  await expectNoMismatches(page);
});

test('reports cold route-chunk navigation timing (no gate)', async ({ page }, testInfo) => {
  await stubReads(page);
  await page.goto('/dashboard');
  await expectPage(page, 'overview');
  // A programmatic click skips the pointer hover, so nothing is prefetched: each sample
  // includes downloading and evaluating the target's route chunk for the first time.
  const samples: number[] = [];
  for (const id of TOUR) {
    await armNavigationTimer(page, id);
    await sidebarLink(page, id).evaluate((link: HTMLElement) => link.click());
    samples.push(await readNavigationTimer(page));
    await expectPage(page, id);
  }
  const line = formatSummary('navigation (cold chunks)', summarize(samples));
  console.log(line);
  testInfo.annotations.push({ type: 'nav-cold', description: line });
  await expectNoMismatches(page);
});
