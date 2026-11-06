/**
 * The Git tab's read shapes (`apps/api/src/dashboard-response.ts` `git_status`, `git_diff`,
 * `git_log`, `worktrees_list`) and the request body of each advanced operation, as the
 * classic tab sends them (`bindGitControls` in `apps/api/dashboard/dashboard.js`).
 */
import { arr, text } from '@/lib/format';

export type GitStatus = {
  branch?: string; upstream?: string;
  ahead: number; behind: number; staged: number; modified: number; untracked: number;
  entries: Array<{ code: string; path: string }>;
};
export type GitCommit = { oid: string; subject: string; author: string; at?: string };
export type Worktree = { name: string; path: string; head: string; branch: string };

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const optional = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

export function gitStatusOf(data: unknown): GitStatus {
  const record = (data ?? {}) as Record<string, unknown>;
  const branch = optional(record.branch);
  const upstream = optional(record.upstream);
  return {
    ...(branch ? { branch } : {}), ...(upstream ? { upstream } : {}),
    ahead: count(record.ahead), behind: count(record.behind),
    staged: count(record.staged), modified: count(record.modified), untracked: count(record.untracked),
    entries: arr(record.entries).map((entry) => ({ code: text(entry.code) || '??', path: text(entry.path) }))
  };
}

export function gitDiffOf(data: unknown): { diff: string; truncated: boolean } {
  const record = (data ?? {}) as Record<string, unknown>;
  return { diff: text(record.diff), truncated: record.truncated === true };
}

export function gitCommitsOf(data: unknown): GitCommit[] {
  return arr((data as Record<string, unknown> | undefined)?.commits).map((commit) => {
    const at = optional(commit.authoredAt) ?? optional(commit.date);
    return {
      oid: text(commit.oid) || text(commit.sha),
      subject: text(commit.subject) || text(commit.message) || 'Commit',
      author: text(commit.author) || 'Unknown author',
      ...(at ? { at } : {})
    };
  });
}

export function worktreesOf(data: unknown): Worktree[] {
  return arr((data as Record<string, unknown> | undefined)?.worktrees).map((tree) => {
    const path = text(tree.path);
    return { name: text(tree.name) || path.split('/').pop() || '', path, head: text(tree.head), branch: text(tree.branch) || 'detached' };
  });
}

export const GIT_ACTIONS = [
  { id: 'fetch', label: 'Fetch from origin', needsRef: false, confirm: false },
  { id: 'pull', label: 'Pull (fast-forward only)', needsRef: false, confirm: false },
  { id: 'checkout', label: 'Checkout a ref', needsRef: true, confirm: true },
  { id: 'branch', label: 'Create a branch', needsRef: true, confirm: false },
  { id: 'merge', label: 'Merge a ref', needsRef: true, confirm: true },
  { id: 'rebase', label: 'Start a rebase', needsRef: true, confirm: true }
] as const;
export type GitAction = (typeof GIT_ACTIONS)[number]['id'];

/** The runner contract body of each operation (`packages/contracts/src/tool-schemas.ts`). */
export function gitActionBody(action: GitAction, argument: string): Record<string, unknown> {
  if (action === 'fetch') return { remote: 'origin' };
  if (action === 'pull') return { remote: 'origin', strategy: 'ff-only' };
  if (action === 'checkout') return { ref: argument };
  if (action === 'branch') return { action: 'create', name: argument };
  if (action === 'merge') return { ref: argument };
  return { action: 'start', upstream: argument };
}

/** What each confirmed operation does to the working tree, in the confirmation's words. */
export const GIT_CONFIRM_COPY: Partial<Record<GitAction, { title: string; description: string; confirmLabel: string }>> = {
  checkout: { title: 'Check out this ref?', description: 'The working tree switches to this ref. Uncommitted changes that conflict with it stop the checkout.', confirmLabel: 'Check out' },
  merge: { title: 'Merge this ref?', description: 'The ref is merged into the current branch. A conflict is reported here and never resolved automatically.', confirmLabel: 'Merge' },
  rebase: { title: 'Start a rebase?', description: 'The current branch is replayed onto this upstream. A conflict stops the rebase and is reported here.', confirmLabel: 'Start rebase' }
};
