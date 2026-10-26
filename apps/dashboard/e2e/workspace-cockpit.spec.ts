import { expect, test, type Page, type Request } from '@playwright/test';
import { answer, expectNoSeriousA11yViolations, expectPage, type ReadHandler, stubReads, watchConsole } from './support';
import {
  activeWorkspace, CLOSED_ID, closedWorkspace, contextProjection, runtimeProjection, SESSION_ID, sessionIo, TASK_ID, taskStatus, taskStatusNext,
  WORKSPACE_ID, workspaceActivity, workspaceAgents
} from './fixtures/workspaces';

// The workspace cockpit: header with lease renewal, a tab per URL, live tabs gated on ACTIVE,
// and the summary, agents, runtime and activity tabs.

const API = '/dashboard/api/v1';
const base = `/workspaces/${WORKSPACE_ID}`;

const READS: Record<string, ReadHandler> = {
  [base]: answer(200, { data: activeWorkspace }),
  [`${base}/context`]: answer(200, contextProjection),
  [`${base}/runtime`]: answer(200, runtimeProjection),
  [`${base}/agents`]: answer(200, workspaceAgents),
  [`${base}/activity`]: answer(200, workspaceActivity),
  [`${base}/tasks/${TASK_ID}`]: (route) => answer(200, new URL(route.request().url()).searchParams.get('cursor') === 'c_2' ? taskStatusNext : taskStatus)(route),
  [`${base}/sessions/${SESSION_ID}/io`]: answer(200, sessionIo),
  [`/workspaces/${CLOSED_ID}`]: answer(200, { data: closedWorkspace })
};

function trackReads(page: Page): string[] {
  const reads: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.startsWith(`${API}/`) && !['/session', '/profile', '/preferences'].includes(url.pathname.slice(API.length))) {
      reads.push(`${url.pathname.slice(API.length)}${url.search}`);
    }
  });
  return reads;
}

/** Captures one mutation to `path` and answers it. */
function mutation(page: Page, path: string, body: unknown = { data: {} }) {
  const captured: Request[] = [];
  const handler: ReadHandler = async (route) => {
    if (route.request().method() === 'GET') return answer(200)(route);
    captured.push(route.request());
    return answer(200, body)(route);
  };
  return { captured, handler };
}

/** A toast, by its title, inside the notifications region (its live mirror repeats the text). */
const toastTitled = (page: Page, title: string) => page.getByRole('region', { name: /Notifications/ }).getByText(title, { exact: true });

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Workspace sections' });

test('summary: header, attention and repository context, reading each endpoint once', async ({ page }) => {
  const problems = watchConsole(page);
  const reads = trackReads(page);
  await stubReads(page, READS);
  await page.goto(`/dashboard${base}`);
  await expectPage(page, 'workspace');
  await expect(page.getByRole('heading', { name: 'acme/rocket' })).toBeVisible();
  await expect(tabs(page).getByRole('link', { name: 'Summary' })).toHaveAttribute('aria-current', 'page');
  const summary = page.getByRole('region', { name: 'Summary' });
  await expect(summary).toContainText('feature/launch');
  await expect(summary).toContainText('12 attributable item(s)');
  await expect(summary).toContainText('git, tests');
  await expect(page.getByRole('region', { name: 'Needs attention' })).toContainText('Nothing needs attention');
  expect(await page.getByTestId('primary-action').count()).toBeLessThanOrEqual(1);
  expect(reads.filter((read) => read === base)).toHaveLength(1);
  expect(reads.filter((read) => read === `${base}/context`)).toHaveLength(1);
  expect(await page.locator('main [style]').count()).toBe(0);
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});

