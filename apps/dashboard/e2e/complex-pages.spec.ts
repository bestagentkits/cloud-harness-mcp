import { expect, type Page, test } from '@playwright/test';
import { answer, expectNoSeriousA11yViolations, expectPage, type ReadHandler, watchConsole } from './support';
import { activeWorkspace, WORKSPACE_ID, workspacesList } from './fixtures/workspaces';
import { ARTIFACT, PACKAGES } from './fixtures/artifacts-packages';
import { stubBff, writesTo } from './write-support';

// The open-workspace wizard (Workspaces primary action), the Artifacts page and the Packages
// page. Each write is asserted with its exact body, its fences and its CSRF header.

const SET = `skset_${'a'.repeat(20)}`;
const REV_LIB = `skrev_${'a'.repeat(20)}`;
const REV_SET = `skrev_${'b'.repeat(20)}`;
const REPO = 'https://github.com/acme/rocket';
const RESTORE = 'ch-dashboard-restore:open-workspace';

const toastTitled = (page: Page, title: string) => page.getByRole('region', { name: /Notifications/ }).getByText(title, { exact: true });
// The header button renders before the lazy page registers its handler; wait for page code.
const openWizard = async (page: Page) => {
  await expect(page.getByLabel('Search workspaces')).toBeVisible();
  await page.getByTestId('primary-action').click();
};
const stored = (page: Page) => page.evaluate((key) => sessionStorage.getItem(key) ?? '', RESTORE);

const WIZARD_READS: Record<string, ReadHandler> = {
  '/workspaces': answer(200, workspacesList),
  [`/workspaces/${WORKSPACE_ID}`]: answer(200, { data: activeWorkspace }),
  '/skill-sets': answer(200, { data: { sets: [{ id: SET, name: 'Core engineering', description: 'Lint and test skills.', generation: 3 }] } }),
  '/toolkits': answer(200, { data: {
    toolkits: [{ id: 'obra/superpowers', name: 'Superpowers', description: 'Planning skills.', license: 'MIT' }],
    licensedKits: [{ kitId: 'engineer', name: 'Engineer kit', description: 'Licensed engineering kit.', defaultChannel: 'stable', available: true, credentialReady: false }]
  } })
};
const PREVIEW = answer(200, { data: { resolved: [{ name: 'lint' }, { name: 'test' }], excluded: [], conflicts: [{ name: 'lint', candidates: [{ revisionId: REV_LIB, tier: 'library' }, { revisionId: REV_SET, tier: 'set' }] }] } });

