// The clock must freeze before any fixture module evaluates; keep these two imports first and last.
import { VISUAL_NOW } from './visual/freeze-time';
import { expect, test } from '@playwright/test';
import { ACTIVITY, GRANTS, PLANS } from './fixtures/activity';
import { AGENTS, LOGS_FIRST, PARENT, PARENT_ID } from './fixtures/agents';
import { AUDIT_PAGE_1 } from './fixtures/audit';
import { knowledgeList } from './fixtures/knowledge';
import { metricsProjection, overviewProjection, reliabilityProjection, serverInfo } from './fixtures/overview';
import { PROFILE_BODY } from './fixtures/profile';
import { projectsList } from './fixtures/projects';
import { oauthBody, settingsBody, TYPESAFE_CREDENTIALS, TYPESAFE_STATUS } from './fixtures/settings';
import { skillsBody } from './fixtures/skills';
import { ARTIFACT, PACKAGES } from './fixtures/artifacts-packages';
import { cockpitTabReads } from './fixtures/cockpit-tabs';
import { activeWorkspace, contextProjection, runtimeProjection, WORKSPACE_ID, workspaceActivity, workspaceAgents, workspacesList } from './fixtures/workspaces';
import { answer, type ReadHandler, stubReads } from './support';
import './visual/thaw-time';

// Screenshot baselines of the migrated pages in light and dark at desktop, tablet and phone
// widths. Fonts and anti-aliasing differ by OS, so baselines are Linux-only (CI runs
// ubuntu-24.04); generate them with the pinned Playwright image as docs/development.md shows.

test.skip(process.platform !== 'linux', 'Screenshot baselines are recorded on Linux only');
test.use({ timezoneId: 'UTC', locale: 'en-US' });

const API = '/dashboard/api/v1';
// The real test API stamps the profile with a live session expiry; answer a fixed body instead.
const PROFILE = { ...PROFILE_BODY, data: { ...PROFILE_BODY.data, sessionExpiresAt: new Date(VISUAL_NOW + 3_600_000).toISOString() } };

const workspace = `/workspaces/${WORKSPACE_ID}`;

const READS: Record<string, ReadHandler> = {
  '/overview': answer(200, overviewProjection),
  '/metrics': answer(200, metricsProjection),
  '/reliability': answer(200, reliabilityProjection),
  '/server': answer(200, serverInfo),
  '/workspaces': answer(200, workspacesList),
  [workspace]: answer(200, { data: activeWorkspace }),
  [`${workspace}/context`]: answer(200, contextProjection),
  [`${workspace}/runtime`]: answer(200, runtimeProjection),
  [`${workspace}/agents`]: answer(200, workspaceAgents),
  [`${workspace}/activity`]: answer(200, workspaceActivity),
  ...Object.fromEntries(Object.entries(cockpitTabReads(workspace)).filter(([path]) => /\/(files|git|worktrees|skills|hooks|deployments|artifacts|tasks)/.test(path.slice(workspace.length)))),
  '/artifacts': answer(200, { data: { artifacts: [ARTIFACT] } }),
  '/packages': answer(200, PACKAGES),
  '/agents': answer(200, AGENTS),
  [`/agents/${PARENT_ID}`]: answer(200, { data: PARENT }),
  [`/agents/${PARENT_ID}/logs`]: answer(200, LOGS_FIRST),
  '/activity': answer(200, ACTIVITY),
  '/privilege-grants': answer(200, GRANTS),
  '/package-plans': answer(200, PLANS),
  '/audit': answer(200, AUDIT_PAGE_1),
  '/projects': answer(200, projectsList),
  '/knowledge': answer(200, knowledgeList),
  '/skills': answer(200, skillsBody),
  '/settings': answer(200, settingsBody()),
  '/settings/oauth': answer(200, oauthBody()),
  '/typesafe/status': answer(200, TYPESAFE_STATUS),
  '/integration-credentials': answer(200, TYPESAFE_CREDENTIALS)
};

/** Each migrated page, by screenshot name. */
const PAGES: { name: string; path: string }[] = [
  { name: 'overview', path: '/dashboard' },
  { name: 'workspaces', path: '/dashboard/workspaces' },
  { name: 'workspace-summary', path: `/dashboard${workspace}` },
  { name: 'workspace-runtime', path: `/dashboard${workspace}/runtime` },
  { name: 'workspace-files', path: `/dashboard${workspace}/files?path=src&file=src%2Fmain.ts` },
  { name: 'workspace-git', path: `/dashboard${workspace}/git` },
  { name: 'workspace-automation', path: `/dashboard${workspace}/automation` },
  { name: 'workspace-deploy', path: `/dashboard${workspace}/deploy` },
  { name: 'agents', path: '/dashboard/agents' },
  { name: 'agent', path: `/dashboard/agents/${PARENT_ID}` },
  { name: 'activity', path: '/dashboard/activity' },
  { name: 'audit', path: '/dashboard/audit' },
  { name: 'projects', path: '/dashboard/projects' },
  { name: 'knowledge', path: '/dashboard/knowledge' },
  { name: 'skills', path: '/dashboard/skills' },
  { name: 'profile', path: '/dashboard/profile' },
  { name: 'settings', path: '/dashboard/settings' },
  { name: 'artifacts', path: '/dashboard/artifacts' },
  { name: 'packages', path: '/dashboard/packages' }
];

const WIDTHS = [1280, 768, 375] as const;
const THEMES = ['light', 'dark'] as const;

for (const { name, path } of PAGES) {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test(`${name} looks right in ${theme} at ${width}px`, async ({ page }) => {
        await page.clock.setFixedTime(VISUAL_NOW);
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        await page.setViewportSize({ width, height: 900 });
        await stubReads(page, READS);
        await page.route(`**${API}/profile`, (route) => (route.request().method() === 'GET' ? answer(200, PROFILE)(route) : route.fallback()));
        await page.goto(path);
        await expect(page.getByTestId('page-frame')).toBeVisible();
        await page.waitForLoadState('networkidle');
        // Settled: no skeleton and no background refetch left on the page.
        await expect(page.locator('[data-slot=skeleton], [data-testid=page-skeleton], [aria-busy=true]')).toHaveCount(0);
        await expect(page).toHaveScreenshot(`${name}-${theme}-${width}.png`, { fullPage: true, animations: 'disabled', caret: 'hide' });
      });
    }
  }
}
