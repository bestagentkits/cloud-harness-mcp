import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const asset = (name: string) => readFileSync(new URL(`../dashboard/${name}`, import.meta.url), 'utf8');

describe('dashboard static UI contract', () => {
  const html = asset('index.html');
  const css = asset('dashboard.css');
  const script = `${asset('dashboard.js')}\n${asset('dashboard-api.js')}\n${asset('dashboard-render.js')}`;

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

  it('uses tokenized responsive styling with reduced-motion and narrow-screen rules', () => {
    for (const token of ['--canvas:', '--surface:', '--ink:', '--accent:', '--space-4:', '--motion-state:']) expect(css).toContain(token);
    expect(css).toContain('@media (max-width: 47.9375rem)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('min-height: 2.75rem');
    expect(css).toContain('.drawer-close { display: block; margin-inline-start: auto; margin-block-end: var(--space-4); }');
    expect(css).not.toContain('.drawer-close { float:');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toContain('gradient(');
  });

  it('backs files and runtime with bounded APIs and exposes no execution surface', () => {
    for (const operation of ['/files/content', '/files/move', '/files/directory', '/runtime', '/close']) expect(script).toContain(operation);
    for (const forbidden of ['exec_run', 'shell_open', 'deployments_run', 'runnerToken', 'cf-access-jwt-assertion', 'ownerId', 'containerName', 'workspacePath']) expect(script).not.toContain(forbidden);
    expect(script).toContain('This item changed after you opened it.');
    expect(script).toContain('No current tasks.');
    expect(script).toContain('No named sessions.');
  });

  it('exposes accessible metadata navigation and only existing dashboard BFF controls', () => {
    for (const [path, label] of [
      ['/dashboard/overview', 'Overview'], ['/dashboard', 'Workspaces'], ['/dashboard/projects', 'Projects'],
      ['/dashboard/secrets', 'Secrets'], ['/dashboard/models', 'Models'], ['/dashboard/artifacts', 'Artifacts'],
      ['/dashboard/audit', 'Audit'], ['/dashboard/api-keys', 'API keys'], ['/dashboard/github', 'GitHub'],
      ['/dashboard/profile', 'Profile']
    ]) {
      expect(html).toContain(`href="${path}"`);
      expect(html).toContain(`>${label}</a>`);
    }
    for (const endpoint of [
      "api('/projects')", "api('/secrets')", "api('/artifacts',", '`/audit?limit=50', "api('/github')", "api('/profile')",
      "'/github/setup'", "'/github/complete'", "'/github/reconcile'", "'/github/disconnect'", '`/environments/${'
    ]) expect(script).toContain(endpoint);
    expect(script).toContain('expectedGeneration');
    expect(script).toContain('retentionSeconds');
    expect(script).toContain('Write-only');
    for (const forbidden of ['sessionStorage', 'document.cookie', 'secret.value', 'secretValue', 'privateKey', 'accessToken']) expect(script).not.toContain(forbidden);
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
    for (const forbidden of ['localStorage', 'sessionStorage', 'document.cookie', 'console.', 'sendBeacon(', 'analytics']) expect(script).not.toContain(forbidden);
    expect(html).not.toContain('value="chm_key_');
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
