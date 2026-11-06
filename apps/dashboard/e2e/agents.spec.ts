import { expect, type Page, type Request, test } from '@playwright/test';
import {
  AGENTS, CHILD_ID, FAILED, FAILED_ID, FAILED_ONLY, LOGS_EMPTY_TAIL, LOGS_FIRST, LOGS_NEXT, NO_AGENTS, PARENT, PARENT_ID, WORKSPACE_ID
} from './fixtures/agents';
import { answer, expectNoSeriousA11yViolations, expectPage, type ReadHandler, stubReads, watchConsole } from './support';

// Agents: the hierarchy and table over one filtered `/agents` read, URL-bound filters, and the
// agent detail with usage against budget, the forward log tail, Follow, follow-up messages
// (one idempotency key per intent) and a confirmed cancel.

const API = '/dashboard/api/v1';
const DETAIL = `/agents/${PARENT_ID}`;
const LOGS = `/agents/${PARENT_ID}/logs`;

/** Every BFF GET the page makes, as `path?query`, so duplicates and extra fan-out show up. */
function recordReads(page: Page): string[] {
  const reads: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.startsWith(API) && !['/session', '/profile', '/preferences'].includes(url.pathname.slice(API.length))) {
      reads.push(`${url.pathname.slice(API.length)}${url.search}`);
    }
  });
  return reads;
}

function expectNoDuplicates(reads: string[]) {
  expect(reads.length, reads.join('\n')).toBe(new Set(reads).size);
}

/** `/agents` answered by its filters, as the BFF would: status narrows the rows. */
const agentList: ReadHandler = async (route) => {
  const status = new URL(route.request().url()).searchParams.get('status');
  await answer(200, status === 'FAILED' ? FAILED_ONLY : status ? NO_AGENTS : AGENTS)(route);
};

/** The log tail answered by cursor: first page, the next page, then an empty tail. */
const logPages: ReadHandler = async (route) => {
  const cursor = new URL(route.request().url()).searchParams.get('cursor');
  await answer(200, cursor === '120' ? LOGS_NEXT : cursor === '180' ? LOGS_EMPTY_TAIL : LOGS_FIRST)(route);
};

/** The table row whose agent link is `agentId` (a child row also names its parent). */
function rowOf(page: Page, agentId: string) {
  return page.getByRole('table').getByRole('row').filter({ has: page.getByRole('link', { name: agentId, exact: true }) });
}

async function pageChecks(page: Page) {
  expect(await page.getByTestId('primary-action').count()).toBeLessThanOrEqual(1);
  await expect(page.locator('main [style]')).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);
}

test('the list shows the hierarchy and table, filters through the URL and restores them on reload', async ({ page }) => {
  const problems = watchConsole(page);
  const reads = recordReads(page);
  await stubReads(page, { '/agents': agentList });
  await page.goto('/dashboard/agents');
  await expectPage(page, 'agents');

  const hierarchy = page.getByRole('region', { name: 'Hierarchy' });
  // The child renders inside its parent's list item, so the nesting is real.
  await expect(hierarchy.locator('li', { hasText: PARENT_ID }).locator('li', { hasText: CHILD_ID })).toHaveCount(1);
  const table = page.getByRole('table', { name: '3 agents' });
  await expect(table.getByRole('row')).toHaveCount(4);
  await expect(table.getByRole('link', { name: PARENT_ID })).toHaveAttribute('href', `/dashboard/agents/${PARENT_ID}?workspaceId=${WORKSPACE_ID}`);
  // Usage against budget, in words as well as a meter.
  await expect(rowOf(page, FAILED_ID)).toContainText('100% of limit');
  await expect(rowOf(page, FAILED_ID)).toContainText('Limit reached');
  await expect(rowOf(page, PARENT_ID)).toContainText('Close to limit');
  await pageChecks(page);

  await page.getByLabel('Status').selectOption('FAILED');
  await expect(page).toHaveURL(/\/dashboard\/agents\?status=FAILED$/);
  await expect(page.getByRole('table', { name: '1 agents' })).toBeVisible();
  await expect(page.getByRole('table', { name: '1 agents' })).toContainText(FAILED_ID);

  await page.reload();
  await expectPage(page, 'agents');
  await expect(page.getByLabel('Status')).toHaveValue('FAILED');
  await expect(page.getByRole('table', { name: '1 agents' })).toContainText(FAILED_ID);

  // One read per filter state, with exactly the classic query, never a duplicate per load.
  expect(reads).toEqual(['/agents', '/agents?status=FAILED', '/agents?status=FAILED']);
  expect(problems).toEqual([]);
});

