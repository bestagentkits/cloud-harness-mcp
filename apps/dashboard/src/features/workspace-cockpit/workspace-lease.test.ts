import { describe, expect, it } from 'vitest';
import { unavailableDetail, workspaceAttention, workspaceLeaseState } from './workspace-lease';

const NOW = Date.parse('2026-10-20T10:00:00Z');

describe('workspace lease posture', () => {
  it('reads unknown, expired, soon and ok from expiresAt', () => {
    expect(workspaceLeaseState({ workspaceId: 'ws' }, NOW).state).toBe('unknown');
    expect(workspaceLeaseState({ workspaceId: 'ws', expiresAt: '2026-10-20T09:59:00Z' }, NOW).state).toBe('expired');
    expect(workspaceLeaseState({ workspaceId: 'ws', expiresAt: '2026-10-20T10:05:00Z' }, NOW)).toEqual({ state: 'soon', label: '5 min left' });
    expect(workspaceLeaseState({ workspaceId: 'ws', expiresAt: '2026-10-20T13:00:00Z' }, NOW)).toEqual({ state: 'ok', label: '3 h left' });
  });

  it('lists only observable attention reasons', () => {
    expect(workspaceAttention({ workspaceId: 'ws', status: 'ACTIVE', expiresAt: '2026-10-20T13:00:00Z' }, NOW)).toEqual([]);
    const ids = workspaceAttention({ workspaceId: 'ws', status: 'NETWORK_QUARANTINED', expiresAt: '2026-10-20T10:01:00Z' }, NOW).map((item) => item.id);
    expect(ids).toEqual(['lease-soon', 'quarantine']);
  });

  it('explains why a live tab is unavailable per state', () => {
    expect(unavailableDetail('CLOSED')).toMatch(/closed/);
    expect(unavailableDetail('CREATING')).toMatch(/not active yet/);
  });
});
