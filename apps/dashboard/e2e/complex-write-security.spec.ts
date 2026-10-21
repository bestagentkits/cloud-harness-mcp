import { expect, type Page, test } from '@playwright/test';
import { answer, watchConsole } from './support';
import { WORKSPACE_ID } from './fixtures/workspaces';

// CSRF and Origin negatives for every write area this phase moved to React, against the real
// in-process BFF: its session, CSRF and Origin checks run before any handler, so a refused
// write never reaches the (unreachable) runner. A write that passes them fails later with a
// server error, never a 401 or 403.

const API = '/dashboard/api/v1';
const ws = `/workspaces/${WORKSPACE_ID}`;

const AREAS: Array<{ area: string; method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; body: unknown }> = [
  { area: 'files', method: 'PUT', path: `${ws}/files/content`, body: { path: 'a.txt', content: 'x', expectedSha256: 'a'.repeat(64) } },
  { area: 'git', method: 'POST', path: `${ws}/git/fetch`, body: { remote: 'origin' } },
  { area: 'worktrees', method: 'POST', path: `${ws}/worktrees`, body: { name: 'wt', ref: 'main' } },
  { area: 'automation skills', method: 'POST', path: `${ws}/skills/lint/run`, body: { script: 'check.sh', expectedContentSha256: 'a'.repeat(64) } },
  { area: 'automation hooks', method: 'POST', path: `${ws}/hooks/run`, body: { name: 'format', event: 'manual', expectedManifestSha256: 'a'.repeat(64) } },
  { area: 'deploy', method: 'POST', path: `${ws}/deployments/run`, body: { name: 'production' } },
  { area: 'finalize', method: 'POST', path: `${ws}/finalize`, body: { all: true, push: false, commitMessage: 'x', idempotencyKey: 'k'.repeat(16) } },
  { area: 'close', method: 'POST', path: `${ws}/close`, body: { expectedGeneration: 1 } },
  { area: 'open workspace', method: 'POST', path: '/workspaces', body: { repositoryUrl: 'https://github.com/acme/rocket', idempotencyKey: 'k'.repeat(16) } },
  { area: 'artifacts create', method: 'POST', path: '/artifacts', body: { workspaceId: WORKSPACE_ID, path: 'a', logicalName: 'a', expectedGeneration: 0 } },
  { area: 'artifacts delete', method: 'DELETE', path: '/artifacts/art_1', body: { expectedGeneration: 1 } },
  { area: 'packages', method: 'POST', path: '/packages/rollback', body: { bindingId: 'pkb_1', releaseId: 'pkr_1', expectedGeneration: 1 } }
];

/** Reads answer empty so the page renders; writes and the session go to the real BFF. */
async function realWrites(page: Page) {
  await page.route(`**${API}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice(API.length);
    if (['/session', '/profile', '/preferences'].includes(path) || request.method() !== 'GET') return route.fallback();
    return answer(200, { data: {} })(route);
  });
}

function pageWrite(page: Page, { method, path, body }: (typeof AREAS)[number], headers: Record<string, string>) {
  return page.evaluate(async ({ url, method: verb, body: payload, headers: extra }) => {
    const response = await fetch(url, { method: verb, headers: { 'content-type': 'application/json', accept: 'application/json', ...extra }, body: JSON.stringify(payload) });
    return { status: response.status, json: await response.json().catch(() => null) as unknown };
  }, { url: `${API}${path}`, method, body, headers });
}

test.beforeEach(async ({ page }) => {
  watchConsole(page, { allow: [/Failed to load resource/] });
  await realWrites(page);
  await page.goto('/dashboard/workspaces');
  expect(await page.evaluate(async (url) => (await fetch(url)).status, `${API}/session`)).toBe(200);
});

for (const area of AREAS) {
  test(`${area.area}: a write without the CSRF token, or with a wrong one, is refused with 403`, async ({ page }) => {
    for (const headers of [{}, { 'x-csrf-token': 'not-the-session-token' }]) {
      const result = await pageWrite(page, area, headers);
      expect(result.status).toBe(403);
      expect(result.json).toEqual({ error: 'csrf_failed' });
    }
  });

  test(`${area.area}: a write from another Origin is refused with 403`, async ({ page }) => {
    const response = await page.request.fetch(`${API}${area.path}`, {
      method: area.method,
      headers: { origin: 'https://attacker.example.test', 'content-type': 'application/json' },
      data: area.body
    });
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden_origin' });
  });
}

test('a write with the session token passes the checks and fails only at the runner', async ({ page }) => {
  const token = await page.evaluate(async (url) => ((await (await fetch(url)).json()) as { csrfToken: string }).csrfToken, `${API}/session`);
  for (const area of AREAS) {
    const result = await pageWrite(page, area, { 'x-csrf-token': token });
    expect([401, 403], area.area).not.toContain(result.status);
  }
});
