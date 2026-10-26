/**
 * Read-only Git inspection for the runner's own commit and push steps. The agent and its verify command
 * run arbitrary code in the checkout, including Git and its configuration, so the runner never trusts a
 * listing it did not produce itself, and the read that decides what is published happens on the staged
 * transfer clone the push sends from (see `PushVerifier`), never on the checkout.
 *
 * The checkout reads here (HEAD and the working-tree changes before staging, and the commit just made)
 * are a defence in depth: every listing is NUL-separated (no quoting to undo), carries the executor's
 * truncation flag, and a caller refuses to act on a truncated listing. Commit parents are taken from the
 * raw commit object, which grafts and replace refs cannot reshape.
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
/** `author` and `committer` are the identities (`Name <email>`) of the raw commit headers, without their dates. */
export type CodingGitCommit = {
  sha: string; parents: string[]; author: string | null; committer: string | null; message: string; paths: string[]; truncated: boolean;
};

export type CodingGitPort = {
  /** HEAD and every changed, staged or untracked path of the working tree. */
  status(ownerId: string, workspaceId: string, signal: AbortSignal): Promise<CodingGitResult<CodingGitStatus>>;
  /** The commit `revision` resolves to, its parents and message, and the paths it changes relative to `base`. */
  commit(ownerId: string, workspaceId: string, revision: string, base: string, signal: AbortSignal): Promise<CodingGitResult<CodingGitCommit>>;
  /** The unified diff of commit `sha` against `base`, for the owner to review; never used to decide a push. */
  diff(ownerId: string, workspaceId: string, base: string, sha: string, signal: AbortSignal): Promise<CodingGitResult<{ text: string; truncated: boolean }>>;
};

/**
 * Decides a push from the staged transfer clone, after it is staged and before anything is sent. The
 * workspace service reads the commit `sha` in that clone with a clean configuration and hands it over
 * (`null` when the clone holds no such commit or the read is malformed); a returned code refuses the
 * push, the clone is discarded, and nothing reaches the remote.
 */
export type PushVerifier = {
  sha: string;
  base: string;
  verify(commit: CodingGitCommit | null): Promise<string | null>;
  /**
   * Told when the transfer helper failed to stage or inspect the clone, so nothing could be decided.
   * Only those two steps report it: a failure around them (a credential, the executor pause, the remote
   * probe) says nothing about the checkout.
   */
  stagingFailed?(): void;
};

/**
 * The alternate refs command a checkout's configuration cannot replace: `true` lists no refs and prints
 * nothing, where an empty value makes Git report that it cannot run the command.
 */
const NO_ALTERNATE_REFS = 'core.alternateRefsCommand=true';

/** The only Git subcommands the inspection port runs; the workspace service refuses anything else. */
export const CODING_GIT_SUBCOMMANDS = new Set(['rev-parse', 'status', 'cat-file', 'diff-tree']);

/**
 * Environment of a checkout inspection: no system or global configuration, replace objects or grafts,
 * and no optional index writes.
 */
export const CODING_GIT_ENV: readonly string[] = [
  'HOME=/tmp', 'GIT_CONFIG_NOSYSTEM=1', 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_NO_REPLACE_OBJECTS=1', 'GIT_GRAFT_FILE=/dev/null/no-grafts',
  'GIT_TERMINAL_PROMPT=0', 'GIT_OPTIONAL_LOCKS=0'
];

/**
 * Options of a checkout inspection, run in the checkout root, that override what its own configuration
 * sets: replace refs (a repository's core.useReplaceRefs re-enables them otherwise), relative diff
 * listings, hooks, fsmonitor, pagers, path quoting and the alternate refs command. The Git directory and
 * work tree are named explicitly, so core.worktree cannot move the listing elsewhere. The graft file is a
 * path that can never exist, so no grafts are read and no graft hint is printed.
 */
export const CODING_GIT_ARGS: readonly string[] = [
  '--no-replace-objects', '--git-dir=.git', '--work-tree=.',
  '-c', 'core.useReplaceRefs=false', '-c', 'diff.relative=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
  '-c', 'core.pager=cat', '-c', 'core.quotePath=false', '-c', NO_ALTERNATE_REFS, '-c', 'core.alternateRefsPrefixes='
];

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

type ParsedCommit = { parents: string[]; author: string | null; committer: string | null; message: string };

/** The identity of an `author` or `committer` header value (`Name <email> <seconds> <zone>`), without its date. */
function identity(value: string | undefined): string | null {
  const match = value === undefined ? null : /^(.*<[^<>\n]*>) -?\d+ [+-]\d{4}$/u.exec(value);
  return match?.[1] ?? null;
}

/**
 * Parents, identities and message of a raw commit object (`git cat-file commit`). The parents are the
 * object's own `parent` headers, so neither a graft nor a replace ref can change them. As Git reads a
 * commit, they are the run of `parent` headers right after `tree`: a `parent` header after any other
 * header is not a parent. Null when it is not a commit.
 */
