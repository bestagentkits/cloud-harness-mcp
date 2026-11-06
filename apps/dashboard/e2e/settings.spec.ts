import { expect, type Page, type Request, test } from '@playwright/test';
import { answer, expectNoSeriousA11yViolations, expectPage, stubReads, watchConsole } from './support';
import { lifecycle, OAUTH_REVISION, OAUTH_SEVEN_DAYS, oauthBody, settingsBody, TYPESAFE_CREDENTIALS, TYPESAFE_STATUS } from './fixtures/settings';

// Settings: network profile, workspace lifecycle, MCP OAuth sessions and the TypeSafe read side.

const READS = {
  '/settings': answer(200, settingsBody()),
  '/settings/oauth': answer(200, oauthBody()),
  '/typesafe/status': answer(200, TYPESAFE_STATUS),
  '/integration-credentials': answer(200, TYPESAFE_CREDENTIALS)
};

type Write = { method: string; body: unknown; csrf: boolean };

/** Answers POSTs to `path` with `respond(body)` after `delayMs`, recording each one; other methods fall through to the read stubs. */
async function stubWrite(page: Page, path: string, respond: (body: unknown) => { status: number; body: unknown }, delayMs = 0): Promise<Write[]> {
  const writes: Write[] = [];
  await page.route(`**/dashboard/api/v1${path}`, async (route) => {
    const request: Request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    const body = request.postDataJSON() as unknown;
    writes.push({ method: request.method(), body, csrf: Boolean(request.headers()['x-csrf-token']) });
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const answer = respond(body);
    return route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) }).catch(() => undefined);
  });
  return writes;
}

async function openSettings(page: Page, handlers = {}) {
  const seen = await stubReads(page, { ...READS, ...handlers });
  await page.goto('/dashboard/settings');
  await expectPage(page, 'settings');
  return seen;
}

const main = (page: Page) => page.locator('main');

