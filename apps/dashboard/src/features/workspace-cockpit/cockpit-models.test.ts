import { describe, expect, it } from 'vitest';
import { ApiError, ConflictError } from '@/lib/api-client';
import { deploymentsOf, groupHooksByLifecycle, hookRunBody, hooksOf, parseDeployDraft, runResultOf, SCRIPT_PATTERN, skillRunFailure, skillsOf } from './automation-model';
import { binaryReadNotice, fileOf, isSavable, joinPath, listingOf, parentPath, partialReadNotice, pathCrumbs, patchCopyText } from './files-model';
import { gitActionBody, gitCommitsOf, gitStatusOf, worktreesOf } from './git-model';
import { NODE_WIDTH, taskGraphLayout, taskGraphOf } from './task-graph-model';

const SHA = 'a'.repeat(64);

describe('files model', () => {
  it('lists folders first, each group alphabetical, and drops nameless entries', () => {
    const listing = listingOf({ path: 'src', entries: [{ name: 'b.ts' }, { name: 'lib', type: 'directory' }, { name: '' }, { name: 'a.ts', type: 'file' }] });
    expect(listing).toEqual({ path: 'src', entries: [{ name: 'lib', type: 'directory' }, { name: 'a.ts', type: 'file' }, { name: 'b.ts', type: 'file' }] });
    expect(listingOf(undefined).path).toBe('.');
  });

  it('reads a file only with its path, content and digest', () => {
    expect(fileOf({ path: 'a', content: 'x', sha256: SHA, bytesReturned: 1, totalBytes: 1, eof: true })).toEqual({ path: 'a', content: 'x', sha256: SHA, whole: true, binary: false, bytesReturned: 1, totalBytes: 1 });
    expect(fileOf({ path: 'a', content: 'x' })).toBeUndefined();
  });

  it('treats a read as whole only when the runner reports eof', () => {
    // The digest covers the whole file, so a window saved back would pass the fence and truncate it.
    const read = (extra: Record<string, unknown>) => {
      const file = fileOf({ path: 'a', content: 'x', sha256: SHA, ...extra });
      if (!file) throw new Error('expected a file');
      return file;
    };
    const partial = read({ bytesReturned: 65_536, totalBytes: 200_000, eof: false });
    expect(partial.whole).toBe(false);
    expect(read({}).whole).toBe(false);
    expect(read({ eof: 'true' }).whole).toBe(false);
    expect(partialReadNotice(partial)).toMatch(/^Showing the first 64 KB of 195 KB\. Saving the whole file is turned off/);
    expect(partialReadNotice(read({}))).toMatch(/^The runner did not confirm this is the whole file\./);
    expect(partialReadNotice(read({ eof: true }))).toBeUndefined();
  });

  it('blocks a save only when the runner reports the file as binary', () => {
    // A binary file's content is a lossy decoding, so a save would pass the fence and corrupt it.
    const read = (extra: Record<string, unknown>) => {
      const file = fileOf({ path: 'a', content: 'x', sha256: SHA, eof: true, ...extra });
      if (!file) throw new Error('expected a file');
      return file;
    };
    expect(isSavable(read({ binary: true }))).toBe(false);
    expect(binaryReadNotice(read({ binary: true }))).toMatch(/^This file is binary or not valid UTF-8 text/);
    // An older runner omits the field: the prior eof-only behaviour stays.
    for (const extra of [{}, { binary: false }, { binary: 'true' }]) {
      expect(isSavable(read(extra))).toBe(true);
      expect(binaryReadNotice(read(extra))).toBeUndefined();
    }
    expect(isSavable(read({ eof: false }))).toBe(false);
  });

  it('joins, climbs and breaks paths the way the classic tab does', () => {
    expect(joinPath('.', 'a')).toBe('a');
    expect(joinPath('src/', 'a')).toBe('src/a');
    expect(parentPath('src/lib/a.ts')).toBe('src/lib');
    expect(parentPath('a.ts')).toBe('.');
    expect(pathCrumbs('a/b')).toEqual([{ label: 'a', path: 'a' }, { label: 'b', path: 'a/b' }]);
    expect(pathCrumbs('.')).toEqual([]);
    expect(patchCopyText('old', 'new')).toBe('Text to replace:\nold\n\nReplacement text:\nnew');
  });
});

describe('git model', () => {
  it('defaults missing counts and entry codes', () => {
    expect(gitStatusOf({ branch: 'main', entries: [{ path: 'a' }] })).toEqual({ branch: 'main', ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, entries: [{ code: '??', path: 'a' }] });
  });

  it('reads commits and worktrees from either field spelling', () => {
    expect(gitCommitsOf({ commits: [{ sha: 'abc', message: 'Fix', date: '2026-01-01' }] })).toEqual([{ oid: 'abc', subject: 'Fix', author: 'Unknown author', at: '2026-01-01' }]);
    expect(worktreesOf({ worktrees: [{ path: '/w/feature' }] })).toEqual([{ name: 'feature', path: '/w/feature', head: '', branch: 'detached' }]);
  });

  it('sends each operation in its contract shape', () => {
    expect(gitActionBody('fetch', '')).toEqual({ remote: 'origin' });
    expect(gitActionBody('pull', '')).toEqual({ remote: 'origin', strategy: 'ff-only' });
    expect(gitActionBody('branch', 'feat')).toEqual({ action: 'create', name: 'feat' });
    expect(gitActionBody('rebase', 'main')).toEqual({ action: 'start', upstream: 'main' });
  });
});