test('attention and id filters send the BFF values and flag a malformed id in place', async ({ page }) => {
  const problems = watchConsole(page);
  const reads = recordReads(page);
  await stubReads(page, { '/agents': agentList });
  // An older boolean link means "needs attention", the value the BFF filter compares.
  await page.goto('/dashboard/agents?attention=1');
  await expectPage(page, 'agents');
  await expect(page.getByLabel('Attention')).toHaveValue('needs-attention');
  await expect.poll(() => reads).toEqual(['/agents?attention=needs-attention']);

  const workspace = page.getByRole('textbox', { name: 'Workspace', exact: true });
  await workspace.fill('ws_short');
  await expect(page.getByText('A workspace id looks like ws_')).toBeVisible();
  await expect(workspace).toHaveAttribute('aria-invalid', 'true');
  await page.waitForTimeout(500);
  expect(page.url()).not.toContain('workspaceId');

  await workspace.fill(WORKSPACE_ID);
  await expect(page).toHaveURL(new RegExp(`workspaceId=${WORKSPACE_ID}`));
  await expect.poll(() => reads.at(-1)).toBe(`/agents?workspaceId=${WORKSPACE_ID}&attention=needs-attention`);

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).toHaveURL(/\/dashboard\/agents$/);
  await expect(workspace).toHaveValue('');
  expectNoDuplicates(reads);
  expect(problems).toEqual([]);
});

test('malformed deep-link params never reach the BFF', async ({ page }) => {
  const problems = watchConsole(page);
  const reads = recordReads(page);
  await stubReads(page, { '/agents': agentList, [DETAIL]: answer(200, { data: PARENT }), [LOGS]: logPages });
  await page.goto(`/dashboard/agents?status=bogus&workspaceId=ws_bad&parentAgentId=nope&attention=maybe&profileId=${'x'.repeat(200)}`);
  await expectPage(page, 'agents');
  await expect(page.getByRole('table', { name: '3 agents' })).toBeVisible();
  await expect(page.getByLabel('Status')).toHaveValue('');
  expect(reads).toEqual(['/agents']);

  await page.goto(`/dashboard/agents/${PARENT_ID}?workspaceId=ws_bad`);
  await expectPage(page, 'agent');
  await expect(page.getByRole('region', { name: 'Overview' })).toContainText('coding-fast');
  expect(reads.slice(1).sort()).toEqual([DETAIL, LOGS].sort());
  expect(problems).toEqual([]);
});

