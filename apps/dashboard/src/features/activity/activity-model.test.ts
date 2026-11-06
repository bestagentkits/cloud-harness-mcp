import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_FILTER_IDS, activityEvents, activityLink, countByCategory, fieldText, filterEvents, grantIsActionable,
  pendingGrantCount, pendingPlanCount, planIsActionable
} from './activity-model';

const AGENT_ID = `agent_${'a'.repeat(24)}`;
const WORKSPACE_ID = `ws_${'b'.repeat(24)}`;

describe('activity filters', () => {
  it('offers every category the classic page offers, in order', () => {
    expect(ACTIVITY_FILTER_IDS).toEqual(['all', 'agents', 'tasks', 'mcp', 'deployments', 'audit']);
  });

  it('filters by category and counts each one', () => {
    const events = [{ category: 'agents' }, { category: 'audit', durable: true }, { category: 'agents' }, { category: 'unknown' }];
    expect(filterEvents(events, 'agents')).toHaveLength(2);
    expect(filterEvents(events, 'all')).toHaveLength(4);
    expect(filterEvents(events, 'mcp')).toEqual([]);
    expect(countByCategory(events)).toEqual({ all: 4, agents: 2, tasks: 0, mcp: 0, deployments: 0, audit: 1 });
  });

  it('reads only record events from an untrusted body', () => {
    expect(activityEvents({ data: { events: [{ summary: 'one' }, null, 'two', 3] } })).toEqual([{ summary: 'one' }]);
    expect(activityEvents({ data: {} })).toEqual([]);
    expect(activityEvents(undefined)).toEqual([]);
  });
});

describe('activityLink', () => {
  it('maps the projection agent href to the in-app agent route', () => {
    expect(activityLink(`/dashboard/agents/${AGENT_ID}`)).toEqual({ to: '/agents/$agentId', params: { agentId: AGENT_ID } });
    expect(activityLink(`/dashboard/workspaces/${WORKSPACE_ID}`)).toEqual({ to: '/workspaces/$workspaceId', params: { workspaceId: WORKSPACE_ID } });
  });

  it('refuses any other href', () => {
    for (const href of [
      'javascript:alert(1)', 'https://evil.example/dashboard/agents/' + AGENT_ID, '//evil.example/x',
      '/dashboard/agents/agent_1', `/dashboard/agents/${AGENT_ID}/../../settings`, `/dashboard/agents/${AGENT_ID}?x=1`,
      `/dashboard/settings`, `/dashboard/agents/%E0%A4%A`, `/dashboard/agents/${encodeURIComponent('<img src=x>')}`,
      `/api/agents/${AGENT_ID}`, '', undefined, 42, { href: '/dashboard/agents' }
    ]) expect(activityLink(href)).toBeUndefined();
  });
});

describe('pending approvals count', () => {
  const now = Date.parse('2026-10-20T00:00:00.000Z');
  it('counts only unexpired pending grants and plans, as the classic badge does', () => {
    const grants = { data: { grants: [
      { status: 'PENDING', expiresAt: '2099-01-01T00:00:00.000Z' },
      { status: 'pending' },
      { status: 'PENDING', expiresAt: '2020-01-01T00:00:00.000Z' },
      { status: 'APPROVED' }
    ] } };
    const plans = { data: { enabled: true, plans: [{ status: 'PENDING_APPROVAL' }, { status: 'APPROVED' }, { status: 'PENDING_APPROVAL', expiresAt: '2020-01-01T00:00:00.000Z' }] } };
    expect(pendingGrantCount(grants, now)).toBe(2);
    expect(pendingPlanCount(plans, now)).toBe(1);
    expect(pendingGrantCount({ data: {} }, now)).toBe(0);
    expect(grantIsActionable(undefined, now)).toBe(false);
    expect(planIsActionable({ status: 'pending_approval' }, now)).toBe(false);
  });
});

describe('fieldText', () => {
  it('renders strings and numbers and falls back for anything else', () => {
    expect(fieldText('x', '-')).toBe('x');
    expect(fieldText(3, '-')).toBe('3');
    expect(fieldText('  ', '-')).toBe('-');
    expect(fieldText({ toString: () => 'x' }, '-')).toBe('-');
    expect(fieldText(Number.NaN, '-')).toBe('-');
  });
});
