import { describe, expect, it } from 'vitest';
import {
  DIFF_PAGE_LINES,
  appendBounded,
  breadcrumbs,
  dependenciesByTask,
  describeError,
  diffLines,
  formatRemaining,
  isReadable,
  looksBinary,
  pageOf,
  parentPath,
  parseGitStatus,
  parseToolResult,
  sortEntries,
  summarizeTasks,
  workspaceState
} from '../mcp-apps/workspace-explorer/view-model.js';

describe('workspace explorer view model', () => {
  it('reads the ToolResult envelope and treats anything else as an error', () => {
    expect(parseToolResult({ structuredContent: { ok: true, message: 'ok', data: { a: 1 }, truncated: true, cursor: '10:abc' } }))
      .toEqual({ ok: true, data: { a: 1 }, error: undefined, truncated: true, cursor: '10:abc' });
    expect(parseToolResult({ structuredContent: { ok: false, message: 'no', error: { code: 'NOT_FOUND', message: 'workspace not found' } } }))
      .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    for (const malformed of [undefined, null, {}, { content: [{ type: 'text', text: '{"ok":true}' }] }, { structuredContent: { ok: 'yes' } }]) {
      expect(parseToolResult(malformed)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    }
  });

  it('maps lifecycle and permission errors to distinct states and bounds the detail', () => {
    expect(describeError({ code: 'EXPIRED', message: 'lease expired' })).toMatchObject({ kind: 'expired', code: 'EXPIRED', detail: 'lease expired' });
    expect(describeError({ code: 'FORBIDDEN', message: 'x' }).kind).toBe('denied');
    expect(describeError({ code: 'LIMIT_EXCEEDED', message: 'x' }).kind).toBe('too-large');
    expect(describeError({ code: 'SOMETHING_NEW', message: 'x' })).toMatchObject({ kind: 'error', code: 'SOMETHING_NEW' });
    expect(describeError(undefined)).toMatchObject({ kind: 'error', code: 'INTERNAL_ERROR', detail: 'No details were provided.' });
    expect(describeError({ code: 'NOT_FOUND', message: 'a'.repeat(5_000) }).detail).toHaveLength(300);
  });

  it('only treats active workspaces as readable', () => {
    expect(workspaceState({ status: 'ACTIVE', leaseState: 'ACTIVE' })).toBe('active');
    expect(workspaceState({ status: 'ACTIVE', leaseState: 'WARNING' })).toBe('expiring');
    expect(workspaceState({ status: 'ACTIVE', leaseState: 'EXPIRED' })).toBe('expired');
    expect(workspaceState({ status: 'EXPIRED_RECOVERABLE' })).toBe('expired');
    expect(workspaceState({ status: 'CLOSED' })).toBe('closed');
    expect(workspaceState({ status: 'FAILED' })).toBe('failed');
    expect(workspaceState({ status: 'CREATING' })).toBe('unavailable');
    expect(workspaceState(undefined)).toBe('unavailable');
    expect(['active', 'expiring'].every(isReadable)).toBe(true);
    expect(['expired', 'closed', 'failed', 'unavailable'].some(isReadable)).toBe(false);
  });

  it('keeps paths workspace-relative', () => {
    expect(breadcrumbs('.')).toEqual([{ label: 'root', path: '.' }]);
    expect(breadcrumbs('src/app')).toEqual([{ label: 'root', path: '.' }, { label: 'src', path: 'src' }, { label: 'app', path: 'src/app' }]);
    expect(parentPath('src/app')).toBe('src');
    expect(parentPath('src')).toBe('.');
    expect(parentPath('.')).toBe('.');
  });

  it('sorts directories first and drops malformed entries', () => {
    const entries = [{ name: 'b.txt', type: 'file' }, { name: 'z', type: 'directory' }, { name: 'a', type: 'directory' }, { name: 1, type: 'file' }, null];
    expect(sortEntries(entries).map((entry: { name: string }) => entry.name)).toEqual(['a', 'z', 'b.txt']);
    expect(sortEntries(undefined)).toEqual([]);
  });

  it('detects binary content decoded as UTF-8', () => {
    expect(looksBinary('plain text\n')).toBe(false);
    expect(looksBinary('')).toBe(false);
    expect(looksBinary('ELF\0\0\0')).toBe(true);
    expect(looksBinary('�'.repeat(50) + 'x'.repeat(100))).toBe(true);
    expect(looksBinary(`caf� ${'x'.repeat(200)}`)).toBe(false);
  });

  it('parses short Git status without trusting file names', () => {
    expect(parseGitStatus('## main...origin/main [ahead 1]\n M src/a.ts\n?? <img src=x onerror=alert(1)>.md\n')).toEqual({
      branch: 'main...origin/main [ahead 1]',
      files: [{ code: ' M', path: 'src/a.ts' }, { code: '??', path: '<img src=x onerror=alert(1)>.md' }]
    });
    expect(parseGitStatus(undefined)).toEqual({ branch: '', files: [] });
  });

  it('types diff lines and pages large diffs', () => {
    expect(diffLines('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same\n').map((line: { kind: string }) => line.kind))
      .toEqual(['meta', 'meta', 'meta', 'hunk', 'del', 'add', 'context']);
    const lines = diffLines(Array.from({ length: DIFF_PAGE_LINES * 2 + 5 }, (_, index) => `+${index}`).join('\n'));
    expect(pageOf(lines, 0)).toMatchObject({ page: 0, pages: 3 });
    expect(pageOf(lines, 0).lines).toHaveLength(DIFF_PAGE_LINES);
    expect(pageOf(lines, 99)).toMatchObject({ page: 2, pages: 3 });
    expect(pageOf(lines, 99).lines).toHaveLength(5);
    expect(pageOf(lines, -3).page).toBe(0);
    expect(pageOf([], 0)).toEqual({ lines: [], page: 0, pages: 1 });
  });

  it('keeps task output bounded to the newest text', () => {
    expect(appendBounded('abc', 'def', 10)).toEqual({ text: 'abcdef', dropped: false });
    expect(appendBounded('abcdef', 'ghijkl', 10)).toEqual({ text: 'cdefghijkl', dropped: true });
  });

  it('summarizes task states and dependencies', () => {
    expect(summarizeTasks([{ status: 'running' }, { status: 'failed' }, { status: 'running' }, {}])).toMatchObject({ running: 2, failed: 1, unknown: 1, queued: 0 });
    const dependencies = dependenciesByTask([{ from: 'build', to: 'test' }, { from: 'lint', to: 'test' }, { from: 1, to: 'x' }]);
    expect(dependencies.get('test')).toEqual(['build', 'lint']);
    expect(dependencies.has('x')).toBe(false);
  });

  it('formats lease time', () => {
    expect(formatRemaining(3_900_000)).toBe('1h 5m');
    expect(formatRemaining(30_000)).toBe('<1m');
    expect(formatRemaining(0)).toBe('expired');
    expect(formatRemaining(undefined)).toBe('');
  });
});
