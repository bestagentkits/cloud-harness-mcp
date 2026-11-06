import { expect, test, type Page, type Route } from '@playwright/test';
import { answer, expectNoSeriousA11yViolations, expectPage, type ReadHandler, sidebarLink, stubReads, watchConsole } from './support';
import { ENTRY_ID, JOURNAL_ID, knowledgeGraph, knowledgeList, knowledgePage2, knowledgeSearch, memoryEntry, PROJECT_ID, projectsForDialog } from './fixtures/knowledge';

// Knowledge list, search, graph and the entry editor: URL-owned filters, one read per view,
// safe Markdown, the generation-fenced save with the D8 conflict dialog, and confirmations.

const API = '/dashboard/api/v1';
// The shared Radix tab list and panel set `outline`/`animation-duration` through the CSSOM
// (allowed by the CSP); any other style attribute in the page would come from rendered content.
const STYLED = 'main [style]:not([role=tablist]):not([role=tabpanel])';
const ENTRY_PATH = `/knowledge/${ENTRY_ID}`;
type Write = { method: string; path: string; body: unknown; csrf: boolean };

/** Every BFF request the page makes (method, path and query), excluding the API-served session reads. */
function trackRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    const path = url.pathname.slice(API.length);
    if (url.pathname.startsWith(`${API}/`) && !['/session', '/profile', '/preferences'].includes(path)) requests.push(`${request.method()} ${path}${url.search}`);
  });
  return requests;
}

/** Records a non-GET request (method, path, JSON body, CSRF header presence) before answering it. */
function record(writes: Write[], route: Route): void {
  const request = route.request();
  writes.push({ method: request.method(), path: new URL(request.url()).pathname.slice(API.length), body: request.postDataJSON(), csrf: Boolean(request.headers()['x-csrf-token']) });
}

/** The list read, answering the second page for the fixture cursor. */
const listHandler: ReadHandler = (route) => {
  const cursor = new URL(route.request().url()).searchParams.get('cursor');
  return answer(200, cursor === 'next.page-2' ? knowledgePage2 : knowledgeList)(route);
};