test('the list has loading, empty, filtered-empty and error states', async ({ page }) => {
  const problems = watchConsole(page, { allow: [/Failed to load resource/] });
  let mode: 'slow' | 'empty' | 'error' = 'slow';
  await stubReads(page, {
    '/agents': async (route) => {
      if (mode === 'slow') return answer(200, NO_AGENTS, { delayMs: 1_500 })(route);
      if (mode === 'error') return answer(503, { error: 'runner_unavailable', message: 'The runner is unavailable.' })(route);
      return answer(200, NO_AGENTS)(route);
    }
  });
  await page.goto('/dashboard/agents');
  await expectPage(page, 'agents');
  await expect(page.getByRole('status', { name: 'Loading agents' })).toBeVisible();
  await expect(page.getByText('No agents yet')).toBeVisible();

  mode = 'empty';
  await page.getByLabel('Status').selectOption('RUNNING');
  await expect(page.getByText('No agents match these filters')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(2);

  mode = 'error';
  await page.getByLabel('Status').selectOption('FAILED');
  const alert = page.getByRole('alert').filter({ hasText: 'The server could not answer' });
  await expect(alert).toBeVisible({ timeout: 10_000 });
  await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(page.locator('main')).not.toContainText('runner_unavailable');
  await pageChecks(page);
  expect(problems).toEqual([]);
});

test('the detail shows usage against budget and the log, pages forward, and costs the classic two reads', async ({ page }) => {
  const problems = watchConsole(page);
  const reads = recordReads(page);
  await stubReads(page, { [DETAIL]: answer(200, { data: PARENT }), [LOGS]: logPages });
  await page.goto(`/dashboard/agents/${PARENT_ID}?workspaceId=${WORKSPACE_ID}`);
  await expectPage(page, 'agent');

  const overview = page.getByRole('region', { name: 'Overview' });
  await expect(overview).toContainText('coding-fast');
  await expect(overview.getByRole('link', { name: 'Agents this one spawned' })).toHaveAttribute('href', `/dashboard/agents?parentAgentId=${PARENT_ID}&workspaceId=${WORKSPACE_ID}`);
  const usage = page.getByRole('region', { name: 'Usage and budget' });
  await expect(usage).toContainText('12,000 of 200,000 (6%)');
  await expect(usage).toContainText('$4.20 of $5.00 (84%)');
  await expect(usage).toContainText('Close to limit');

  const log = page.getByRole('log', { name: 'Agent log' });
  await expect(log).toContainText('Planning the change');
  // Log content is text, never markup.
  await expect(log).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('main img')).toHaveCount(0);
  expect([...reads].sort()).toEqual([`${DETAIL}?workspaceId=${WORKSPACE_ID}`, `${LOGS}?workspaceId=${WORKSPACE_ID}`].sort());
  await pageChecks(page);

  await page.getByRole('button', { name: 'Load newer events' }).click();
  await expect(log).toContainText('Tests passed');
  await expect(page.getByRole('button', { name: 'Load newer events' })).toHaveCount(0);
  expect(reads).toContain(`${LOGS}?workspaceId=${WORKSPACE_ID}&cursor=120`);
  // Follow is off by default: the page did not poll.
  await page.waitForTimeout(6_000);
  expect(reads).toHaveLength(3);
  expect(problems).toEqual([]);
});

test('Follow polls the detail and the log tail only while the agent runs', async ({ page }) => {
  test.setTimeout(60_000);
  const problems = watchConsole(page);
  const reads = recordReads(page);
  let status = 'RUNNING';
  await stubReads(page, { [DETAIL]: async (route) => answer(200, { data: { ...PARENT, status } })(route), [LOGS]: logPages });
  await page.goto(`/dashboard/agents/${PARENT_ID}?workspaceId=${WORKSPACE_ID}`);
  await expectPage(page, 'agent');
  const follow = page.getByRole('button', { name: 'Follow' });
  await follow.click();
  await expect(follow).toHaveAttribute('aria-pressed', 'true');
  // The poll reads only what follows the tail.
  await expect.poll(() => reads.filter((read) => read.includes('cursor=120')).length, { timeout: 12_000 }).toBeGreaterThan(0);
  await expect(page.getByRole('log', { name: 'Agent log' })).toContainText('Tests passed');

  status = 'SUCCEEDED';
  await expect(page.getByRole('region', { name: 'Overview' }).locator('[data-status=SUCCEEDED]')).toBeVisible({ timeout: 12_000 });
  await expect(follow).toHaveCount(0);
  // Terminal: the message and cancel controls are gone and the polls stop.
  await expect(page.getByRole('button', { name: 'Cancel agent' })).toHaveCount(0);
  await page.waitForTimeout(1_000);
  const settled = reads.length;
  await page.waitForTimeout(6_500);
  expect(reads.length).toBe(settled);
  expect(problems).toEqual([]);
});

