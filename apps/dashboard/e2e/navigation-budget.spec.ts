import { expect, test, type Page } from '@playwright/test';
import { ACTIVITY, GRANTS, PLANS } from './fixtures/activity';
import { AGENTS, LOGS_FIRST, PARENT, PARENT_ID } from './fixtures/agents';
import { metricsProjection, overviewProjection, reliabilityProjection, serverInfo } from './fixtures/overview';
import { IMPORT_JOB, importJob, registry, skillSets, skillsBody } from './fixtures/skills';
import { workspacesList } from './fixtures/workspaces';
import { answer, expectPage, sidebarLink, stubReads, type VisitedPage } from './support';

// Moving between the migrated pages inside one document: every navigation reads no more than
// the classic loader for that page read (docs/dashboard-parity-matrix.md §6), and a page's
// pollers stop the moment it is left, so a client-side tour never stacks duplicate pollers.

const API = '/dashboard/api/v1';
const SHELL_READS = new Set(['/session', '/profile', '/preferences']);

/**
 * The page reads of each classic loader (`apps/api/dashboard/dashboard.js`), without the
 * shell's session, profile and preferences reads, which the React shell makes once.
 */
const LEGACY_READS: Record<'overview' | 'workspaces' | 'agents' | 'agent' | 'activity' | 'skills', readonly string[]> = {
  // `loadOverview` plus `refreshApprovalsBadge`.
  overview: ['/server', '/overview', '/metrics', '/reliability', '/privilege-grants', '/package-plans'],
  // `loadIndex`.
  workspaces: ['/workspaces'],
  // `loadAgents`.
  agents: ['/agents'],
  // `loadAgents(agentId)`: the detail and its log tail.
  agent: [`/agents/${PARENT_ID}`, `/agents/${PARENT_ID}/logs`],
  // `loadActivity` plus `refreshApprovalsBadge`.
  activity: ['/activity', '/privilege-grants', '/package-plans'],
  // `loadSkills`: the library rows.
  skills: ['/skills']
};

const POLLED_AFTER_LEAVING = [`/agents/${PARENT_ID}`, `/agents/${PARENT_ID}/logs`, `/skill-imports/${IMPORT_JOB}`];

type Read = { path: string; url: string };

function trackReads(page: Page): Read[] {
  const reads: Read[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() !== 'GET' || !url.pathname.startsWith(`${API}/`)) return;
    const path = url.pathname.slice(API.length);
    if (!SHELL_READS.has(path)) reads.push({ path, url: `${path}${url.search}` });
  });
  return reads;
}

