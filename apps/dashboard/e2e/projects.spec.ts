import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import { answer, expectNoSeriousA11yViolations, expectPage, type ReadHandler, stubReads, watchConsole } from './support';
import { ENVIRONMENT_ID, environmentsList, OTHER_PROJECT_ID, PROJECT_ID, projectsList } from './fixtures/projects';

// Projects and environments: one primary action, strict create bodies, generation fences on
// rename/delete, confirmations naming the target, and the 409 "changed elsewhere" path.

const API = '/dashboard/api/v1';

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

/** Answers GET with `read` and records + answers every other method with `write`. */
function byMethod(read: ReadHandler, writes: Array<{ method: string; body: unknown; csrf: boolean }>, write: ReadHandler = answer(200, { data: {} })): ReadHandler {
  return async (route: Route) => {
    const request: Request = route.request();
    if (request.method() === 'GET') return read(route);
    writes.push({ method: request.method(), body: request.postDataJSON(), csrf: Boolean(request.headers()['x-csrf-token']) });
    return write(route);
  };
}

test('lists projects as escaped text with one primary action and one read', async ({ page }) => {
  const problems = watchConsole(page);
  const requests = trackRequests(page);
  await stubReads(page, { '/projects': answer(200, projectsList) });
  await page.goto('/dashboard/projects');
  await expectPage(page, 'projects');
  const table = page.getByRole('table', { name: '2 projects' });
  await expect(table.getByRole('link', { name: 'Rocket' })).toHaveAttribute('href', `/dashboard/projects/${PROJECT_ID}`);
  // A hostile name renders as text: no element, no handler.
  await expect(table.getByRole('link', { name: '<img src=x onerror=alert(1)>' })).toHaveAttribute('href', `/dashboard/projects/${OTHER_PROJECT_ID}`);
  await expect(page.locator('main img')).toHaveCount(0);
  await expect(page.getByTestId('primary-action')).toHaveCount(1);
  await expect(page.getByTestId('primary-action')).toHaveText('New project');
  expect(requests).toEqual(['GET /projects']);
  expect(await page.locator('main [style]').count()).toBe(0);
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});

test('New project validates, sends a strict gen0 body with CSRF and refreshes the list', async ({ page }) => {
  const problems = watchConsole(page);
  const writes: Array<{ method: string; body: unknown; csrf: boolean }> = [];
  const requests = trackRequests(page);
  await stubReads(page, { '/projects': byMethod(answer(200, projectsList), writes, answer(200, { data: { id: `prj_${'e'.repeat(24)}`, name: 'Billing', generation: 1 } })) });
  await page.goto('/dashboard/projects');
  await expect(page.getByRole('table', { name: '2 projects' })).toBeVisible();

  await page.getByTestId('primary-action').click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Project name')).toBeFocused();
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Enter a name.');
  expect(writes).toEqual([]);

  // An edited form asks before an accidental dismissal discards it.
  await dialog.getByLabel('Project name').fill('  Billing  ');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expectNoSeriousA11yViolations(page);

  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Project created').first()).toBeVisible();
  expect(writes).toEqual([{ method: 'POST', body: { name: 'Billing', expectedGeneration: 0 }, csrf: true }]);
  await expect.poll(() => requests.filter((request) => request === 'GET /projects').length).toBe(2);
  expect(problems).toEqual([]);
});

test('empty and error states explain themselves', async ({ page }) => {
  const problems = watchConsole(page, { allow: [/Failed to load resource/] });
  await stubReads(page, { '/projects': answer(200, { data: { projects: [] } }) });
  await page.goto('/dashboard/projects');
  await expect(page.getByText('No projects yet')).toBeVisible();

  await page.unroute(`**${API}/**`);
  await stubReads(page, { '/projects': answer(503, { error: 'RUNNER_UNAVAILABLE', message: 'The runner is unavailable.' }) });
  await page.goto('/dashboard/projects');
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible({ timeout: 10_000 });
  await expect(alert).toContainText('The server could not answer');
  await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
  expect(problems).toEqual([]);
});

test('a bogus search param never reaches the BFF', async ({ page }) => {
  const requests = trackRequests(page);
  await stubReads(page, { '/projects': answer(200, projectsList) });
  await page.goto('/dashboard/projects?foo=%3Cscript%3E&cursor=x');
  await expect(page.getByRole('table', { name: '2 projects' })).toBeVisible();
  expect(requests).toEqual(['GET /projects']);
});

