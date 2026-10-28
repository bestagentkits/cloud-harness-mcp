/**
 * Pure view-model helpers for the workspace explorer. Nothing here touches the DOM or the host
 * bridge, so the bounds, parsing and error mapping are unit-tested in Node.
 */

/** Bytes requested per file preview read; matches the files_read default. */
export const PREVIEW_BYTES = 65_536;
/** Bytes requested per diff page and the most diff text the view keeps in memory. */
export const DIFF_CHUNK_BYTES = 65_536;
export const DIFF_MAX_BYTES = 1_048_576;
/** Diff lines rendered per page, so one huge diff never builds an unbounded DOM. */
export const DIFF_PAGE_LINES = 400;
/** Entries requested per directory page and task page. */
export const LIST_PAGE_SIZE = 200;
/** Characters of task output kept per task view; older output is dropped first. */
export const TASK_OUTPUT_MAX_CHARS = 262_144;
/** Longest error detail shown; server messages are already redacted, this only keeps layout sane. */
const MAX_ERROR_DETAIL = 300;

/**
 * Reads the ToolResult envelope from a tools/call result. A result without the envelope is
 * reported as an error rather than guessed at.
 */
export function parseToolResult(result) {
  const envelope = result && typeof result === 'object' ? result.structuredContent : undefined;
  if (!envelope || typeof envelope !== 'object' || typeof envelope.ok !== 'boolean') {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'The server returned an unexpected result.' }, truncated: false };
  }
  return {
    ok: envelope.ok,
    data: envelope.data,
    error: envelope.ok ? undefined : (envelope.error ?? { code: 'INTERNAL_ERROR', message: envelope.message ?? 'Request failed.' }),
    truncated: envelope.truncated === true,
    cursor: typeof envelope.cursor === 'string' ? envelope.cursor : undefined
  };
}

const ERROR_KINDS = {
  EXPIRED: { kind: 'expired', title: 'Workspace expired' },
  NOT_FOUND: { kind: 'not-found', title: 'Not found' },
  FORBIDDEN: { kind: 'denied', title: 'Access denied' },
  AUTHENTICATION_FAILED: { kind: 'denied', title: 'Sign-in required' },
  AUTHORIZATION_REQUIRED: { kind: 'denied', title: 'Authorization required' },
  LIMIT_EXCEEDED: { kind: 'too-large', title: 'Too large to show' },
  CONFLICT: { kind: 'conflict', title: 'Content changed' },
  UNAVAILABLE: { kind: 'unavailable', title: 'Temporarily unavailable' },
  TIMEOUT: { kind: 'unavailable', title: 'Timed out' },
  DEPENDENCY_EGRESS_UNAVAILABLE: { kind: 'unavailable', title: 'Workspace network unavailable' }
};

/** Maps an error envelope to a display state. The detail is the server's own (redacted) message. */
export function describeError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR';
  const known = ERROR_KINDS[code] ?? { kind: 'error', title: 'Request failed' };
  const raw = typeof error?.message === 'string' && error.message.length > 0 ? error.message : 'No details were provided.';
  const detail = raw.length > MAX_ERROR_DETAIL ? `${raw.slice(0, MAX_ERROR_DETAIL - 1)}…` : raw;
  return { ...known, code, detail };
}

/** Classifies a workspace_status record for the header and for gating reads. */
export function workspaceState(record) {
  const status = typeof record?.status === 'string' ? record.status : '';
  const lease = typeof record?.leaseState === 'string' ? record.leaseState : '';
  if (status === 'CLOSED') return 'closed';
  if (status === 'FAILED') return 'failed';
  if (status === 'EXPIRED_RECOVERABLE' || lease === 'EXPIRED' || lease === 'EXPIRED_RECOVERABLE') return 'expired';
  if (status === 'ACTIVE') return lease === 'WARNING' ? 'expiring' : 'active';
  return 'unavailable';
}

export function isReadable(state) {
  return state === 'active' || state === 'expiring';
}

/**
 * The repository selector to use for a workspace record. A multi-repository workspace requires
 * one for Git tools, so an unset or stale selection falls back to the primary repository's alias.
 * Single-repository workspaces need none.
 */
