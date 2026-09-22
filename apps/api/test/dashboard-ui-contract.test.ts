import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_SECRET_NAMES, FORBIDDEN_SECRET_PREFIXES, validateSecretName } from '@cloud-harness/contracts';
import {
  FORBIDDEN_CLIENT_NAMES,
  FORBIDDEN_CLIENT_PREFIXES,
  validateSecretClient
} from '../dashboard/dashboard.js';

import { renderSkillsSkeleton, renderTypesafeSkeleton } from '../dashboard/dashboard-render.js';
import { DASHBOARD_PAGES } from '../dashboard/dashboard-pages.js';

const asset = (name: string) => readFileSync(new URL(`../dashboard/${name}`, import.meta.url), 'utf8');

// The stylesheet is authored as compact single-line rules, but a formatter may
// reflow them. Normalizing whitespace keeps the structural assertions below
// about the declarations themselves rather than about their layout, so a reflow
// cannot silently drop the contract.
const squish = (value: string) => value.replace(/\s+/g, ' ').trim();

describe('dashboard static UI contract', () => {
  const html = asset('index.html');
  const css = asset('dashboard.css');
  const script = `${asset('dashboard.js')}\n${asset('dashboard-api.js')}\n${asset('dashboard-render.js')}\n${asset('dashboard-pages.js')}`;
  const squishedCss = squish(css);

  it('provides native landmarks, focus entry, live status, and destructive confirmation', () => {
    expect(html).toContain('href="#main"');
    expect(html).toContain('<aside id="product-nav"');
    expect(html).toContain('<main id="main" tabindex="-1">');
    expect(html).toContain('role="search"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('<dialog id="confirm-dialog"');
    expect(html).toContain('<dialog id="file-conflict-dialog"');
    for (const recovery of ['Review latest', 'Copy my changes', 'Cancel']) expect(html).toContain(recovery);
    expect(html).not.toContain('<form method="dialog"');
    expect((html.match(/<h1/g) ?? [])).toHaveLength(1);
  });

  it('marks state changes with bounded motion that reduced-motion collapses', () => {
    for (const selector of [
      '.content-just-updated', '.status-message[data-save-state="saved"]', '.lease-soon', '.lease-expired',
      '.chart-bar:focus-visible', '.task-node:focus-visible', '.nav-badge', '#detail'
    ]) expect(css, selector).toContain(selector);

    // The only infinite animation is the loading skeleton; everything else is a
    // state change, and the reduced-motion block collapses all of it by selector `*`.
    const infinite = css.split('\n').filter((line) => line.includes('infinite'));
    expect(infinite).toHaveLength(1);
    expect(infinite[0]).toContain('.skeleton');
    expect(css).toContain('animation-iteration-count: 1 !important');
    expect(css).toContain('transition-duration: .01ms !important');
    // Durations come from the motion tokens rather than ad-hoc numbers.
    expect(css).toContain('var(--motion-fast)');
    expect(css).toContain('var(--motion-state)');
    expect(css).not.toContain('gradient(');
  });

  it('exposes the save state and the mutation cue in the client', () => {
    expect(script).toContain("status.dataset.saveState = 'saved'");
    expect(script).toContain("status.dataset.saveState = 'saving'");
    expect(script).toContain('content-just-updated');
    expect(script).toContain('flashUpdated');
  });

  it('uses tokenized responsive styling with reduced-motion and narrow-screen rules', () => {
    for (const token of ['--canvas:', '--surface:', '--ink:', '--accent:', '--space-4:', '--motion-state:', '--info:', '--hud-cyan:', '--void:', '--panel:']) expect(css).toContain(token);
    expect(css).toContain('@media (max-width: 47.9375rem)');
    expect(css).toContain('@media (prefers-color-scheme: light)');
    expect(css).toContain(':root[data-theme="light"]');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('min-height: 2.75rem');
    expect(squishedCss).toContain(squish('.drawer-close { display: block; margin-inline-start: auto; margin-block-end: var(--space-4); }'));
    expect(css).not.toContain('.drawer-close { float:');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toContain('gradient(');
  });

  it('keeps the dashboard free of external assets and inline styles', () => {
    // The dashboard document is served with a strict CSP (`style-src 'self'`, no
    // 'unsafe-inline'), so a web font, an external stylesheet, or a markup
    // `style=` attribute would either be blocked at runtime or silently widen the
    // policy. Nothing asserted this before.
    expect(css).not.toMatch(/@font-face|@import|url\(/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/<link[^>]+href="https?:/i);
    expect(script).not.toMatch(/setAttribute\('style'|setAttribute\("style"/);
    // The artifact download is served under the /dashboard mount, so a bare
    // /api/v1 href would 404. Pin both directions.
    expect(script).toContain('/dashboard/api/v1/artifacts/');
    expect(script).not.toContain('href="/api/v1/artifacts/');
    // Three CSSOM inline-style mutations remain, all in the knowledge-graph zoom
    // (svg.style.transform). CSSOM inline-style handling under CSP is
    // browser-dependent, so they are pinned by identity rather than asserted
    // away: any new inline-style site fails this count, and the zoom control is
    // called out for a browser check in the PR.
    expect([...script.matchAll(/\.style\.[A-Za-z]+/g)].map((m) => m[0])).toEqual(['.style.transform', '.style.transform', '.style.transform']);
  });

  it('keeps every spacing step on the marketing 4px rhythm', () => {
    const steps = [...css.matchAll(/--space-(\d+):\s*([\d.]+)rem;/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(steps.length).toBeGreaterThan(0);
    for (const [step, value] of steps) expect((value * 16) % 4, `--space-${step} is ${value * 16}px`).toBe(0);
    // The marketing scale is exactly this set; 20px is the trap it excludes.
    expect(steps.map(([step]) => step).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 6, 8]);
  });

  it('never removes a focus indicator without a replacement', () => {
    expect(css).not.toContain('outline: none');
    expect(css).not.toContain('outline: 0');
  });

  it('keeps the interactive target floor at 24px', () => {
    const start = css.indexOf('.checkbox-label input {');
    expect(start, 'the checkbox rule exists').toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf('}', start));
    expect(rule).toContain('1.5rem');
    expect(rule).not.toContain('1.25rem');
  });

  it('backs files and runtime with bounded APIs and exposes no execution surface', () => {
    for (const operation of ['/files/content', '/files/move', '/files/directory', '/runtime', '/close']) expect(script).toContain(operation);
    for (const forbidden of ['exec_run', 'shell_open', 'deployments_run', 'runnerToken', 'cf-access-jwt-assertion', 'ownerId', 'containerName', 'workspacePath']) expect(script).not.toContain(forbidden);
    expect(script).toContain('This item changed after you opened it.');
    expect(script).toContain('No current tasks.');
    expect(script).toContain('No named sessions.');
  });

  it('renders the typename panel with a write-only key and no prompt surface', () => {
    const skeleton = renderTypesafeSkeleton();
    for (const selector of [
      'id="typesafe-panel"', 'id="typesafe-key"', 'id="typesafe-model"', 'id="typesafe-gate-threshold"',
      'id="typesafe-fit-threshold"', 'id="typesafe-max-egress-bytes"', 'id="typesafe-cache-ttl"',
      'id="typesafe-enabled"', 'id="typesafe-egress"', 'id="typesafe-test"', 'id="typesafe-status"', 'id="typesafe-usage"'
    ]) expect(skeleton, selector).toContain(selector);

    // The key field never renders a stored value back, and the usage surface has no prompt column.
    expect(skeleton).toMatch(/id="typesafe-key"[^>]*type="password"/);
    expect(skeleton).not.toMatch(/prompt/i);
    expect(skeleton).toContain('aria-live="polite"');
  });

  it('renders every skills selector the UI contract names', () => {
    const skeleton = renderSkillsSkeleton();
    for (const selector of [
      'id="skills-section"',
      'id="skills-tab-library"', 'id="skills-tab-discover"', 'id="skills-tab-sets"', 'id="skills-tab-registry"',
      'id="skills-library-search"', 'id="skills-library-table"', 'id="skills-bulk-bar"',
      'id="skills-library-empty"', 'id="skills-library-empty-message"', 'id="skills-library-empty-action"',
      'id="skill-detail"', 'id="skill-detail-title"', 'id="skill-detail-slug"', 'id="skill-detail-close"',
      'id="skill-detail-instructions"', 'id="skill-detail-files"', 'id="skill-detail-revisions"', 'id="skill-detail-usage"',
      'id="skill-editor"', 'id="skill-editor-title"', 'id="skill-editor-save"', 'id="skill-editor-status"',
      'id="skill-revision-diff"',
      'id="skill-import-dialog"', 'id="skill-import-source"', 'id="skill-import-ref"', 'id="skill-import-scope"',
      'id="skill-import-review"', 'id="skill-import-job"', 'id="skill-import-retry"',
      'id="skill-set-builder"', 'id="skill-set-picker"', 'id="skill-set-members"', 'id="skill-set-save"', 'id="skill-set-status"',
      'id="skills-registry-table"', 'id="skills-registry-status"'
    ]) expect(skeleton, selector).toContain(selector);
    // The registry live region has to announce changes, or a cache-state update stays silent.
    expect(skeleton).toMatch(/id="skills-registry-status"[^>]*aria-live="polite"/);
  });

  it('keeps the skills layout decisions the previous markup got wrong', () => {
    const skeleton = renderSkillsSkeleton();
    const mobileBreakpoint = squishedCss.indexOf('@media (max-width: 47.9375rem)');
    expect(mobileBreakpoint, 'the mobile breakpoint exists').toBeGreaterThan(-1);

    // The card list is the library's mobile rendering of the same rows. It had no base rule while the
    // table was already hidden on a phone, so it rendered beside the table at every wider width and every
    // skill appeared twice. The base rule hides it and the mobile block is the only place it returns.
    expect(squishedCss).toContain(squish('#skills-library-cards { display: none; }'));
    expect(squishedCss.slice(mobileBreakpoint)).toContain(squish('#skills-library-cards { display: grid; }'));

    // The active tab is marked from the state the tab controller already maintains, so the strip needs no
    // second source of truth.
    expect(squishedCss).toContain(squish('.skills-tabs [role="tab"][aria-selected="true"]'));

    // The filter bar and the editor declare their own layout rather than inheriting the global form rule
    // that laid every label and control out as one wrapping, end-aligned row.
    expect(squishedCss).toContain(squish('.skills-toolbar { display: grid;'));
    expect(squishedCss).toContain(squish('.skills-editor { display: grid;'));

    // An author `display` rule beats the UA `[hidden]` rule, so each surface this page toggles from data or
    // from its tab controller needs an explicit guard, the same way `.command-surface[hidden]` does.
    expect(squishedCss).toContain(squish('#skills-library-table[hidden], #skills-library-cards[hidden], #skills-library-empty[hidden], #skill-detail[hidden], .skills-panel[hidden] { display: none; }'));

    // The detail panel names the skill it opened and offers the only way out, and the revision diff renders
    // inside it instead of in the Discover panel, which is hidden whenever the Library tab is open.
    expect(skeleton.indexOf('id="skill-revision-diff"')).toBeLessThan(skeleton.indexOf('id="skills-panel-discover"'));
    expect(skeleton.indexOf('id="skill-revision-diff"')).toBeGreaterThan(skeleton.indexOf('id="skills-panel-library"'));
  });

  it('drives the import wizard from one path, including its retry, and states the job guidance', () => {
    // The wizard's submit and its retry are one start path, and the job line reports the guidance for the
    // state rather than the bare state token, so a failed import is actionable where the operator is
    // already looking. The control router does serve these routes
    // (`apps/api/src/dashboard-control-router.ts`), so the wizard is wired end to end.
    expect(script).toContain("document.querySelector('#skill-import-submit')?.addEventListener");
    expect(script).toContain("document.querySelector('#skill-import-retry')?.addEventListener");
    expect(script).toContain('jobBox.textContent = renderImportJobGuidance(job)');
    expect(script).toContain("api('/skill-imports'");
    // The bare state token is what the job line used to print, and it is not guidance.
    expect(script).not.toContain("String(job.state ?? 'queued')");
  });

  it('reduces the open workspace dialog to skill-set selection and drops the dead toolkit grid', () => {
    for (const selector of [
      'id="open-skill-sets-select"', 'id="open-skill-sets-chips"', 'id="open-skill-conflicts"',
      'id="open-workspace-preview"', 'id="skills-manage-link"'
    ]) expect(html, selector).toContain(selector);

    // The placeholder grid was never populated by any code path, so leaving it would show operators an
    // empty box that looks like a loading failure.
    expect(html).not.toContain('toolkits-selection-grid');
    expect(script).not.toContain('toolkits-selection-grid');
    expect(script).not.toContain('toolkits-grid');
  });

  it('exposes accessible metadata navigation and only existing dashboard BFF controls', () => {
    // Navigation is registry output (see dashboard-pages.test.ts for the parity and
    // group contracts), so this test asserts the destinations exist as pages rather
    // than as literals in the shell markup.
    for (const [id, route, label] of [
      ['overview', '/dashboard', 'Overview'], ['workspaces', '/dashboard/workspaces', 'Workspaces'],
      ['agents', '/dashboard/agents', 'Agents'],
      ['projects', '/dashboard/projects', 'Projects'], ['secrets', '/dashboard/secrets', 'Secrets'],
      ['models', '/dashboard/models', 'Models & Budgets'], ['artifacts', '/dashboard/artifacts', 'Artifacts'],
      ['audit', '/dashboard/audit', 'Audit'], ['api-keys', '/dashboard/api-keys', 'API Access'],
      ['integrations', '/dashboard/integrations', 'Integrations'],
      ['skills', '/dashboard/skills', 'Skills'],
      ['profile', '/dashboard/profile', 'Profile']
    ]) {
      const page = DASHBOARD_PAGES.find((candidate) => candidate.id === id);
      expect(page, id).toBeDefined();
      expect(page?.route, id).toBe(route);
      expect(page?.label, id).toBe(label);
    }
    // GitHub and MCP Servers are tabs of the Integrations page, not own destinations.
    expect(DASHBOARD_PAGES.some((page) => page.route === '/dashboard/github')).toBe(false);
    expect(DASHBOARD_PAGES.some((page) => page.route === '/dashboard/mcp-servers')).toBe(false);
    for (const endpoint of [
      "api('/projects')", "api('/secrets')", "api('/artifacts',", '`/audit?limit=50', "api('/github')", "api('/profile')",
      "'/github/setup'", "'/github/complete'", "'/github/reconcile'", "'/github/disconnect'", '`/environments/${'
    ]) expect(script).toContain(endpoint);
    expect(script).toContain('expectedGeneration');
    expect(script).toContain('retentionSeconds');
    expect(script).toContain('Write-only');
    for (const forbidden of ['sessionStorage', 'document.cookie', 'secret.value', 'secretValue', 'privateKey', 'accessToken']) expect(script).not.toContain(forbidden);
  });

  it('exposes the settings page through the registry, the loader dispatch, and the palette', () => {
    const settings = DASHBOARD_PAGES.find((page) => page.id === 'settings');
    expect(settings?.route).toBe('/dashboard/settings');
    expect(settings?.nav).toBe(true);
    expect(settings?.palette).toBe(true);
    expect(script).toContain('loadSettings()');
    expect(script).toContain('settings: loadSettings');
    expect(script).toContain('palettePageCommands()');
    for (const contract of ["api('/settings')", "api('/settings/network-check'", 'id="settings-network-profile"', 'id="settings-status"']) expect(script).toContain(contract);
  });

  it('offers only the contract network profiles and drops the retired networkMode markup', () => {
    expect(html).toContain('<label for="open-network-profile">Network profile (optional)</label>');
    expect(html).toContain('<select id="open-network-profile" name="networkProfile">');
    expect(html).toContain('<option value="dependency-access" selected>');
    expect(html).toContain('<option value="network-none">');
    expect(html).not.toContain('networkMode');
    expect(html).not.toContain('open-network-mode');
    // The retired field must not survive anywhere the browser can send or render it.
    expect(asset('dashboard-render.js')).not.toContain('networkMode');
    expect(asset('dashboard-render.js')).toContain('networkLabel(workspace.networkProfile)');
  });

  it('keeps the server version in the persistent sidebar rail', () => {
    expect(html).toContain('class="sidebar-version"');
    expect(html).toContain('__CH_VERSION__');
    expect(html).toContain('<span class="sr-only">Server version</span>');
    expect(css).toContain('.sidebar-version');
    expect(css).toContain('.app-shell.nav-collapsed .sidebar-version');
  });

  it('exposes a bounded keyboard command palette without a second search landmark', () => {
    expect(html).toContain('<dialog id="command-palette"');
    expect(html).toContain('id="palette-input"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-controls="palette-results"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('id="palette-results"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('id="palette-status"');
    expect(html).toContain('id="open-palette"');
    expect(html).toContain('aria-keyshortcuts="Meta+K Control+K"');
    expect(html).toContain('class="palette-note"');
    // The workspaces toolbar already owns the page's single search landmark.
    expect((html.match(/role="search"/g) ?? [])).toHaveLength(1);
    const paletteStart = html.indexOf('<dialog id="command-palette"');
    const palette = html.slice(paletteStart, html.indexOf('</dialog>', paletteStart));
    expect(palette).not.toContain('<form');
    expect(palette).toContain('Results cover the first page');
    expect(script).toContain('isPaletteHotkey');
    expect(script).toContain('buildPaletteIndex');
    expect(script).toContain('rankPaletteMatches');
  });

  it('keeps API keys transient while exposing create, list, and generation-fenced revoke controls', () => {
    for (const text of [
      'id="api-key-reveal-dialog"', 'This is the only time the complete key will be shown',
      'full MCP access', 'arbitrary command execution', 'I have saved it'
    ]) expect(html).toContain(text);
    for (const contract of [
      "api('/api-keys')", "api('/api-keys', { method: 'POST'", '`/api-keys/${',
      "method: 'DELETE'", 'expiresInDays', 'expectedGeneration', 'apiKeyReveal.clear()'
    ]) expect(script).toContain(contract);
    // No client-side tracking, and no persistence of a transient key. The word
    // "analytics" itself is allowed: the Analytics section is a dashboard surface, not a
    // tracking call, so the guard checks the call shapes instead of the word.
    for (const forbidden of ['localStorage', 'sessionStorage', 'document.cookie', 'console.', 'sendBeacon(', 'gtag(', 'posthog', 'plausible(', 'mixpanel']) expect(script).not.toContain(forbidden);
    expect(html).not.toContain('value="chm_key_');
  });

  it('keeps the navigation rail fixed and internally scrollable with a global footer', () => {
    expect(squishedCss).toContain(squish('.sidebar { position: sticky; inset-block-start: 3.5rem; height: calc(100dvh - 3.5rem); overflow: hidden;'));
    expect(squishedCss).toContain(squish('.sidebar nav { display: grid; gap: var(--space-1); align-content: start; flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }'));
    expect(css).toContain('.site-footer');
    expect(css).toContain('.profile-chip:hover');
    // An author display rule beats the UA [hidden] rule, so the shell's hiding of
    // the workspaces toolbar and conditional form rows needs an explicit rule.
    expect(squishedCss).toContain(squish('.command-surface[hidden], .form-row[hidden] { display: none; }'));
    expect(html).toContain('<footer class="site-footer">');
    expect(html).toContain('Made with ❤️ by <a href="https://agentkit.best"');
    expect(html).toContain('>AgentKit</a>');
  });

  it('routes the header identity to the profile page and keeps sign out as an icon control', () => {
    expect(html).toContain('<a class="profile-chip" id="profile-chip" href="/dashboard/profile" aria-label="Open profile">');
    expect(html).toContain('<a class="icon-btn signout" id="signout" href="/cdn-cgi/access/logout" aria-label="Sign out" title="Sign out">');
    expect(html).not.toContain('>Sign out</a>');
    expect(html).toContain('id="profile-name"');
    expect(script).toContain('profileDisplayName');
    expect(script).toContain('dismissOnBackdrop');
  });

  it('lets an operator edit the display name from the profile page', () => {
    expect(script).toContain('id="profile-name-form"');
    expect(script).toContain('profileDisplayName(data)');
    expect(script).toContain("method: 'PUT', body: requestBody({ displayName: value })");
  });

  it('provides a top header with profile, theme control, sign out, an icon collapse, and server status', () => {
    expect(html).toContain('<header class="topbar">');
    expect(html).toContain('href="/cdn-cgi/access/logout"');
    for (const theme of ['data-theme-value="system"', 'data-theme-value="light"', 'data-theme-value="dark"']) expect(html).toContain(theme);
    const themeStart = html.indexOf('<button id="theme-toggle"');
    expect(themeStart, 'a single icon theme control exists').toBeGreaterThan(-1);
    const themeButton = html.slice(themeStart, html.indexOf('</button>', themeStart));
    expect(themeButton).toContain('class="icon-btn theme-toggle"');
    expect(themeButton).toContain('aria-label="Theme: system.');
    // A three-state cycler must not advertise a two-state pressed condition.
    expect(themeButton).not.toContain('aria-pressed');
    expect(html).not.toContain('class="theme-control"');
    expect(html).not.toContain('class="theme-opt"');
    expect(css).not.toContain('theme-opt');
    expect(html).toContain('id="profile-name"');
    expect(html).toContain('id="nav-toggle"');
    expect(html).not.toContain('>Collapse navigation</button>');
    expect(script).toContain("api('/server')");
    expect(script).toContain("api('/preferences'");
    expect(script).toContain("classList.toggle('nav-collapsed')");
    expect(css).toContain('.app-shell.nav-collapsed');
  });
});

describe('dashboard secret-name policy parity', () => {
  it('mirrors the reserved-name policy exactly so the browser cannot drift from the server', () => {
    expect([...FORBIDDEN_CLIENT_NAMES].sort()).toEqual(Object.keys(FORBIDDEN_SECRET_NAMES).sort());
    expect([...FORBIDDEN_CLIENT_PREFIXES].sort()).toEqual([...FORBIDDEN_SECRET_PREFIXES].sort());
  });

  it('accepts GitHub credential names in the form instead of rejecting them as reserved', () => {
    for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
      expect(validateSecretClient(name, 'ghp_example_value'), name).toBeNull();
      expect(validateSecretName(name).ok, name).toBe(true);
    }
  });

  it('still rejects control-plane and toolchain names', () => {
    for (const name of ['RUNNER_TOKEN', 'PATH', 'GITHUB_APP_PRIVATE_KEY', 'CLOUDFLARE_API_TOKEN']) {
      expect(validateSecretClient(name, 'ghp_example_value'), name).not.toBeNull();
      expect(validateSecretName(name).ok, name).toBe(false);
    }
  });
});
