import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const helper = resolve(import.meta.dirname, '../worker/gh-helper.sh');
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/** Runs the real helper with a `gh` stand-in that records its argv and runs `stub` for its output. */
function run(args: string[], stub = '') {
  const directory = mkdtempSync(join(tmpdir(), 'gh-helper-read-'));
  directories.push(directory);
  const log = join(directory, 'calls.log');
  writeFileSync(join(directory, 'gh'), `#!/bin/bash\nprintf '%s\\0' "$@" >> "${log}"\nprintf '\\n--\\n' >> "${log}"\n${stub}\n`);
  chmodSync(join(directory, 'gh'), 0o755);
  const result = spawnSync('bash', [helper, ...args], {
    input: 'dummy_token\n',
    encoding: 'utf8',
    env: { PATH: `${directory}:${process.env.PATH ?? ''}`, GH_REPO: 'acme/widgets', HOME: directory, TMPDIR: directory }
  });
  let calls: string[][] = [];
  try {
    calls = readFileSync(log, 'utf8').split('\n--\n').filter(Boolean).map((chunk) => chunk.split('\0').filter((part, index, all) => part !== '' || index < all.length - 1));
  } catch { /* the helper rejected the input before calling gh */ }
  return { ...result, calls };
}

const cap = '100000';
const commit = 'c'.repeat(40);
const blob = 'f'.repeat(40);
/** A gh stand-in whose GraphQL lookup returns `file` (JSON or null) at the resolved commit. */
const graphql = (file: string, extra = '') => [
  'case "$*" in',
  `  *graphql*) echo '{"data":{"repository":{"object":{"oid":"${commit}","file":${file}}}}}';;`,
  extra,
  'esac'
].join('\n');
/** A gh stand-in answering GraphQL with file null, the given errors, and gh's exit status for a partial response. */
const graphqlErrors = (errors: unknown[]) =>
  `echo '${JSON.stringify({ data: { repository: { object: { oid: commit, file: null } } }, errors })}'; echo "gh: GraphQL error" >&2; exit 1`;

describe('gh-helper pr_diff', () => {
  it('reads the pull request around one capped files page and joins the three responses', () => {
    const stub = [
      'case "$*" in',
      '  *"pulls/12/files"*) echo \'[{"filename":"a.ts","patch":"@@","previous_filename":"old.ts","status":"renamed","additions":1,"deletions":0,"changes":1,"blob_url":"x"}]\';;',
      '  *"pulls/12"*) echo \'{"baseSha":"b","headSha":"h","changedFiles":1}\';;',
      'esac'
    ].join('\n');
    const result = run(['pr_diff', '12', '3', '30', cap], stub);
    expect(result.status).toBe(0);
    expect(result.calls.map((call) => call.slice(0, 4))).toEqual([
      ['api', 'repos/{owner}/{repo}/pulls/12', '--jq', expect.stringContaining('baseSha')],
      ['api', '-X', 'GET', 'repos/{owner}/{repo}/pulls/12/files'],
      ['api', 'repos/{owner}/{repo}/pulls/12', '--jq', expect.stringContaining('baseSha')]
    ]);
    expect(result.calls[1]).toEqual(expect.arrayContaining(['per_page=30', 'page=3']));
    expect(result.calls[1]).not.toContain('--jq');
    expect(JSON.parse(result.stdout)).toEqual({
      baseSha: 'b', headSha: 'h', changedFiles: 1, baseShaAfter: 'b', headShaAfter: 'h',
      files: [{ filename: 'a.ts', previousFilename: 'old.ts', status: 'renamed', additions: 1, deletions: 0, changes: 1, patch: '@@' }]
    });
  });

  it('stops at the download cap with its marker instead of parsing a partial response', () => {
    const stub = 'case "$*" in *"pulls/12/files"*) head -c 5000 /dev/zero | tr "\\0" x;; *) echo \'{"baseSha":"b","headSha":"h","changedFiles":1}\';; esac';
    const result = run(['pr_diff', '12', '1', '30', '1000'], stub);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('GITHUB_READ_DOWNLOAD_CAP_EXCEEDED');
    expect(result.stdout).toBe('');
  });

  it('fails with GitHub\'s error when any read is refused', () => {
    const result = run(['pr_diff', '12', '1', '30', cap], 'case "$*" in *files*) echo "gh: Not Found (HTTP 404)" >&2; exit 1;; *) echo "{}";; esac');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('HTTP 404');
  });

  it('refuses non-numeric arguments before calling GitHub', () => {
    const result = run(['pr_diff', '12', '1;rm', '30', cap]);
    expect(result.stderr).toContain('Page must be a positive integer');
    expect(result.calls).toHaveLength(0);
  });
});

