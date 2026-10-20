import { expect, type Page, type Request, test } from '@playwright/test';
import { answer, expectNoSeriousA11yViolations, expectPage, stubReads, watchConsole } from './support';
import {
  deployDiff, deployRevisions, deployUsage, emptySkills, hostileSkills, IMPORT_JOB, importJob, registry, releaseSet, REV_DEPLOY_1,
  searchResults, SET_RELEASE, SKILL_DEPLOY, SKILL_DOCS, skillSets, skillsBody
} from './fixtures/skills';

const API = '/dashboard/api/v1';

/** Every read the page can make, answered with realistic projections. */
function reads(overrides: Record<string, ReturnType<typeof answer>> = {}) {
  return {
    '/skills': answer(200, skillsBody),
    [`/skills/${SKILL_DEPLOY}/revisions`]: answer(200, deployRevisions),
    [`/skills/${SKILL_DEPLOY}/usage`]: answer(200, deployUsage),
    [`/skills/${SKILL_DEPLOY}/diff`]: answer(200, deployDiff),
    '/skill-sets': answer(200, skillSets),
    [`/skill-sets/${SET_RELEASE}`]: answer(200, releaseSet),
    '/toolkit-registry': answer(200, registry),
    '/skills/search': answer(200, searchResults),
    ...overrides
  };
}

/** GET requests to the BFF as `path?query`, to prove a page load never repeats one. */
function watchGets(page: Page): string[] {
  const gets: string[] = [];
  page.on('request', (request: Request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.startsWith(API) && !/\/(session|profile|preferences)$/.test(url.pathname)) gets.push(`${url.pathname.slice(API.length)}${url.search}`);
  });
  return gets;
}

