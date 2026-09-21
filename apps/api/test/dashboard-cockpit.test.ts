import { describe, expect, it } from 'vitest';
import { DASHBOARD_SHELL_PATHS } from '../src/dashboard-assets.js';
import {
  WORKSPACE_TABS, renderFinalizeDialog, renderWorkspaceAttentionPanel, renderWorkspaceCockpitHeader,
  renderWorkspaceSummary, renderWorkspaceTabPlaceholder, renderWorkspaceTabs, workspaceAttention,
  workspaceLeaseState
} from '../dashboard/dashboard-render.js';
import { pageForPath } from '../dashboard/dashboard-pages.js';

const workspaceId = `ws_${'a'.repeat(24)}`;
const base = {
  workspaceId,
  repositoryUrl: 'https://github.com/example/project.git',
  ref: 'main',
  status: 'ACTIVE',
  networkProfile: 'dependency-access',
  createdAt: '2026-08-17T00:00:00.000Z',
  lastActivityAt: '2026-08-17T00:01:00.000Z',
  expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1_000).toISOString(),
  version: 7
};

describe('workspace cockpit', () => {
  it('carries the nine contextual sections in operator order', () => {
    expect(WORKSPACE_TABS.map((tab) => tab.id)).toEqual([
      'summary', 'agents', 'runtime', 'files', 'git', 'automation', 'deploy', 'artifacts', 'activity'
    ]);
    const tabs = renderWorkspaceTabs(workspaceId, 'git');
    expect(tabs).toContain(`href="/dashboard/workspaces/${workspaceId}/summary"`);
    expect(tabs).toContain(`href="/dashboard/workspaces/${workspaceId}/git" aria-current="page"`);
    expect((tabs.match(/aria-current="page"/g) ?? [])).toHaveLength(1);
  });

  it('serves every tab as a shell route that the registry still resolves to workspaces', () => {
    for (const tab of WORKSPACE_TABS) {
      expect(DASHBOARD_SHELL_PATHS, tab.id).toContain(`/workspaces/:workspaceId/${tab.id}`);
      expect(pageForPath(`/dashboard/workspaces/${workspaceId}/${tab.id}`)?.id, tab.id).toBe('workspaces');
    }
  });

  it('states header posture and the lifecycle actions', () => {
    const header = renderWorkspaceCockpitHeader(base);
    expect(header).toContain('example/project');
    expect(header).toContain('id="renew-workspace-lease"');
    expect(header).toContain('data-dialog="finalize-workspace-dialog"');
    expect(header).toContain('id="recover-workspace"');
    expect(header).toContain('id="close-workspace"');
    expect(header).toContain('Dependency access');
    expect(header).toContain(`data-copy="${workspaceId}"`);
    expect(header).toContain('Nothing needs attention');
    // Closing needs a lifecycle generation; without one the control is disabled.
    expect(renderWorkspaceCockpitHeader({ ...base, version: undefined })).toContain('id="close-workspace" class="danger" type="button" disabled');
  });

  it('derives lease emphasis from thresholds rather than decoration', () => {
    const now = Date.parse('2026-08-17T00:00:00.000Z');
    expect(workspaceLeaseState({ expiresAt: '2026-08-17T00:00:00.000Z' }, now).state).toBe('expired');
    expect(workspaceLeaseState({ expiresAt: '2026-08-17T00:05:00.000Z' }, now)).toEqual({ state: 'soon', label: '5 min left' });
    expect(workspaceLeaseState({ expiresAt: '2026-08-17T04:00:00.000Z' }, now).state).toBe('ok');
    expect(workspaceLeaseState({ expiresAt: 'not-a-date' }, now).state).toBe('unknown');
  });

  it('lists only attention reasons the dashboard can observe', () => {
    const now = Date.parse('2026-08-17T00:00:00.000Z');
    const expired = workspaceAttention({ ...base, expiresAt: '2026-08-16T23:00:00.000Z' }, { now }).map((item) => item.id);
    expect(expired).toEqual(['lease-expired']);
    const soon = workspaceAttention({ ...base, expiresAt: '2026-08-17T00:05:00.000Z' }, { now }).map((item) => item.id);
    expect(soon).toEqual(['lease-soon']);
    const failed = workspaceAttention({ ...base, status: 'FAILED' }, { now }).map((item) => item.id);
    expect(failed).toEqual(['failed']);
    const quarantined = workspaceAttention({ ...base, status: 'NETWORK_QUARANTINED' }, { now }).map((item) => item.id);
    expect(quarantined).toEqual(['quarantine']);
    const dirty = workspaceAttention(base, { now, dirty: true }).map((item) => item.id);
    expect(dirty).toEqual(['dirty-git']);
    expect(workspaceAttention(base, { now })).toEqual([]);
    // Healthy workspace: the panel says so rather than rendering an empty list.
    expect(renderWorkspaceAttentionPanel(base, { now })).toContain('Nothing needs attention right now.');
  });

  it('reports only observable summary state and never invents a number', () => {
    const summary = renderWorkspaceSummary({
      workspace: base,
      context: { branch: 'feature/x', capabilities: { tasks: true, sessions: false }, manifest: { itemCount: 12, truncated: true } }
    });
    expect(summary).toContain('feature/x');
    expect(summary).toContain('12 attributable item(s) (truncated)');
    expect(summary).toContain('tasks');
    expect(summary).not.toContain('sessions,');
    expect(summary).toContain('Cost used');
    expect(summary).toContain('Not reported for workspaces yet');
    // A missing context response degrades to "Not reported" instead of zeroes.
    const degraded = renderWorkspaceSummary({ workspace: base });
    expect(degraded).toContain('Not reported');
    expect(degraded).not.toContain('0 attributable');
  });

  it('names the owning phase on tabs that have not shipped yet', () => {
    for (const [tab, phase] of [['agents', 'Agent Control Center'], ['git', 'Git and Finalize'], ['automation', 'Automation and Deploy'], ['deploy', 'Automation and Deploy'], ['activity', 'Activity Center']]) {
      const markup = renderWorkspaceTabPlaceholder(tab);
      expect(markup, tab).toContain(phase);
      expect(markup, tab).toContain('Files and Runtime');
    }
    expect(renderWorkspaceTabPlaceholder('artifacts')).toContain('a later workspace phase');
  });

  it('describes the finalize dialog before the operator runs it', () => {
    const dialog = renderFinalizeDialog();
    expect(dialog).toContain('id="finalize-workspace-dialog"');
    expect(dialog).toContain('id="finalize-commit-message"');
    expect(dialog).toContain('name="push" type="checkbox" checked');
    expect(dialog).toContain('data-dialog-close');
    expect(dialog).toContain('Stages the changes');
  });
});
