import { describe, expect, it } from 'vitest';
import { parseGitStatus, parseWorktrees } from '../src/dashboard-response.js';
import {
  renderGitAdvanced, renderGitDiff, renderGitLog, renderGitPanel, renderGitStatus, renderWorktrees
} from '../dashboard/dashboard-render.js';

const STATUS_TEXT = [
  '## main...origin/main [ahead 2, behind 1]',
  'M  src/staged.ts',
  ' M src/modified.ts',
  '?? notes.md',
  'MM both.ts'
].join('\n');

describe('git adapter parsing', () => {
  it('summarises branch, upstream, ahead/behind and file entries', () => {
    const status = parseGitStatus(STATUS_TEXT) as Record<string, any>;
    expect(status.branch).toBe('main');
    expect(status.upstream).toBe('origin/main');
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(1);
    expect(status.entries).toHaveLength(4);
    expect(status.entries[0]).toEqual({ code: 'M', path: 'src/staged.ts' });
    // Index changes, worktree changes and untracked files are counted separately.
    expect(status.staged).toBe(2);
    expect(status.modified).toBe(2);
    expect(status.untracked).toBe(1);
  });

  it('handles a detached head, an upstream-less branch and empty output', () => {
    expect((parseGitStatus('## HEAD (no branch)') as Record<string, any>).branch).toBe('HEAD (no branch)');
    const noUpstream = parseGitStatus('## feature/x') as Record<string, any>;
    expect(noUpstream.branch).toBe('feature/x');
    expect(noUpstream.upstream).toBeUndefined();
    expect(noUpstream.ahead).toBe(0);
    const empty = parseGitStatus('') as Record<string, any>;
    expect(empty.entries).toEqual([]);
    expect(empty.branch).toBe('detached');
  });

  it('parses the worktree listing into path, head and branch', () => {
    const trees = parseWorktrees(['/jobs/ws_1 abc1234 [main]', '/jobs/ws_1/.worktrees/feature def5678 [feature/x]', '/jobs/ws_1 9999999 (detached HEAD)'].join('\n'));
    expect(trees[0]).toEqual({ path: '/jobs/ws_1', head: 'abc1234', branch: 'main' });
    expect(trees[1].branch).toBe('feature/x');
    expect(trees[2].branch).toBe('(detached HEAD)');
    expect(parseWorktrees('')).toEqual([]);
  });
});

describe('git panel renderers', () => {
  it('shows the working-tree summary and escapes file paths', () => {
    const markup = renderGitStatus({
      branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0, staged: 1, modified: 0, untracked: 1,
      entries: [{ code: '??', path: '<img src=x onerror=alert(1)>' }]
    });
    expect(markup).toContain('main');
    expect(markup).toContain('1 ahead · 0 behind');
    expect(markup).toContain('Staged');
    expect(markup).not.toContain('<img src=x');
    expect(markup).toContain('&lt;img src=x');
    expect(renderGitStatus({})).toContain('No changed files.');
  });

  it('labels the diff side, offers the toggle, and states truncation', () => {
    const staged = renderGitDiff({ staged: true, diff: '+added', truncated: false });
    expect(staged).toContain('Staged diff');
    expect(staged).toContain('data-staged="true"');
    expect(staged).toContain('Show unstaged diff');
    expect(staged).toContain('+added');
    const truncated = renderGitDiff({ staged: false, diff: 'x', truncated: true });
    expect(truncated).toContain('Unstaged diff');
    expect(truncated).toContain('Diff is truncated');
    expect(renderGitDiff({}).diff ?? renderGitDiff({})).toContain('No diff to show.');
  });

  it('lists recent commits with their short id and author', () => {
    const markup = renderGitLog([{ oid: 'a'.repeat(40), subject: 'feat: ship', author: 'Operator', authoredAt: '2026-08-17T00:00:00.000Z' }]);
    expect(markup).toContain('feat: ship');
    expect(markup).toContain('a'.repeat(12));
    expect(markup).toContain('Operator');
    expect(renderGitLog([])).toContain('No commits reported.');
  });

  it('keeps worktrees collapsed with their own create form', () => {
    const markup = renderWorktrees([{ path: '/jobs/ws_1/.worktrees/feature', head: 'b'.repeat(40), branch: 'feature' }]);
    expect(markup).toContain('<details class="row-edit">');
    expect(markup).toContain('id="create-worktree-form"');
    expect(markup).toContain('data-worktree-name="feature"');
    expect(markup).toContain('class="danger remove-worktree"');
    expect(renderWorktrees([])).toContain('No managed worktrees.');
  });

  it('keeps advanced operations collapsed, with every fenced action offered', () => {
    const markup = renderGitAdvanced();
    for (const action of ['fetch', 'pull', 'checkout', 'branch', 'merge', 'rebase']) {
      expect(markup, action).toContain(`value="${action}"`);
    }
    expect(markup).toContain('<details class="row-edit">');
    expect(markup).toContain('Conflicts are reported here');
    expect(markup).toContain('Finalize remains the recommended path');
  });

  it('composes the panel and names Finalize as the happy path', () => {
    const panel = renderGitPanel({ status: { branch: 'main' }, diff: { staged: false, diff: 'd' }, log: [], worktrees: [] });
    expect(panel).toContain('Working tree');
    expect(panel).toContain('Unstaged diff');
    expect(panel).toContain('Recent commits');
    expect(panel).toContain('Worktrees');
    expect(panel).toContain('Advanced Git operations');
    expect(panel).toContain('Finalize stages, commits and pushes');
  });
});
