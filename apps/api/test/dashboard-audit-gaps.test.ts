import { describe, expect, it } from 'vitest';
import { buildActivityProjection } from '../src/dashboard-response.js';
import {
  renderAgentsIndex, renderOverview, renderWorkspaceIndex
} from '../dashboard/dashboard-render.js';

const workspaceId = `ws_${'a'.repeat(24)}`;
const otherWorkspaceId = `ws_${'c'.repeat(24)}`;
const agent = (overrides: Record<string, unknown> = {}) => ({
  agentId: `agent_${'b'.repeat(24)}`,
  workspaceId,
  profileId: 'coding-fast',
  status: 'RUNNING',
  startedAt: '2026-08-17T00:00:00.000Z',
  ...overrides
});

describe('the gaps the second audit found', () => {
  it('offers every agent filter the issue enumerates, not only status and workspace', () => {
    const markup = renderAgentsIndex({
      agents: [],
      filters: { status: 'FAILED', profileId: 'coding-fast', parentAgentId: `agent_${'c'.repeat(24)}`, attention: 'needs-attention' }
    });
    expect(markup).toContain('name="status"');
    expect(markup).toContain('name="workspaceId"');
    expect(markup).toContain('name="profileId"');
    expect(markup).toContain('name="parentAgentId"');
    expect(markup).toContain('name="attention"');
    // The values are reflected, so a shared URL reopens the same filtered view.
    expect(markup).toContain('value="coding-fast"');
    expect(markup).toContain('value="needs-attention" selected');
  });

  it('links every Overview tile into a filtered view rather than a bare page', () => {
    const markup = renderOverview({ overview: { attention: [], running: {}, cost: {}, expiring: [] } });
    expect(markup).toContain('/dashboard/agents?attention=needs-attention');
    expect(markup).toContain('/dashboard/agents?status=RUNNING');
    expect(markup).toContain('/dashboard/workspaces?expiring=60');
    expect(markup).not.toContain('href="/dashboard/agents"');
    expect(markup).not.toContain('href="/dashboard/workspaces"');
  });

  it('filters the workspace list by an expiry budget', () => {
    const base = {
      workspaceId,
      repositoryUrl: 'https://github.com/example/expiring-soon-repo.git',
      status: 'ACTIVE',
      lastActivityAt: new Date().toISOString()
    };
    const soon = { ...base, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
    const later = {
      ...base,
      workspaceId: otherWorkspaceId,
      repositoryUrl: 'https://github.com/example/far-away-repo.git',
      expiresAt: new Date(Date.now() + 300 * 60_000).toISOString()
    };
    const markup = renderWorkspaceIndex([soon, later], { q: '', status: '', expiring: '60' });
    expect(markup).toContain('expiring-soon-repo');
    expect(markup).not.toContain('far-away-repo');
    expect(markup).toContain('1 workspaces');
    // Without the budget both rows stay visible.
    expect(renderWorkspaceIndex([soon, later], { q: '', status: '' })).toContain('far-away-repo');
  });

  it('scopes activity to one workspace across both sources', () => {
    const events = [
      { id: 'a', action: 'workspace_open', subjectType: 'workspace', subjectId: workspaceId, createdAt: '2026-08-17T00:00:00.000Z' },
      { id: 'b', action: 'workspace_open', subjectType: 'workspace', subjectId: otherWorkspaceId, createdAt: '2026-08-17T00:01:00.000Z' }
    ];
    const agents = [agent(), agent({ agentId: `agent_${'d'.repeat(24)}`, workspaceId: otherWorkspaceId })];
    const scoped = buildActivityProjection({ events, agents, workspaceId }) as { events: Record<string, unknown>[] };
    // One retained audit row for this workspace plus one live agent row.
    expect(scoped.events).toHaveLength(2);
    expect(JSON.stringify(scoped)).not.toContain(otherWorkspaceId);
    // Unscoped, both workspaces are represented.
    const all = buildActivityProjection({ events, agents }) as { events: Record<string, unknown>[] };
    expect(all.events).toHaveLength(4);
  });
});
