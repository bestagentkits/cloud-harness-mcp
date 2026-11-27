import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { z } from 'zod';
import { HarnessError } from '@cloud-harness/contracts';

/**
 * Turns the gh helper's output for github_read pr_diff and file_read into bounded pages.
 *
 * The helper reads each GitHub response through a download cap and returns it reduced to the fields used
 * here. This module cuts one page whose serialized JSON never exceeds the caller's output budget, measured
 * on the exact response it returns. Cursors are opaque base64url JSON bound to the workspace and repository
 * and to the exact pull request head and base, or to the exact blob, so a page from another workspace or a
 * moved revision is refused instead of being mixed in.
 */

/** GitHub lists at most this many files of one pull request; the rest cannot be read through the API. */
export const PULL_REQUEST_FILES_UPSTREAM_LIMIT = 3_000;
/** Files requested per GitHub page; a page over the download cap is read again with fewer files. */
export const PULL_REQUEST_DIFF_PAGE_SIZES = [30, 5, 1] as const;
/** Largest file file_read downloads; larger files report contentStatus too_large. */
export const FILE_READ_MAX_BYTES = 4 * 1_024 * 1_024;
/** Largest single GitHub response the helper reads for pr_diff or file_read; it stops downloading past it. */
export const GITHUB_READ_RESPONSE_MAX_BYTES = 8 * 1_024 * 1_024;
/** Largest helper output the runner accepts: one capped response plus the small reads around it. */
export const GITHUB_READ_HELPER_OUTPUT_MAX_BYTES = 9 * 1_024 * 1_024;
/** The stderr marker with which the helper reports a response over the download cap. */
export const GITHUB_READ_DOWNLOAD_CAP_MARKER = 'GITHUB_READ_DOWNLOAD_CAP_EXCEEDED';
/** Bytes scanned for a NUL when deciding whether a file is binary, as Git does. */
const BINARY_SNIFF_BYTES = 8_000;

type PullRequestDiffCursor = { v: 1; k: 'pr_diff'; w: string; pr: number; i: number; b: string; h: string };
type FileReadCursor = { v: 1; k: 'file_read'; t: string; s: string; o: number };

const PullRequestDiffHelperOutputSchema = z.object({
  baseSha: z.string(),
  headSha: z.string(),
  changedFiles: z.number().int().nonnegative(),
  files: z.array(z.object({
    filename: z.string(),
    previousFilename: z.string().nullish(),
    status: z.string(),
    additions: z.number(),
    deletions: z.number(),
    changes: z.number(),
    patch: z.string().nullish()
  })),
  baseShaAfter: z.string(),
  headShaAfter: z.string()
});
export type PullRequestDiffHelperOutput = z.infer<typeof PullRequestDiffHelperOutputSchema>;

const FileReadHelperOutputSchema = z.discriminatedUnion('exists', [
  z.object({ exists: z.literal(false), commitSha: z.string() }),
  z.object({
    exists: z.literal(true),
    commitSha: z.string(),
    type: z.enum(['file', 'dir', 'symlink', 'submodule']),
    sha: z.string(),
    size: z.number().int().nonnegative().nullish(),
    encoding: z.string().nullish(),
    content: z.string().nullish(),
    entriesTruncatedUpstream: z.boolean().nullish(),
    entries: z.array(z.object({
      name: z.string(),
      path: z.string(),
      type: z.enum(['file', 'dir', 'symlink', 'submodule']),
      size: z.number().nullish(),
      sha: z.string()
    })).nullish()
  })
]);
export type FileReadHelperOutput = z.infer<typeof FileReadHelperOutputSchema>;

/** Validates the gh helper's JSON for pr_diff or file_read before any of it is trusted. */
export function parseGitHubReadHelperOutput(action: 'pr_diff', stdout: string): PullRequestDiffHelperOutput;
export function parseGitHubReadHelperOutput(action: 'file_read', stdout: string): FileReadHelperOutput;
export function parseGitHubReadHelperOutput(action: 'pr_diff' | 'file_read', stdout: string): PullRequestDiffHelperOutput | FileReadHelperOutput {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    value = undefined;
  }
  const parsed = (action === 'pr_diff' ? PullRequestDiffHelperOutputSchema : FileReadHelperOutputSchema).safeParse(value);
  if (!parsed.success) throw new HarnessError('UNAVAILABLE', `GitHub ${action} returned an unexpected response`, 502, true);
  return parsed.data;
}

