import { expect, type Page, test } from '@playwright/test';
import { answer, expectPage, watchConsole } from './support';
import { stubBff, watchForLeaks, writesTo } from './write-support';

// Write paths: the exact bodies and generation fences the classic Dashboard sends, the 409
// conflict experience, and wizard restore that keeps non-secret step state only.

const CONFLICT = 'This item changed after you opened it. The latest version is loaded: review it before trying again.';
const SECRET_VALUE = 'e2e-secret-value-not-real-91c4';
const API_KEY = 'sk-e2e-wizard-key-not-real-5d20';

const secret = (generation: number) => ({ id: 'sec_1', name: 'STRIPE_API_KEY', description: 'Payments', state: 'ACTIVE', version: generation, generation, createdAt: 1, updatedAt: 1 });
const SECRETS = (generation: number) => answer(200, { data: { secrets: [secret(generation)], readiness: { ready: true } } });

const PROVIDERS = answer(200, { data: { providers: [{ id: 'openai', displayName: 'OpenAI', description: 'GPT models', authModes: ['bearer'], defaultAuthMode: 'bearer' }] } });
const EMPTY_MODELS = {
  '/provider-credentials': answer(200, { data: { credentials: [] } }),
  '/agent-model-profiles': answer(200, { data: { profiles: [] } }),
  '/model-providers': PROVIDERS,
  '/model-spend': answer(200, { data: { summary: { isEstimate: true, windows: [] } } })
};

test.beforeEach(({ page }) => {
  watchConsole(page, { allow: [/Failed to load resource/] });
});

test('creating a secret sends the legacy body with a zero generation fence', async ({ page }) => {
  const leaks = watchForLeaks(page);
  const writes = await stubBff(page, { reads: { '/secrets': answer(200, { data: { secrets: [], readiness: { ready: true } } }) } });
  await page.goto('/dashboard/secrets');
  await expectPage(page, 'secrets');
  await page.getByTestId('primary-action').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Secret name').fill('STRIPE_API_KEY');
  await dialog.getByLabel('Write-only value').fill(SECRET_VALUE);
  await dialog.getByRole('button', { name: 'Create global secret' }).click();
  await expect(dialog).toBeHidden();
  const [create] = writesTo(writes, 'POST', '/secrets');
  expect(create?.body).toEqual({ name: 'STRIPE_API_KEY', value: SECRET_VALUE, description: null, expectedGeneration: 0 });
  expect(create?.csrf).toBeTruthy();
  await leaks.assertClean(SECRET_VALUE);
});

test('a rotate that loses the generation race shows the conflict, and the retry is fenced on the reloaded row', async ({ page }) => {
  const leaks = watchForLeaks(page);
  const writes = await stubBff(page, {
    reads: { '/secrets': [SECRETS(3), SECRETS(4)] },
    writes: { 'PUT /secrets/STRIPE_API_KEY': [answer(409, { error: 'conflict', message: 'generation mismatch' }), answer(200, { data: secret(5) })] }
  });
  await page.goto('/dashboard/secrets');
  await expectPage(page, 'secrets');
  await page.getByRole('button', { name: 'Rotate STRIPE_API_KEY' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('New write-only value').fill(SECRET_VALUE);
  await dialog.getByRole('button', { name: 'Rotate' }).click();
  await expect(page.getByText(CONFLICT).first()).toBeVisible();
  const [rotate] = writesTo(writes, 'PUT', '/secrets/STRIPE_API_KEY');
  expect(rotate?.body).toEqual({ value: SECRET_VALUE, expectedGeneration: 3 });
  // The conflict is never retried automatically: one write only.
  expect(writesTo(writes, 'PUT', '/secrets/STRIPE_API_KEY')).toHaveLength(1);
  // The reloaded row (generation 4) reaches the open dialog; its value field stays empty.
  await expect(page.getByText('gen 4')).toBeVisible();
  await expect(dialog.getByLabel('New write-only value')).toHaveValue('');
  await dialog.getByLabel('New write-only value').fill(SECRET_VALUE);
  await dialog.getByRole('button', { name: 'Rotate' }).click();
  await expect(dialog).toBeHidden();
  const retry = writesTo(writes, 'PUT', '/secrets/STRIPE_API_KEY')[1];
  expect(retry?.body).toEqual({ value: SECRET_VALUE, expectedGeneration: 4 });
  await leaks.assertClean(SECRET_VALUE);
});

test('saving a provider key sends the legacy credential body', async ({ page }) => {
  const leaks = watchForLeaks(page);
  const writes = await stubBff(page, {
    reads: EMPTY_MODELS,
    writes: { 'POST /provider-credentials': answer(200, { data: { id: 'cred_1', label: 'Primary', provider: 'openai', status: 'ACTIVE', activeVersion: 1 } }) }
  });
  await page.goto('/dashboard/models');
  await expectPage(page, 'models');
  await page.getByTestId('primary-action').click();
  const dialog = page.getByTestId('credential-dialog');
  await dialog.getByLabel('Label').fill('Primary');
  await dialog.getByLabel('API key (write-only)').fill(API_KEY);
  await dialog.getByRole('button', { name: 'Save credential' }).click();
  await expect(dialog).toBeHidden();
  const [create] = writesTo(writes, 'POST', '/provider-credentials');
  expect(create?.body).toEqual({ label: 'Primary', provider: 'openai', authMode: 'bearer', apiKey: API_KEY });
  await leaks.assertClean(API_KEY);
});

test('the profile wizard restores its step after a reload but never the key', async ({ page }) => {
  await stubBff(page, { reads: EMPTY_MODELS });
  await page.goto('/dashboard/models');
  await expectPage(page, 'models');
  await page.getByTestId('model-profiles').getByRole('button', { name: 'Add profile' }).first().click();
  const wizard = page.getByTestId('profile-wizard');
  await wizard.getByText('OpenAI', { exact: true }).click();
  await wizard.locator('[data-wizard-action=continue]').click();
  await expect(wizard.getByRole('heading', { name: /Step 2 of 5/ })).toBeVisible();
  await wizard.getByLabel('Label').fill('Restored label');
  await wizard.getByTestId('wizard-api-key').fill(API_KEY);
  await page.reload();
  await expectPage(page, 'models');
  const restored = page.getByTestId('profile-wizard');
  await expect(restored.getByRole('heading', { name: /Step 2 of 5/ })).toBeVisible();
  await expect(restored.getByLabel('Label')).toHaveValue('Restored label');
  await expect(restored.getByTestId('wizard-api-key')).toHaveValue('');
  const stored = await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('ch-dashboard-restore:')));
  expect(stored.length).toBeGreaterThan(0);
  expect(JSON.stringify(stored)).not.toContain(API_KEY);
  // Cancelling clears the restore entry.
  await restored.getByRole('button', { name: 'Cancel' }).click();
  const discard = page.getByRole('alertdialog');
  if (await discard.isVisible().catch(() => false)) await discard.getByRole('button', { name: /Discard/ }).click();
  await expect(restored).toBeHidden();
  const after = await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.includes('models-profile-wizard')));
  expect(after).toEqual([]);
  await watchForLeaks(page).assertClean(API_KEY);
});

