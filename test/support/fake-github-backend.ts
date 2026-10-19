import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A GitHub stand-in for coding-workflow tests. The repository is a local bare Git remote seeded from
 * a fixture on `main`; pull requests and issue comments live in memory. Faults are one-shot and are
 * applied either before the effect (nothing happened) or after it (the effect happened, but its answer
 * is lost), which is the distinction the coding pipeline's reconciliation has to get right.
 */

export const FAKE_GITHUB_REPOSITORY = 'acme/widgets';
const GIT_IDENTITY = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false'];

/**
 * - `rate-limit`: HTTP 429 before the effect (retryable).
 * - `server-error`: HTTP 500 before the effect (retryable).
 * - `timeout-after-effect`: the effect happens, then the call times out.
 * - `crash-after-effect`: the effect happens, then the runner dies before it records the outcome; the
 *   call never answers, and `crashed` resolves so the test can restart the runner.
 * - `unreadable`: a read that cannot reach GitHub.
 */
export type GitHubFault = 'rate-limit' | 'server-error' | 'timeout-after-effect' | 'crash-after-effect' | 'unreadable';
export type GitHubFaultTarget = 'push' | 'pr_create' | 'ref_get' | 'pr_list' | 'commit';

export type FakePullRequest = {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  url: string;
  /** A pull request from a fork: its head branch lives in another repository. */
  crossRepository: boolean;
};

export type FakeCallResult = { ok: boolean; data?: unknown; error?: { code: string; retryable?: boolean } };

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

export class FakeGitHubBackend {
  readonly remote: string;
  readonly pulls: FakePullRequest[] = [];
  readonly comments: { issueNumber: number; body: string }[] = [];
  /** Branches the remote accepted, one entry per effective push. */
  readonly pushes: { branch: string; oid: string }[] = [];
  /** Every push request that reached the backend, effective or not. */
  pushAttempts = 0;
  private readonly faults = new Map<GitHubFaultTarget, GitHubFault[]>();
  private readonly commentKeys = new Set<string>();
  private crash = Promise.withResolvers<GitHubFaultTarget>();

  private constructor(root: string) {
    this.remote = join(root, 'remote.git');
  }

  /** Creates the bare remote with one commit on `main` holding the fixture tree; `branches` start at that commit too. */
  static create(root: string, fixture: string, branches: readonly string[] = []): FakeGitHubBackend {
    const backend = new FakeGitHubBackend(root);
    mkdirSync(backend.remote, { recursive: true });
    git(backend.remote, ['init', '--quiet', '--bare', '--initial-branch=main']);
    const seed = join(root, 'seed');
    cpSync(fixture, seed, { recursive: true });
    git(seed, ['init', '--quiet', '--initial-branch=main']);
    git(seed, ['add', '-A']);
    git(seed, ['commit', '--quiet', '-m', 'Initial commit']);
    git(seed, ['push', '--quiet', backend.remote, 'main:refs/heads/main', ...branches.map((branch) => `main:refs/heads/${branch}`)]);
    return backend;
  }

