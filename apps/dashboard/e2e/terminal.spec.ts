import { expect, type Page, type Route, test } from '@playwright/test';
import { activeWorkspace, WORKSPACE_ID, workspacesList } from './fixtures/workspaces';
import { answer, expectNoSeriousA11yViolations, expectPage, stubReads, watchConsole } from './support';

// The workspace terminal: an xterm emulator over the BFF long-poll protocol. A scripted fake
// runner answers every terminal call, so the suite proves the lifecycle the operator sees:
// open, output with colours under the strict CSP, re-attach after leaving the tab (without
// replay), explicit close, expiry and loss, and keys that stay inside the shell.

const API = '/dashboard/api/v1';
const base = `/workspaces/${WORKSPACE_ID}`;
const TERMINAL_ID = 'term_e2eterminalterminal01';
const OTHER_ID = 'term_e2eotherterminalxx01';
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

type Read = { terminalId: string; cursor: string };
type Write = { path: string; body: unknown; csrf: string | undefined };

/**
 * A fake runner for one terminal. `chunks` are returned in order, one per read; after they run
 * out a read parks briefly and returns nothing. `endWith` turns the terminal into that status
 * on the next read (or answers that HTTP status).
 */
function fakeRunner({ chunks = [b64('\x1b[38;2;170;0;0mred-text\x1b[0m ready\r\n$ ')], running = [] as unknown[] } = {}) {
  const reads: Read[] = [];
  const writes: Write[] = [];
  const state = { status: 'running', cursor: 0, queue: [...chunks], endWith: undefined as undefined | string | number };
  const view = (terminalId = TERMINAL_ID) => ({ terminalId, workspaceId: WORKSPACE_ID, status: state.status, cols: 80, rows: 24, createdAt: new Date(Date.now() - 120_000).toISOString(), idleExpiresAt: new Date(Date.now() + 1_800_000).toISOString() });
  const handler = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(API.length);
    if (request.method() === 'GET' && path === `${base}/terminals`) return answer(200, { data: { terminals: running } })(route);
    if (request.method() === 'GET' && path.endsWith('/output')) {
      const terminalId = decodeURIComponent(path.split('/').at(-2) ?? '');
      reads.push({ terminalId, cursor: url.searchParams.get('cursor') ?? '' });
      if (typeof state.endWith === 'number') return answer(state.endWith, { error: 'gone', message: 'Workspace expired.' })(route);
      if (typeof state.endWith === 'string') { state.status = state.endWith; state.endWith = undefined; }
      const next = state.queue.shift();
      if (!next) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return answer(200, { data: { terminal: view(terminalId), data: '', nextCursor: String(state.cursor), missedBytes: 0, more: false } })(route);
      }
      state.cursor += Buffer.from(next, 'base64').length;
      return answer(200, { data: { terminal: view(terminalId), data: next, nextCursor: String(state.cursor), missedBytes: 0, more: false } })(route);
    }
    if (request.method() === 'POST') {
      writes.push({ path, body: request.postDataJSON(), csrf: request.headers()['x-csrf-token'] });
      if (path === `${base}/terminals`) return answer(200, { data: { terminal: view() } })(route);
      if (path.endsWith('/close')) { state.status = 'closed'; return answer(200, { data: { terminal: view(decodeURIComponent(path.split('/').at(-2) ?? '')) } })(route); }
      return answer(200, { data: { terminal: view() } })(route);
    }
    return route.fallback();
  };
  return { reads, writes, state, handler };
}

async function setup(page: Page, runner: ReturnType<typeof fakeRunner>) {
  await stubReads(page, {
    [base]: answer(200, { data: activeWorkspace }),
    '/workspaces': answer(200, workspacesList),
    [`${base}/terminals`]: runner.handler
  });
  await page.route(`**${API}${base}/terminals/**`, runner.handler);
  await page.route(`**${API}${base}/terminals`, runner.handler);
}

const terminalStatus = (page: Page) => page.getByTestId('terminal-status');
const surface = (page: Page) => page.getByRole('group', { name: 'Terminal' });

