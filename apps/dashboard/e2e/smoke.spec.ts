import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** Fails the test on any console error, including CSP violations, and uncaught exceptions. */
function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()); });
  page.on('pageerror', (error) => problems.push(error.message));
  return problems;
}

async function expectNoSeriousA11yViolations(page: Page) {
  // Measure settled colours: mid-fade elements blend with the overlay and misreport contrast.
  // Endless loops (skeleton pulse, progress sweep) never settle and do not fade content.
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getComputedTiming().iterations === Infinity));
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  expect(serious.map((violation) => `${violation.id}: ${violation.nodes.map((node) => `${node.target.join(' ')} ${node.failureSummary ?? ''} ${node.html}`).join(', ')}`)).toEqual([]);
}

// The sidebar approvals badge reads two runner-backed endpoints on Overview; the e2e server
// has no runner, so answer them with an empty inbox rather than a 503 in the console.
test.beforeEach(async ({ page }) => {
  for (const path of ['/privilege-grants', '/package-plans']) {
    await page.route(`**/dashboard/api/v1${path}`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { grants: [], plans: [] } }) }));
  }
});

test('renders the shell under a strict per-response CSP', async ({ page }) => {
  const problems = watchConsole(page);
  const response = await page.goto('/dashboard');
  const policy = response?.headers()['content-security-policy'] ?? '';
  expect(policy).toMatch(/style-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
  expect(policy).not.toContain('unsafe-inline');

  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByTestId('display-name-chip')).toContainText('owner@example.test');
  await expect(page).toHaveTitle('Overview | Cloud Harness');
  const fontFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(fontFamily).toContain('Geist');
  expect(problems).toEqual([]);
});

test('serves content-hashed assets immutable, nosniff and under the CSP, first load and replay alike', async ({ page }) => {
  const assets: { url: string; headers: Record<string, string> }[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/dashboard/assets/')) assets.push({ url: response.url(), headers: response.headers() });
  });
  for (let load = 0; load < 2; load += 1) {
    await page.goto('/dashboard');
    await expect(page.getByTestId('page-frame')).toBeVisible();
  }
  expect(assets.length).toBeGreaterThan(0);
  for (const { url, headers } of assets) {
    expect(headers['cache-control'], url).toBe('private, max-age=31536000, immutable');
    expect(headers['x-content-type-options'], url).toBe('nosniff');
    expect(headers['content-security-policy'], url).toContain("default-src 'none'");
  }
});

test('switches theme and keeps it across a reload before first paint', async ({ page }) => {
  const problems = watchConsole(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/dashboard');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'light');

  await page.getByRole('button', { name: 'Dark theme' }).click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Dark theme' })).toHaveAttribute('aria-pressed', 'true');

  await page.reload();
  // The boot script sets the attribute before the app bundle runs.
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  expect(problems).toEqual([]);
});

test('opens display preferences without CSP violations from the scroll lock', async ({ page }) => {
  const problems = watchConsole(page);
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Display preferences' }).click();
  const dialog = page.getByRole('dialog', { name: 'Display preferences' });
  await expect(dialog).toBeVisible();
  await dialog.getByText('Large', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-font-scale', 'lg');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(problems).toEqual([]);
});

test('answers unknown routes with 404 and renders the not-found page', async ({ page }) => {
  const response = await page.goto('/dashboard/does-not-exist');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`has no serious or critical axe violations (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto('/dashboard');
    await expect(page.getByTestId('display-name-chip')).toContainText('owner@example.test');
    await expectNoSeriousA11yViolations(page);
    await page.getByRole('button', { name: 'Display preferences' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
}
