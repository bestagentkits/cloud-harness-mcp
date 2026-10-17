import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_FILTERS, activityEvent, renderActivityCenter, renderApprovals, grantIsActionable
} from '../dashboard/dashboard-render.js';

const grant = (overrides: Record<string, unknown> = {}) => ({
  id: `grant_${'a'.repeat(24)}`,
  workspaceId: `ws_${'b'.repeat(24)}`,
  command: 'npm run migrate',
  cwd: '.',
  commandSha256: 'c'.repeat(64),
  status: 'PENDING',
  createdAt: '2026-08-17T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
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
    expect(markup).toContain('stay listed briefly, without actions');
  });

  it('offers decisions only for an unexpired pending grant and labels every other state truthfully', () => {
    const now = Date.parse('2026-10-13T08:00:00.000Z');
    const future = '2026-10-13T08:01:00.000Z';
    const past = '2026-10-13T07:59:00.000Z';
    const cases = [
      { status: 'APPROVED', expiresAt: future, label: 'Approved', tone: 'approved' },
      { status: 'REJECTED', expiresAt: future, label: 'Rejected', tone: 'rejected' },
      { status: 'CONSUMED', expiresAt: future, label: 'Used', tone: 'consumed' },
      { status: 'EXPIRED', expiresAt: past, label: 'Expired', tone: 'expired' },
      { status: 'PENDING', expiresAt: past, label: 'Expired', tone: 'expired' }
    ];
    for (const { status, expiresAt, label, tone } of cases) {
      const markup = renderApprovals({ grants: [grant({ status, expiresAt })], now });
      expect(markup).toContain(`<span class="status ${tone}">${label}</span>`);
      expect(markup).not.toContain('approve-grant');
      expect(markup).not.toContain('reject-grant');
      expect(grantIsActionable({ status, expiresAt }, now)).toBe(false);
    }
    const pending = renderApprovals({ grants: [grant({ status: 'PENDING', expiresAt: future })], now });
    expect(pending).toContain('<span class="status pending">Pending</span>');
    expect(pending).toContain('approve-grant');
    expect(grantIsActionable({ status: 'PENDING', expiresAt: future }, now)).toBe(true);
  });

  it('degrades a missing field to Not reported instead of a blank', () => {
    const markup = renderApprovals({ grants: [grant({ commandSha256: undefined, cwd: undefined, expiresAt: undefined })] });
    expect(markup).toContain('Not reported');
  });
});
