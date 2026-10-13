import { describe, expect, it } from 'vitest';
import { GITHUB_READ_ACTIONS, GITHUB_WRITE_ACTIONS, TOOL_SCHEMA_BY_NAME, TOOL_SPECS, WorkspaceCapabilityResultSchema } from '../src/index.js';

const workspaceId = `ws_${'a'.repeat(24)}`;

describe('repository history contracts', () => {
  it('annotates github_read as read-only so clients need not prompt for approval', () => {
    const spec = TOOL_SPECS.find((tool) => tool.name === 'github_read');
    expect(spec).toMatchObject({ readOnly: true, destructive: false, idempotent: true, openWorld: true });
    expect(TOOL_SPECS.find((tool) => tool.name === 'github_action')?.destructive).toBe(true);
  });

  it('classifies every GitHub action exactly once as read-only or gated', () => {
    const all = [...GITHUB_READ_ACTIONS, ...GITHUB_WRITE_ACTIONS];
    expect(new Set(all).size).toBe(all.length);
    expect(GITHUB_READ_ACTIONS).toEqual(expect.arrayContaining(['pr_list', 'pr_view', 'issue_list', 'issue_view', 'commit_list', 'compare']));
  });

  it('accepts read actions on github_read and refuses mutating actions', () => {
    const read = TOOL_SCHEMA_BY_NAME.github_read;
    expect(read.parse({ workspaceId, action: 'commit_list', since: '2026-08-24', path: 'apps/api' })).toMatchObject({ action: 'commit_list', limit: 30 });
    expect(read.parse({ workspaceId, action: 'compare', base: 'v1.0.0', head: 'main' })).toMatchObject({ limit: 100 });
    expect(read.parse({ workspaceId, action: 'pr_list' })).toMatchObject({ limit: 20, state: 'open' });
    expect(() => read.parse({ workspaceId, action: 'pr_create', title: 'x', head: 'y' })).toThrow();
    expect(() => read.parse({ workspaceId, action: 'issue_comment', issueNumber: 1, body: 'x' })).toThrow();
  });

  it('refuses compare revisions that carry range syntax, traversal, or option-like values', () => {
    const read = TOOL_SCHEMA_BY_NAME.github_read;
    for (const bad of ['main..dev', '../main', '-x', 'a b', 'main?x=1']) {
      expect(() => read.parse({ workspaceId, action: 'compare', base: bad, head: 'main' })).toThrow();
    }
    expect(() => read.parse({ workspaceId, action: 'commit_list', since: 'last week' })).toThrow();
  });

  it('keeps the new history actions available on github_action', () => {
    expect(TOOL_SCHEMA_BY_NAME.github_action.parse({ workspaceId, action: 'compare', base: 'main', head: 'feature/x' })).toMatchObject({ action: 'compare' });
    expect(TOOL_SCHEMA_BY_NAME.github_action.parse({ workspaceId, action: 'tag_list' })).toMatchObject({ limit: 30 });
  });

  it('accepts one workspace_open history option at a time', () => {
    const open = TOOL_SCHEMA_BY_NAME.workspace_open;
    const base = { repositoryUrl: 'https://github.com/owner/repo', idempotencyKey: 'open-history-1' };
    expect(open.parse({ ...base, fetchDepth: 0 })).toMatchObject({ fetchDepth: 0 });
    expect(open.parse({ ...base, shallowSince: '2026-08-24' })).toMatchObject({ shallowSince: '2026-08-24' });
    expect(() => open.parse({ ...base, fetchDepth: 10, shallowSince: '2026-08-24' })).toThrow();
    expect(() => open.parse({ ...base, fetchDepth: -1 })).toThrow();
  });

  it('accepts at most one git_fetch history option', () => {
    const fetch = TOOL_SCHEMA_BY_NAME.git_fetch;
    expect(fetch.parse({ workspaceId, unshallow: true })).toMatchObject({ unshallow: true });
    expect(fetch.parse({ workspaceId, depth: 200 })).toMatchObject({ depth: 200 });
    expect(() => fetch.parse({ workspaceId, depth: 0 })).toThrow();
    expect(() => fetch.parse({ workspaceId, depth: 10, unshallow: true })).toThrow();
  });

  it('carries the read-only classification in workspace capabilities', () => {
    const parsed = WorkspaceCapabilityResultSchema.parse({
      workspaceId,
      repository: 'owner/repo',
      repositoryUrl: 'https://github.com/owner/repo',
      capabilities: {
        repository: { read: true, push: false, issuesRead: true, issuesWrite: false, pullRequestsRead: true, pullRequestsWrite: false },
        workspace: { shell: true, tasks: true, sessions: true, deployments: true, privileged: false, networkProfile: 'network-none' }
      },
      permissions: { contents: { read: true, write: false }, issues: { read: true, write: false }, pullRequests: { read: true, write: false } },
      operations: {
        gitFetch: true, gitPull: true, gitPush: false, issueList: true, issueView: true, issueCreate: false, issueComment: false,
        issueUpdate: false, issuePublish: false, labelCreate: false, pullRequestList: true, pullRequestView: true, pullRequestCreate: false,
        commitList: true, compare: true, releaseList: true, tagList: true, execRun: true, privilegedExec: false, deploymentsRun: true
      },
      githubActions: { readOnlyTool: 'github_read', readOnly: [...GITHUB_READ_ACTIONS], gated: [...GITHUB_WRITE_ACTIONS] }
    });
    expect(parsed.githubActions?.readOnlyTool).toBe('github_read');
    expect(parsed.operations.commitList).toBe(true);
  });
});
