import { expect, type Page, test } from '@playwright/test';
import { answer, expectNoSeriousA11yViolations, expectPage, watchConsole } from './support';
import { WORKSPACE_ID } from './fixtures/workspaces';
import { cockpitTabReads, cockpitWorkspace as workspace, SHA, SHA_NEXT } from './fixtures/cockpit-tabs';
import { stubBff, writesTo } from './write-support';

// The cockpit tabs moved to React in this phase: Files, Git, Automation, Deploy, Artifacts,
// the Runtime task graph and the header's lifecycle actions. Every write is asserted with its
// exact body (the classic Dashboard's, plus the contract fences) and its CSRF header.

const base = `/workspaces/${WORKSPACE_ID}`;

const READS = cockpitTabReads(base);

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Workspace sections' });
const toastTitled = (page: Page, title: string) => page.getByRole('region', { name: /Notifications/ }).getByText(title, { exact: true });

test('files: folder and file deep links, a fenced save, and a 409 that keeps the edit', async ({ page }) => {
  const problems = watchConsole(page);
  const writes = await stubBff(page, {
    reads: READS,
    writes: { [`PUT ${base}/files/content`]: [answer(200, { data: {} }), answer(409, { error: 'CONFLICT', message: 'Changed.' })] }
  });
  await page.goto(`/dashboard${base}/files?path=src`);
  await expectPage(page, 'workspace');
  await expect(tabs(page).getByRole('link', { name: 'Files' })).toHaveAttribute('aria-current', 'page');
  const listing = page.getByRole('list', { name: 'Contents of src' });
  // Folders first.
  await expect(listing.getByRole('link')).toHaveText(['lib', 'main.ts']);
  await expectNoSeriousA11yViolations(page);

  await listing.getByRole('link', { name: 'main.ts' }).click();
  await expect(page).toHaveURL(/file=src%2Fmain\.ts/);
  const editor = page.getByLabel('File content');
  await expect(editor).toHaveValue('export const answer = 41;\n');
  await editor.fill('export const answer = 42;\n');
  await page.getByRole('button', { name: 'Save file' }).click();
  await expect(toastTitled(page, 'File saved.')).toBeVisible();
  expect(writesTo(writes, 'PUT', `${base}/files/content`)[0]).toMatchObject({ body: { path: 'src/main.ts', content: 'export const answer = 42;\n', expectedSha256: SHA } });
  expect(writes[0]!.csrf).toBeTruthy();

  // A file that changed meanwhile is refused; the operator's text stays in the editor.
  await editor.fill('export const answer = 43;\n');
  await page.getByRole('button', { name: 'Save file' }).click();
  const conflict = page.getByRole('dialog');
  await expect(conflict).toBeVisible();
  await conflict.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toHaveValue('export const answer = 43;\n');

  await page.reload();
  await expect(page.getByLabel('File content')).toBeVisible();
  expect(problems.filter((line) => !/409|Failed to load resource/.test(line))).toEqual([]);
});