export function selectRepository(repositories, selected) {
  const entries = Array.isArray(repositories) ? repositories.filter((entry) => typeof entry?.alias === 'string') : [];
  if (entries.length <= 1) return undefined;
  if (typeof selected === 'string' && entries.some((entry) => entry.alias === selected || entry.repositoryId === selected)) return selected;
  return (entries.find((entry) => entry.primary === true) ?? entries[0]).alias;
}

/** Workspace-relative path helpers. Paths stay relative; the server rejects anything else. */
export function joinPath(directory, name) {
  return !directory || directory === '.' ? name : `${directory}/${name}`;
}

export function parentPath(path) {
  if (!path || path === '.') return '.';
  const index = path.lastIndexOf('/');
  return index < 0 ? '.' : path.slice(0, index);
}

export function breadcrumbs(path) {
  const crumbs = [{ label: 'root', path: '.' }];
  if (!path || path === '.') return crumbs;
  let current = '.';
  for (const part of path.split('/')) {
    current = joinPath(current, part);
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

/** Directories first, then by name, using only the fields files_list returns. */
export function sortEntries(entries) {
  const valid = Array.isArray(entries) ? entries.filter((entry) => typeof entry?.name === 'string' && typeof entry?.type === 'string') : [];
  return valid.sort((left, right) => {
    const rank = (entry) => (entry.type === 'directory' ? 0 : 1);
    return rank(left) - rank(right) || left.name.localeCompare(right.name);
  });
}

/**
 * files_read decodes bytes as UTF-8, so binary content arrives with NULs or replacement
 * characters. Either is treated as binary and not rendered.
 */
export function looksBinary(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (text.includes('\0')) return true;
  const sample = text.slice(0, 8_192);
  let replaced = 0;
  for (const char of sample) if (char === '�') replaced += 1;
  return replaced > 0 && replaced / sample.length > 0.01;
}

/** Parses `git status --short --branch` output into a branch line and changed entries. */
export function parseGitStatus(output) {
  const lines = typeof output === 'string' ? output.split('\n').filter((line) => line.length > 0) : [];
  let branch = '';
  const files = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      branch = line.slice(3);
      continue;
    }
    files.push({ code: line.slice(0, 2), path: line.slice(3) });
  }
  return { branch, files };
}

/** Splits unified diff text into typed lines. */
export function diffLines(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  return lines.map((line) => ({ kind: diffKind(line), text: line }));
}

function diffKind(line) {
  if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('+++ ') || line.startsWith('--- ')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}

/** One page of lines plus the page count, clamping out-of-range pages. */
export function pageOf(lines, page, size = DIFF_PAGE_LINES) {
  const pages = Math.max(1, Math.ceil(lines.length / size));
  const current = Math.min(Math.max(0, Number.isInteger(page) ? page : 0), pages - 1);
  return { lines: lines.slice(current * size, (current + 1) * size), page: current, pages };
}

/** Keeps the newest `maxChars` of appended text, so polling task output stays bounded. */
export function appendBounded(existing, chunk, maxChars = TASK_OUTPUT_MAX_CHARS) {
  const combined = `${existing ?? ''}${chunk ?? ''}`;
  if (combined.length <= maxChars) return { text: combined, dropped: false };
  return { text: combined.slice(combined.length - maxChars), dropped: true };
}

export const TASK_STATES = ['queued', 'running', 'blocked', 'succeeded', 'failed', 'cancelled'];

export function isTerminalTask(status) {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/** Counts tasks per state for the summary row; unknown states are counted as their own key. */
export function summarizeTasks(tasks) {
  const counts = Object.fromEntries(TASK_STATES.map((state) => [state, 0]));
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const state = typeof task?.status === 'string' ? task.status : 'unknown';
    counts[state] = (counts[state] ?? 0) + 1;
  }
  return counts;
}

/** Dependencies of each task id from tasks_graph edges (`from` must finish before `to`). */
export function dependenciesByTask(edges) {
  const map = new Map();
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (typeof edge?.from !== 'string' || typeof edge?.to !== 'string') continue;
    if (!map.has(edge.to)) map.set(edge.to, []);
    map.get(edge.to).push(edge.from);
  }
  return map;
}

/** Human lease remaining, e.g. "1h 5m"; empty when unknown. */
export function formatRemaining(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  if (ms <= 0) return 'expired';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