test.describe('project detail', () => {
  const detailUrl = `/dashboard/projects/${PROJECT_ID}`;

  async function openDetail(page: Page, handlers: Record<string, ReadHandler> = {}) {
    await stubReads(page, { '/projects': answer(200, projectsList), [`/projects/${PROJECT_ID}/environments`]: answer(200, environmentsList), ...handlers });
    await page.goto(detailUrl);
    await expect(page.locator('[data-testid=page-frame]')).toHaveAttribute('data-page-id', 'project');
    await expect(page.getByTestId('page-title')).toHaveText('Project');
    await expect(page.getByRole('heading', { name: 'Rocket' })).toBeVisible();
  }

  test('shows the project and its environments from the same two reads as the classic page', async ({ page }) => {
    const problems = watchConsole(page);
    const requests = trackRequests(page);
    await openDetail(page);
    const table = page.getByRole('table', { name: '2 environments' });
    await expect(table.getByRole('row', { name: /Production/ })).toContainText('3');
    // No page-level primary action here, and no secret reads: those move with the secrets pages.
    await expect(page.getByTestId('primary-action')).toHaveCount(0);
    expect([...requests].sort()).toEqual(['GET /projects', `GET /projects/${PROJECT_ID}/environments`]);
    expect(await page.locator('main [style]').count()).toBe(0);
    await expectNoSeriousA11yViolations(page);
    await page.setViewportSize({ width: 375, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(problems).toEqual([]);
  });

  test('environment create, rename and delete send the right bodies and fences', async ({ page }) => {
    const writes: Array<{ method: string; body: unknown; csrf: boolean }> = [];
    await openDetail(page, {
      [`/projects/${PROJECT_ID}/environments`]: byMethod(answer(200, environmentsList), writes),
      [`/environments/${ENVIRONMENT_ID}`]: byMethod(answer(404, {}), writes)
    });

    await page.getByRole('button', { name: 'New environment' }).click();
    const create = page.getByRole('dialog', { name: 'New environment' });
    await create.getByLabel('Environment name').fill('Preview');
    await create.getByRole('button', { name: 'Create environment' }).click();
    await expect(create).toBeHidden();

    await page.getByRole('button', { name: 'Rename Production' }).click();
    const rename = page.getByRole('dialog', { name: 'Rename environment' });
    await expect(rename.getByLabel('Environment name')).toHaveValue('Production');
    await rename.getByLabel('Environment name').fill('Prod');
    await rename.getByRole('button', { name: 'Rename' }).click();
    await expect(rename).toBeHidden();

    await page.getByRole('button', { name: 'Delete Production' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete environment?' });
    await expect(confirm).toContainText('Production');
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Delete environment' }).click();
    await expect(confirm).toBeHidden();

    expect(writes).toEqual([
      { method: 'POST', body: { name: 'Preview', expectedGeneration: 0 }, csrf: true },
      { method: 'PATCH', body: { name: 'Prod', expectedGeneration: 3 }, csrf: true },
      { method: 'DELETE', body: { expectedGeneration: 3 }, csrf: true }
    ]);
  });

  test('a 409 on delete shows "This changed elsewhere" and refetches; a delete that lands returns to the list', async ({ page }) => {
    const problems = watchConsole(page, { allow: [/Failed to load resource/] });
    const writes: Array<{ method: string; body: unknown; csrf: boolean }> = [];
    const requests = trackRequests(page);
    let attempt = 0;
    await openDetail(page, {
      [`/projects/${PROJECT_ID}`]: byMethod(answer(404, {}), writes, (route) => {
        attempt += 1;
        return attempt === 1 ? answer(409, { error: 'CONFLICT', message: 'Project generation conflict' })(route) : answer(200, { data: { id: PROJECT_ID } })(route);
      })
    });

    await page.getByRole('button', { name: 'Rename project' }).click();
    const rename = page.getByRole('dialog', { name: 'Rename project' });
    await expect(rename.getByLabel('Project name')).toHaveValue('Rocket');
    await page.keyboard.press('Escape');
    await expect(rename).toBeHidden();

    await page.getByRole('button', { name: 'Delete project' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete project?' });
    await expect(confirm).toContainText('Rocket');
    await confirm.getByRole('button', { name: 'Delete project' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'This changed elsewhere' });
    await expect(alert).toBeVisible();
    await expect.poll(() => requests.filter((request) => request === 'GET /projects').length).toBeGreaterThan(1);
    await expect(page).toHaveURL(new RegExp(`/dashboard/projects/${PROJECT_ID}$`));

    await page.getByRole('button', { name: 'Delete project' }).click();
    await page.getByRole('alertdialog', { name: 'Delete project?' }).getByRole('button', { name: 'Delete project' }).click();
    await expect(page).toHaveURL(/\/dashboard\/projects$/);
    expect(writes).toEqual([
      { method: 'DELETE', body: { expectedGeneration: 2 }, csrf: true },
      { method: 'DELETE', body: { expectedGeneration: 2 }, csrf: true }
    ]);
    expect(problems).toEqual([]);
  });

  test('an unknown project says so instead of failing', async ({ page }) => {
    const problems = watchConsole(page, { allow: [/Failed to load resource/] });
    const missing = `prj_${'z'.repeat(24)}`;
    await stubReads(page, { '/projects': answer(200, projectsList), [`/projects/${missing}/environments`]: answer(404, { error: 'NOT_FOUND', message: 'Project not found' }) });
    await page.goto(`/dashboard/projects/${missing}`);
    await expect(page.getByText('Project not found')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to projects' })).toHaveAttribute('href', '/dashboard/projects');
    expect(problems).toEqual([]);
  });
});
