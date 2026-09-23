/**
 * History specs are the single positional argument the clone and transfer helpers read to decide how much
 * Git history to transfer. They are built only from schema-validated integers, booleans, and ISO dates, so a
 * spec never carries option-like or shell-significant text into a helper container.
 *
 * - `''`          helper default (clone: one commit; fetch: no depth change)
 * - `full`        complete history (clone without depth; fetch with --unshallow on a shallow checkout)
 * - `depth:N`     N commits from each tip
 * - `since:DATE`  commits newer than DATE
 */
export function cloneHistorySpec(fetchDepth?: number, shallowSince?: string): string {
  if (shallowSince !== undefined) return `since:${shallowSince}`;
  if (fetchDepth === undefined) return '';
  return fetchDepth === 0 ? 'full' : `depth:${fetchDepth}`;
}

export function fetchHistorySpec(depth?: number, unshallow?: boolean, shallowSince?: string): string {
  if (unshallow === true) return 'full';
  if (shallowSince !== undefined) return `since:${shallowSince}`;
  return depth === undefined ? '' : `depth:${depth}`;
}