test('the classic /summary deep link lands on the bare workspace URL', async ({ page }) => {
  const problems = watchConsole(page);
  await stubReads(page, READS);
  await page.goto(`/dashboard${base}/summary`);
  await expect(page).toHaveURL(new RegExp(`/dashboard${base}$`));
  await expectPage(page, 'workspace');
  await expect(page.getByText('Page not found')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('renew lease posts once with the CSRF header and reports a capped renewal', async ({ page }) => {
  const renew = mutation(page, `${base}/lease-renew`, { data: { ...activeWorkspace, leaseCapped: true } });
  await stubReads(page, { ...READS, [`${base}/lease-renew`]: renew.handler });
  await page.goto(`/dashboard${base}`);
  await page.getByRole('button', { name: 'Renew lease' }).dblclick();
  await expect(toastTitled(page, 'Lease renewed only until the maximum workspace lifetime; the workspace still expires then.')).toBeVisible();
  expect(renew.captured).toHaveLength(1);
  expect(renew.captured[0]!.method()).toBe('POST');
  expect(renew.captured[0]!.postDataJSON()).toEqual({});
  expect(renew.captured[0]!.headers()['x-csrf-token']).toBeTruthy();
});

test('a closed workspace offers no renewal and explains why live tabs are unavailable', async ({ page }) => {
  const reads = trackReads(page);
  await stubReads(page, READS);
  await page.goto(`/dashboard/workspaces/${CLOSED_ID}`);
  await expect(page.getByRole('heading', { name: 'acme/legacy-site' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Renew lease' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Needs attention' })).toContainText('Lease expired');
  // No context read for a workspace whose runner does not offer it.
  expect(reads.some((read) => read.endsWith('/context'))).toBe(false);

  await tabs(page).getByRole('link', { name: 'Runtime' }).click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/${CLOSED_ID}/runtime$`));
  await expect(page.getByText('Runtime is unavailable while the workspace is Closed')).toBeVisible();
  expect(reads.some((read) => read.endsWith('/runtime'))).toBe(false);
});

test('an unknown workspace shows a not-found state with a way back', async ({ page }) => {
  await stubReads(page, { '/workspaces/ws_missingmissingmiss01': answer(404, { error: 'NOT_FOUND', message: 'Workspace not found.' }) });
  await page.goto('/dashboard/workspaces/ws_missingmissingmiss01');
  await expect(page.getByText('Workspace not found or no longer available')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to workspaces' })).toHaveAttribute('href', '/dashboard/workspaces');
});

test('runtime: tasks and sessions, task output as a deep link, bounded slices', async ({ page }) => {
  const problems = watchConsole(page);
  await stubReads(page, READS);
  await page.goto(`/dashboard${base}/runtime`);
  const tasks = page.getByRole('region', { name: 'Tasks' });
  await expect(tasks.locator('caption')).toHaveText('2 task(s)');
  await expect(tasks.getByRole('row', { name: /npm test/ })).toContainText('Succeeded');
  await expect(tasks.getByRole('row', { name: /npm test/ }).getByRole('button', { name: /Cancel/ })).toHaveCount(0);

  await tasks.getByRole('button', { name: 'Output of npm run build' }).click();
  await expect(page).toHaveURL(new RegExp(`task=${TASK_ID}`));
  const output = page.getByTestId('runtime-output');
  // Process output renders as text, never markup.
  await expect(output).toContainText('<b>not markup</b>');
  await page.getByRole('button', { name: 'Next slice' }).click();
  await expect(output).toHaveText('built in 4.2s');

  await page.reload();
  await expect(page.getByRole('region', { name: 'Task output' })).toBeVisible();

  const sessions = page.getByRole('region', { name: 'Sessions' });
  await sessions.getByRole('button', { name: 'Read output of review' }).click();
  await expect(page.getByRole('region', { name: 'Session output' })).toContainText('On branch main');
  // Session output never reaches the URL.
  expect(page.url()).not.toContain(SESSION_ID);
  expect(await page.locator('main [style]').count()).toBe(0);
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});

test('runtime: cancel confirms and posts once; an invalid task param is ignored', async ({ page }) => {
  const cancel = mutation(page, `${base}/tasks/${TASK_ID}/cancel`);
  await stubReads(page, { ...READS, [`${base}/tasks/${TASK_ID}/cancel`]: cancel.handler });
  await page.goto(`/dashboard${base}/runtime?task=..%2Fetc`);
  await expect(page.getByRole('region', { name: 'Task output' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Cancel npm run build' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(TASK_ID);
  await dialog.getByRole('button', { name: 'Cancel task' }).click();
  await expect(toastTitled(page, 'Task cancelled.')).toBeVisible();
  expect(cancel.captured).toHaveLength(1);
  expect(cancel.captured[0]!.headers()['x-csrf-token']).toBeTruthy();
});

test('runtime: open session sends name, cwd and one idempotency key across a retry', async ({ page }) => {
  const sent: Array<Record<string, unknown>> = [];
  let attempts = 0;
  await stubReads(page, {
    ...READS,
    [`${base}/sessions`]: async (route) => {
      sent.push(route.request().postDataJSON() as Record<string, unknown>);
      attempts += 1;
      return attempts === 1 ? answer(503, { error: 'RUNNER_UNAVAILABLE', message: 'Try again.' })(route) : answer(200, { data: { id: 'sess_new_01' } })(route);
    }
  });
  await page.goto(`/dashboard${base}/runtime`);
  await page.getByRole('button', { name: 'Open session' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open coding session' });
  await dialog.getByRole('button', { name: 'Open session' }).click();
  await expect(dialog.getByText('Name the session.')).toBeVisible();
  await dialog.getByLabel('Session name').fill('docs');
  await dialog.getByRole('button', { name: 'Open session' }).click();
  await expect(toastTitled(page, 'The session was not opened')).toBeVisible();
  await dialog.getByRole('button', { name: 'Open session' }).click();
  await expect(dialog).toBeHidden();
  expect(sent).toHaveLength(2);
  expect(sent[0]).toMatchObject({ name: 'docs', cwd: '.' });
  expect(typeof sent[0]!.idempotencyKey).toBe('string');
  expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
});

test('runtime: open session sends the name and directory trimmed, as the server pattern expects', async ({ page }) => {
  const sent: Array<Record<string, unknown>> = [];
  await stubReads(page, {
    ...READS,
    [`${base}/sessions`]: async (route) => {
      sent.push(route.request().postDataJSON() as Record<string, unknown>);
      return answer(200, { data: { id: 'sess_trim_01' } })(route);
    }
  });
  await page.goto(`/dashboard${base}/runtime`);
  await page.getByRole('button', { name: 'Open session' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open coding session' });
  await dialog.getByLabel('Session name').fill('  review ');
  await dialog.getByLabel('Working directory').fill(' packages/api  ');
  await dialog.getByRole('button', { name: 'Open session' }).click();
  await expect(dialog).toBeHidden();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ name: 'review', cwd: 'packages/api' });
});

test('runtime: a changed name or a reopened dialog after a failure is a new intent with a new key', async ({ page }) => {
  const sent: Array<Record<string, unknown>> = [];
  await stubReads(page, {
    ...READS,
    [`${base}/sessions`]: async (route) => {
      sent.push(route.request().postDataJSON() as Record<string, unknown>);
      return answer(503, { error: 'RUNNER_UNAVAILABLE', message: 'Try again.' })(route);
    }
  });
  await page.goto(`/dashboard${base}/runtime`);
  await page.getByRole('button', { name: 'Open session' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open coding session' });
  await dialog.getByLabel('Session name').fill('docs');
  await dialog.getByRole('button', { name: 'Open session' }).click();
  await expect.poll(() => sent.length).toBe(1);
  await dialog.getByLabel('Session name').fill('tests');
  await dialog.getByRole('button', { name: 'Open session' }).click();
  await expect.poll(() => sent.length).toBe(2);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  // The typed values make the dialog dirty, so closing asks first.
  const discard = page.getByRole('button', { name: /discard/i });
  if (await discard.isVisible().catch(() => false)) await discard.click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Open session' }).click();
  await dialog.getByLabel('Session name').fill('tests');
  await dialog.getByRole('button', { name: 'Open session' }).click();
  await expect.poll(() => sent.length).toBe(3);
  expect(sent.map((body) => body.name)).toEqual(['docs', 'tests', 'tests']);
  expect(new Set(sent.map((body) => body.idempotencyKey)).size).toBe(3);
});

test('agents and activity tabs render their projections', async ({ page }) => {
  await stubReads(page, READS);
  await page.goto(`/dashboard${base}/agents`);
  await expect(page.getByRole('link', { name: 'agent_cockpit_01' })).toHaveAttribute('href', `/dashboard/agents/agent_cockpit_01?workspaceId=${WORKSPACE_ID}`);
  await tabs(page).getByRole('link', { name: 'Activity' }).click();
  await expect(page.getByRole('list', { name: 'Workspace activity' }).getByTestId('activity-event')).toHaveCount(2);
  await expect(page.getByText('Retained audit', { exact: true })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test('a tab deep link keeps its URL, and the classic hand-off carries it', async ({ page }) => {
  await stubReads(page, READS);
  await page.goto(`/dashboard${base}/files?path=src`);
  await expect(tabs(page).getByRole('link', { name: 'Files' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Use classic Dashboard' })).toHaveAttribute('href', `/dashboard${base}/files?path=src&ui=legacy`);
});