test.describe('knowledge list', () => {
  test('renders entries in one read with one primary action and no injected markup', async ({ page }) => {
    const problems = watchConsole(page);
    const requests = trackRequests(page);
    await stubReads(page, { '/knowledge': listHandler });
    await page.goto('/dashboard/knowledge');
    await expectPage(page, 'knowledge');
    await expect(page.getByRole('link', { name: 'Cache architecture' })).toHaveAttribute('href', `/dashboard/knowledge/${ENTRY_ID}`);
    await expect(page.getByRole('link', { name: 'Use write-through' })).toBeVisible();
    await expect(page.getByTestId('primary-action')).toHaveCount(1);
    await expect(page.getByTestId('primary-action')).toHaveText('New entry');
    expect(requests).toEqual(['GET /knowledge']);
    await expect(page.locator('main script, main img')).toHaveCount(0);
    expect(await page.locator(STYLED).count()).toBe(0);
    await expectNoSeriousA11yViolations(page);
    expect(problems).toEqual([]);
  });

  test('a bogus search param never reaches the BFF', async ({ page }) => {
    const requests = trackRequests(page);
    await stubReads(page, { '/knowledge': listHandler });
    await page.goto('/dashboard/knowledge?kind=bogus&scope=%3Cscript%3E&projectId=nope&evil=1');
    await expect(page.getByRole('link', { name: 'Cache architecture' })).toBeVisible();
    // The invalid values are dropped, not forwarded: the read is the plain list.
    expect(requests).toEqual(['GET /knowledge']);
    await expect(page.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Scope')).toHaveValue('');
  });

  test('tabs, scope, search and the cursor live in the URL and survive a reload', async ({ page }) => {
    const problems = watchConsole(page);
    const requests = trackRequests(page);
    const writes: Write[] = [];
    await stubReads(page, {
      '/knowledge': listHandler,
      '/knowledge/search': (route) => { record(writes, route); return answer(200, knowledgeSearch)(route); }
    });
    await page.goto('/dashboard/knowledge');
    await expect(page.getByRole('link', { name: 'Cache architecture' })).toBeVisible();

    await page.getByRole('tab', { name: 'Journals' }).click();
    await expect(page).toHaveURL(/[?&]kind=journal/);
    await page.getByLabel('Scope').selectOption('project');
    await expect(page).toHaveURL(/[?&]scope=project/);
    await expect.poll(() => requests.at(-1)).toBe('GET /knowledge?kind=journal&scope=project');

    await page.reload();
    await expect(page.getByRole('tab', { name: 'Journals' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Scope')).toHaveValue('project');

    // Paging forward keeps the filters and sends the opaque cursor.
    await page.getByRole('navigation', { name: 'Knowledge pages' }).getByRole('button', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/[?&]cursor=next\.page-2/);
    await expect(page.getByRole('link', { name: 'Older note' })).toBeVisible();
    expect(requests.at(-1)).toBe('GET /knowledge?kind=journal&scope=project&cursor=next.page-2');

    // A text query switches to the search endpoint with the classic body and starts again from page one.
    await page.getByLabel('Search knowledge').fill('pool');
    await expect(page).toHaveURL(/[?&]q=pool/);
    await expect(page).not.toHaveURL(/cursor=/);
    await expect(page.getByRole('status').filter({ hasText: '1 results for “pool”' })).toBeVisible();
    await expect(page.getByText('hybrid match · 96%')).toBeVisible();
    expect(writes).toEqual([{ method: 'POST', path: '/knowledge/search', body: { query: 'pool', kinds: ['journal'], scope: 'project' }, csrf: true }]);

    await page.getByRole('search', { name: 'Knowledge filters' }).getByRole('button', { name: /Clear/ }).click();
    await expect(page).toHaveURL(/\/dashboard\/knowledge$/);
    expect(problems).toEqual([]);
  });

  test('the graph tab reads the graph once and opens a node from the keyboard', async ({ page }) => {
    const problems = watchConsole(page);
    const requests = trackRequests(page);
    await stubReads(page, { '/knowledge': listHandler, '/knowledge-graph': answer(200, knowledgeGraph), [ENTRY_PATH]: answer(200, { data: memoryEntry }) });
    await page.goto('/dashboard/knowledge?view=graph');
    const graph = page.getByRole('group', { name: 'Knowledge graph: 2 entries, 1 links' });
    await expect(graph).toBeVisible();
    expect(requests.filter((request) => request.startsWith('GET /knowledge-graph'))).toEqual(['GET /knowledge-graph?depth=2&maxNodes=50']);
    expect(await page.locator(STYLED).count()).toBe(0);
    await expectNoSeriousA11yViolations(page);

    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(page.locator('main svg[role=group]')).not.toHaveAttribute('viewBox', '0 0 800 500');
    await page.getByRole('button', { name: 'Reset view' }).click();
    await expect(page.locator('main svg[role=group]')).toHaveAttribute('viewBox', '0 0 800 500');

    const node = graph.getByRole('button', { name: 'Open Cache architecture' });
    await node.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/dashboard/knowledge/${ENTRY_ID}$`));
    expect(problems).toEqual([]);
  });

  test('empty and failed reads explain themselves', async ({ page }) => {
    const problems = watchConsole(page, { allow: [/Failed to load resource/] });
    await stubReads(page, { '/knowledge': answer(200, { data: { items: [] } }) });
    await page.goto('/dashboard/knowledge');
    await expect(page.getByText('No knowledge yet')).toBeVisible();
    await page.goto('/dashboard/knowledge?scope=owner');
    await expect(page.getByText('No entries match these filters')).toBeVisible();

    await page.unroute(`**${API}/**`);
    await stubReads(page, { '/knowledge': answer(503, { error: 'RUNNER_UNAVAILABLE', message: 'The runner is unavailable.' }) });
    await page.goto('/dashboard/knowledge');
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('The server could not answer', { timeout: 10_000 });
    await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(problems).toEqual([]);
  });

  test('New entry with project scope loads projects and sends a strict gen0 body', async ({ page }) => {
    const problems = watchConsole(page);
    const requests = trackRequests(page);
    const writes: Write[] = [];
    const created = { ...memoryEntry, id: 'kn_new1234567890', title: 'Pooling', scope: 'project', projectId: PROJECT_ID, content: '', generation: 1, outboundLinks: [] };
    await stubReads(page, {
      '/knowledge': (route) => {
        if (route.request().method() === 'GET') return listHandler(route);
        record(writes, route);
        return answer(200, { data: created })(route);
      },
      '/projects': answer(200, projectsForDialog),
      '/knowledge/kn_new1234567890': answer(200, { data: created })
    });
    await page.goto('/dashboard/knowledge');
    await expect(page.getByRole('link', { name: 'Cache architecture' })).toBeVisible();

    await page.getByTestId('primary-action').click();
    const dialog = page.getByRole('dialog', { name: 'New knowledge entry' });
    await expect(dialog.getByLabel('Title', { exact: true })).toBeFocused();
    expect(requests).not.toContain('GET /projects');
    await dialog.getByRole('button', { name: 'Create entry' }).click();
    await expect(dialog.getByLabel('Title', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    expect(writes).toEqual([]);

    await dialog.getByLabel('Scope').selectOption('project');
    await expect(dialog.getByLabel('Project', { exact: true })).toHaveValue(PROJECT_ID);
    expect(requests.filter((request) => request === 'GET /projects')).toEqual(['GET /projects']);
    await dialog.getByLabel('Title', { exact: true }).fill(' Pooling ');
    await dialog.getByLabel('Tags').fill('pg, cache');
    await expectNoSeriousA11yViolations(page);
    await dialog.getByRole('button', { name: 'Create entry' }).click();

    await expect(page).toHaveURL(/\/dashboard\/knowledge\/kn_new1234567890$/);
    expect(writes).toEqual([{
      method: 'POST', path: '/knowledge', csrf: true,
      body: { kind: 'memory', scope: 'project', projectId: PROJECT_ID, title: 'Pooling', content: '', tags: ['pg', 'cache'], expectedGeneration: 0 }
    }]);
    expect(problems).toEqual([]);
  });
});

test.describe('knowledge entry', () => {
  const entryUrl = `/dashboard/knowledge/${ENTRY_ID}`;

  async function openEntry(page: Page, handlers: Record<string, ReadHandler> = {}) {
    await page.addInitScript(() => sessionStorage.clear());
    await stubReads(page, { [ENTRY_PATH]: answer(200, { data: memoryEntry }), ...handlers });
    await page.goto(entryUrl);
    await expect(page.locator('[data-testid=page-frame]')).toHaveAttribute('data-page-id', 'knowledge-entry');
    await expect(page.getByTestId('page-title')).toHaveText('Knowledge entry');
    await expect(page.getByLabel('Markdown source')).toHaveValue(memoryEntry.content);
  }

  test('renders hostile Markdown as escaped text with safe links only', async ({ page }) => {
    const problems = watchConsole(page);
    const requests = trackRequests(page);
    await openEntry(page);
    const preview = page.getByTestId('knowledge-preview');
    await expect(preview.getByRole('heading', { name: 'Cache architecture' })).toBeVisible();
    await expect(preview.locator('strong')).toHaveText('write-through');
    await expect(preview.getByRole('link', { name: 'the decision' })).toHaveAttribute('href', `/dashboard/knowledge/${JOURNAL_ID}`);
    await expect(preview.getByRole('checkbox', { name: 'Measured' })).toBeChecked();
    // Raw HTML stays text; a javascript: link is not a link.
    await expect(preview).toContainText('<script>window.__pwned = 1</script>');
    await expect(preview.locator('script, img, iframe, [style]')).toHaveCount(0);
    await expect(preview.getByRole('link', { name: 'bad' })).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await expect(page.getByRole('link', { name: JOURNAL_ID })).toBeVisible();
    await expect(page.getByTestId('primary-action')).toHaveCount(0);
    await expect(page.getByTestId('knowledge-save-state')).toHaveAttribute('data-save-state', 'saved');
    expect(requests).toEqual([`GET ${ENTRY_PATH}`]);
    expect(await page.locator(STYLED).count()).toBe(0);
    await expectNoSeriousA11yViolations(page);
    expect(problems).toEqual([]);
  });

  test('Ctrl+S saves with the generation fence and moves the state saving → saved', async ({ page }) => {
    const problems = watchConsole(page);
    const writes: Write[] = [];
    await openEntry(page, {
      [ENTRY_PATH]: (route) => {
        if (route.request().method() === 'GET') return answer(200, { data: memoryEntry })(route);
        record(writes, route);
        return answer(200, { data: { ...memoryEntry, content: 'Edited **now**', generation: 3 } }, { delayMs: 400 })(route);
      }
    });
    const state = page.getByTestId('knowledge-save-state');
    const editor = page.getByLabel('Markdown source');
    await editor.fill('Edited **now**');
    await expect(state).toHaveAttribute('data-save-state', 'dirty');
    await expect(page.getByTestId('knowledge-preview').locator('strong')).toHaveText('now');

    await editor.press('ControlOrMeta+s');
    await expect(state).toHaveAttribute('data-save-state', 'saving');
    await expect(state).toHaveAttribute('data-save-state', 'saved');
    await expect(page.getByTestId('knowledge-generation')).toHaveText('3');
    expect(writes).toEqual([{ method: 'PUT', path: ENTRY_PATH, body: { content: 'Edited **now**', expectedGeneration: 2 }, csrf: true }]);
    expect(problems).toEqual([]);
  });

  test('a 409 opens the conflict dialog, keeps the draft, and loads the server version only after confirming', async ({ page }) => {
    const problems = watchConsole(page, { allow: [/Failed to load resource/] });
    const writes: Write[] = [];
    let serverVersion = memoryEntry;
    await openEntry(page, {
      [ENTRY_PATH]: (route) => {
        if (route.request().method() === 'GET') return answer(200, { data: serverVersion })(route);
        record(writes, route);
        serverVersion = { ...memoryEntry, content: 'Changed on the server', generation: 5 };
        return answer(409, { error: 'CONFLICT', message: 'Knowledge generation conflict' })(route);
      }
    });
    const editor = page.getByLabel('Markdown source');
    await editor.fill('My draft');
    await page.getByRole('button', { name: 'Save changes' }).click();

    const dialog = page.getByRole('dialog', { name: 'This entry changed elsewhere' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('region', { name: 'Current on server (generation 5)' })).toContainText('Changed on the server');
    await expect(dialog.getByRole('region', { name: 'Your changes (unsaved)' })).toContainText('My draft');
    await expect(dialog.getByRole('region', { name: 'Base version (generation 2)' })).toContainText('write-through');
    await expect(page.getByTestId('knowledge-save-state')).toHaveAttribute('data-save-state', 'error');
    await expectNoSeriousA11yViolations(page);

    // Keeping the draft is the default; nothing is lost.
    await dialog.getByRole('button', { name: 'Keep my draft' }).click();
    await expect(dialog).toBeHidden();
    await expect(editor).toHaveValue('My draft');

    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Load server version' }).click();
    const confirm = dialog.getByRole('alertdialog', { name: /Discard your draft and load the server version/ });
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(editor).toHaveValue('My draft');

    await dialog.getByRole('button', { name: 'Load server version' }).click();
    await dialog.getByRole('button', { name: 'Discard draft and load' }).click();
    await expect(dialog).toBeHidden();
    await expect(editor).toHaveValue('Changed on the server');
    await expect(page.getByTestId('knowledge-generation')).toHaveText('5');
    await expect(page.getByTestId('knowledge-save-state')).toHaveAttribute('data-save-state', 'saved');
    expect(writes.map((write) => write.body)).toEqual([{ content: 'My draft', expectedGeneration: 2 }, { content: 'My draft', expectedGeneration: 2 }]);
    expect(problems).toEqual([]);
  });

  test('an unsaved draft survives a reload and blocks leaving until confirmed', async ({ page }) => {
    await stubReads(page, { [ENTRY_PATH]: answer(200, { data: memoryEntry }), '/knowledge': listHandler });
    await page.goto(entryUrl);
    const editor = page.getByLabel('Markdown source');
    await expect(editor).toHaveValue(memoryEntry.content);
    await editor.fill('Draft in progress');
    // The draft is written after the preview debounce; only non-secret entry content is stored.
    await expect.poll(() => page.evaluate((id) => sessionStorage.getItem(`cloud-harness:knowledge-draft:${id}`), ENTRY_ID)).toContain('Draft in progress');
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('Draft in progress');

    await page.reload();
    await expect(editor).toHaveValue('Draft in progress');
    await expect(page.getByRole('status').filter({ hasText: 'Restored your unsaved draft' })).toBeVisible();

    await sidebarLink(page, 'knowledge').click();
    const leave = page.getByRole('alertdialog', { name: 'Leave with unsaved changes?' });
    await expect(leave).toBeVisible();
    await leave.getByRole('button', { name: 'Cancel' }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/knowledge/${ENTRY_ID}$`));
    await expect(editor).toHaveValue('Draft in progress');

    await sidebarLink(page, 'knowledge').click();
    await page.getByRole('alertdialog', { name: 'Leave with unsaved changes?' }).getByRole('button', { name: 'Discard and leave' }).click();
    await expect(page).toHaveURL(/\/dashboard\/knowledge$/);
    expect(await page.evaluate((id) => sessionStorage.getItem(`cloud-harness:knowledge-draft:${id}`), ENTRY_ID)).toBeNull();
  });

  test('delete confirms with the target, sends the fence and returns to the list', async ({ page }) => {
    const problems = watchConsole(page);
    const writes: Write[] = [];
    await openEntry(page, {
      [ENTRY_PATH]: (route) => {
        if (route.request().method() === 'GET') return answer(200, { data: memoryEntry })(route);
        record(writes, route);
        return answer(200, { data: { id: ENTRY_ID, deleted: true } })(route);
      },
      '/knowledge': listHandler
    });
    await page.getByRole('button', { name: 'Delete entry' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete knowledge entry?' });
    await expect(confirm).toContainText(ENTRY_ID);
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Delete entry' }).click();
    await expect(page).toHaveURL(/\/dashboard\/knowledge$/);
    expect(writes).toEqual([{ method: 'DELETE', path: ENTRY_PATH, body: { expectedGeneration: 2 }, csrf: true }]);
    expect(problems).toEqual([]);
  });

  test('an unknown entry says so instead of failing', async ({ page }) => {
    const problems = watchConsole(page, { allow: [/Failed to load resource/] });
    await stubReads(page, { '/knowledge/kn_gone1234567890': answer(404, { error: 'NOT_FOUND', message: 'Knowledge item not found' }) });
    await page.goto('/dashboard/knowledge/kn_gone1234567890');
    await expect(page.getByText('Knowledge entry not found')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to knowledge' })).toHaveAttribute('href', '/dashboard/knowledge');
    expect(problems).toEqual([]);
  });
});