export function parseCommitObject(raw: string): ParsedCommit | null {
  const end = raw.indexOf('\n\n');
  const header = end === -1 ? raw : raw.slice(0, end);
  const lines = header.split('\n');
  if (!/^tree [a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(lines[0] ?? '')) return null;
  const parents: string[] = [];
  let index = 1;
  for (; index < lines.length && lines[index]!.startsWith('parent '); index += 1) {
    const parent = lines[index]!.slice('parent '.length);
    if (!SHA.test(parent)) return null;
    parents.push(parent);
  }
  const rest = lines.slice(index);
  const field = (name: string) => rest.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1);
  return { parents, author: identity(field('author')), committer: identity(field('committer')), message: end === -1 ? '' : raw.slice(end + 2) };
}

/**
 * The transfer helper's `inspect` answer (see `worker/git-transfer-helper.sh`): the resolved commit id,
 * the raw commit in base64, `paths` or `no-base`, then the NUL-separated paths against the base. Null
 * when the clone holds no such commit or the answer is malformed; a base the clone lacks yields no paths
 * (the parent check refuses such a commit anyway).
 */
export function parseTransferInspection(stdout: string, truncated: boolean): CodingGitCommit | null {
  const first = stdout.indexOf('\n');
  const second = first === -1 ? -1 : stdout.indexOf('\n', first + 1);
  const third = second === -1 ? -1 : stdout.indexOf('\n', second + 1);
  const sha = (first === -1 ? stdout : stdout.slice(0, first)).trim();
  if (!SHA.test(sha) || second === -1) return null;
  const encoded = stdout.slice(first + 1, second);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return null;
  const commit = parseCommitObject(Buffer.from(encoded, 'base64').toString('utf8'));
  if (!commit) return null;
  const marker = third === -1 ? stdout.slice(second + 1) : stdout.slice(second + 1, third);
  if (marker === 'no-base') return { sha, ...commit, paths: [], truncated };
  if (marker !== 'paths' || third === -1) return null;
  return { sha, ...commit, paths: nulPaths(stdout.slice(third + 1)), truncated };
}

function failure(error: unknown): { ok: false; code: string; retryable: boolean } {
  const record = error as { code?: unknown; retryable?: unknown } | null;
  return {
    ok: false,
    code: typeof record?.code === 'string' ? record.code.slice(0, 60) : 'GIT_INSPECT_FAILED',
    retryable: record?.retryable === true
  };
}

const inspectFailed = () => Object.assign(new Error('git inspection failed'), { code: 'GIT_INSPECT_FAILED', retryable: false });

export function createCodingGitPort(run: CodingGitRunner): CodingGitPort {
  const git = async (ownerId: string, workspaceId: string, args: readonly string[], signal: AbortSignal) => {
    const result = await run(ownerId, workspaceId, args, signal);
    if (result.exitCode !== 0) throw inspectFailed();
    return result;
  };
  const resolve = async (ownerId: string, workspaceId: string, revision: string, signal: AbortSignal): Promise<string> => {
    const sha = (await git(ownerId, workspaceId, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], signal)).stdout.trim();
    if (!SHA.test(sha)) throw inspectFailed();
    return sha;
  };
  return {
    async status(ownerId, workspaceId, signal) {
      try {
        const head = await resolve(ownerId, workspaceId, 'HEAD', signal);
        // The one porcelain read: changes that are not committed yet exist only in the working tree, so no
        // plumbing read of objects (and no transfer clone) can list them. Porcelain v1 is Git's stable machine
        // format: status.* display settings do not apply to it, and unlike a raw index diff it compares
        // content, not just file timestamps. What it lists is gated again from the commit on the transfer clone.
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
        const raw = await git(ownerId, workspaceId, ['cat-file', 'commit', sha], signal);
        const parsed = raw.truncated ? null : parseCommitObject(raw.stdout);
        if (!parsed) throw inspectFailed();
        const diff = await git(ownerId, workspaceId, ['diff-tree', '-r', '--no-renames', '--no-commit-id', '--name-only', '-z', base, sha, '--'], signal);
        return { ok: true, data: { sha, ...parsed, paths: nulPaths(diff.stdout), truncated: diff.truncated } };
      } catch (error) {
        return failure(error);
      }
    },
    async diff(ownerId, workspaceId, base, sha, signal) {
      if (!SHA.test(base) || !SHA.test(sha)) return { ok: false, code: 'GIT_INSPECT_FAILED', retryable: false };
      try {
        // Plumbing with external diff drivers and text conversion off, so the checkout's configuration
        // cannot run a program while the diff is read.
        const patch = await git(ownerId, workspaceId, ['diff-tree', '-r', '-p', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', base, sha, '--'], signal);
        return { ok: true, data: { text: patch.stdout, truncated: patch.truncated } };
      } catch (error) {
        return failure(error);
      }
    }
  };
}
