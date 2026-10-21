import { expect, test, type Page } from '@playwright/test';
import { answer, expectNoSeriousA11yViolations, expectPage, watchConsole } from './support';
import { stubBff, writesTo } from './write-support';

// The embedded assistant end to end: the real widget, the real Dewee BFF (Access, session,
// CSRF, rate limit) and a scripted loopback gateway (`e2e/dewee-gateway-stub.mjs`). The agent
// may navigate and prepare a mutation; nothing is written until the owner confirms the exact
// request, and no secret reaches the gateway through page context or action results.

const SENTINEL = 'e2e-assistant-leak-sentinel';
const PROJECT_ID = `prj_${'a'.repeat(24)}`;
const NEW_PROJECT_ID = `prj_${'b'.repeat(24)}`;
const WIDGET_SESSION_KEY = 'dewee-webchat:session:/dashboard/api/v1/dewee';

/** Project rows carrying a secret-shaped field the page context must never forward. */
const projects = { data: { projects: [{ id: PROJECT_ID, name: 'Rocket', state: 'ACTIVE', generation: 2, token: SENTINEL, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', deletedAt: null }] }, truncated: false };

async function gatewayMessages(page: Page): Promise<string[]> {
  const response = await page.request.get('/__e2e/dewee-messages');
  return ((await response.json()) as { messages: string[] }).messages;
}

/** Every Dewee BFF request the widget makes, with whether it carried the CSRF header. */
function trackDewee(page: Page): Array<{ method: string; path: string; csrf: boolean }> {
  const seen: Array<{ method: string; path: string; csrf: boolean }> = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/dashboard/api/v1/dewee/')) seen.push({ method: request.method(), path: url.pathname, csrf: Boolean(request.headers()['x-csrf-token']) });
  });
  return seen;
}

async function openAssistant(page: Page) {
  await page.getByTestId('assistant-trigger').click();
  const input = page.locator('dewee-chat').getByRole('textbox');
  await expect(input).toBeVisible();
  return input;
}

async function ask(page: Page, text: string) {
  const input = page.locator('dewee-chat').getByRole('textbox');
  await input.fill(text);
  await input.press('Enter');
}

test.beforeEach(async ({ page }) => {
  await page.request.delete('/__e2e/dewee-messages');
});

test('the agent navigates through a typed action with CSRF on every widget request', async ({ page }) => {
  const problems = watchConsole(page);
  const dewee = trackDewee(page);
  await stubBff(page, { reads: { '/projects': answer(200, projects) } });
  await page.goto('/dashboard/');
  await expectPage(page, 'overview');

  await openAssistant(page);
  await ask(page, 'Please open projects');
  await expectPage(page, 'projects');
  await expect(page.locator('dewee-chat').getByText('Done. Anything else?')).toBeVisible();

  // Every widget write carried the in-memory CSRF token; the token never sat in storage.
  const posts = dewee.filter((entry) => entry.method === 'POST');
  expect(posts.length).toBeGreaterThan(0);
  expect(posts.every((entry) => entry.csrf)).toBe(true);
  expect(await page.evaluate((key) => localStorage.getItem(key), WIDGET_SESSION_KEY)).toBeNull();
  // The widget's styles and the AA state colours were adopted (no inline <style>, which the CSP refuses).
  expect(await page.evaluate(() => {
    const root = document.querySelector('dewee-chat')?.shadowRoot;
    return { adopted: root?.adoptedStyleSheets.length ?? 0, inline: root?.querySelectorAll('style').length ?? -1 };
  })).toEqual({ adopted: 2, inline: 0 });

  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});

test('a prepared mutation stays blocked until the owner confirms the exact request', async ({ page }) => {
  const problems = watchConsole(page);
  const recorded = await stubBff(page, {
    reads: { '/projects': answer(200, projects) },
    writes: { 'POST /projects': answer(200, { data: { id: NEW_PROJECT_ID, name: 'Assistant Alpha', generation: 1, token: SENTINEL } }) }
  });
  await page.goto('/dashboard/projects');
  await expectPage(page, 'projects');
  await openAssistant(page);
  await ask(page, 'create project please');

  const dialog = page.getByRole('alertdialog', { name: 'Create this project?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('prepared-request')).toContainText('POST /dashboard/api/v1/projects');
  await expect(dialog.getByLabel('Request body')).toContainText('"name": "Assistant Alpha"');
  await expectNoSeriousA11yViolations(page);
  // Nothing has been written while the dialog waits.
  await page.waitForTimeout(300);
  expect(writesTo(recorded, 'POST', '/projects')).toEqual([]);

  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => writesTo(recorded, 'POST', '/projects').length).toBe(1);
  const [write] = writesTo(recorded, 'POST', '/projects');
  expect(write?.body).toEqual({ name: 'Assistant Alpha', expectedGeneration: 0 });
  expect(write?.csrf).toBeTruthy();
  await expect(page.locator('dewee-chat').getByText('Done. Anything else?')).toBeVisible();

  // The gateway saw the page context and the action result, never the secret-shaped fields.
  const messages = await gatewayMessages(page);
  expect(messages.some((message) => message.includes(PROJECT_ID))).toBe(true);
  expect(messages.some((message) => message.includes('dewee-action-result') && message.includes(NEW_PROJECT_ID))).toBe(true);
  expect(messages.filter((message) => message.includes(SENTINEL))).toEqual([]);
  expect(problems).toEqual([]);
});

test('dismissing the confirmation denies the request and sends nothing', async ({ page }) => {
  const problems = watchConsole(page);
  const recorded = await stubBff(page, { reads: { '/projects': answer(200, projects) } });
  await page.goto('/dashboard/projects');
  await expectPage(page, 'projects');
  await openAssistant(page);
  await ask(page, 'create project please');

  const dialog = page.getByRole('alertdialog', { name: 'Create this project?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await gatewayMessages(page)).some((message) => message.includes('"status":"denied"'))).toBe(true);
  expect(recorded.filter((entry) => entry.method !== 'GET')).toEqual([]);
  expect(problems).toEqual([]);
});

test('the command palette offers pages, recent workspaces and actions from the keyboard alone', async ({ page }) => {
  const problems = watchConsole(page);
  await stubBff(page, { reads: { '/projects': answer(200, projects) } });
  // A workspace visited earlier is offered under Recent (ids only, validated on read).
  await page.addInitScript(() => localStorage.setItem('ch-dashboard-recent-workspaces', JSON.stringify([`ws_${'r'.repeat(24)}`])));
  await page.goto('/dashboard/projects');
  await expectPage(page, 'projects');

  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('option', { name: /ws_r{24}/ })).toBeVisible();
  // The current page's primary action is a palette action too.
  await page.keyboard.type('New project');
  await expect(palette.getByRole('option', { name: /New project/ })).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Ask the assistant');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page.locator('dewee-chat').getByRole('textbox')).toBeVisible();
  await expect(page.locator('dewee-chat').getByRole('textbox')).toBeFocused();
  expect(problems).toEqual([]);
});