test('a follow-up keeps its idempotency key across a failed retry and renews it after success', async ({ page }) => {
  const problems = watchConsole(page, { allow: [/Failed to load resource/] });
  await stubReads(page, { [DETAIL]: answer(200, { data: PARENT }), [LOGS]: logPages });
  const sent: Array<{ body: Record<string, unknown>; csrf: string | undefined }> = [];
  let fail = true;
  await page.route(`**${API}${DETAIL}/messages`, async (route) => {
    const request: Request = route.request();
    expect(request.method()).toBe('POST');
    sent.push({ body: request.postDataJSON() as Record<string, unknown>, csrf: request.headers()['x-csrf-token'] });
    if (fail) {
      fail = false;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal_error', message: 'Internal error' }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { agentId: PARENT_ID, status: 'RUNNING', replayed: false } }) });
  });
  await page.goto(`/dashboard/agents/${PARENT_ID}?workspaceId=${WORKSPACE_ID}`);
  await expectPage(page, 'agent');

  const send = page.getByRole('button', { name: 'Send message' });
  // Blank is refused on the client.
  await send.click();
  await expect(page.getByText('Write a message for the agent.')).toBeVisible();
  expect(sent).toHaveLength(0);

  await page.getByLabel('Delivery').selectOption('followUp');
  await page.getByRole('textbox', { name: 'Message' }).fill('Also update the changelog');
  await send.click();
  await expect(page.getByText('The message was not sent', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Send message|Not sent/ })).toHaveText(/Send message/, { timeout: 5_000 });
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Message sent to the agent', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');

  expect(sent).toHaveLength(2);
  expect(sent[0]?.body).toEqual({ workspaceId: WORKSPACE_ID, message: 'Also update the changelog', mode: 'followUp', idempotencyKey: expect.stringMatching(/^[A-Za-z0-9._:-]{8,128}$/) });
  // The retry is the same intent: same key, same body, and the path id is never repeated in it.
  expect(sent[1]?.body).toEqual(sent[0]?.body);
  expect(sent.every((entry) => Boolean(entry.csrf))).toBe(true);
  expect(sent[0]?.body).not.toHaveProperty('agentId');

  await page.getByRole('textbox', { name: 'Message' }).fill('Then open a PR');
  await page.getByRole('button', { name: /Send message|Sent/ }).click();
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2]?.body.idempotencyKey).not.toBe(sent[0]?.body.idempotencyKey);
  expect(problems).toEqual([]);
});

test('cancel confirms naming the agent and sends the workspace and a bounded reason', async ({ page }) => {
  const problems = watchConsole(page);
  await stubReads(page, { [DETAIL]: answer(200, { data: PARENT }), [LOGS]: logPages });
  const sent: Array<{ body: unknown; csrf: string | undefined }> = [];
  await page.route(`**${API}${DETAIL}/cancel`, async (route) => {
    expect(route.request().method()).toBe('POST');
    sent.push({ body: route.request().postDataJSON(), csrf: route.request().headers()['x-csrf-token'] });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { agentId: PARENT_ID, status: 'CANCELLING', affectedAgentIds: [PARENT_ID] } }) });
  });
  await page.goto(`/dashboard/agents/${PARENT_ID}?workspaceId=${WORKSPACE_ID}`);
  await expectPage(page, 'agent');

  await expect(page.getByLabel(/Reason/)).toHaveAttribute('maxlength', '2000');
  await page.getByLabel(/Reason/).fill('Wrong branch');
  await page.getByRole('button', { name: 'Cancel agent' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Cancel this agent and its children?' });
  await expect(dialog).toContainText(PARENT_ID);
  // Dismissing sends nothing.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(sent).toHaveLength(0);

  await page.getByRole('button', { name: 'Cancel agent' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel agent' }).click();
  await expect(page.getByText('Agent cancelled', { exact: true })).toBeVisible();
  expect(sent).toEqual([{ body: { workspaceId: WORKSPACE_ID, reason: 'Wrong branch' }, csrf: expect.any(String) }]);
  expect(problems).toEqual([]);
});

test('an unknown agent says so, and a terminal agent offers no controls', async ({ page }) => {
  const problems = watchConsole(page, { allow: [/Failed to load resource/] });
  await stubReads(page, {
    [DETAIL]: answer(404, { error: 'not_found', message: 'Agent not found.' }),
    [LOGS]: answer(404, { error: 'not_found', message: 'Agent not found.' }),
    [`/agents/${FAILED_ID}`]: answer(200, { data: FAILED }),
    [`/agents/${FAILED_ID}/logs`]: answer(200, { data: { ...LOGS_EMPTY_TAIL.data, agentId: FAILED_ID, cursor: '0', nextCursor: '0' } })
  });
  await page.goto(`/dashboard/agents/${PARENT_ID}`);
  await expectPage(page, 'agent');
  await expect(page.getByText('Agent not found')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('link', { name: 'Back to agents' })).toHaveAttribute('href', '/dashboard/agents');

  await page.goto(`/dashboard/agents/${FAILED_ID}`);
  await expectPage(page, 'agent');
  await expect(page.getByRole('region', { name: 'Overview' })).toContainText('budget exhausted');
  await expect(page.getByText('No retained log events for this agent.')).toBeVisible();
  await expect(page.getByText('This agent is not running, so it cannot receive messages.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel agent' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Follow' })).toHaveCount(0);
  await pageChecks(page);
  expect(problems).toEqual([]);
});