/** The workspace and repository a cursor belongs to; a cursor from any other one is refused. */
export function githubReadCursorScope(workspaceId: string, repositoryUrl: string): string {
  return createHash('sha256').update(`${workspaceId}\0${repositoryUrl}`).digest('hex').slice(0, 24);
}

type DiffFileEntry = {
  filename: string;
  previousFilename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patchStatus: 'included' | 'unavailable_upstream' | 'exceeds_response_limit';
  patch?: string;
  patchBytes?: number;
};

function encodeCursor(cursor: PullRequestDiffCursor | FileReadCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function invalidCursor(): HarnessError {
  return new HarnessError('INVALID_INPUT', 'cursor is not valid for this request; omit it to start from the beginning');
}

function budgetTooSmall(budgetBytes: number): HarnessError {
  return new HarnessError('LIMIT_EXCEEDED', `the smallest page of this read does not fit the ${budgetBytes}-byte response limit`);
}

function decodeCursorObject(cursor: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* reported below */ }
  throw invalidCursor();
}

const isIndex = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Reads a pr_diff cursor; it must belong to the same scope and pull request. Head and base are checked against GitHub later. */
export function decodePullRequestDiffCursor(cursor: string | undefined, scope: string, prNumber: number): PullRequestDiffCursor | undefined {
  if (cursor === undefined) return undefined;
  const value = decodeCursorObject(cursor);
  if (value.v !== 1 || value.k !== 'pr_diff' || value.w !== scope || value.pr !== prNumber || !isIndex(value.i)
    || value.i >= PULL_REQUEST_FILES_UPSTREAM_LIMIT || typeof value.b !== 'string' || typeof value.h !== 'string') throw invalidCursor();
  return value as PullRequestDiffCursor;
}

function fileReadBinding(scope: string, path: string, revision: string): string {
  return createHash('sha256').update(`${scope}\0${path}\0${revision}`).digest('hex').slice(0, 24);
}

/** Reads a file_read cursor; it must belong to the same scope, path, and revision. The blob is checked against GitHub later. */
export function decodeFileReadCursor(cursor: string | undefined, scope: string, path: string, revision: string): FileReadCursor | undefined {
  if (cursor === undefined) return undefined;
  const value = decodeCursorObject(cursor);
  if (value.v !== 1 || value.k !== 'file_read' || value.t !== fileReadBinding(scope, path, revision) || typeof value.s !== 'string' || !isIndex(value.o)) {
    throw invalidCursor();
  }
  return value as FileReadCursor;
}

/** The GitHub page that holds the file at `index` when pages hold `pageSize` files. */
export function pullRequestDiffPage(index: number, pageSize: number): { page: number; offset: number } {
  return { page: Math.floor(index / pageSize) + 1, offset: index % pageSize };
}

const byteLength = (text: string) => Buffer.byteLength(text);