test('visiting the tab starts nothing; New session opens a shell with colours and no CSP violation', async ({ page }) => {
  const problems = watchConsole(page);
  const runner = fakeRunner();
  await setup(page, runner);
  await page.goto(`/dashboard${base}/terminal`);
  await expectPage(page, 'workspace');
  await expect(terminalStatus(page)).toContainText('Not started');
  await expect(surface(page)).toBeHidden();
  expect(runner.writes).toEqual([]);
  await page.getByRole('button', { name: 'New session' }).click();
  await expect(terminalStatus(page)).toContainText('Running');
  await expect(surface(page).locator('.xterm-rows')).toContainText('red-text ready');
  // Truecolour cells go through CSSOM (`style.cssText`), so the colour applies under the CSP.
  const color = await surface(page).locator('.xterm-rows span', { hasText: 'red-text' }).first().evaluate((element) => getComputedStyle(element).color);
  expect(color).toBe('rgb(170, 0, 0)');
  expect(await page.evaluate(() => document.adoptedStyleSheets.length)).toBeGreaterThan(0);
  // The adapter leaves the page's own document untouched.
  expect(await page.evaluate(() => Object.prototype.hasOwnProperty.call(document, 'createElement'))).toBe(false);
  expect(runner.writes[0]).toMatchObject({ path: `${base}/terminals`, csrf: expect.any(String) });
  expect((runner.writes[0]!.body as { cols: number }).cols).toBeGreaterThan(0);
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});

test('typed keys go to the shell, global shortcuts stay silent, and Ctrl+Shift+F6 releases focus', async ({ page }) => {
  const runner = fakeRunner();
  await setup(page, runner);
  await page.goto(`/dashboard${base}/terminal`);
  await page.getByRole('button', { name: 'New session' }).click();
  await expect(surface(page).locator('.xterm-rows')).toContainText('ready');
  await surface(page).click();
  await page.keyboard.type('ls/[');
  await page.keyboard.press('Control+k');
  await page.keyboard.press('Tab');
  await expect.poll(() => runner.writes.filter((write) => write.path.endsWith('/input')).map((write) => Buffer.from((write.body as { data: string }).data, 'base64').toString('utf8')).join('')).toBe('ls/[\x0b\t');
  expect(runner.writes.filter((write) => write.path.endsWith('/input')).every((write) => typeof write.csrf === 'string' && write.csrf.length > 0)).toBe(true);
  // Neither the command palette (Ctrl+K) nor the sidebar toggle ([) reacted.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('nav[aria-label=Primary]')).toBeVisible();
  await page.keyboard.press('Control+Shift+F6');
  await expect(page.getByRole('button', { name: 'New session' })).toBeFocused();
});

test('leaving the tab keeps the shell; returning continues from the same cursor without replay', async ({ page }) => {
  const runner = fakeRunner({ chunks: [b64('first-output\r\n')] });
  await setup(page, runner);
  await page.goto(`/dashboard${base}/terminal`);
  await page.getByRole('button', { name: 'New session' }).click();
  await expect(surface(page).locator('.xterm-rows')).toContainText('first-output');
  await page.getByRole('navigation', { name: 'Workspace sections' }).getByRole('link', { name: 'Summary' }).click();
  await expect(surface(page)).toHaveCount(0);
  const readsWhileAway = runner.reads.length;
  runner.state.queue.push(b64('after-return\r\n'));
  await page.waitForTimeout(1_200);
  // Paused while no view shows it: at most the read in flight when the tab unmounted.
  expect(runner.reads.length - readsWhileAway).toBeLessThanOrEqual(1);
  await page.getByRole('navigation', { name: 'Workspace sections' }).getByRole('link', { name: 'Terminal' }).click();
  await expect(terminalStatus(page)).toContainText('Running');
  await expect(surface(page).locator('.xterm-rows')).toContainText('first-output');
  await expect(surface(page).locator('.xterm-rows')).toContainText('after-return');
  // One open, one replay from cursor 0, and the earlier output is shown exactly once.
  expect(runner.writes.filter((write) => write.path === `${base}/terminals`)).toHaveLength(1);
  expect(runner.reads.filter((read) => read.cursor === '0')).toHaveLength(1);
  expect(await surface(page).locator('.xterm-rows').innerText()).toMatch(/^(?![\s\S]*first-output[\s\S]*first-output)/);
});

test('Close asks first, then ends the shell and says so', async ({ page }) => {
  const runner = fakeRunner();
  await setup(page, runner);
  await page.goto(`/dashboard${base}/terminal`);
  await page.getByRole('button', { name: 'New session' }).click();
  await expect(terminalStatus(page)).toContainText('Running');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Close this terminal?' });
  await expect(dialog).toContainText('Unsaved work in that shell is lost');
  await dialog.getByRole('button', { name: 'Close terminal' }).click();
  await expect(terminalStatus(page)).toContainText('Closed');
  await expect(terminalStatus(page)).toContainText('This terminal was closed. Start a new session to continue.');
  expect(runner.writes.filter((write) => write.path === `${base}/terminals/${TERMINAL_ID}/close`)).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
});

