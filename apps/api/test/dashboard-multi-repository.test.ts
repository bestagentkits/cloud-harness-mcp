import { describe, expect, it } from 'vitest';
import { mapDashboardData } from '../src/dashboard-response.js';
import { renderWorkspaceDetail, renderWorkspaceIndex } from '../dashboard/dashboard-render.js';

const workspaceId = `ws_${'a'.repeat(24)}`;
const repositories = [
  { repositoryId: `repo_${'a'.repeat(32)}`, alias: 'api', repositoryUrl: 'https://github.com/acme/api.git', ref: null, access: 'read-write', primary: true, path: 'repos/api' },
  { repositoryId: `repo_${'b'.repeat(32)}`, alias: 'web', repositoryUrl: 'https://github.com/acme/web.git', ref: 'develop', access: 'read-only', primary: false, path: 'repos/web', internal: 'dropped' }
];
const workspace = {
  workspaceId, repositoryUrl: 'https://github.com/acme/api.git', status: 'ACTIVE', networkProfile: 'network-none',
  createdAt: '2026-10-17T00:00:00.000Z', lastActivityAt: '2026-10-17T00:00:00.000Z', expiresAt: '2026-10-17T02:00:00.000Z'
};

describe('multi-repository workspaces in the dashboard', () => {
  it('projects the repository registry with only its public fields', () => {
    const { workspaces } = mapDashboardData('workspace_list', { workspaces: [{ ...workspace, repositories }] }) as { workspaces: Array<{ repositories: Record<string, unknown>[] }> };
    expect(workspaces[0]!.repositories).toHaveLength(2);
    expect(workspaces[0]!.repositories[1]).not.toHaveProperty('internal');
    expect(workspaces[0]!.repositories[1]).toMatchObject({ alias: 'web', access: 'read-only', path: 'repos/web' });
    const single = mapDashboardData('workspace_status', workspace);
    expect(single).not.toHaveProperty('repositories');
  });

  it('shows the repository count, aliases, and access in the index and detail', () => {
    const index = renderWorkspaceIndex([{ ...workspace, repositories }], { q: 'web', status: '' });
    expect(index).toContain('acme/api');
    expect(index).toContain('2 repositories');
    const detail = renderWorkspaceDetail({ ...workspace, repositories });
    expect(detail).toContain('Repositories');
    expect(detail).toContain('repos/web');
    expect(detail).toContain('Read-only');
    expect(detail).toContain('@ develop');
  });

  it('keeps the single-repository rendering unchanged', () => {
    expect(renderWorkspaceIndex([workspace], { q: '', status: '' })).not.toContain('repositories</span>');
    expect(renderWorkspaceDetail(workspace)).not.toContain('<dt>Repositories</dt>');
  });
});