/** One pr_diff response from one GitHub page of pull request files, within `budgetBytes`. */
export function shapePullRequestDiffPage(input: {
  prNumber: number;
  scope: string;
  startIndex: number;
  pageSize: number;
  cursor: PullRequestDiffCursor | undefined;
  output: PullRequestDiffHelperOutput;
  budgetBytes: number;
}): string {
  const { prNumber, scope, startIndex, pageSize, cursor, output, budgetBytes } = input;
  if (output.headSha !== output.headShaAfter || output.baseSha !== output.baseShaAfter) {
    throw new HarnessError('STALE_HEAD', `pull request #${prNumber} moved while its files were read; call pr_diff again without a cursor`, 409, true, {
      currentHeadOid: output.headShaAfter,
      expectedHeadOid: output.headSha
    });
  }
  if (cursor && (cursor.h !== output.headSha || cursor.b !== output.baseSha)) {
    throw new HarnessError('STALE_HEAD', `pull request #${prNumber} moved since this cursor was issued (head ${output.headSha}, base ${output.baseSha}); read it again without a cursor`, 409, false, {
      currentHeadOid: output.headSha,
      expectedHeadOid: cursor.h
    });
  }

  const listed = Math.min(output.changedFiles, PULL_REQUEST_FILES_UPSTREAM_LIMIT);
  const pageFiles = output.files.slice(pullRequestDiffPage(startIndex, pageSize).offset);
  // A full GitHub page may have a next one; a short page is the end of what GitHub lists.
  const githubPageFull = output.files.length === pageSize;
  const render = (files: DiffFileEntry[]) => {
    const nextIndex = startIndex + files.length;
    const more = files.length < pageFiles.length || (githubPageFull && nextIndex < listed);
    return JSON.stringify({
      prNumber,
      baseSha: output.baseSha,
      headSha: output.headSha,
      changedFiles: output.changedFiles,
      startIndex,
      files,
      // Every changed file GitHub will not list counts here: those past its listing limit, and any that a
      // listing ending early never reached. The diff is complete only when this is 0 at the last page.
      filesUnavailableUpstream: more
        ? Math.max(0, output.changedFiles - PULL_REQUEST_FILES_UPSTREAM_LIMIT)
        : Math.max(0, output.changedFiles - nextIndex),
      nextCursor: more ? encodeCursor({ v: 1, k: 'pr_diff', w: scope, pr: prNumber, i: nextIndex, b: output.baseSha, h: output.headSha }) : null
    });
  };

  const files: DiffFileEntry[] = [];
  let page = render(files);
  if (byteLength(page) > budgetBytes) throw budgetTooSmall(budgetBytes);
  for (const file of pageFiles) {
    let entry: DiffFileEntry = {
      filename: file.filename,
      ...(file.previousFilename ? { previousFilename: file.previousFilename } : {}),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      ...(typeof file.patch === 'string' ? { patchStatus: 'included' as const, patch: file.patch } : { patchStatus: 'unavailable_upstream' as const })
    };
    let candidate = render([...files, entry]);
    if (byteLength(candidate) > budgetBytes) {
      // A later file starts the next page; only a page's first file may be cut down to fit.
      if (files.length > 0) break;
      if (entry.patch !== undefined) {
        const { patch, ...withoutPatch } = entry;
        entry = { ...withoutPatch, patchStatus: 'exceeds_response_limit', patchBytes: Buffer.byteLength(patch) };
        candidate = render([entry]);
      }
      if (byteLength(candidate) > budgetBytes) throw budgetTooSmall(budgetBytes);
    }
    files.push(entry);
    page = candidate;
  }
  return page;
}

/** Largest offset at or below `end` that starts a UTF-8 character. */
function characterBoundary(bytes: Buffer, end: number): number {
  let boundary = end;
  while (boundary < bytes.length && boundary > 0 && (bytes[boundary]! & 0xc0) === 0x80) boundary -= 1;
  return boundary;
}

/** First offset after the character that starts at `start`. */
function nextCharacter(bytes: Buffer, start: number): number {
  let next = start + 1;
  while (next < bytes.length && (bytes[next]! & 0xc0) === 0x80) next += 1;
  return next;
}

