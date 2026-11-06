/** Realistic `GET /audit` pages (`audit_list` in `mapDashboardData`), newest first, with an opaque cursor. */
export const WORKSPACE_ID = `ws_${'b2'.repeat(12)}`;

function event(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `audit_${String(index).padStart(24, '0')}`,
    action: 'workspace_open',
    subjectType: 'workspace',
    subjectId: WORKSPACE_ID,
    subjectGeneration: 1,
    details: { repositoryHost: 'github.com', networkProfile: 'dependency-access' },
    createdAt: new Date(Date.parse('2026-10-20T10:00:00.000Z') - index * 60_000).toISOString(),
    ...overrides
  };
}

export const FIRST_CURSOR = 'c_page2.token-1';

export const AUDIT_PAGE_1 = {
  data: { events: [event(0, { action: 'privilege_grant_approve', subjectType: 'privilege_grant', subjectId: `grant_${'c'.repeat(24)}`, details: { command: '<script>alert(1)</script>' } }), event(1), event(2, { details: {} })] },
  cursor: FIRST_CURSOR
};

export const AUDIT_PAGE_2 = {
  data: { events: [event(50, { action: 'api_key_revoke', subjectType: 'api_key', subjectId: 'key_1', subjectGeneration: 3 })] }
};

export const EMPTY_AUDIT = { data: { events: [] } };