describe('automation model', () => {
  it('keeps only well-formed digests on skills and hooks', () => {
    // A skill run is fenced by the bundle digest the list reports as `contentSha256`.
    expect(skillsOf({ skills: [{ name: 'lint', contentSha256: SHA }, { name: 'raw', contentSha256: 'nope' }, { name: 'old', sha256: SHA }, { name: '' }] }))
      .toEqual([{ name: 'lint', contentSha256: SHA }, { name: 'raw' }, { name: 'old' }]);
    expect(hooksOf({ hooks: [{ path: 'h.sh', event: 'manual', active: false }], manifestSha256: SHA })).toEqual({ hooks: [{ name: 'h.sh', events: ['manual'], active: false }], manifestSha256: SHA });
  });

  it('groups hooks by stage in run order', () => {
    const groups = groupHooksByLifecycle([{ name: 'h', events: ['pre_commit', 'manual'], active: true }]);
    expect(groups.map((group) => group.id)).toEqual(['on_workspace_open', 'post_checkout', 'pre_commit', 'post_commit', 'manual']);
    expect(groups.filter((group) => group.hooks.length).map((group) => group.id)).toEqual(['pre_commit', 'manual']);
  });

  it('fences a hook run by the manifest digest, then the hook digest, else refuses it', () => {
    const hook = { name: 'h', events: ['manual'], active: true, sha256: SHA };
    expect(hookRunBody(hook, 'manual', 'b'.repeat(64))).toEqual({ name: 'h', event: 'manual', expectedManifestSha256: 'b'.repeat(64) });
    expect(hookRunBody(hook, 'manual', undefined)).toEqual({ name: 'h', event: 'manual', expectedSha256: SHA });
    expect(hookRunBody({ name: 'h', events: [], active: true }, 'manual', undefined)).toBeUndefined();
  });

  it('accepts only bare script names', () => {
    expect(SCRIPT_PATTERN.test('check.sh')).toBe(true);
    expect(SCRIPT_PATTERN.test('../x')).toBe(false);
    expect(SCRIPT_PATTERN.test('a b')).toBe(false);
  });

  it('describes deployments and run results with readable fallbacks', () => {
    expect(deploymentsOf({ deployments: [{ name: 'prod', cwd: 'app', durationMs: 12 }, { name: 'stage', status: 'ok' }] })).toEqual([
      { name: 'prod', cwd: 'app', lastResult: 'Not reported', duration: '12 ms', failure: 'None reported' },
      { name: 'stage', cwd: '', lastResult: 'ok', duration: 'Not reported', failure: 'None reported' }
    ]);
    expect(runResultOf({ exitCode: 0, durationMs: 5, output: 'done' })).toEqual({ exitCode: 0, durationMs: 5, output: 'done' });
    expect(runResultOf({ exitCode: 1, executionMode: 'helper-container', signal: 'SIGTERM', output: '' }))
      .toEqual({ exitCode: 1, executionMode: 'helper-container', signal: 'SIGTERM', output: '' });
    expect(runResultOf({ signal: 'kill -9' })).toEqual({ output: '' });
  });

  it('shows a failed skill run only for an execution failure that carries its result', () => {
    const data = { exitCode: 3, executionMode: 'helper-container', output: 'boom' };
    expect(skillRunFailure(new ApiError(422, 'Failed.', 'execution_failed', data))).toEqual({ exitCode: 3, executionMode: 'helper-container', output: 'boom' });
    expect(skillRunFailure(new ApiError(422, 'Failed.', 'execution_failed'))).toBeUndefined();
    expect(skillRunFailure(new ApiError(400, 'Bad.', 'invalid_input', data))).toBeUndefined();
    expect(skillRunFailure(new ConflictError(409, 'Changed.', 'conflict'))).toBeUndefined();
  });

  it('restores only a well-formed deploy target name', () => {
    expect(parseDeployDraft({ target: 'prod', output: 'secret' })).toEqual({ target: 'prod' });
    expect(parseDeployDraft({ target: '../x' })).toEqual({});
    expect(parseDeployDraft('x')).toBeUndefined();
  });
});

describe('task graph model', () => {
  it('lays nodes out by dependency depth and drops edges to unknown nodes', () => {
    const graph = taskGraphOf({ nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { nope: 1 }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'x', to: 'c' }] });
    const layout = taskGraphLayout(graph);
    expect(layout.nodes).toHaveLength(3);
    expect(layout.edges).toEqual([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]);
    expect(layout.positions.get('a')?.x).toBe(20);
    expect((layout.positions.get('c')?.x ?? 0) - (layout.positions.get('b')?.x ?? 0)).toBe(240);
    expect(layout.width).toBeGreaterThan(2 * 240 + NODE_WIDTH - 1);
  });

  it('survives a dependency cycle', () => {
    const layout = taskGraphLayout(taskGraphOf({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }));
    expect(layout.positions.size).toBe(2);
  });
});
