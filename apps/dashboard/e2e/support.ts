import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';

/**
 * Shared Playwright helpers for the navigation and state suites. The test server's runner is
 * unreachable on purpose, so every page read is answered here with `page.route`; the session,
 * profile and preferences endpoints the API serves itself stay real, and so does the
 * assistant's `/dewee/*` BFF (its gateway is the scripted stub in `e2e/dewee-gateway-stub.mjs`).
 */

const API = '/dashboard/api/v1';
const SERVED_BY_API = new Set(['/session', '/profile', '/preferences']);

export type ReadHandler = (route: Route) => Promise<void> | void;

/** A read answer: `delayMs` holds it back, and a route aborted meanwhile is left alone. */
export function answer(status: number, body: unknown = { data: { items: [] } }, { delayMs = 0, headers = {} }: { delayMs?: number; headers?: Record<string, string> } = {}): ReadHandler {
  return async (route) => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) }).catch(() => undefined);
  };
}

/**
 * Stubs every BFF read the runner would answer. `handlers` maps an API path (without the
 * `/dashboard/api/v1` prefix or query) to its answer; anything else is an empty list.
 * Returns the paths requested, in order.
 */
export async function stubReads(page: Page, handlers: Record<string, ReadHandler> = {}): Promise<string[]> {
  const seen: string[] = [];
  await page.route(`**${API}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.slice(API.length);
    if (SERVED_BY_API.has(path) || path.startsWith('/dewee/')) return route.fallback();
    seen.push(path);
    return (handlers[path] ?? answer(200))(route);
  });
  return seen;
}

/** Fails the test on any console error, including CSP violations, and uncaught exceptions. */
export function watchConsole(page: Page, { allow = [] }: { allow?: RegExp[] } = {}): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !allow.some((pattern) => pattern.test(message.text()))) problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  return problems;
}

/** Title per page id for the pages these suites visit, and the sidebar entry that owns each. */
export const PAGES = {
  overview: { title: 'Overview', nav: 'overview' },
  workspaces: { title: 'Workspaces', nav: 'workspaces' },
  workspace: { title: 'Workspace', nav: 'workspaces' },
  agents: { title: 'Agents', nav: 'agents' },
  agent: { title: 'Agent', nav: 'agents' },
  activity: { title: 'Activity', nav: 'activity' },
  approvals: { title: 'Approvals', nav: 'approvals' },
  packages: { title: 'Packages', nav: 'packages' },
  projects: { title: 'Projects', nav: 'projects' },
  secrets: { title: 'Secrets', nav: 'secrets' },
  models: { title: 'Models & Budgets', nav: 'models' },
  skills: { title: 'Skills', nav: 'skills' },
  integrations: { title: 'Integrations', nav: 'integrations' },
  github: { title: 'GitHub', nav: 'integrations' },
  'mcp-servers': { title: 'MCP Servers', nav: 'mcp-servers' },
  knowledge: { title: 'Knowledge', nav: 'knowledge' },
  artifacts: { title: 'Artifacts', nav: 'artifacts' },
  'api-keys': { title: 'API Access', nav: 'api-keys' },
  settings: { title: 'Settings', nav: 'settings' }
} as const;
export type VisitedPage = keyof typeof PAGES;

/**
 * Samples the shell's identity on every animation frame and after every DOM mutation and
 * records any sample where the document title, the h1, the page frame and the current
 * sidebar entry disagree. Frames without a page frame (first load, not-found) are skipped.
 */
export async function installIdentityMonitor(page: Page): Promise<void> {
  await page.addInitScript((pages: Record<string, { title: string; nav: string }>) => {
    const state = { samples: 0, mismatches: [] as string[] };
    (window as unknown as { __identity: typeof state }).__identity = state;
    const check = () => {
      const frame = document.querySelector<HTMLElement>('[data-testid=page-frame]');
      if (!frame) return;
      const pageId = frame.dataset.pageId ?? '';
      const expected = pages[pageId];
      if (!expected) return;
      state.samples += 1;
      const heading = document.querySelector('[data-testid=page-title]')?.textContent?.trim() ?? '';
      const nav = document.querySelector<HTMLElement>('nav[aria-label=Primary] [aria-current=page]')?.dataset.navId ?? '';
      const title = document.title;
      const titleMatches = title === `${expected.title} | Cloud Harness` || title.endsWith(` · ${expected.title} | Cloud Harness`);
      if (heading !== expected.title || !titleMatches || nav !== expected.nav) {
        state.mismatches.push(`${pageId}: title="${title}" h1="${heading}" nav="${nav}"`);
      }
    };
    const frame = () => { check(); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-current', 'data-page-id'] });
  }, PAGES);
}

export async function identityReport(page: Page): Promise<{ samples: number; mismatches: string[] }> {
  return page.evaluate(() => (window as unknown as { __identity: { samples: number; mismatches: string[] } }).__identity);
}

export async function expectNoMismatches(page: Page): Promise<void> {
  const report = await identityReport(page);
  expect(report.samples).toBeGreaterThan(0);
  expect(report.mismatches).toEqual([]);
}

/** Waits until the shell shows `pageId` consistently: title, heading, frame and sidebar. */
export async function expectPage(page: Page, pageId: VisitedPage): Promise<void> {
  const { title, nav } = PAGES[pageId];
  await expect(page.locator('[data-testid=page-frame]')).toHaveAttribute('data-page-id', pageId);
  await expect(page.getByTestId('page-title')).toHaveText(title);
  await expect(page).toHaveTitle(new RegExp(`(^| · )${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\| Cloud Harness$`));
  await expect(page.locator('nav[aria-label=Primary] [aria-current=page]')).toHaveAttribute('data-nav-id', nav);
}

export function sidebarLink(page: Page, pageId: VisitedPage) {
  return page.locator(`nav[aria-label=Primary] [data-nav-id="${pageId}"]`);
}

export async function expectNoSeriousA11yViolations(page: Page): Promise<void> {
  // Measure settled colours: mid-fade elements blend with the overlay and misreport contrast.
  // Endless loops (skeleton pulse, progress sweep) never settle and do not fade content.
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getComputedTiming().iterations === Infinity));
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  expect(serious.map((violation) => `${violation.id}: ${violation.nodes.map((node) => `${node.target.join(' ')} ${node.failureSummary ?? ''}`).join(', ')}`)).toEqual([]);
}