const mcpServer = (generation: number, enabled: boolean) => ({ id: 'mcp_1', name: 'Docs', transport: 'streamable-http', endpoint: 'https://mcp.example.test/mcp', headers: [], enabled, status: 'READY', toolCount: 2, permissionDefault: 'allow', generation });
const MCP_LIST = (generation: number, enabled: boolean) => answer(200, { data: { servers: [mcpServer(generation, enabled)] } });

test('disabling an MCP server sends the generation fence, and a 409 reloads the list', async ({ page }) => {
  const writes = await stubBff(page, {
    reads: { '/mcp-servers': [MCP_LIST(7, true), MCP_LIST(8, false)], '/mcp-gateway': answer(200, { data: { ready: true } }) },
    writes: { 'POST /mcp-servers/mcp_1/enabled': answer(409, { error: 'conflict' }) }
  });
  await page.goto('/dashboard/mcp-servers');
  await expectPage(page, 'mcp-servers');
  await page.getByRole('button', { name: 'Disable Docs' }).click();
  await expect(page.getByText(CONFLICT).first()).toBeVisible();
  const [toggle] = writesTo(writes, 'POST', '/mcp-servers/mcp_1/enabled');
  expect(toggle?.body).toEqual({ enabled: false, expectedGeneration: 7 });
  expect(toggle?.csrf).toBeTruthy();
  // The refetched row (generation 8, already disabled) replaces the stale one.
  await expect(page.getByRole('button', { name: 'Enable Docs' })).toBeVisible();
  expect(writesTo(writes, 'POST', '/mcp-servers/mcp_1/enabled')).toHaveLength(1);
});

// The edit dialog validates names client-side (lowercase), so edited fixtures use one.
const editable = (generation: number, enabled: boolean) => ({ ...mcpServer(generation, enabled), name: 'docs' });
const EDITABLE_LIST = answer(200, { data: { servers: [editable(7, true)] } });

