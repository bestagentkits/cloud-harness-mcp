import { describe, expect, it } from 'vitest';
import { mapDashboardData } from '../src/dashboard-response.js';

const listing = {
  repositories: [{ fullName: 'acme/api', owner: 'acme', name: 'api', repositoryUrl: 'https://github.com/acme/api.git', access: 'write', via: 'installation' }],
  accounts: [{ login: 'acme', type: 'Organization', via: 'installation', installationId: '456', repositoryCount: 1, live: true }],
  unreachableAccounts: [{ login: 'globex', type: 'Organization', installation: 'unknown', installUrl: 'https://github.com/apps/cloud-harness/installations/new' }],
  userAuthorization: 'connected',
  listedAt: '2026-11-27T00:00:00.000Z',
  synced: true,
  incomplete: false,
  warnings: []
};

describe('dashboard GitHub repository listing projection', () => {
  it('passes a well-formed listing through unchanged', () => {
    expect(mapDashboardData('github_repository_list', listing)).toEqual(listing);
  });

  it('keeps a repository with the longest owner and name GitHub allows', () => {
    const owner = 'o'.repeat(39);
    const name = 'n'.repeat(100);
    const longest = { ...listing.repositories[0], fullName: `${owner}/${name}`, owner, name, repositoryUrl: `https://github.com/${owner}/${name}.git` };
    const withLongest = { ...listing, repositories: [...listing.repositories, longest] };
    expect(mapDashboardData('github_repository_list', withLongest)).toEqual(withLongest);
  });

  it('keeps a repository owned by an Enterprise Managed User login', () => {
    const managed = { ...listing.repositories[0], fullName: 'developer_company/project', owner: 'developer_company', name: 'project', repositoryUrl: 'https://github.com/developer_company/project.git' };
    const withManaged = { ...listing, repositories: [...listing.repositories, managed] };
    expect(mapDashboardData('github_repository_list', withManaged)).toEqual(withManaged);
  });

  it('replaces a listing carrying an unexpected value shape instead of forwarding it', () => {
    const marker = { token: 'ghu_marker_should_never_reach_the_browser' };
    for (const tampered of [
      { ...listing, userAuthorization: marker },
      { ...listing, repositories: [{ ...listing.repositories[0], name: marker }] },
      { ...listing, extra: marker },
      { ...listing, repositories: [{ ...listing.repositories[0], repositoryUrl: 'https://ghu_marker@github.com/acme/api.git' }] },
      { ...listing, unreachableAccounts: [{ login: 'globex', type: 'Organization', installation: 'unknown', installUrl: 'https://github.com/apps/cloud-harness/installations/new?ghu_marker=1' }] },
      { ...listing, unreachableAccounts: [{ login: 'globex', type: 'Organization', installation: 'unknown', installUrl: 'https://evil.example/ghu_marker' }] }
    ]) {
      const projected = mapDashboardData('github_repository_list', tampered);
      expect(JSON.stringify(projected)).not.toContain('ghu_marker');
      expect(projected).toMatchObject({ repositories: [], incomplete: true });
    }
  });
});