function duplicates(reads: readonly Read[]): string[] {
  const counts = new Map<string, number>();
  for (const { url } of reads) counts.set(url, (counts.get(url) ?? 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([url, count]) => `${url} ×${count}`);
}

const READS = {
  '/overview': answer(200, overviewProjection),
  '/metrics': answer(200, metricsProjection),
  '/reliability': answer(200, reliabilityProjection),
  '/server': answer(200, serverInfo),
  '/workspaces': answer(200, workspacesList),
  '/agents': answer(200, AGENTS),
  [`/agents/${PARENT_ID}`]: answer(200, { data: PARENT }),
  [`/agents/${PARENT_ID}/logs`]: answer(200, LOGS_FIRST),
  '/activity': answer(200, ACTIVITY),
  '/privilege-grants': answer(200, GRANTS),
  '/package-plans': answer(200, PLANS),
  '/skills': answer(200, skillsBody),
  '/skill-sets': answer(200, skillSets),
  '/toolkit-registry': answer(200, registry),
  // An import that never finishes, so its poll runs for as long as the page is open.
  [`/skill-imports/${IMPORT_JOB}`]: answer(200, importJob('running'))
};

test('a client-side tour reads no more than the classic loaders and leaves no poller behind', async ({ page }) => {
  test.setTimeout(90_000);
  await page.clock.install();
  const reads = trackReads(page);
  await stubReads(page, READS);
  await page.route(`**${API}/skill-imports`, (route) => (route.request().method() === 'POST' ? answer(200, importJob('queued'))(route) : route.fallback()));

  /** Reads made since `from`, after the arriving page settles. */
  async function arrive(pageId: VisitedPage, from: number, budget: readonly string[]) {
    await expectPage(page, pageId);
    await expect(page.locator('main [aria-busy=true], main [data-slot=skeleton]')).toHaveCount(0);
    const made = reads.slice(from);
    expect(duplicates(made), `${pageId}: duplicate reads`).toEqual([]);
    expect(made.length, `${pageId}: ${made.map((read) => read.url).join(', ')}`).toBeLessThanOrEqual(budget.length);
    return made;
  }

  /** Two minutes of fake time: every poll interval (live 5 s, standard 15 s, slow 60 s) fires. */
  async function rest(): Promise<Read[]> {
    const from = reads.length;
    await page.clock.runFor(120_000);
    await page.waitForTimeout(200);
    return reads.slice(from);
  }

  const expectNoLeftoverPolls = (since: number) =>
    expect(reads.slice(since).filter((read) => POLLED_AFTER_LEAVING.includes(read.path)).map((read) => read.url)).toEqual([]);

  // Overview, at rest: nothing polls.
  await page.goto('/dashboard');
  await arrive('overview', 0, LEGACY_READS.overview);
  expect(await rest()).toEqual([]);

  let mark = reads.length;
  await sidebarLink(page, 'workspaces').click();
  await arrive('workspaces', mark, LEGACY_READS.workspaces);
  expect(await rest()).toEqual([]);

  mark = reads.length;
  await sidebarLink(page, 'agents').click();
  await arrive('agents', mark, LEGACY_READS.agents);
  expect(await rest()).toEqual([]);

  // Agent detail with Follow on: it polls while open (one owner per read, no duplicates per tick).
  mark = reads.length;
  await page.locator(`main a[href^="/dashboard/agents/${PARENT_ID}"]`).first().click();
  await arrive('agent', mark, LEGACY_READS.agent);
  await page.getByRole('button', { name: 'Follow' }).click();
  const following = reads.length;
  await page.clock.runFor(10_000);
  await expect.poll(() => reads.slice(following).filter((read) => read.path === `/agents/${PARENT_ID}/logs`).length).toBeGreaterThan(0);
  const perTick = reads.slice(following).filter((read) => read.path === `/agents/${PARENT_ID}`).length;
  expect(perTick).toBeLessThanOrEqual(2);

  // Leaving stops both of the detail's polls at once.
  mark = reads.length;
  await sidebarLink(page, 'activity').click();
  await arrive('activity', mark, LEGACY_READS.activity);
  expectNoLeftoverPolls(mark);
  expect(await rest()).toEqual([]);
  expectNoLeftoverPolls(mark);

  // Skills with an import running: the job polls while the page is open.
  mark = reads.length;
  await sidebarLink(page, 'skills').click();
  await arrive('skills', mark, LEGACY_READS.skills);
  await page.getByRole('tab', { name: 'Discover' }).click();
  await page.getByRole('textbox', { name: 'Source' }).fill('acme/review-skills');
  await page.getByRole('button', { name: 'Import' }).click();
  const importing = reads.length;
  await page.clock.runFor(10_000);
  await expect.poll(() => reads.slice(importing).filter((read) => read.path === `/skill-imports/${IMPORT_JOB}`).length).toBeGreaterThan(0);

  // Back to Overview: the import poll stops, and Overview reads no more than its loader did.
  mark = reads.length;
  await sidebarLink(page, 'overview').click();
  await arrive('overview', mark, LEGACY_READS.overview);
  expectNoLeftoverPolls(mark);
  expect(await rest()).toEqual([]);
  expectNoLeftoverPolls(mark);
});

test('hovering a filtered link preloads exactly the filtered read the page renders', async ({ page }) => {
  await page.clock.install();
  const reads = trackReads(page);
  await stubReads(page, READS);
  await page.goto('/dashboard');
  await expectPage(page, 'overview');
  await expect(page.locator('main [aria-busy=true], main [data-slot=skeleton]')).toHaveCount(0);
  const mark = reads.length;
  const tile = page.locator('main a[href="/dashboard/agents?status=RUNNING"]').first();
  await tile.hover();
  await expect.poll(() => reads.slice(mark).map((read) => read.url)).toEqual(['/agents?status=RUNNING']);
  // The click reuses the warmed read instead of asking again.
  await tile.click();
  await expectPage(page, 'agents');
  await page.waitForTimeout(300);
  expect(reads.slice(mark).map((read) => read.url)).toEqual(['/agents?status=RUNNING']);
});
