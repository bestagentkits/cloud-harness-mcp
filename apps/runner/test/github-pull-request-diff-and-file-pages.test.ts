import { describe, expect, it } from 'vitest';
import {
  FILE_READ_MAX_BYTES,
  decodeFileReadCursor,
  decodePullRequestDiffCursor,
  githubReadCursorScope,
  parseGitHubReadHelperOutput,
  pullRequestDiffPage,
  shapeFileReadPage,
  shapePullRequestDiffPage,
  type FileReadHelperOutput,
  type PullRequestDiffHelperOutput
} from '../src/github-pull-request-diff-and-file-pages.js';

const base = 'b'.repeat(40);
const head = 'a'.repeat(40);
const commit = 'c'.repeat(40);
const blob = 'f'.repeat(40);
const scope = githubReadCursorScope(`ws_${'1'.repeat(24)}`, 'https://github.com/acme/widgets.git');
const otherScope = githubReadCursorScope(`ws_${'2'.repeat(24)}`, 'https://github.com/acme/widgets.git');

type DiffPage = {
  prNumber: number;
  baseSha: string;
  headSha: string;
  changedFiles: number;
  startIndex: number;
  filesUnavailableUpstream: number;
  nextCursor: string | null;
  files: Array<{ filename: string; previousFilename?: string; patchStatus: string; patch?: string; patchBytes?: number }>;
};

type FilePage = { contentStatus?: string; content?: string; offset?: number; nextCursor?: string | null; entries?: unknown[]; entriesTruncated?: boolean; target?: string | null };

function diffOutput(files: PullRequestDiffHelperOutput['files'], overrides: Partial<PullRequestDiffHelperOutput> = {}): PullRequestDiffHelperOutput {
  return { baseSha: base, headSha: head, changedFiles: files.length, files, baseShaAfter: base, headShaAfter: head, ...overrides };
}

const file = (name: string, patch?: string | null) => ({ filename: name, status: 'modified', additions: 1, deletions: 1, changes: 2, patch });

/**
 * Reads every page of a pull request the way a client would, against a GitHub listing that serves
 * `listing` (which may hold fewer files than `changedFiles`).
 */
function readAllDiffPages(listing: PullRequestDiffHelperOutput['files'], pageSize: number, budgetBytes: number, changedFiles = listing.length) {
  const pages: DiffPage[] = [];
  let cursor: string | undefined;
  do {
    const decoded = decodePullRequestDiffCursor(cursor, scope, 7);
    const startIndex = decoded?.i ?? 0;
    const { page } = pullRequestDiffPage(startIndex, pageSize);
    const output = diffOutput(listing.slice((page - 1) * pageSize, page * pageSize), { changedFiles });
    const text = shapePullRequestDiffPage({ prNumber: 7, scope, startIndex, pageSize, cursor: decoded, output, budgetBytes });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(budgetBytes);
    const parsed = JSON.parse(text) as DiffPage;
    pages.push(parsed);
    cursor = parsed.nextCursor ?? undefined;
    expect(pages.length).toBeLessThan(500);
  } while (cursor);
  return pages;
}

function fileOutput(content: Buffer, overrides: Partial<Extract<FileReadHelperOutput, { exists: true }>> = {}): FileReadHelperOutput {
  return { exists: true, commitSha: commit, type: 'file', sha: blob, size: content.length, encoding: 'base64', content: content.toString('base64'), ...overrides };
}

const credential = 'ghs_sentinelTokenForTests0123456789';
const shapeFile = (output: FileReadHelperOutput, budgetBytes = 4_096, cursor?: string, path = 'src/a.ts') =>
  shapeFileReadPage({ scope, path, revision: head, cursor: decodeFileReadCursor(cursor, scope, path, head), output, budgetBytes, credentials: [credential] });

function readAllFilePages(content: Buffer, budgetBytes: number) {
  const output = fileOutput(content);
  const chunks: Buffer[] = [];
  const sizes: number[] = [];
  let cursor: string | undefined;
  do {
    const text = shapeFile(output, budgetBytes, cursor);
    sizes.push(Buffer.byteLength(text));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(budgetBytes);
    const parsed = JSON.parse(text) as FilePage;
    expect(parsed.contentStatus).toBe('text');
    chunks.push(Buffer.from(parsed.content!, 'utf8'));
    cursor = parsed.nextCursor ?? undefined;
    expect(sizes.length).toBeLessThan(10_000);
  } while (cursor);
  return { content: Buffer.concat(chunks), sizes };
}