test('an MCP edit that loses the generation race reloads the server, and the retry is fenced on it', async ({ page }) => {
  const writes = await stubBff(page, {
    reads: {
      '/mcp-servers': EDITABLE_LIST,
      '/mcp-servers/mcp_1': answer(200, { data: { server: { ...editable(8, true), description: 'Changed elsewhere' }, tools: [] } }),
      '/mcp-gateway': answer(200, { data: { ready: true } })
    },
    writes: { 'PATCH /mcp-servers/mcp_1': [answer(409, { error: 'conflict' }), answer(200, { data: editable(9, true) })] }
  });
  await page.goto('/dashboard/mcp-servers');
  await expectPage(page, 'mcp-servers');
  await page.getByRole('button', { name: 'Edit docs' }).click();
  const dialog = page.getByTestId('mcp-server-dialog');
  await dialog.getByLabel('Description').fill('Mine');
  await dialog.getByRole('button', { name: 'Save server' }).click();
  await expect(dialog.getByText(CONFLICT)).toBeVisible();
  expect(writesTo(writes, 'PATCH', '/mcp-servers/mcp_1')[0]?.body).toMatchObject({ description: 'Mine', expectedGeneration: 7 });
  // The latest server re-seeds the form for review before the operator saves again.
  await expect(dialog.getByLabel('Description')).toHaveValue('Changed elsewhere');
  await dialog.getByRole('button', { name: 'Save server' }).click();
  await expect(dialog).toBeHidden();
  const patches = writesTo(writes, 'PATCH', '/mcp-servers/mcp_1');
  expect(patches).toHaveLength(2);
  expect(patches[1]?.body).toMatchObject({ description: 'Changed elsewhere', expectedGeneration: 8 });
});

test('an MCP edit whose enable step fails reports a partial save and fences the retry on the saved server', async ({ page }) => {
  const writes = await stubBff(page, {
    reads: { '/mcp-servers': EDITABLE_LIST, '/mcp-gateway': answer(200, { data: { ready: true } }) },
    writes: {
      'PATCH /mcp-servers/mcp_1': [answer(200, { data: editable(8, true) }), answer(200, { data: editable(9, true) })],
      'POST /mcp-servers/mcp_1/enabled': [answer(500, { error: 'internal_error', message: 'Enable failed.' }), answer(200, { data: editable(10, false) })]
    }
  });
  await page.goto('/dashboard/mcp-servers');
  await expectPage(page, 'mcp-servers');
  await page.getByRole('button', { name: 'Edit docs' }).click();
  const dialog = page.getByTestId('mcp-server-dialog');
  await dialog.getByLabel('Enabled').click();
  await dialog.getByRole('button', { name: 'Save server' }).click();
  await expect(dialog.getByText(/Saved; enabled state not changed\./)).toBeVisible();
  expect(writesTo(writes, 'POST', '/mcp-servers/mcp_1/enabled')[0]?.body).toEqual({ enabled: false, expectedGeneration: 8 });
  await dialog.getByRole('button', { name: 'Save server' }).click();
  await expect(dialog).toBeHidden();
  expect(writesTo(writes, 'PATCH', '/mcp-servers/mcp_1')[1]?.body).toMatchObject({ expectedGeneration: 8 });
  expect(writesTo(writes, 'POST', '/mcp-servers/mcp_1/enabled')[1]?.body).toEqual({ enabled: false, expectedGeneration: 9 });
});

// Two clicks in one task land before React re-renders the disabled button, so only the
// action's own lock can stop the second write.
const clickTwice = (page: Page, name: string) =>
  page.getByRole('button', { name }).evaluate((button: HTMLElement) => { button.click(); button.click(); });

test('a double click on an MCP server toggle sends one write', async ({ page }) => {
  const writes = await stubBff(page, {
    reads: { '/mcp-servers': MCP_LIST(7, true), '/mcp-gateway': answer(200, { data: { ready: true } }) },
    writes: { 'POST /mcp-servers/mcp_1/enabled': answer(200, { data: mcpServer(8, false) }, { delayMs: 300 }) }
  });
  await page.goto('/dashboard/mcp-servers');
  await expectPage(page, 'mcp-servers');
  await clickTwice(page, 'Disable Docs');
  await expect.poll(() => writesTo(writes, 'POST', '/mcp-servers/mcp_1/enabled').length).toBe(1);
  await page.waitForTimeout(500);
  expect(writesTo(writes, 'POST', '/mcp-servers/mcp_1/enabled')).toHaveLength(1);
});

test('a double click on a model profile toggle sends one write', async ({ page }) => {
  const profile = { id: 'gpt-fast', displayName: 'GPT fast', provider: 'openai', model: 'gpt-5-mini', credentialId: null, status: 'ACTIVE', generation: 1 };
  const writes = await stubBff(page, {
    reads: { ...EMPTY_MODELS, '/agent-model-profiles': answer(200, { data: { profiles: [profile] } }) },
    writes: { 'POST /agent-model-profiles/gpt-fast/disable': answer(200, { data: { ...profile, status: 'DISABLED', generation: 2 } }, { delayMs: 300 }) }
  });
  await page.goto('/dashboard/models');
  await expectPage(page, 'models');
  await clickTwice(page, 'Disable GPT fast');
  await expect.poll(() => writesTo(writes, 'POST', '/agent-model-profiles/gpt-fast/disable').length).toBe(1);
  await page.waitForTimeout(500);
  expect(writesTo(writes, 'POST', '/agent-model-profiles/gpt-fast/disable')).toHaveLength(1);
});