/** Records one mutation to `path`, answering `body`. */
async function captureMutation(page: Page, path: string, body: unknown, status = 200) {
  const captured: { method: string; body: string; headers: Record<string, string> }[] = [];
  await page.route(`**${API}${path}`, async (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fallback();
    captured.push({ method: request.method(), body: request.postData() ?? '', headers: request.headers() });
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return captured;
}

async function expectCleanMain(page: Page) {
  // Radix Tabs writes runtime CSSOM styles on its tablist (roving focus `outline: none`) and its
  // active panel (animation duration); nothing this page renders carries a style attribute.
  await expect(page.locator('main [style]:not([role=tablist]):not([role=tabpanel])')).toHaveCount(0);
}

test('the library lists skills with one read, one primary action and a clean page', async ({ page }) => {
  const problems = watchConsole(page);
  const gets = watchGets(page);
  const seen = await stubReads(page, reads());
  await page.goto('/dashboard/skills');
  await expectPage(page, 'skills');
  const table = page.getByRole('table', { name: 'Installed skills' });
  await expect(table.getByRole('button', { name: 'Deploy checklist' })).toBeVisible();
  await expect(page.getByTestId('skills-library-count')).toHaveText('3 skills');
  await expect(page.getByTestId('primary-action')).toHaveCount(1);
  await expect(page.getByTestId('primary-action')).toHaveText(/Upload skill/);
  await expectCleanMain(page);
  await expectNoSeriousA11yViolations(page);
  expect(seen).toEqual(['/skills']);
  expect(new Set(gets).size).toBe(gets.length);
  expect(problems).toEqual([]);
});

test('loading, empty and error states', async ({ page }) => {
  const problems = watchConsole(page, { allow: [/Failed to load resource/] });
  await stubReads(page, reads({ '/skills': answer(200, emptySkills, { delayMs: 800 }) }));
  await page.goto('/dashboard/skills');
  await expect(page.getByRole('status', { name: /Loading skills/i }).or(page.locator('[aria-busy=true]')).first()).toBeVisible();
  await expect(page.getByText('No skills yet', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Discover skills' }).click();
  await expect(page).toHaveURL(/tab=imports/);
  await expect(page.getByRole('heading', { name: 'Search providers' })).toBeVisible();

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await stubReads(page, reads({ '/skills': answer(503, { error: 'runner_unavailable', message: 'The runner is unavailable.' }) }));
  await page.goto('/dashboard/skills');
  const alert = page.getByRole('alert').filter({ hasText: 'The server could not answer' });
  await expect(alert).toBeVisible({ timeout: 10_000 });
  await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(page.locator('main')).not.toContainText('runner_unavailable');
  expect(problems).toEqual([]);
});

test('filters round-trip through the URL and survive a reload; bogus params never reach a request', async ({ page }) => {
  const problems = watchConsole(page);
  const gets = watchGets(page);
  await stubReads(page, reads());
  await page.goto('/dashboard/skills?tab=evil&skill=../../etc&provider=root&sort=__proto__');
  await expect(page.getByRole('tab', { name: 'Library' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('../../etc');
  await page.getByRole('searchbox', { name: 'Search skills' }).fill('docs');
  await expect(page).toHaveURL(/q=docs/);
  await page.getByLabel('State').selectOption('disabled');
  await expect(page).toHaveURL(/state=disabled/);
  await expect(page.getByTestId('skills-library-count')).toHaveText('1 of 3 skills');
  await page.reload();
  await expect(page.getByRole('searchbox', { name: 'Search skills' })).toHaveValue('docs');
  await expect(page.getByTestId('skills-library-count')).toHaveText('1 of 3 skills');
  await page.getByRole('searchbox', { name: 'Search skills' }).fill('nothing-matches');
  await expect(page.getByText('No skills match the current filters')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).first().click();
  await expect(page.getByTestId('skills-library-count')).toHaveText('3 skills');
  expect(gets.every((entry) => !entry.includes('etc') && !entry.includes('root') && !entry.includes('proto'))).toBe(true);
  expect(problems).toEqual([]);
});

test('the detail drawer deep-links, reads revisions and usage once, diffs and restores with the generation fence', async ({ page }) => {
  const problems = watchConsole(page);
  const gets = watchGets(page);
  await stubReads(page, reads());
  const restore = await captureMutation(page, `/skills/${SKILL_DEPLOY}/restore`, { data: { id: SKILL_DEPLOY } });
  await page.goto('/dashboard/skills');
  await page.getByRole('button', { name: 'Deploy checklist' }).click();
  await expect(page).toHaveURL(new RegExp(`skill=${SKILL_DEPLOY}`));
  const drawer = page.getByRole('dialog', { name: 'Deploy checklist' });
  await expect(drawer.getByTestId('skill-usage-lock')).toContainText('Locked');
  await expect(drawer.getByText('Release kit')).toBeVisible();
  await drawer.getByRole('button', { name: `Diff revision ${REV_DEPLOY_1} against current` }).click();
  await expect(drawer.getByLabel('Revision diff')).toContainText('+Run the canary twice.');
  // Opening the drawer adds exactly the classic drawer's two reads, once each.
  expect(gets.filter((entry) => entry === `/skills/${SKILL_DEPLOY}/revisions`)).toHaveLength(1);
  expect(gets.filter((entry) => entry === `/skills/${SKILL_DEPLOY}/usage`)).toHaveLength(1);
  expect(gets.filter((entry) => entry === `/skills/${SKILL_DEPLOY}`)).toHaveLength(0);
  await drawer.getByRole('button', { name: `Restore revision ${REV_DEPLOY_1}` }).click();
  await expect.poll(() => restore.length).toBe(1);
  expect(restore[0]?.method).toBe('POST');
  expect(JSON.parse(restore[0]?.body ?? '{}')).toEqual({ revisionId: REV_DEPLOY_1, expectedGeneration: 3 });
  expect(restore[0]?.headers['x-csrf-token']).toBeTruthy();
  await expectNoSeriousA11yViolations(page);

  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Deploy checklist' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/skill=/);
  expect(problems).toEqual([]);
});

test('bulk archive confirms, groups by generation and keeps refused rows selected', async ({ page }) => {
  await stubReads(page, reads());
  const bulk = await captureMutation(page, '/skills/bulk', { data: { results: [{ skillId: SKILL_DEPLOY, ok: true }, { skillId: SKILL_DOCS, ok: false, error: 'LOCKED' }] } });
  await page.goto('/dashboard/skills');
  await page.getByRole('checkbox', { name: 'Select Deploy checklist' }).click();
  await page.getByRole('checkbox', { name: 'Select Docs writer' }).click();
  await page.getByRole('region', { name: 'Bulk actions' }).getByRole('button', { name: 'Archive' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Archive 2 skills?' });
  await expect(confirm).toContainText('deploy-checklist, docs-writer');
  await confirm.getByRole('button', { name: 'Archive' }).click();
  await expect.poll(() => bulk.length).toBe(2);
  const bodies = bulk.map((entry) => JSON.parse(entry.body) as { action: string; skillIds: string[]; expectedGeneration: number });
  expect(bodies).toEqual(expect.arrayContaining([
    { action: 'archive', skillIds: [SKILL_DEPLOY], expectedGeneration: 3 },
    { action: 'archive', skillIds: [SKILL_DOCS], expectedGeneration: 2 }
  ]));
  expect(bulk.every((entry) => Boolean(entry.headers['x-csrf-token']))).toBe(true);
  await expect(page.getByRole('list', { name: 'Skills the server did not change' })).toContainText('LOCKED');
});

test('Upload skill sends the raw zip with the CSRF header and lists per-entry results', async ({ page }) => {
  const problems = watchConsole(page);
  await stubReads(page, reads());
  const upload = await captureMutation(page, '/skill-archives', { data: { results: [{ slug: 'review', ok: true, skillId: 'sk_review00000000000000000001' }, { slug: 'huge', ok: false, error: 'LIMIT_EXCEEDED', message: 'SKILL.md is over 64 KiB.' }] } });
  await page.goto('/dashboard/skills');
  await page.getByTestId('primary-action').click();
  const dialog = page.getByRole('dialog', { name: 'Upload skills' });
  await dialog.getByRole('button', { name: 'Upload' }).click();
  await expect(dialog.getByText('Choose a .zip archive first.')).toBeVisible();
  await dialog.getByLabel('Archive').setInputFiles({ name: 'skills.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\u0003\u0004fake-zip') });
  await dialog.getByRole('button', { name: 'Upload' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Imported 1 of 2. The rest are listed below.');
  await expect(dialog.getByRole('list', { name: 'Upload results' })).toContainText('SKILL.md is over 64 KiB.');
  expect(upload).toHaveLength(1);
  expect(upload[0]?.headers['content-type']).toBe('application/zip');
  expect(upload[0]?.headers['x-csrf-token']).toBeTruthy();
  expect(upload[0]?.body.startsWith('PK')).toBe(true);
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});

test('an import polls the job until it is terminal and then stops', async ({ page }) => {
  const problems = watchConsole(page);
  const states = ['queued', 'running', 'succeeded'];
  let polls = 0;
  await stubReads(page, reads({
    [`/skill-imports/${IMPORT_JOB}`]: (route) => { polls += 1; return answer(200, importJob(states.shift() ?? 'succeeded'))(route); }
  }));
  const start = await captureMutation(page, '/skill-imports', importJob('queued'));
  await page.goto('/dashboard/skills?tab=imports');
  await page.getByRole('textbox', { name: 'Source' }).fill('not a repo');
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText('Enter the source as owner/repository.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Source' }).fill('acme/review-skills');
  await page.getByRole('button', { name: 'Import' }).click();
  await expect.poll(() => start.length).toBe(1);
  expect(JSON.parse(start[0]?.body ?? '{}')).toEqual({ sourceKind: 'skills-sh', sourceRef: 'acme/review-skills', expectedGeneration: 0 });
  expect(start[0]?.headers['x-csrf-token']).toBeTruthy();
  const job = page.getByTestId('skill-import-job');
  await expect(job.getByRole('status')).toHaveText('Import finished. The skill is now in the library.', { timeout: 10_000 });
  const afterTerminal = polls;
  expect(afterTerminal).toBe(3);
  await page.waitForTimeout(4_000);
  expect(polls).toBe(afterTerminal);
  expect(problems).toEqual([]);
});

test('cancelling an import sends the schema minimum fence the BFF projection allows and leaving the tab stops the poll', async ({ page }) => {
  let polls = 0;
  // The BFF job projection has no generation field, so the page falls back to 1.
  await stubReads(page, reads({ [`/skill-imports/${IMPORT_JOB}`]: (route) => { polls += 1; return answer(200, importJob('running'))(route); } }));
  await captureMutation(page, '/skill-imports', importJob('queued'));
  const cancel = await captureMutation(page, `/skill-imports/${IMPORT_JOB}/cancel`, importJob('cancelled'));
  await page.goto('/dashboard/skills?tab=imports');
  await page.getByRole('textbox', { name: 'Source' }).fill('acme/review-skills');
  await page.getByRole('button', { name: 'Import' }).click();
  await page.getByRole('button', { name: 'Cancel import' }).click();
  await expect.poll(() => cancel.length).toBe(1);
  expect(JSON.parse(cancel[0]?.body ?? '{}')).toEqual({ expectedGeneration: 1 });
  await page.getByRole('tab', { name: 'Library' }).click();
  await page.waitForTimeout(500);
  const left = polls;
  await page.waitForTimeout(3_500);
  expect(polls).toBe(left);
});

test('Discover searches every provider on submit and reports a failed provider beside the hits', async ({ page }) => {
  const gets = watchGets(page);
  await stubReads(page, reads());
  await page.goto('/dashboard/skills?tab=imports');
  await page.getByRole('searchbox', { name: 'Search term' }).fill('review');
  await expect.poll(() => gets.filter((entry) => entry.startsWith('/skills/search')).length).toBe(0);
  await page.getByRole('search', { name: 'Search skill providers' }).getByRole('button', { name: 'Search' }).click();
  await expect(page.getByTestId('skills-search-results')).toContainText('Code review');
  await expect(page.getByTestId('skills-search-results')).toContainText('SkillX did not answer in time.');
  await expect(page).toHaveURL(/find=review/);
  expect(gets.filter((entry) => entry.startsWith('/skills/search'))).toEqual(['/skills/search?query=review&providers=local%2Cskills-sh%2Cskillx']);
});

test('New skill posts a custom skill with a zero fence; a dirty editor asks before closing', async ({ page }) => {
  await stubReads(page, reads());
  const create = await captureMutation(page, '/skills', { data: { id: 'sk_new000000000000000000001' } });
  await page.goto('/dashboard/skills');
  await page.getByRole('button', { name: 'New skill' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a custom skill' });
  await dialog.getByLabel('Slug').fill('release-notes');
  await page.keyboard.press('Escape');
  await expect(dialog.getByText('Discard unsaved changes?')).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await dialog.getByLabel('Display name').fill('Release notes');
  await dialog.getByLabel('Instructions').fill('---\nname: release-notes\n');
  await dialog.getByRole('button', { name: 'Save skill' }).click();
  await expect(dialog.getByText('Frontmatter opens with --- but never closes.')).toBeVisible();
  await dialog.getByLabel('Instructions').fill('Write the release notes.');
  await dialog.getByRole('button', { name: 'Save skill' }).click();
  await expect(dialog).toBeHidden();
  expect(create).toHaveLength(1);
  expect(JSON.parse(create[0]?.body ?? '{}')).toEqual({ slug: 'release-notes', displayName: 'Release notes', instructions: 'Write the release notes.', expectedGeneration: 0 });
});

test('skill sets list, open with their pinned members, and delete after a named confirm', async ({ page }) => {
  const problems = watchConsole(page);
  await stubReads(page, reads());
  const remove = await captureMutation(page, `/skill-sets/${SET_RELEASE}`, { data: { skillSetId: SET_RELEASE, deleted: true } });
  const create = await captureMutation(page, '/skill-sets', { data: { skillSetId: 'skset_new0000000000000000000001' } });
  await page.goto('/dashboard/skills?tab=sets');
  await expect(page.getByRole('table', { name: 'Skill sets' })).toContainText('Release kit');
  await page.getByLabel('Name').fill('Docs kit');
  await page.getByRole('checkbox', { name: 'Docs writer' }).click();
  await page.getByRole('button', { name: 'Save set' }).click();
  await expect.poll(() => create.length).toBe(1);
  expect(JSON.parse(create[0]?.body ?? '{}')).toEqual({ name: 'Docs kit', description: '', items: [{ skillSourceId: SKILL_DOCS, revisionId: 'skrev_docs0000000000000000001', name: 'docs-writer' }], expectedGeneration: 0 });
  await expectNoSeriousA11yViolations(page);

  await page.getByRole('button', { name: 'Release kit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Release kit' });
  await expect(dialog.getByRole('list', { name: 'Members' })).toContainText('deploy-checklist');
  await dialog.getByRole('button', { name: 'Delete set' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete this skill set?' });
  await expect(confirm).toContainText('Release kit');
  await confirm.getByRole('button', { name: 'Delete set' }).click();
  await expect.poll(() => remove.length).toBe(1);
  expect(remove[0]?.method).toBe('DELETE');
  expect(JSON.parse(remove[0]?.body ?? '{}')).toEqual({ expectedGeneration: 2 });
  expect(problems).toEqual([]);
});

test('the registry tab shows the cache inventory and installable presets', async ({ page }) => {
  await stubReads(page, reads());
  await page.goto('/dashboard/skills?tab=registry');
  const table = page.getByRole('table', { name: 'Registry and toolkit inventory' });
  await expect(table).toContainText('Acme docs skills');
  await expect(table).toContainText('locked');
  await expect(page.getByText('Core toolkit')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test('hostile skill data renders as text with no script and no CSP violation', async ({ page }) => {
  const problems = watchConsole(page);
  await stubReads(page, reads({ '/skills': answer(200, hostileSkills) }));
  await page.goto(`/dashboard/skills?skill=${SKILL_DEPLOY}`);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('main script, [role=dialog] script')).toHaveCount(0);
  await expect(page.locator('main img, [role=dialog] img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(problems).toEqual([]);
});

test('the page fits a 375px viewport without page-level horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await stubReads(page, reads());
  await page.goto('/dashboard/skills');
  await expect(page.getByRole('table', { name: 'Installed skills' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
