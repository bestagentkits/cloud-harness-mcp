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
      ['/dashboard/projects', 'Projects'], ['/dashboard/artifacts', 'Artifacts'],
      ['/dashboard/audit', 'Audit'], ['/dashboard/api-keys', 'API keys'], ['/dashboard/github', 'GitHub'],
      ['/dashboard/profile', 'Profile']
    ]) {
      expect(html).toContain(`href="${path}"`);
      expect(html).toContain(`>${label}</a>`);
    }
    for (const endpoint of [
      "api('/projects')", "api('/artifacts',", '`/audit?limit=50', "api('/github')",
      "'/github/setup'", "'/github/complete'", "'/github/reconcile'", '`/environments/${'
    ]) expect(script).toContain(endpoint);
    expect(script).toContain('expectedGeneration');
    expect(script).toContain('retentionSeconds');
    expect(script).toContain('Write-only');
    for (const forbidden of ['sessionStorage', 'document.cookie', 'secret.value', 'secretValue', 'privateKey', 'accessToken']) expect(script).not.toContain(forbidden);
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
});