/** One file_read response for a path at a revision, within `budgetBytes`. */
export function shapeFileReadPage(input: {
  scope: string;
  path: string;
  revision: string;
  cursor: FileReadCursor | undefined;
  output: FileReadHelperOutput;
  budgetBytes: number;
  /** Credentials used to read the file. Helper output is redacted while still base64, so decoded content is checked here. */
  credentials: readonly string[];
}): string {
  const { scope, path, revision, cursor, output, budgetBytes, credentials } = input;
  const fits = (text: string) => byteLength(text) <= budgetBytes;
  if (!output.exists) {
    if (cursor) throw new HarnessError('STALE_HEAD', `${path} no longer exists at ${revision}; read it again without a cursor`, 409, false);
    const missing = JSON.stringify({ path, revision, commitSha: output.commitSha, exists: false });
    if (!fits(missing)) throw budgetTooSmall(budgetBytes);
    return missing;
  }
  // A cursor continues only the same regular file: another blob, or the same blob now a symlink, is stale.
  if (cursor && (cursor.s !== output.sha || output.type !== 'file')) {
    throw new HarnessError('STALE_HEAD', `${path} at ${revision} changed since this cursor was issued; read it again without a cursor`, 409, false, {
      currentHeadOid: output.sha,
      expectedHeadOid: cursor.s
    });
  }
  const decode = (): Buffer => {
    if (output.encoding !== 'base64' || typeof output.content !== 'string') {
      throw new HarnessError('UNAVAILABLE', `GitHub returned ${path} at ${revision} without base64 content`, 502, true);
    }
    const bytes = Buffer.from(output.content, 'base64');
    if (credentials.some((credential) => credential.length > 0 && bytes.includes(credential))) {
      throw new HarnessError('FORBIDDEN', `${path} at ${revision} contains the credential used to read it, so its content is not returned`, 403, false);
    }
    return bytes;
  };
  const base = { path, revision, commitSha: output.commitSha, exists: true, type: output.type, sha: output.sha };

  if (output.type === 'dir') {
    const entries = output.entries ?? [];
    // Serialized with entriesTruncated false, the longer spelling, so turning it true never grows the page.
    const empty = JSON.stringify({ ...base, entriesTotal: entries.length, entriesTruncated: false, entries: [] });
    let used = byteLength(empty);
    if (used > budgetBytes) throw budgetTooSmall(budgetBytes);
    const kept: typeof entries = [];
    for (const entry of entries) {
      const size = byteLength(JSON.stringify(entry)) + (kept.length > 0 ? 1 : 0);
      if (used + size > budgetBytes) break;
      kept.push(entry);
      used += size;
    }
    const truncated = kept.length < entries.length || output.entriesTruncatedUpstream === true;
    return JSON.stringify({ ...base, entriesTotal: entries.length, entriesTruncated: truncated, entries: kept });
  }
  if (output.type === 'submodule') {
    // A submodule reports only its commit; its repository is never followed.
    if (!fits(JSON.stringify(base))) throw budgetTooSmall(budgetBytes);
    return JSON.stringify(base);
  }
  if (output.type === 'symlink') {
    // A symlink reports its target, never the content of what it points to.
    const symlink = JSON.stringify({ ...base, target: decode().toString('utf8') });
    if (!fits(symlink)) throw budgetTooSmall(budgetBytes);
    return symlink;
  }

  const size = output.size ?? 0;
  const fileBase = { ...base, size };
  if (size > FILE_READ_MAX_BYTES) {
    const tooLarge = JSON.stringify({ ...fileBase, contentStatus: 'too_large', maxBytes: FILE_READ_MAX_BYTES });
    if (!fits(tooLarge)) throw budgetTooSmall(budgetBytes);
    return tooLarge;
  }
  const bytes = decode();
  if (bytes.length !== size) {
    throw new HarnessError('UNAVAILABLE', `GitHub returned ${bytes.length} of the ${size} bytes of ${path} at ${revision}`, 502, true);
  }
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0) || !isUtf8(bytes)) {
    const binary = JSON.stringify({ ...fileBase, contentStatus: 'binary' });
    if (!fits(binary)) throw budgetTooSmall(budgetBytes);
    return binary;
  }
  const start = cursor?.o ?? 0;
  if (start > bytes.length || (start > 0 && start === bytes.length) || characterBoundary(bytes, start) !== start) throw invalidCursor();

  const render = (end: number) => JSON.stringify({
    ...fileBase,
    contentStatus: 'text',
    offset: start,
    content: bytes.subarray(start, end).toString('utf8'),
    nextCursor: end < bytes.length ? encodeCursor({ v: 1, k: 'file_read', t: fileReadBinding(scope, path, revision), s: output.sha, o: end }) : null
  });
  const whole = render(bytes.length);
  if (fits(whole)) return whole;

  // The rest does not fit, so this page ends before the last byte and carries a cursor. Its size grows with
  // its end, so the largest character boundary that fits is found by binary search. Content is at least
  // as long in JSON as in bytes, so no end past start + budget can fit.
  const smallest = nextCharacter(bytes, start);
  if (smallest >= bytes.length || !fits(render(smallest))) throw budgetTooSmall(budgetBytes);
  const endAt = (offset: number) => Math.max(smallest, characterBoundary(bytes, offset));
  let low = smallest;
  let high = Math.min(bytes.length - 1, start + budgetBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(render(endAt(middle)))) low = middle;
    else high = middle - 1;
  }
  return render(endAt(low));
}
