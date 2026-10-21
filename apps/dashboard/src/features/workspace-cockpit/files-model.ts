/**
 * The Files tab's read shapes (`apps/api/src/dashboard-response.ts` `files_list`, `files_read`)
 * and its path arithmetic. Paths are workspace-relative and `.` is the workspace root; the
 * runner validates every path again, so these helpers only build what the operator clicked.
 */
import { arr, text } from '@/lib/format';

export type FileEntry = { name: string; type: string };
export type FileListing = { path: string; entries: FileEntry[] };
export type FileContent = { path: string; content: string; sha256: string; bytes?: number };

export const WORKSPACE_ROOT = '.';

export function listingOf(data: unknown): FileListing {
  const record = (data ?? {}) as Record<string, unknown>;
  const entries = arr(record.entries)
    .map((entry) => ({ name: text(entry.name), type: text(entry.type) || 'file' }))
    .filter((entry) => entry.name !== '');
  // Folders first, then files, each alphabetical: the order an operator scans a tree in.
  entries.sort((left, right) => Number(right.type === 'directory') - Number(left.type === 'directory') || left.name.localeCompare(right.name));
  return { path: text(record.path) || WORKSPACE_ROOT, entries };
}

export function fileOf(data: unknown): FileContent | undefined {
  const record = (data ?? {}) as Record<string, unknown>;
  if (typeof record.path !== 'string' || typeof record.content !== 'string' || typeof record.sha256 !== 'string') return undefined;
  return { path: record.path, content: record.content, sha256: record.sha256, ...(typeof record.bytes === 'number' ? { bytes: record.bytes } : {}) };
}

/** `base/name`, with the root written as `.` (the legacy `join`). */
export function joinPath(base: string, name: string): string {
  return !base || base === WORKSPACE_ROOT ? name : `${base.replace(/\/+$/, '')}/${name}`;
}

/** The folder that holds `path`; the root's parent is the root. */
export function parentPath(path: string): string {
  const index = path.replace(/\/+$/, '').lastIndexOf('/');
  return index <= 0 ? WORKSPACE_ROOT : path.slice(0, index);
}

/** Breadcrumb steps under the root: `a/b/c` → `a`, `a/b`, `a/b/c`. */
export function pathCrumbs(path: string): Array<{ label: string; path: string }> {
  if (!path || path === WORKSPACE_ROOT) return [];
  const parts = path.split('/').filter(Boolean);
  return parts.map((label, index) => ({ label, path: parts.slice(0, index + 1).join('/') }));
}

/** What "Copy my changes" puts on the clipboard after a conflicting text patch (legacy wording). */
export function patchCopyText(oldText: string, newText: string): string {
  return `Text to replace:\n${oldText}\n\nReplacement text:\n${newText}`;
}