test('New session on a running shell confirms, closes it, and opens another', async ({ page }) => {
  const runner = fakeRunner();
  await setup(page, runner);
  await page.goto(`/dashboard${base}/terminal`);
  await page.getByRole('button', { name: 'New session' }).click();
  await expect(terminalStatus(page)).toContainText('Running');
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Close this terminal and start a new one?' });
  runner.state.status = 'running';
  await dialog.getByRole('button', { name: 'Close and start new' }).click();
  await expect.poll(() => runner.writes.filter((write) => write.path === `${base}/terminals`).length).toBe(2);
  expect(runner.writes.map((write) => write.path)).toContain(`${base}/terminals/${TERMINAL_ID}/close`);
});

test('a terminal that reaches its idle limit shows Timed out; a 410 shows the workspace-ended state', async ({ page }) => {
  const runner = fakeRunner();
  await setup(page, runner);
  await page.goto(`/dashboard${base}/terminal`);
  await page.getByRole('button', { name: 'New session' }).click();
  await expect(terminalStatus(page)).toContainText('Running');
  runner.state.endWith = 'timed_out';
  await expect(terminalStatus(page)).toContainText('Timed out');
  await expect(terminalStatus(page)).toContainText('The terminal reached its idle or lifetime limit and was ended.');

  runner.state.status = 'running';
  runner.state.endWith = 410;
  await page.getByRole('button', { name: 'New session' }).click();
  await expect(terminalStatus(page)).toContainText('No longer available');
  await expect(terminalStatus(page)).toContainText('This terminal ended with its workspace, which was closed or expired.');
});

test('after a reload a running shell is offered for re-attach and replays from the start', async ({ page }) => {
  const runner = fakeRunner({ chunks: [b64('replayed-output\r\n')], running: [{ terminalId: OTHER_ID, workspaceId: WORKSPACE_ID, status: 'running', cols: 100, rows: 30, createdAt: new Date(Date.now() - 600_000).toISOString(), idleExpiresAt: new Date(Date.now() + 600_000).toISOString() }] });
  await setup(page, runner);
  await page.goto(`/dashboard${base}/terminal`);
  const offers = page.getByRole('list', { name: 'Running terminals' });
  await expect(offers).toContainText(OTHER_ID);
  await expect(offers).toContainText('100×30');
  await offers.getByRole('button', { name: `Re-attach ${OTHER_ID}` }).click();
  await expect(terminalStatus(page)).toContainText('Running');
  await expect(surface(page).locator('.xterm-rows')).toContainText('replayed-output');
  expect(runner.reads[0]).toEqual({ terminalId: OTHER_ID, cursor: '0' });
  expect(runner.writes.filter((write) => write.path === `${base}/terminals`)).toHaveLength(0);
});

test('the Terminals page lists every terminal and closes one after a confirmation', async ({ page }) => {
  const problems = watchConsole(page);
  const closed: Write[] = [];
  const terminal = { terminalId: TERMINAL_ID, workspaceId: WORKSPACE_ID, status: 'running', cols: 80, rows: 24, createdAt: new Date(Date.now() - 125 * 60_000).toISOString(), idleExpiresAt: new Date(Date.now() + 600_000).toISOString() };
  await stubReads(page, {
    '/terminals': answer(200, { data: { terminals: [terminal, { ...terminal, terminalId: OTHER_ID, status: 'exited', exitCode: 2 }] } }),
    '/workspaces': answer(200, workspacesList),
    [`${base}/terminals/${TERMINAL_ID}/close`]: async (route) => {
      closed.push({ path: route.request().url(), body: route.request().postDataJSON(), csrf: route.request().headers()['x-csrf-token'] });
      return answer(200, { data: { terminal: { ...terminal, status: 'closed' } } })(route);
    }
  });
  await page.goto('/dashboard/terminals');
  await expect(page.getByTestId('page-title')).toHaveText('Terminals');
  const table = page.getByRole('table');
  await expect(table).toContainText('rocket');
  await expect(table).toContainText('2 h 5 min');
  await expect(table).toContainText('Exited (code 2)');
  await expect(page.getByRole('link', { name: 'rocket' }).first()).toHaveAttribute('href', `/dashboard${base}/terminal`);
  await expect(page.getByRole('button', { name: `Close ${OTHER_ID}` })).toBeDisabled();
  await page.getByRole('button', { name: `Close ${TERMINAL_ID}` }).click();
  await page.getByRole('alertdialog', { name: 'Close this terminal?' }).getByRole('button', { name: 'Close terminal' }).click();
  await expect.poll(() => closed.length).toBe(1);
  expect(closed[0]).toMatchObject({ body: {}, csrf: expect.any(String) });
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});
