import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_FILTERS, activityEvent, renderActivityCenter, renderApprovals
} from '../dashboard/dashboard-render.js';

const grant = (overrides: Record<string, unknown> = {}) => ({
  id: `grant_${'a'.repeat(24)}`,
  workspaceId: `ws_${'b'.repeat(24)}`,
  command: 'npm run migrate',
  cwd: '.',
  commandSha256: 'c'.repeat(64),
  status: 'pending',
  createdAt: '2026-08-17T00:00:00.000Z',
  expiresAt: '2026-08-17T01:00:00.000Z',
  ...overrides
});

describe('activity center', () => {
  it('offers every filter the issue names', () => {
    expect(ACTIVITY_FILTERS.map((filter) => filter.id)).toEqual(['all', 'agents', 'tasks', 'mcp', 'deployments', 'audit']);
  });

  it('labels durable audit rows apart from live runtime rows', () => {
    const markup = renderActivityCenter({
      events: [
        activityEvent({ at: '2026-08-17T00:00:00.000Z', category: 'audit', status: 'recorded', actor: 'workspace ws_1', summary: 'workspace_open', durable: true }),
        activityEvent({ at: '2026-08-17T00:01:00.000Z', category: 'agents', status: 'running', actor: 'ws_2', summary: 'Agent agent_1 running', href: '/dashboard/agents/agent_1' })
      ]
    });
    expect(markup).toContain('Retained audit');
    expect(markup).toContain('Live runtime');
    expect(markup).toContain('workspace_open');
    expect(markup).toContain('href="/dashboard/agents/agent_1"');
    expect(markup).toContain('never confused');
  });

  it('marks the active filter and counts each category', () => {
    const markup = renderActivityCenter({
      filter: 'agents',
      events: [
        activityEvent({ category: 'agents', status: 'running', summary: 'agent-event-one' }),
        activityEvent({ category: 'audit', status: 'recorded', summary: 'audit-event-two', durable: true })
      ]
    });
    expect(markup).toContain('href="/dashboard/activity?filter=agents" aria-current="page"');
    expect(markup).toContain('Agents (1)');
    // A filtered view shows only its category.
    expect(markup).toContain('agent-event-one');
    expect(markup).not.toContain('audit-event-two');
  });

  it('explains an empty view instead of showing nothing', () => {
    expect(renderActivityCenter({ events: [], filter: 'mcp' })).toContain('No events in this view yet.');
  });
});

describe('approvals inbox', () => {
  it('shows the context, capability and decisions for a pending grant', () => {
    const markup = renderApprovals({ grants: [grant()] });
    expect(markup).toContain('npm run migrate');
    expect(markup).toContain(`ws_${'b'.repeat(24)}`);
    expect(markup).toContain('Pending');
    expect(markup).toContain('c'.repeat(64));
    expect(markup).toContain('class="accent-btn approve-grant"');
    expect(markup).toContain('class="danger reject-grant"');
    expect(markup).toContain('Both decisions are audited');
  });

  it('states the empty inbox and its meaning', () => {
    const markup = renderApprovals({ grants: [] });
    expect(markup).toContain('No approvals are waiting.');
    expect(markup).toContain('leave once you decide');
  });

  it('degrades a missing field to Not reported instead of a blank', () => {
    const markup = renderApprovals({ grants: [grant({ commandSha256: undefined, cwd: undefined, expiresAt: undefined })] });
    expect(markup).toContain('Not reported');
  });
});