test('renders every section from one read each, with no primary action and no markup styles', async ({ page }) => {
  const problems = watchConsole(page);
  const seen = await openSettings(page);
  await expect(page.getByRole('heading', { name: 'Default network profile' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workspace limits & lifecycle' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'MCP OAuth sessions' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'TypeSafe integration' })).toBeVisible();
  await expect(page.getByLabel('Effective default')).toHaveValue('');
  await expect(main(page)).toContainText('Runner default (WORKSPACE_NETWORK_PROFILE or built-in)');
  await expect(main(page)).toContainText('exfiltrate');
  await expect(page.getByLabel('Idle timeout (minutes)')).toHaveValue('5');
  await expect(main(page)).toContainText('30 days — provider maximum');
  await expect(main(page)).toContainText('TYPESAFE_EGRESS=off');
  await expect(main(page).getByRole('link', { name: /classic Dashboard/ })).toHaveAttribute('href', '/dashboard/settings?ui=legacy');
  // The credential id and generation never reach the page.
  await expect(main(page)).not.toContainText('icred_');
  await expect(page.getByTestId('primary-action')).toHaveCount(0);
  // The only styled nodes belong to Radix Checkbox, which sets them at runtime through the
  // CSSOM (CSP-safe): its indicator (`pointer-events: none`) and the hidden native input it
  // adds inside a form so the value takes part in form events.
  const styled = await page.locator('main [style]').evaluateAll((nodes) => nodes.map((node) => {
    if (node.closest('[role=checkbox]')) return 'indicator';
    return node.tagName === 'INPUT' && node.getAttribute('aria-hidden') === 'true' && node.previousElementSibling?.getAttribute('role') === 'checkbox' ? 'bubble-input' : node.outerHTML.slice(0, 120);
  }));
  expect(styled.every((entry) => entry === 'indicator' || entry === 'bubble-input'), styled.join(', ')).toBe(true);
  expect([...seen].sort()).toEqual(['/integration-credentials', '/settings', '/settings/oauth', '/typesafe/status']);
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});

test('network profile: save shows saving then saved, reset restores the runner default, check shows readiness', async ({ page }) => {
  const problems = watchConsole(page);
  await openSettings(page);
  const writes = await stubWrite(page, '/settings', (body) => {
    const profile = (body as { defaultNetworkProfile: string | null }).defaultNetworkProfile;
    return { status: 200, body: settingsBody(profile ? { profile, source: 'setting' } : {}) };
  }, 600);
  const checks = await stubWrite(page, '/settings/network-check', () => ({ status: 200, body: { data: { ready: false, reason: 'egress proxy unreachable' } } }));

  await page.getByLabel('Effective default').selectOption('network-none');
  const save = page.getByTestId('save-network-profile');
  await save.click();
  await expect(save).toHaveAttribute('data-state', 'pending');
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(save).toHaveAttribute('data-state', 'success');
  await expect(page.getByTestId('network-status')).toHaveText('Default network profile saved.');
  await expect(main(page)).toContainText('Set in this dashboard');
  await expect(page.getByLabel('Effective default')).toHaveValue('network-none');

  await page.getByTestId('reset-network-profile').click();
  await expect(page.getByTestId('network-status')).toHaveText('Runner default restored.');
  await expect(page.getByLabel('Effective default')).toHaveValue('');

  await page.getByTestId('check-network').click();
  await expect(page.getByTestId('network-status')).toHaveText('Egress is not ready: egress proxy unreachable');
  await expect(main(page)).toContainText('Not ready: egress proxy unreachable');

  expect(writes.map((write) => write.body)).toEqual([{ defaultNetworkProfile: 'network-none' }, { defaultNetworkProfile: null }]);
  expect(checks.map((write) => write.body)).toEqual([{}]);
  expect([...writes, ...checks].every((write) => write.csrf)).toBe(true);
  expect(problems).toEqual([]);
});

test('lifecycle: inline validation, changed fields only, grace 0 acknowledgement and reset', async ({ page }) => {
  const problems = watchConsole(page);
  await openSettings(page);
  const writes = await stubWrite(page, '/settings', (body) => {
    const update = (body as { workspaceLifecycle: Record<string, number | null> }).workspaceLifecycle;
    const next = lifecycle({ revision: 8 });
    if (typeof update.idleTtlSeconds === 'number') next.settings.idleTtlSeconds = { ...next.settings.idleTtlSeconds, value: update.idleTtlSeconds, source: 'setting' };
    return { status: 200, body: settingsBody({ workspaceLifecycle: next }) };
  });

  const idle = page.getByLabel('Idle timeout (minutes)');
  await idle.fill('721');
  await expect(main(page).getByText('Enter whole minutes from 1 to 720.')).toBeVisible();
  await expect(idle).toHaveAttribute('aria-invalid', 'true');
  await page.getByTestId('save-lifecycle').click();
  await expect(page.getByTestId('lifecycle-status')).toHaveText('Fix the highlighted fields before saving.');

  await idle.fill('10');
  await expect(idle).not.toHaveAttribute('aria-invalid');
  await page.getByTestId('save-lifecycle').click();
  await expect(page.getByTestId('lifecycle-status')).toHaveText('Workspace lifecycle settings saved. Effective: up to 3 active per principal, idle 10 min, lifetime 15 min, grace 60 min.');
  await expect(idle).toHaveValue('10');

  const grace = page.getByLabel('Recoverable grace before auto-close (minutes)');
  await grace.fill('0');
  const acknowledge = page.getByRole('checkbox', { name: 'I understand expired workspaces close without a recovery window' });
  await expect(acknowledge).toBeVisible();
  await page.getByTestId('save-lifecycle').click();
  await expect(main(page).getByText('Confirm that a grace of 0 closes expired workspaces without a recovery window.')).toBeVisible();
  await expect(acknowledge).toBeFocused();
  await acknowledge.check();
  await page.getByTestId('save-lifecycle').click();
  await expect(page.getByTestId('lifecycle-status')).toContainText('Workspace lifecycle settings saved.');

  await page.getByTestId('reset-lifecycle').click();
  await expect(page.getByTestId('lifecycle-status')).toContainText('Runner values restored.');

  expect(writes.map((write) => write.body)).toEqual([
    { workspaceLifecycle: { expectedRevision: 7, idleTtlSeconds: 600 } },
    { workspaceLifecycle: { expectedRevision: 8, recoverableGraceSeconds: 0, acknowledgeImmediateClose: true } },
    { workspaceLifecycle: { expectedRevision: 8, maxActiveWorkspacesPerOwner: null, idleTtlSeconds: null, wallTtlSeconds: null, recoverableGraceSeconds: null } }
  ]);
  expect(writes.every((write) => write.csrf)).toBe(true);
  expect(problems).toEqual([]);
});

test('lifecycle: a stale revision reloads the current values instead of retrying', async ({ page }) => {
  const problems = watchConsole(page, { allow: [/Failed to load resource/] });
  const seen = await openSettings(page);
  const writes = await stubWrite(page, '/settings', () => ({ status: 409, body: { error: 'conflict', message: 'Instance settings changed after you opened them. Reload and try again.' } }));
  await page.getByLabel('Max active workspaces per principal').fill('5');
  const save = page.getByTestId('save-lifecycle');
  await save.click();
  await expect(save).toHaveAttribute('data-state', 'error');
  await expect(page.getByTestId('lifecycle-status')).toHaveText(/changed elsewhere after you opened Settings/);
  await expect.poll(() => seen.filter((path) => path === '/settings').length).toBe(2);
  expect(writes).toHaveLength(1);
  expect(problems).toEqual([]);
});

test('OAuth: choosing a preset sends it and the form reflects the provider read-back', async ({ page }) => {
  const problems = watchConsole(page);
  await openSettings(page);
  const writes = await stubWrite(page, '/settings/oauth', () => ({ status: 200, body: OAUTH_SEVEN_DAYS }));
  const persistent = page.getByRole('checkbox', { name: /Stay signed in — use the provider maximum \(30 days\)/ });
  await expect(persistent).toBeChecked();
  const grant = page.getByLabel('Grant duration');
  await expect(grant).toBeDisabled();
  await expect(page.getByRole('button', { name: /Adopt default/ })).toHaveCount(0);

  await persistent.uncheck();
  await expect(grant).toBeEnabled();
  await grant.selectOption({ label: '7 days' });
  await expect(page.getByLabel('Custom duration (hours)')).toBeDisabled();
  await page.getByTestId('save-oauth').click();
  await expect(page.getByTestId('oauth-status')).toHaveText('OAuth settings saved and confirmed by the provider.');
  await expect(main(page)).toContainText('Custom duration');
  await expect(grant).toHaveValue('604800');
  await expect(persistent).not.toBeChecked();

  expect(writes.map((write) => write.body)).toEqual([{ grant: { mode: 'custom', seconds: 604_800 }, tokenLifetimeSeconds: 900, expectedRevision: OAUTH_REVISION }]);
  expect(writes[0]?.csrf).toBe(true);
  expect(problems).toEqual([]);
});

test('OAuth: a custom duration out of range is refused before any request, and an unmanaged value can adopt the default', async ({ page }) => {
  await openSettings(page, { '/settings/oauth': answer(200, oauthBody({ management: { state: 'unmanaged', desired: null, updatedAt: null, updatedBy: null } })) });
  const writes = await stubWrite(page, '/settings/oauth', () => ({ status: 200, body: oauthBody() }));
  await page.getByRole('checkbox', { name: /Stay signed in/ }).uncheck();
  await page.getByLabel('Grant duration').selectOption('custom');
  await page.getByLabel('Custom duration (hours)').fill('721');
  await page.getByTestId('save-oauth').click();
  await expect(page.getByTestId('oauth-status')).toHaveText('The grant duration must be between 1 hour(s) and 720 hours.');
  expect(writes).toHaveLength(0);

  await page.getByRole('button', { name: 'Adopt default: stay signed in, 15 minutes tokens' }).click();
  await expect(page.getByTestId('oauth-status')).toHaveText('Default adopted: clients stay signed in for the provider maximum.');
  expect(writes.map((write) => write.body)).toEqual([{ grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: 900, expectedRevision: OAUTH_REVISION }]);
});

test('OAuth: a read-only provider shows facts and the reason without a form', async ({ page }) => {
  await openSettings(page, { '/settings/oauth': answer(200, oauthBody({ capabilities: { ...oauthBody().data.capabilities, canWriteGrantConfiguration: false }, readOnlyReason: 'The Cloudflare API token cannot update this Access application.' })) });
  await expect(main(page)).toContainText('cannot update this Access application');
  await expect(page.getByTestId('save-oauth')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reload from provider' }).click();
  await expect(page.getByTestId('oauth-status')).toHaveText('Reloaded from the provider.');
});

test('loading shows a skeleton, and an unavailable runner fails only its own sections', async ({ page }) => {
  const problems = watchConsole(page, { allow: [/Failed to load resource/] });
  await stubReads(page, {
    ...READS,
    '/settings': answer(503, { error: 'settings_unavailable', message: 'Settings are temporarily unavailable.' }, { delayMs: 400 }),
    '/settings/oauth': answer(403, { error: 'forbidden', message: 'Forbidden.' })
  });
  await page.goto('/dashboard/settings');
  await expectPage(page, 'settings');
  await expect(page.getByRole('status', { name: 'Loading instance settings' })).toBeVisible();
  const unavailable = page.getByRole('alert').filter({ hasText: 'Instance settings are unavailable' });
  await expect(unavailable).toBeVisible({ timeout: 10_000 });
  await expect(unavailable).toContainText('Settings are temporarily unavailable.');
  await expect(unavailable.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Not allowed' })).toBeVisible();
  // TypeSafe still renders.
  await expect(main(page)).toContainText('typesafe-small');
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});

test('a runner without lifecycle settings omits that panel; works at 375px without page scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await openSettings(page, { '/settings': answer(200, settingsBody({ workspaceLifecycle: null })) });
  await expect(page.getByRole('heading', { name: 'Default network profile' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workspace limits & lifecycle' })).toHaveCount(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