test('files: delete confirms and is fenced by the version the operator opened', async ({ page }) => {
  const writes = await stubBff(page, { reads: READS });
  await page.goto(`/dashboard${base}/files?file=src%2Fmain.ts`);
  await page.getByRole('button', { name: 'Delete file' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('src/main.ts');
  await dialog.getByRole('button', { name: 'Delete file' }).click();
  await expect(toastTitled(page, 'File deleted.')).toBeVisible();
  expect(writesTo(writes, 'DELETE', `${base}/files/content`).map((entry) => entry.body)).toEqual([{ path: 'src/main.ts', recursive: false, expectedSha256: SHA }]);
  await expect(page).toHaveURL(/path=\./);
});

test('git: status, the staged diff as a URL param, and advanced operations in contract shape', async ({ page }) => {
  const writes = await stubBff(page, { reads: READS, writes: { [`POST ${base}/git/fetch`]: answer(200, { data: { output: 'From origin' } }) } });
  await page.goto(`/dashboard${base}/git`);
  await expect(page.getByRole('list', { name: 'Changed files' })).toContainText('src/main.ts');
  await expect(page.getByTestId('git-diff')).toHaveText('+unstaged line');
  await page.getByRole('button', { name: 'Show staged diff' }).click();
  await expect(page).toHaveURL(/staged=true/);
  await expect(page.getByTestId('git-diff')).toHaveText('+staged line');
  await expect(page.getByRole('list', { name: 'Recent commits' })).toContainText('Add launch');

  await page.getByText('Advanced Git operations').click();
  await page.getByRole('button', { name: 'Run Git operation' }).click();
  await expect(page.getByRole('region', { name: /Notifications/ }).getByText('Git fetch completed.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Output of git fetch')).toHaveText('From origin');
  expect(writesTo(writes, 'POST', `${base}/git/fetch`).map((entry) => entry.body)).toEqual([{ remote: 'origin' }]);

  // A history-moving operation confirms first.
  await page.getByLabel('Action').selectOption('checkout');
  await page.getByLabel('Ref (checkout, branch, merge, rebase)').fill('main');
  await page.getByRole('button', { name: 'Run Git operation' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('main');
  await dialog.getByRole('button', { name: 'Check out' }).click();
  await expect.poll(() => writesTo(writes, 'POST', `${base}/git/checkout`).map((entry) => entry.body)).toEqual([{ ref: 'main' }]);
  await expectNoSeriousA11yViolations(page);
});

test('automation: a skill run carries its content digest and a hook run its manifest digest', async ({ page }) => {
  const writes = await stubBff(page, {
    reads: READS,
    writes: {
      [`POST ${base}/skills/lint/run`]: answer(200, { data: { exitCode: 0, durationMs: 40, output: 'lint ok' } }),
      [`POST ${base}/hooks/run`]: answer(200, { data: { exitCode: 0, output: 'formatted' } })
    }
  });
  await page.goto(`/dashboard${base}/automation`);
  await expect(page.getByRole('list', { name: 'Workspace skills' })).toContainText('Runs the linters.');
  await expectNoSeriousA11yViolations(page);

  await page.getByRole('button', { name: 'Run script of lint' }).click();
  const dialog = page.getByRole('dialog', { name: 'Run a skill script' });
  await dialog.getByLabel('Script').fill('../escape');
  await dialog.getByRole('button', { name: 'Run script' }).click();
  await expect(dialog.getByRole('alert')).toContainText('script name only');
  await dialog.getByLabel('Script').fill('check.sh');
  await dialog.getByRole('button', { name: 'Run script' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel('lint · check.sh output')).toHaveText('lint ok');
  expect(writesTo(writes, 'POST', `${base}/skills/lint/run`).map((entry) => entry.body)).toEqual([{ script: 'check.sh', expectedContentSha256: SHA }]);

  const lifecycle = page.getByRole('list', { name: 'Hook lifecycle in run order' });
  await expect(lifecycle.getByRole('listitem')).toHaveCount(5);
  await page.getByRole('button', { name: 'Run hook format at Before commit' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('Before commit');
  await confirm.getByRole('button', { name: 'Run hook' }).click();
  await expect(toastTitled(page, 'Hooks finished.')).toBeVisible();
  expect(writesTo(writes, 'POST', `${base}/hooks/run`).map((entry) => entry.body)).toEqual([{ name: 'format', event: 'pre_commit', expectedManifestSha256: SHA_NEXT }]);
  expect(writes.every((entry) => entry.csrf)).toBe(true);
});

test('deploy wizard: choose, review, survive a reload, confirm, and keep the output out of storage', async ({ page }) => {
  const writes = await stubBff(page, { reads: READS, writes: { [`POST ${base}/deployments/run`]: answer(200, { data: { exitCode: 0, durationMs: 1200, output: 'deployed release 42' } }) } });
  await page.goto(`/dashboard${base}/deploy`);
  const targets = page.getByRole('list', { name: 'Deployment targets' });
  await expect(targets.getByRole('heading')).toHaveText(['production', 'staging']);
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('button', { name: 'Review deployment production' }).click();
  await expect(page.getByRole('heading', { name: 'Review deployment: production' })).toBeVisible();

  // The chosen target and step are restored after a reload.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Review deployment: production' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await page.getByRole('button', { name: 'Run deployment' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('external effects');
  await dialog.getByRole('button', { name: 'Run deployment' }).click();
  await expect(toastTitled(page, 'Deployment finished.')).toBeVisible();
  await expect(page.getByLabel('Deployment production output')).toHaveText('deployed release 42');
  expect(writesTo(writes, 'POST', `${base}/deployments/run`).map((entry) => entry.body)).toEqual([{ name: 'production' }]);
  // The wizard reset to the target list, and nothing of the run reached browser storage.
  await expect(targets).toBeVisible();
  const stored = await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }));
  expect(stored).not.toContain('deployed release 42');
  expect(stored).not.toContain('production');
});

test('artifacts tab lists the workspace snapshots with a same-origin download', async ({ page }) => {
  await stubBff(page, { reads: READS });
  await page.goto(`/dashboard${base}/artifacts`);
  const download = page.getByRole('link', { name: /Download bundle\.tgz/ });
  await expect(download).toHaveAttribute('href', '/dashboard/api/v1/artifacts/art_tab_01/download');
  await expect(download).toHaveAttribute('download', /.*/);
  await expectNoSeriousA11yViolations(page);
});

test('runtime: the task graph draws each task with its state written in the node', async ({ page }) => {
  await stubBff(page, { reads: READS });
  await page.goto(`/dashboard${base}/runtime`);
  const graph = page.getByRole('list', { name: 'Task dependency graph' });
  await expect(graph.getByRole('listitem')).toHaveCount(2);
  await expect(graph.getByRole('listitem', { name: /npm run build: Succeeded/ })).toBeVisible();
  await expect(graph.getByRole('listitem', { name: /npm test: Running/ })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test('header: finalize keeps one idempotency key across a retry; recover and close post their contract bodies', async ({ page }) => {
  const writes = await stubBff(page, {
    reads: READS,
    writes: {
      [`POST ${base}/finalize`]: [answer(503, { error: 'RUNNER_UNAVAILABLE', message: 'Try again.' }), answer(200, { data: {} })],
      [`POST ${base}/close`]: answer(200, { data: { ...workspace, status: 'CLOSED' } })
    }
  });
  await page.goto(`/dashboard${base}`);
  await page.getByRole('button', { name: 'Finalize workspace' }).click();
  const dialog = page.getByRole('dialog', { name: 'Finalize workspace' });
  await dialog.getByLabel('Commit message').fill('Ship the launch');
  await dialog.getByRole('button', { name: 'Finalize workspace' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: 'Finalize workspace' }).click();
  await expect(dialog).toBeHidden();
  const finalize = writesTo(writes, 'POST', `${base}/finalize`).map((entry) => entry.body as Record<string, unknown>);
  expect(finalize).toHaveLength(2);
  expect(finalize[0]).toMatchObject({ all: true, push: true, commitMessage: 'Ship the launch' });
  expect(finalize[1]!.idempotencyKey).toBe(finalize[0]!.idempotencyKey);

  await page.getByRole('button', { name: 'Recover workspace' }).click();
  await expect.poll(() => writesTo(writes, 'POST', `${base}/recover`).map((entry) => entry.body)).toEqual([{ mode: 'resume' }]);

  await page.getByRole('button', { name: 'Close workspace' }).click();
  const close = page.getByRole('alertdialog');
  await expect(close).toContainText(WORKSPACE_ID);
  await close.getByRole('button', { name: 'Close workspace' }).click();
  await expect(toastTitled(page, 'Workspace closed.')).toBeVisible();
  expect(writesTo(writes, 'POST', `${base}/close`).map((entry) => entry.body)).toEqual([{ expectedGeneration: 7 }]);
  expect(writes.every((entry) => entry.csrf)).toBe(true);
});

test('a refused close, deployment or hook run says so in a toast', async ({ page }) => {
  await stubBff(page, {
    reads: READS,
    writes: {
      [`POST ${base}/close`]: answer(409, { error: 'STALE_GENERATION', message: 'The workspace changed.' }),
      [`POST ${base}/deployments/run`]: answer(503, { error: 'RUNNER_UNAVAILABLE', message: 'Try again.' }),
      [`POST ${base}/hooks/run`]: answer(409, { error: 'STALE_MANIFEST', message: 'The hooks changed.' })
    }
  });
  await page.goto(`/dashboard${base}`);
  await page.getByRole('button', { name: 'Close workspace' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Close workspace' }).click();
  await expect(toastTitled(page, 'The workspace was not closed')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${base}$`));

  await page.goto(`/dashboard${base}/deploy`);
  await page.getByRole('button', { name: 'Review deployment production' }).click();
  await page.getByRole('button', { name: 'Run deployment' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Run deployment' }).click();
  await expect(toastTitled(page, 'The deployment did not run')).toBeVisible();

  await page.goto(`/dashboard${base}/automation`);
  await page.getByRole('button', { name: 'Run hook format at Before commit' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Run hook' }).click();
  await expect(toastTitled(page, 'The hooks did not run')).toBeVisible();
});
