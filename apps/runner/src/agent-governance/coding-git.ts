/**
 * Read-only Git inspection of a coding checkout, for the runner's own commit and push steps. The agent
 * and its verify command run arbitrary code in the checkout, so the runner never trusts a listing it did
 * not produce itself: it reads HEAD and the working-tree changes before staging, and the paths of the
 * exact commit it is about to push. Every listing is NUL-separated (no quoting to undo) and carries the
 * executor's truncation flag; a caller refuses to act on a truncated listing.
 */

/** One Git invocation in the checkout: fixed arguments, bounded output, never a shell. */
export type CodingGitRunner = (
  ownerId: string,
  workspaceId: string,
  args: readonly string[],
  signal: AbortSignal
) => Promise<{ exitCode: number; stdout: string; truncated: boolean }>;

export type CodingGitResult<T> = { ok: true; data: T } | { ok: false; code: string; retryable: boolean };

export type CodingGitStatus = { head: string; paths: string[]; truncated: boolean };
export type CodingGitCommit = { sha: string; parents: string[]; message: string; paths: string[]; truncated: boolean };

export type CodingGitPort = {
  /** HEAD and every changed, staged or untracked path of the working tree. */
  status(ownerId: string, workspaceId: string, signal: AbortSignal): Promise<CodingGitResult<CodingGitStatus>>;
  /** The commit `revision` resolves to, its parents and message, and the paths it changes relative to `base`. */
  commit(ownerId: string, workspaceId: string, revision: string, base: string, signal: AbortSignal): Promise<CodingGitResult<CodingGitCommit>>;
};

/** The only Git subcommands the inspection port runs; the workspace service refuses anything else. */
export const CODING_GIT_SUBCOMMANDS = new Set(['rev-parse', 'status', 'rev-list', 'log', 'diff']);

const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const REVISION = /^(?:HEAD|[a-f0-9]{40}(?:[a-f0-9]{24})?)$/u;

export const isCommitSha = (value: unknown): value is string => typeof value === 'string' && SHA.test(value);

/** Paths of `git status --porcelain=v1 -z --no-renames`: each entry is `XY <path>`, NUL-terminated. */
export function porcelainPaths(output: string): string[] {
  const paths = new Set<string>();
  for (const entry of output.split('\0')) {
    if (entry.length < 4) continue;
    paths.add(entry.slice(3));
  }
  return [...paths].sort();
}

/** Paths of a `-z` name listing. */
export function nulPaths(output: string): string[] {
  return [...new Set(output.split('\0').filter((entry) => entry.length > 0))].sort();
}

function failure(error: unknown): { ok: false; code: string; retryable: boolean } {
  const record = error as { code?: unknown; retryable?: unknown } | null;
  return {
    ok: false,
    code: typeof record?.code === 'string' ? record.code.slice(0, 60) : 'GIT_INSPECT_FAILED',
    retryable: record?.retryable === true
  };
}

export function createCodingGitPort(run: CodingGitRunner): CodingGitPort {
  const git = async (ownerId: string, workspaceId: string, args: readonly string[], signal: AbortSignal) => {
    const result = await run(ownerId, workspaceId, args, signal);
    if (result.exitCode !== 0) throw Object.assign(new Error('git inspection failed'), { code: 'GIT_INSPECT_FAILED', retryable: false });
    return result;
  };
  const resolve = async (ownerId: string, workspaceId: string, revision: string, signal: AbortSignal): Promise<string> => {
    const sha = (await git(ownerId, workspaceId, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], signal)).stdout.trim();
    if (!SHA.test(sha)) throw Object.assign(new Error('not a commit'), { code: 'GIT_INSPECT_FAILED', retryable: false });
    return sha;
  };
  return {
    async status(ownerId, workspaceId, signal) {
      try {
        const head = await resolve(ownerId, workspaceId, 'HEAD', signal);
        const listed = await git(ownerId, workspaceId, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=none'], signal);
        return { ok: true, data: { head, paths: porcelainPaths(listed.stdout), truncated: listed.truncated } };
      } catch (error) {
        return failure(error);
      }
    },
    async commit(ownerId, workspaceId, revision, base, signal) {
      if (!REVISION.test(revision) || !SHA.test(base)) return { ok: false, code: 'GIT_INSPECT_FAILED', retryable: false };
      try {
        const sha = await resolve(ownerId, workspaceId, revision, signal);
        const parents = (await git(ownerId, workspaceId, ['rev-list', '--parents', '-n', '1', sha, '--'], signal)).stdout.trim().split(' ').slice(1);
        const message = await git(ownerId, workspaceId, ['log', '-1', '--format=%B', sha, '--'], signal);
        const diff = await git(ownerId, workspaceId, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, sha, '--'], signal);
        return { ok: true, data: { sha, parents, message: message.stdout, paths: nulPaths(diff.stdout), truncated: message.truncated || diff.truncated } };
      } catch (error) {
        return failure(error);
      }
    }
  };
}
