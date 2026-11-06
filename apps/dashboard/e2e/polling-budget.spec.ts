import { expect, test, type Page } from '@playwright/test';
import { expectPage, stubReads, type VisitedPage } from './support';

// Poller and query-count budget for the migrated pages. The classic Dashboard polls nothing on
// these pages at rest, so with a settled page and two minutes of fake time every BFF read must
// have been made exactly once: no duplicate fetch on load and no idle poller.

const API = '/dashboard/api/v1';
const SHELL_READS = new Set(['/session', '/profile', '/preferences']);

type PageCase = { path: string; pageId: VisitedPage | 'audit' | 'profile'; title: string };

const PAGES: PageCase[] = [
  { path: '/dashboard', pageId: 'overview', title: 'Overview' },
  { path: '/dashboard/workspaces', pageId: 'workspaces', title: 'Workspaces' },
  { path: '/dashboard/workspaces/ws_pollingpollingpoll01', pageId: 'workspace', title: 'Workspace' },
  { path: '/dashboard/workspaces/ws_pollingpollingpoll01/agents', pageId: 'workspace', title: 'Workspace' },
  { path: '/dashboard/workspaces/ws_pollingpollingpoll01/activity', pageId: 'workspace', title: 'Workspace' },
  { path: '/dashboard/agents', pageId: 'agents', title: 'Agents' },
  { path: `/dashboard/agents/agent_${'p1'.repeat(12)}`, pageId: 'agent', title: 'Agent' },
  { path: '/dashboard/activity', pageId: 'activity', title: 'Activity' },
  { path: '/dashboard/audit', pageId: 'audit', title: 'Audit' },
  { path: '/dashboard/projects', pageId: 'projects', title: 'Projects' },
  { path: '/dashboard/knowledge', pageId: 'knowledge', title: 'Knowledge' },
  { path: '/dashboard/skills', pageId: 'skills', title: 'Skills' },
  { path: '/dashboard/profile', pageId: 'profile', title: 'Profile' },
  { path: '/dashboard/settings', pageId: 'settings', title: 'Settings' }
];

/** Every page GET (path and query), excluding the shell's own session, profile and preferences reads. */
function trackReads(page: Page): string[] {
  const reads: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() !== 'GET' || !url.pathname.startsWith(`${API}/`)) return;
    const path = url.pathname.slice(API.length);
    if (!SHELL_READS.has(path)) reads.push(`${path}${url.search}`);
  });
  return reads;
}

function duplicates(reads: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const read of reads) counts.set(read, (counts.get(read) ?? 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([read, count]) => `${read} ×${count}`);
}

for (const { path, pageId, title } of PAGES) {
  test(`${path} reads each endpoint once and polls nothing at rest`, async ({ page }) => {
    await page.clock.install();
    const reads = trackReads(page);
    await stubReads(page);
    await page.goto(path);
    if (pageId === 'audit' || pageId === 'profile') await expect(page.getByTestId('page-title')).toHaveText(title);
    else await expectPage(page, pageId);
    await page.waitForLoadState('networkidle');
    const settled = reads.length;
    // Profile reuses the shell's own profile read, so it makes no page read of its own.
    if (pageId !== 'profile') expect(settled).toBeGreaterThan(0);
    expect(duplicates(reads)).toEqual([]);

    // Two minutes covers every polling interval (live 5 s, standard 15 s, slow 60 s).
    await page.clock.runFor(120_000);
    await page.waitForLoadState('networkidle');
    expect(reads.slice(settled)).toEqual([]);
  });
}