test('open workspace: repository, skills with a settled conflict, review, and one key across a lost answer', async ({ page }) => {
  const problems = watchConsole(page, { allow: [/Failed to load resource/] });
  const writes = await stubBff(page, {
    reads: WIZARD_READS,
    writes: {
      'POST /skill-sets/preview': PREVIEW,
      'POST /toolkits/preview': answer(200, { data: { requestFingerprint: 'f'.repeat(64), toolkitsCount: 1 } }),
      'POST /workspaces': [answer(503, { error: 'RUNNER_UNAVAILABLE', message: 'Try again.' }), answer(200, { data: { workspaceId: WORKSPACE_ID } })]
    }
  });
  await page.goto('/dashboard/workspaces');
  await expectPage(page, 'workspaces');
  await openWizard(page);
  const dialog = page.getByRole('dialog', { name: 'Open new workspace' });
  await expect(dialog.getByRole('list', { name: 'Open workspace steps' }).getByRole('listitem').first()).toHaveAttribute('aria-current', 'step');
  await expectNoSeriousA11yViolations(page);

  // The URL is checked before anything is sent; credentials in it are refused and never stored.
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Enter the repository HTTPS URL.');
  await dialog.getByLabel('Repository HTTPS URL').fill('https://owner:hunter2-token@github.com/acme/rocket');
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Remove credentials');
  expect(await stored(page)).not.toContain('hunter2-token');
  await dialog.getByLabel('Repository HTTPS URL').fill(REPO);
  await dialog.getByLabel('Branch or commit ref').fill('main');
  await dialog.getByLabel('Network profile').selectOption('network-none');
  await dialog.getByRole('button', { name: 'Next' }).click();

  await dialog.getByLabel('Core engineering').check();
  await expect(dialog.getByText('2 skill(s) resolved, 1 conflict(s) to settle.')).toBeVisible();
  await dialog.getByLabel('Superpowers').check();
  // A licensed kit without a licence token cannot be chosen.
  await expect(dialog.getByLabel('Engineer kit')).toBeDisabled();
  await expectNoSeriousA11yViolations(page);

  // The draft survives a reload: the wizard reopens on the same step with the same choices.
  await page.reload();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Core engineering')).toBeChecked();
  await expect(dialog.getByLabel('Superpowers')).toBeChecked();

  await dialog.getByRole('button', { name: 'Next' }).click();
  // Launch stays blocked while the conflict has no override.
  await expect(dialog.getByRole('button', { name: 'Launch workspace' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Back' }).click();
  await dialog.getByRole('radio', { name: /set ·/ }).check();
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog).toContainText(REPO);
  await expect(dialog).toContainText('1 toolkit selection(s) checked by the runner.');
  await dialog.getByRole('button', { name: 'Launch workspace' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: 'Launch workspace' }).click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/${WORKSPACE_ID}$`));
  await expect(toastTitled(page, 'Workspace opened.')).toBeVisible();

  const launches = writesTo(writes, 'POST', '/workspaces').map((entry) => entry.body as Record<string, unknown>);
  expect(launches).toHaveLength(2);
  expect(launches[0]).toEqual({
    repositoryUrl: REPO, ref: 'main', networkProfile: 'network-none',
    skillSets: [{ skillSetId: SET, expectedGeneration: 3 }], skillOverrides: { lint: REV_SET },
    toolkits: [{ kind: 'preset', id: 'obra/superpowers', scope: 'owner' }],
    idempotencyKey: launches[0]!.idempotencyKey
  });
  expect(typeof launches[0]!.idempotencyKey).toBe('string');
  expect(launches[1]!.idempotencyKey).toBe(launches[0]!.idempotencyKey);
  expect(writesTo(writes, 'POST', '/skill-sets/preview').at(-1)?.body).toEqual({ skillSets: [{ skillSetId: SET, expectedGeneration: 3 }], skillOverrides: { lint: REV_SET } });
  expect(writes.every((entry) => entry.csrf)).toBe(true);
  // A finished launch leaves no draft behind.
  expect(await stored(page)).toBe('');
  expect(problems).toEqual([]);
});

test('open workspace: a changed request is a new intent with a new key; cancel discards the draft', async ({ page }) => {
  const writes = await stubBff(page, {
    reads: WIZARD_READS,
    writes: { 'POST /workspaces': answer(503, { error: 'RUNNER_UNAVAILABLE', message: 'Try again.' }) }
  });
  await page.goto('/dashboard/workspaces');
  await openWizard(page);
  const dialog = page.getByRole('dialog', { name: 'Open new workspace' });
  await dialog.getByLabel('Repository HTTPS URL').fill(REPO);
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByRole('button', { name: 'Launch workspace' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: 'Back' }).click();
  await dialog.getByRole('button', { name: 'Back' }).click();
  await dialog.getByLabel('Branch or commit ref').fill('release');
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByRole('button', { name: 'Launch workspace' }).click();
  await expect.poll(() => writesTo(writes, 'POST', '/workspaces').length).toBe(2);
  const keys = writesTo(writes, 'POST', '/workspaces').map((entry) => (entry.body as { idempotencyKey: string }).idempotencyKey);
  expect(new Set(keys).size).toBe(2);

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await stored(page)).toBe('');
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Open new workspace' })).toHaveCount(0);
});


test('artifacts: create a retained snapshot and delete one, each fenced by its generation', async ({ page }) => {
  const writes = await stubBff(page, {
    reads: { '/artifacts': answer(200, { data: { artifacts: [ARTIFACT] } }) },
    writes: { 'POST /artifacts': answer(200, { data: { ...ARTIFACT, artifactId: 'art_page_02' } }) }
  });
  await page.goto('/dashboard/artifacts');
  await expectPage(page, 'artifacts');
  await expect(page.getByRole('link', { name: 'Download report.json' })).toHaveAttribute('href', '/dashboard/api/v1/artifacts/art_page_01/download');
  await expectNoSeriousA11yViolations(page);

  await page.getByTestId('primary-action').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Workspace ID').fill(WORKSPACE_ID);
  await dialog.getByLabel('Workspace path').fill('dist/report.json');
  await dialog.getByLabel('Logical name').fill('report.json');
  await dialog.getByLabel('Retention in seconds').fill('30');
  await dialog.getByRole('button', { name: 'Create retained snapshot' }).click();
  await expect(dialog).toContainText('Use 60 to 2592000 seconds');
  await dialog.getByLabel('Retention in seconds').fill('3600');
  await dialog.getByRole('button', { name: 'Create retained snapshot' }).click();
  await expect(toastTitled(page, 'Retained artifact snapshot created.')).toBeVisible();
  expect(writesTo(writes, 'POST', '/artifacts').map((entry) => entry.body)).toEqual([
    { workspaceId: WORKSPACE_ID, path: 'dist/report.json', logicalName: 'report.json', retentionSeconds: 3600, expectedGeneration: 0 }
  ]);

  await page.getByRole('button', { name: 'Delete report.json' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('art_page_01');
  await confirm.getByRole('button', { name: 'Delete artifact' }).click();
  await expect(toastTitled(page, 'Artifact deleted.')).toBeVisible();
  expect(writesTo(writes, 'DELETE', '/artifacts/art_page_01').map((entry) => entry.body)).toEqual([{ expectedGeneration: 4 }]);
  expect(writes.every((entry) => entry.csrf)).toBe(true);
});


test('packages: roll back and uninstall confirm with the classic copy and are fenced by the binding generation', async ({ page }) => {
  const writes = await stubBff(page, { reads: { '/packages': answer(200, PACKAGES) } });
  await page.goto('/dashboard/packages');
  await expectPage(page, 'packages');
  await expect(page.getByRole('table', { name: 'History of tsx' })).toContainText('Current');
  await expectNoSeriousA11yViolations(page);

  await page.getByRole('button', { name: 'Roll back to 4.0.0' }).click();
  let confirm = page.getByRole('alertdialog', { name: 'Roll back tsx from 4.1.0 to 4.0.0?' });
  await expect(confirm).toContainText('expected generation 5');
  await confirm.getByRole('button', { name: 'Roll back' }).click();
  await expect(toastTitled(page, 'tsx rolled back to 4.0.0.')).toBeVisible();
  expect(writesTo(writes, 'POST', '/packages/rollback').map((entry) => entry.body)).toEqual([{ bindingId: 'pkb_tsx_01', releaseId: 'pkr_tsx_1', expectedGeneration: 5 }]);

  await page.getByRole('button', { name: 'Uninstall tsx' }).click();
  confirm = page.getByRole('alertdialog', { name: 'Uninstall tsx?' });
  await confirm.getByRole('button', { name: 'Uninstall' }).click();
  await expect(toastTitled(page, 'tsx uninstalled.')).toBeVisible();
  expect(writesTo(writes, 'POST', '/packages/remove').map((entry) => entry.body)).toEqual([{ bindingId: 'pkb_tsx_01', expectedGeneration: 5 }]);
  expect(writes.every((entry) => entry.csrf)).toBe(true);
});

test('packages: a disabled instance says so and offers no change', async ({ page }) => {
  await stubBff(page, { reads: { '/packages': answer(200, { data: { enabled: false } }) } });
  await page.goto('/dashboard/packages');
  await expect(page.getByText('Managed packages are off', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Uninstall|Roll back/ })).toHaveCount(0);
});