  /** Adds a commit writing one file on top of a remote branch; returns its id. */
  commitOn(branch: string, path: string, content: string): string {
    const work = mkdtempSync(join(tmpdir(), 'fake-github-commit-'));
    try {
      git(work, ['clone', '--quiet', '--branch', branch, this.remote, '.']);
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), content);
      git(work, ['add', '-A']);
      git(work, ['commit', '--quiet', '-m', `Update ${path}`]);
      git(work, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
      return git(work, ['rev-parse', 'HEAD']).trim();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** A pull request someone opened from a fork whose branch has the given name. */
  addForkPull(head: string, base: string): FakePullRequest {
    const number = this.pulls.length + 1;
    const pull: FakePullRequest = {
      number, title: 'Fork change', body: '', head, base, state: 'OPEN', crossRepository: true,
      url: `https://github.com/${FAKE_GITHUB_REPOSITORY}/pull/${number}`
    };
    this.pulls.push(pull);
    return pull;
  }

  /** Queues a one-shot fault for the next call to a target. */
  inject(target: GitHubFaultTarget, fault: GitHubFault): void {
    this.faults.set(target, [...(this.faults.get(target) ?? []), fault]);
  }

  /** Resolves with the target of the next simulated crash. */
  get crashed(): Promise<GitHubFaultTarget> {
    return this.crash.promise;
  }

  takeFault(target: GitHubFaultTarget): GitHubFault | undefined {
    const queued = this.faults.get(target);
    const fault = queued?.shift();
    if (queued && queued.length === 0) this.faults.delete(target);
    return fault;
  }

  /** The answer for a fault applied after the effect, or a call that never answers on a crash. */
  async afterEffect(target: GitHubFaultTarget, fault: GitHubFault | undefined, result: FakeCallResult): Promise<FakeCallResult> {
    if (fault === 'timeout-after-effect') return { ok: false, error: { code: 'TIMEOUT', retryable: true } };
    if (fault === 'crash-after-effect') {
      const resolve = this.crash.resolve;
      this.crash = Promise.withResolvers<GitHubFaultTarget>();
      resolve(target);
      // The runner is gone: nothing ever answers this call.
      return await new Promise<never>(() => undefined);
    }
    return result;
  }

  /** The answer for a fault applied before the effect; undefined when the call should proceed. */
  beforeEffect(fault: GitHubFault | undefined): FakeCallResult | undefined {
    if (fault === 'rate-limit') return { ok: false, error: { code: 'GITHUB_RATE_LIMITED', retryable: true } };
    if (fault === 'server-error' || fault === 'unreadable') return { ok: false, error: { code: 'UNAVAILABLE', retryable: true } };
    return undefined;
  }

  /** The commit a remote branch points at, or null when it does not exist. */
  branchOid(branch: string): string | null {
    try {
      return git(this.remote, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).trim() || null;
    } catch {
      return null;
    }
  }

  /** Files of a remote branch, for assertions on what was published. */
  branchFiles(branch: string): string[] {
    return git(this.remote, ['ls-tree', '-r', '--name-only', `refs/heads/${branch}`]).split('\n').filter(Boolean).sort();
  }

  /** Commits on a branch that its base does not have. */
  commitsAhead(branch: string, base = 'main'): string[] {
    return git(this.remote, ['rev-list', `refs/heads/${base}..refs/heads/${branch}`]).split('\n').filter(Boolean);
  }

  remoteBranches(): string[] {
    return git(this.remote, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']).split('\n').filter(Boolean).sort();
  }

  /** Create-only push of `source` (a commit id or HEAD) from the checkout; refuses when the branch already exists. */
  async push(checkout: string, source: string, branch: string, expectedAbsent: boolean): Promise<FakeCallResult> {
    this.pushAttempts += 1;
    const fault = this.takeFault('push');
    const early = this.beforeEffect(fault);
    if (early) return early;
    if (expectedAbsent && this.branchOid(branch) !== null) return { ok: false, error: { code: 'CONFLICT', retryable: false } };
    const oid = git(checkout, ['rev-parse', '--verify', `${source}^{commit}`]).trim();
    git(checkout, ['push', '--quiet', this.remote, `${oid}:refs/heads/${branch}`]);
    this.pushes.push({ branch, oid });
    return await this.afterEffect('push', fault, { ok: true, data: { refspec: `${source}:refs/heads/${branch}` } });
  }

  /** `github_read` with the JSON shapes the runner's GitHub helper returns. */
  read(action: string, input: Record<string, unknown>): FakeCallResult {
    if (action === 'ref_get') {
      const early = this.beforeEffect(this.takeFault('ref_get'));
      if (early) return early;
      const ref = String(input.ref ?? '');
      const oid = this.branchOid(ref.replace(/^refs\/heads\//u, ''));
      return { ok: true, data: { output: JSON.stringify({ ref, oid, objectType: oid ? 'commit' : null, exists: oid !== null }) } };
    }
    if (action === 'pr_list') {
      const early = this.beforeEffect(this.takeFault('pr_list'));
      if (early) return early;
      return {
        ok: true,
        data: {
          output: JSON.stringify(this.pulls.map((pull) => ({
            number: pull.number, title: pull.title, state: pull.state, author: pull.crossRepository ? 'mallory' : 'cloud-harness[bot]',
            headRefName: pull.head, baseRefName: pull.base, isCrossRepository: pull.crossRepository, url: pull.url
          })))
        }
      };
    }
    return { ok: false, error: { code: 'INVALID_INPUT', retryable: false } };
  }

  /** `github_action` for pull requests and issue comments. Merging is not offered: the pipeline never merges. */
  async action(action: string, input: Record<string, unknown>): Promise<FakeCallResult> {
    if (action === 'pr_create') {
      const fault = this.takeFault('pr_create');
      const early = this.beforeEffect(fault);
      if (early) return early;
      const head = String(input.head ?? '');
      const base = String(input.base ?? '');
      if (!head || !base || this.branchOid(head) === null || this.branchOid(base) === null) {
        return { ok: false, error: { code: 'INVALID_INPUT', retryable: false } };
      }
      if (this.pulls.some((pull) => pull.head === head && !pull.crossRepository && pull.state === 'OPEN')) return { ok: false, error: { code: 'CONFLICT', retryable: false } };
      const number = this.pulls.length + 1;
      const url = `https://github.com/${FAKE_GITHUB_REPOSITORY}/pull/${number}`;
      this.pulls.push({ number, title: String(input.title ?? ''), body: String(input.body ?? ''), head, base, state: 'OPEN', url, crossRepository: false });
      return await this.afterEffect('pr_create', fault, { ok: true, data: { output: `${url}\n` } });
    }
    if (action === 'issue_comment') {
      const key = typeof input.idempotencyKey === 'string' ? input.idempotencyKey : null;
      if (key && this.commentKeys.has(key)) return { ok: true, data: { replayed: true } };
      if (key) this.commentKeys.add(key);
      this.comments.push({ issueNumber: Number(input.issueNumber), body: String(input.body ?? '') });
      return { ok: true, data: {} };
    }
    return { ok: false, error: { code: 'INVALID_INPUT', retryable: false } };
  }
}