describe('pr_diff pages', () => {
  it('returns every file exactly once across pages, each page within the budget, with renames and missing patches marked', () => {
    const listing = Array.from({ length: 23 }, (_, index) => file(`src/file-${index}.ts`, index === 4 ? undefined : `@@ -1 +1 @@\n-old ${index}\n+${'x'.repeat(300)}`));
    listing[2] = { ...listing[2]!, status: 'renamed', previousFilename: 'src/old-name.ts' };
    const pages = readAllDiffPages(listing, 5, 2_048);
    expect(pages.flatMap((page) => page.files.map((entry) => entry.filename))).toEqual(listing.map((entry) => entry.filename));
    expect(pages.length).toBeGreaterThan(5);
    const all = pages.flatMap((page) => page.files);
    expect(all[2]).toMatchObject({ previousFilename: 'src/old-name.ts', patchStatus: 'included' });
    expect(all[4]).toEqual(expect.objectContaining({ patchStatus: 'unavailable_upstream' }));
    expect(all[4]!.patch).toBeUndefined();
    expect(pages.at(-1)).toMatchObject({ baseSha: base, headSha: head, nextCursor: null, filesUnavailableUpstream: 0 });
  });

  it('keeps a patch whose exact page fits the budget instead of reserving room for a cursor the last page lacks', () => {
    const patch = `@@ +1 @@\n+${'z'.repeat(500)}`;
    const [page] = readAllDiffPages([file('only.ts', patch)], 30, 1_024);
    expect(page!.files[0]).toMatchObject({ patchStatus: 'included', patch });
    expect(page!.nextCursor).toBeNull();
  });

  it('reports a single patch larger than a response without its text, stays within the budget, and still advances', () => {
    const huge = `@@ -1 +1 @@\n+${'y'.repeat(10_000)}`;
    const pages = readAllDiffPages([file('big.ts', huge), file('small.ts', '@@ +1 @@')], 30, 1_024);
    const [big, small] = pages.flatMap((page) => page.files);
    expect(big).toMatchObject({ filename: 'big.ts', patchStatus: 'exceeds_response_limit', patchBytes: Buffer.byteLength(huge) });
    expect(big!.patch).toBeUndefined();
    expect(small).toMatchObject({ filename: 'small.ts', patchStatus: 'included', patch: '@@ +1 @@' });
  });

  it('never reports a complete diff when GitHub lists fewer files than the pull request changed', () => {
    const pages = readAllDiffPages([file('a', '@@'), file('b', '@@')], 30, 4_096, 5);
    expect(pages.at(-1)).toMatchObject({ nextCursor: null, filesUnavailableUpstream: 3 });
  });

  it('counts files beyond the GitHub listing limit', () => {
    const text = shapePullRequestDiffPage({
      prNumber: 7, scope, startIndex: 2_999, pageSize: 30, cursor: undefined,
      output: diffOutput(Array.from({ length: 30 }, (_, index) => file(`f${index}`, '@@')), { changedFiles: 3_200 }),
      budgetBytes: 262_144
    });
    const page = JSON.parse(text) as DiffPage;
    expect(page.files.map((entry) => entry.filename)).toEqual(['f29']);
    expect(page).toMatchObject({ changedFiles: 3_200, filesUnavailableUpstream: 200, nextCursor: null });
  });

  it('refuses a page when even its metadata does not fit the budget', () => {
    expect(() => shapePullRequestDiffPage({
      prNumber: 7, scope, startIndex: 0, pageSize: 30, cursor: undefined, output: diffOutput([file(`${'n'.repeat(2_000)}.ts`, '@@')]), budgetBytes: 1_024
    })).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
  });

  it('refuses a cursor after a force-push and a page read while the pull request moved', () => {
    const cursorText = JSON.parse(shapePullRequestDiffPage({
      prNumber: 7, scope, startIndex: 0, pageSize: 1, cursor: undefined, output: diffOutput([file('a', '@@')], { changedFiles: 2 }), budgetBytes: 4_096
    })).nextCursor as string;
    const cursor = decodePullRequestDiffCursor(cursorText, scope, 7);
    const pushed = 'd'.repeat(40);
    expect(() => shapePullRequestDiffPage({
      prNumber: 7, scope, startIndex: 1, pageSize: 1, cursor, output: diffOutput([file('b', '@@')], { changedFiles: 2, headSha: pushed, headShaAfter: pushed }), budgetBytes: 4_096
    })).toThrow(expect.objectContaining({ code: 'STALE_HEAD', currentHeadOid: pushed, expectedHeadOid: head }));
    expect(() => shapePullRequestDiffPage({
      prNumber: 7, scope, startIndex: 0, pageSize: 1, cursor: undefined, output: diffOutput([file('a', '@@')], { headShaAfter: pushed }), budgetBytes: 4_096
    })).toThrow(expect.objectContaining({ code: 'STALE_HEAD', retryable: true }));
  });

  it('refuses a cursor of another workspace, another pull request, or a forged one', () => {
    const cursorText = JSON.parse(shapePullRequestDiffPage({
      prNumber: 7, scope, startIndex: 0, pageSize: 1, cursor: undefined, output: diffOutput([file('a', '@@')], { changedFiles: 2 }), budgetBytes: 4_096
    })).nextCursor as string;
    expect(() => decodePullRequestDiffCursor(cursorText, otherScope, 7)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => decodePullRequestDiffCursor(cursorText, scope, 8)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => decodePullRequestDiffCursor('bm90LWpzb24', scope, 7)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    const forged = Buffer.from(JSON.stringify({ v: 1, k: 'pr_diff', w: scope, pr: 7, i: -1, b: base, h: head })).toString('base64url');
    expect(() => decodePullRequestDiffCursor(forged, scope, 7)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});

describe('file_read pages', () => {
  it('reassembles multi-byte text exactly across pages without splitting a character or exceeding the budget', () => {
    const text = Buffer.from(`${'héllo "wörld" \\ \t 日本語 🙂\n'.repeat(400)}`, 'utf8');
    const { content, sizes } = readAllFilePages(text, 1_024);
    expect(content.equals(text)).toBe(true);
    expect(sizes.length).toBeGreaterThan(10);
  });

  it('fills each page close to the budget even when escaping doubles the text', () => {
    const text = Buffer.from('\n'.repeat(5_000));
    const { content, sizes } = readAllFilePages(text, 1_024);
    expect(content.equals(text)).toBe(true);
    // Every page but the last carries well over a few bytes: each newline costs two JSON bytes.
    for (const size of sizes.slice(0, -1)) expect(size).toBeGreaterThan(900);
  });

  it('returns an empty file as empty text with no cursor', () => {
    expect(JSON.parse(shapeFile(fileOutput(Buffer.alloc(0))))).toMatchObject({ contentStatus: 'text', content: '', offset: 0, nextCursor: null, commitSha: commit });
  });

  it('reports a binary file without content', () => {
    for (const bytes of [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), Buffer.from([0xff, 0xfe, 0x41])]) {
      const page = JSON.parse(shapeFile(fileOutput(bytes))) as FilePage;
      expect(page.contentStatus).toBe('binary');
      expect(page.content).toBeUndefined();
    }
  });

  it('reports a file above the cap as too_large', () => {
    const page = JSON.parse(shapeFile(fileOutput(Buffer.alloc(0), { size: FILE_READ_MAX_BYTES + 1, encoding: null, content: null }))) as FilePage & { maxBytes?: number };
    expect(page).toMatchObject({ contentStatus: 'too_large', maxBytes: FILE_READ_MAX_BYTES });
    expect(page.content).toBeUndefined();
  });

  it('refuses content whose length differs from the declared size instead of returning it as the whole file', () => {
    expect(() => shapeFile(fileOutput(Buffer.from('hi\n'), { size: 2_000_000 }))).toThrow(expect.objectContaining({ code: 'UNAVAILABLE' }));
    expect(() => shapeFile(fileOutput(Buffer.from('hi\n'), { encoding: 'none' }))).toThrow(expect.objectContaining({ code: 'UNAVAILABLE' }));
  });

  it('decodes GitHub\'s line-wrapped base64 to the exact bytes', () => {
    const text = Buffer.from(`${'line of text\n'.repeat(200_000)}`);
    const wrapped = text.toString('base64').replace(/.{60}/g, '$&\n');
    const page = JSON.parse(shapeFile(fileOutput(text, { content: wrapped }), 4 * 1_024 * 1_024)) as FilePage;
    expect(page.contentStatus).toBe('text');
    expect(Buffer.from(page.content!).equals(text)).toBe(true);
  });

  it('refuses to return decoded content that holds the credential used to read it', () => {
    const leaked = Buffer.from(`token=${credential}\n`);
    expect(() => shapeFile(fileOutput(leaked))).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    const target = Buffer.from(`../${credential}`).toString('base64');
    expect(() => shapeFile({ exists: true, commitSha: commit, type: 'symlink', sha: blob, encoding: 'base64', content: target }, 4_096, undefined, 'link'))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('refuses a cursor once the same blob is no longer a regular file', () => {
    const output = fileOutput(Buffer.from('x'.repeat(5_000)));
    const first = JSON.parse(shapeFile(output, 1_024)) as FilePage;
    const nowSymlink: FileReadHelperOutput = { exists: true, commitSha: commit, type: 'symlink', sha: blob, encoding: 'base64', content: Buffer.from('a').toString('base64') };
    expect(() => shapeFile(nowSymlink, 1_024, first.nextCursor!)).toThrow(expect.objectContaining({ code: 'STALE_HEAD' }));
  });

  it('refuses a cursor once the file changed, and a cursor of another workspace, path, or revision', () => {
    const output = fileOutput(Buffer.from('x'.repeat(5_000)));
    const first = JSON.parse(shapeFile(output, 1_024)) as FilePage;
    expect(() => shapeFile({ ...output, sha: 'e'.repeat(40) }, 1_024, first.nextCursor!))
      .toThrow(expect.objectContaining({ code: 'STALE_HEAD', currentHeadOid: 'e'.repeat(40) }));
    expect(() => decodeFileReadCursor(first.nextCursor!, otherScope, 'src/a.ts', head)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => decodeFileReadCursor(first.nextCursor!, scope, 'src/b.ts', head)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => decodeFileReadCursor(first.nextCursor!, scope, 'src/a.ts', 'main')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('reports a path absent at the commit', () => {
    expect(JSON.parse(shapeFile({ exists: false, commitSha: commit }))).toEqual({ path: 'src/a.ts', revision: head, commitSha: commit, exists: false });
  });

  it('lists directory entries within the budget and flags the remainder', () => {
    const entries = Array.from({ length: 200 }, (_, index) => ({ name: `f${index}`, path: `dir/f${index}`, type: 'file' as const, size: 1, sha: blob }));
    const text = shapeFile({ exists: true, commitSha: commit, type: 'dir', sha: 'd'.repeat(40), entries }, 4_096, undefined, 'dir');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4_096);
    const page = JSON.parse(text) as FilePage & { entriesTotal: number };
    expect(page).toMatchObject({ entriesTotal: 200, entriesTruncated: true });
    expect(page.entries!.length).toBeGreaterThan(20);
  });

  it('returns a symlink target and a submodule commit without following either', () => {
    const target = Buffer.from('../etc').toString('base64');
    const symlink = JSON.parse(shapeFile({ exists: true, commitSha: commit, type: 'symlink', sha: blob, encoding: 'base64', content: target }, 4_096, undefined, 'link')) as FilePage;
    expect(symlink).toMatchObject({ type: 'symlink', target: '../etc' });
    expect(symlink.content).toBeUndefined();
    const submodule = JSON.parse(shapeFile({ exists: true, commitSha: commit, type: 'submodule', sha: '1'.repeat(40) }, 4_096, undefined, 'vendor/lib'));
    expect(submodule).toEqual({ path: 'vendor/lib', revision: head, commitSha: commit, exists: true, type: 'submodule', sha: '1'.repeat(40) });
  });

  it('refuses helper output of an unexpected shape', () => {
    expect(() => parseGitHubReadHelperOutput('file_read', '{"exists":true,"type":"file"}')).toThrow(expect.objectContaining({ code: 'UNAVAILABLE' }));
    expect(() => parseGitHubReadHelperOutput('pr_diff', '{"files":[')).toThrow(expect.objectContaining({ code: 'UNAVAILABLE' }));
  });
});
