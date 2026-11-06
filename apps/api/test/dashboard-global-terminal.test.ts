import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { navGroups } from '../dashboard/dashboard-pages.js';
import { renderTerminalPanel } from '../dashboard/dashboard-render.js';

const shell = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../dashboard/dashboard.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../dashboard/dashboard.css', import.meta.url), 'utf8');

describe('universal workspace terminal dock', () => {
  it('exposes a keyboard-accessible launcher and a dock outside route-owned content', () => {
    expect(shell).toContain('id="global-terminal-toggle"');
    expect(shell).toContain('aria-controls="global-terminal-dock"');
    expect(shell).toContain('id="global-terminal-workspace"');
    expect(shell).toContain('id="global-terminal-detach"');
    expect(shell.indexOf('id="global-terminal-dock"')).toBeGreaterThan(shell.indexOf('id="content"'));
    expect(shell).toContain('id="global-terminal-panes"');
  });

  it('keeps the global dock independent of page loading and does not expose a host target', () => {
    expect(dashboard).toContain('const dockSessions = new Map()');
    expect(dashboard).toContain('function hideDock()');
    expect(dashboard).toContain('entry.pane?.dispose()');
    expect(dashboard).toContain('renderTerminalPanel({ workspaceId, terminals, idPrefix })');
    expect(dashboard).toContain('mountTerminalPane({');
    expect(dashboard).toContain('nextDockTab');
    expect(dashboard).toContain('dockSessions.set(tabId');
    expect(dashboard).toContain('const persistentApi');
    expect(styles).toContain('.global-terminal-dock[hidden] { display: none; }');
    expect(shell).not.toContain('option value="host"');
  });

  it('uses unique IDs for each concurrent terminal pane', () => {
    const first = renderTerminalPanel({ idPrefix: 'dock-1-' });
    const second = renderTerminalPanel({ idPrefix: 'dock-2-' });
    expect(first).toContain('id="dock-1-terminal-panel"');
    expect(second).toContain('id="dock-2-terminal-panel"');
    expect(first).toContain('aria-labelledby="dock-1-terminal-heading"');
    expect(first).not.toContain('id="terminal-panel"');
  });

  it('makes Terminals visible in the operator navigation', () => {
    const operate = navGroups().find((group) => group.id === 'operate');
    expect(operate?.pages.some((page) => page.id === 'terminals' && page.nav)).toBe(true);
  });
});