describe('gh-helper file_read', () => {
  const max = '4194304';

  it('resolves the revision to a commit, passes the path as a GraphQL variable, and reads a file blob by ID', () => {
    const stub = graphql(`{"mode":33188,"oid":"${blob}","object":{"byteSize":3}}`, `  *"git/blobs/${blob}"*) echo '{"content":"aGkK\\n","encoding":"base64","size":3}';;`);
    const result = run(['file_read', 'docs/a b?#.md', 'feature/x', max, cap], stub);
    expect(result.status).toBe(0);
    expect(result.calls[0]).toEqual(expect.arrayContaining(['graphql', 'owner=acme', 'repo=widgets', 'expression=feature/x^{commit}', 'path=docs/a b?#.md']));
    expect(result.calls[1]!.slice(0, 2)).toEqual(['api', `repos/{owner}/{repo}/git/blobs/${blob}`]);
    expect(JSON.parse(result.stdout)).toEqual({ commitSha: commit, exists: true, type: 'file', sha: blob, size: 3, encoding: 'base64', content: 'aGkK\n' });
  });

  it('returns a symlink\'s own blob, never the content of the file it points to', () => {
    const target = Buffer.from('../README.md').toString('base64');
    const stub = graphql(`{"mode":40960,"oid":"${blob}","object":{"byteSize":12}}`, `  *"git/blobs/${blob}"*) echo '{"content":"${target}","encoding":"base64"}';;`);
    const result = run(['file_read', 'AGENTS.md', 'main', max, cap], stub);
    expect(JSON.parse(result.stdout)).toEqual({ commitSha: commit, exists: true, type: 'symlink', sha: blob, encoding: 'base64', content: target });
  });

  it('lists a directory from its tree with each entry typed by mode', () => {
    const tree = 'd'.repeat(40);
    const entries = JSON.stringify({ truncated: false, tree: [
      { path: 'a.ts', mode: '100644', type: 'blob', size: 4, sha: blob },
      { path: 'link', mode: '120000', type: 'blob', size: 7, sha: blob },
      { path: 'lib', mode: '040000', type: 'tree', sha: tree },
      { path: 'vendor', mode: '160000', type: 'commit', sha: commit }
    ] });
    const stub = graphql(`{"mode":16384,"oid":"${tree}","object":{}}`, `  *"git/trees/${tree}"*) echo '${entries}';;`);
    const result = run(['file_read', 'src', 'main', max, cap], stub);
    const page = JSON.parse(result.stdout);
    expect(page).toMatchObject({ type: 'dir', sha: tree, entriesTruncatedUpstream: false });
    expect(page.entries.map((entry: { path: string; type: string }) => [entry.path, entry.type])).toEqual([
      ['src/a.ts', 'file'], ['src/link', 'symlink'], ['src/lib', 'dir'], ['src/vendor', 'submodule']
    ]);
  });

  it('reports a submodule commit without reading anything else', () => {
    const result = run(['file_read', 'vendor', 'main', max, cap], graphql(`{"mode":57344,"oid":"${blob}","object":null}`));
    expect(result.calls).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({ commitSha: commit, exists: true, type: 'submodule', sha: blob });
  });

  it('does not download a file above the size cap', () => {
    const result = run(['file_read', 'huge.bin', 'main', max, cap], graphql(`{"mode":33188,"oid":"${blob}","object":{"byteSize":50000000}}`));
    expect(result.calls).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({ commitSha: commit, exists: true, type: 'file', sha: blob, size: 50_000_000 });
  });

  it('reports a path absent at the commit only for GitHub\'s NOT_FOUND on the file field', () => {
    const missing = run(['file_read', 'nope.txt', 'main', max, cap], graphqlErrors([{ type: 'NOT_FOUND', path: ['repository', 'object', 'file'], message: 'Could not resolve file' }]));
    expect(missing.status).toBe(0);
    expect(JSON.parse(missing.stdout)).toEqual({ commitSha: commit, exists: false });
  });

  it.each([
    ['a permission refusal', [{ type: 'FORBIDDEN', path: ['repository', 'object', 'file'], message: 'Resource not accessible by integration' }]],
    ['an upstream failure', [{ type: 'INTERNAL', path: ['repository', 'object', 'file'], message: 'Something went wrong' }]],
    ['NOT_FOUND on another field', [{ type: 'NOT_FOUND', path: ['repository'], message: 'Could not resolve to a Repository' }]],
    ['NOT_FOUND beside another error', [
      { type: 'NOT_FOUND', path: ['repository', 'object', 'file'], message: 'Could not resolve file' },
      { type: 'FORBIDDEN', path: ['repository', 'object', 'file'], message: 'Resource not accessible by integration' }
    ]]
  ])('fails with gh\'s status on %s instead of reporting the path absent', (_name, errors) => {
    const result = run(['file_read', 'a.ts', 'main', max, cap], graphqlErrors(errors));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('fails for an unknown revision', () => {
    const unknown = run(['file_read', 'a.ts', 'deadbeef', max, cap], 'echo \'{"data":{"repository":{"object":null}}}\'');
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain('HTTP 404');
  });

  it.each(['../secret', 'a//b', './a', 'a/', '/etc/passwd'])('refuses the path %s before calling GitHub', (path) => {
    const result = run(['file_read', path, 'main', max, cap]);
    expect(result.status).not.toBe(0);
    expect(result.calls).toHaveLength(0);
  });

  it('refuses a revision that could change the GraphQL expression before calling GitHub', () => {
    for (const revision of ['main..dev', 'main:secret', 'main^{tree}']) {
      const result = run(['file_read', 'a.ts', revision, max, cap]);
      expect(result.stderr).toContain('Revision must be');
      expect(result.calls).toHaveLength(0);
    }
  });
});
