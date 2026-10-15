import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeWorkerRequest } from '../../../worker/harness-worker.mjs';

const temporaryDirectories: string[] = [];

afterEach(() => {
  delete process.env.CH_WORKSPACE_ROOT;
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', [
  '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args
], { cwd, stdio: 'pipe' }).toString();

/** A clone whose only commit is on its remote, so it starts with nothing an automatic close would lose. */
function cleanClone() {
  const base = mkdtempSync(join(tmpdir(), 'cloud-harness-close-check-'));
  temporaryDirectories.push(base);
  const origin = join(base, 'origin');
  const clone = join(base, 'clone');
  git(base, 'init', '--quiet', '--initial-branch=main', origin);
  writeFileSync(join(origin, 'README.md'), '# origin\n');
  git(origin, 'add', 'README.md');
  git(origin, 'commit', '--quiet', '-m', 'initial');
  git(base, 'clone', '--quiet', origin, clone);
  process.env.CH_WORKSPACE_ROOT = clone;
  return clone;
}

const closeCheck = async (input: Record<string, unknown> = {}) => await executeWorkerRequest('workspace_recover', { mode: 'close_check', ...input });
const trackPush = async (branch: string, commit: string | null) => await executeWorkerRequest('workspace_recover', { mode: 'track_push', branch, commit });

describe('workspace close check', () => {
  it('reports a clone with all work on its remote as clean', async () => {
    cleanClone();
    const result = await closeCheck();
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ uncommittedPaths: 0, stashes: 0, unpushedCommits: 0 });
  });

  it('counts modified and untracked files', async () => {
    const clone = cleanClone();
    writeFileSync(join(clone, 'README.md'), '# changed\n');
    writeFileSync(join(clone, 'notes.txt'), 'draft\n');
    expect((await closeCheck()).data).toMatchObject({ uncommittedPaths: 2, stashes: 0, unpushedCommits: 0 });
  });

  it('counts stashes', async () => {
    const clone = cleanClone();
    writeFileSync(join(clone, 'README.md'), '# stashed\n');
    git(clone, 'stash', '--quiet');
    expect((await closeCheck()).data).toMatchObject({ uncommittedPaths: 0, stashes: 1, unpushedCommits: 0 });
  });

  it('counts commits that no remote ref contains, including on branches other than HEAD', async () => {
    const clone = cleanClone();
    writeFileSync(join(clone, 'a.txt'), 'a\n');
    git(clone, 'add', 'a.txt');
    git(clone, 'commit', '--quiet', '-m', 'local on main');
    git(clone, 'switch', '--quiet', '-c', 'side', 'origin/main');
    writeFileSync(join(clone, 'b.txt'), 'b\n');
    git(clone, 'add', 'b.txt');
    git(clone, 'commit', '--quiet', '-m', 'local on side');
    git(clone, 'switch', '--quiet', '--detach', 'origin/main');
    expect((await closeCheck()).data).toMatchObject({ uncommittedPaths: 0, stashes: 0, unpushedCommits: 2 });
  });

  it('fails instead of reporting clean when the directory is not a repository', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-close-check-norepo-'));
    temporaryDirectories.push(directory);
    process.env.CH_WORKSPACE_ROOT = directory;
    expect((await closeCheck()).ok).toBe(false);
  });

  it('treats a commit pushed from a separate transfer repository as saved once the push is tracked', async () => {
    const clone = cleanClone();
    const base = join(clone, '..');
    writeFileSync(join(clone, 'feature.txt'), 'feature\n');
    git(clone, 'add', 'feature.txt');
    git(clone, 'commit', '--quiet', '-m', 'feature');
    // The harness pushes from a bare copy of the checkout, which leaves the checkout's tracking ref behind.
    git(base, 'clone', '--quiet', '--bare', clone, join(base, 'transfer.git'));
    git(join(base, 'origin'), 'config', 'receive.denyCurrentBranch', 'ignore');
    git(join(base, 'transfer.git'), 'push', '--quiet', join(base, 'origin'), 'main:refs/heads/main');
    expect((await closeCheck()).data).toMatchObject({ unpushedCommits: 1 });

    const head = git(clone, 'rev-parse', 'HEAD').trim();
    expect((await trackPush('main', head)).ok).toBe(true);
    expect(git(clone, 'rev-parse', 'refs/remotes/origin/main').trim()).toBe(head);
    expect((await closeCheck()).data).toEqual({ uncommittedPaths: 0, stashes: 0, unpushedCommits: 0 });

    // Deleting the remote branch removes its tracking ref, so the commit counts as unsaved again.
    expect((await trackPush('main', null)).ok).toBe(true);
    expect((await closeCheck()).data).toMatchObject({ unpushedCommits: 2 });
  });

  it('refuses to track a malformed branch or commit', async () => {
    cleanClone();
    expect((await trackPush('../escape', 'a'.repeat(40))).ok).toBe(false);
    expect((await trackPush('-main', 'a'.repeat(40))).ok).toBe(false);
    expect((await trackPush('main', 'HEAD')).ok).toBe(false);
    expect((await trackPush('main.lock', 'a'.repeat(40))).ok).toBe(false);
  });

  it('never moves the remote default branch through the origin/HEAD symbolic ref', async () => {
    const clone = cleanClone();
    const main = git(clone, 'rev-parse', 'refs/remotes/origin/main').trim();
    git(clone, 'commit', '--quiet', '--allow-empty', '-m', 'local');
    const head = git(clone, 'rev-parse', 'HEAD').trim();
    expect((await trackPush('HEAD', head)).ok).toBe(false);
    expect(git(clone, 'rev-parse', 'refs/remotes/origin/main').trim()).toBe(main);
    expect(git(clone, 'symbolic-ref', 'refs/remotes/origin/HEAD').trim()).toBe('refs/remotes/origin/main');
  });

  it('counts the commit a tag clone started from as on the remote', async () => {
    const clone = cleanClone();
    const base = join(clone, '..');
    git(join(base, 'origin'), 'tag', 'v1');
    const tagged = join(base, 'tagged');
    git(base, 'clone', '--quiet', '--branch', 'v1', '--depth', '1', '--no-tags', `file://${join(base, 'origin')}`, tagged);
    process.env.CH_WORKSPACE_ROOT = tagged;
    expect((await closeCheck()).data).toMatchObject({ unpushedCommits: 1 });
    expect((await closeCheck({ cloneRef: 'v1' })).data).toMatchObject({ unpushedCommits: 0 });
    writeFileSync(join(tagged, 'local.txt'), 'local\n');
    git(tagged, 'add', 'local.txt');
    git(tagged, 'commit', '--quiet', '-m', 'local work on a tag clone');
    expect((await closeCheck({ cloneRef: 'v1' })).data).toMatchObject({ unpushedCommits: 1 });
  });

  it('still counts local branches when HEAD is an unborn branch', async () => {
    const clone = cleanClone();
    writeFileSync(join(clone, 'a.txt'), 'a\n');
    git(clone, 'add', 'a.txt');
    git(clone, 'commit', '--quiet', '-m', 'local');
    git(clone, 'checkout', '--quiet', '--orphan', 'empty');
    git(clone, 'rm', '-rf', '--quiet', '.');
    expect((await closeCheck()).data).toMatchObject({ uncommittedPaths: 0, unpushedCommits: 1 });
  });

  it('checks linked worktrees on their own instead of as an untracked directory', async () => {
    const clone = cleanClone();
    git(clone, 'worktree', 'add', '--quiet', '--detach', join('.worktrees', 'review'), 'HEAD');
    expect((await closeCheck()).data).toEqual({ uncommittedPaths: 0, stashes: 0, unpushedCommits: 0 });

    const worktree = join(clone, '.worktrees', 'review');
    writeFileSync(join(worktree, 'one.txt'), 'one\n');
    writeFileSync(join(worktree, 'two.txt'), 'two\n');
    expect((await closeCheck()).data).toMatchObject({ uncommittedPaths: 2, unpushedCommits: 0 });

    git(worktree, 'add', 'one.txt', 'two.txt');
    git(worktree, 'commit', '--quiet', '-m', 'work on a detached worktree');
    // The commit is reachable only from the worktree's detached HEAD, not from any branch.
    expect((await closeCheck()).data).toMatchObject({ uncommittedPaths: 0, unpushedCommits: 1 });
  });

  it('still counts files the repository keeps in its own .worktrees directory', async () => {
    const clone = cleanClone();
    mkdirSync(join(clone, '.worktrees'));
    writeFileSync(join(clone, '.worktrees', 'notes.txt'), 'draft\n');
    git(clone, 'worktree', 'add', '--quiet', '--detach', join('.worktrees', 'review'), 'HEAD');
    expect((await closeCheck()).data).toMatchObject({ uncommittedPaths: 1 });
  });

  it('still counts files left in a worktree directory that lost its link to the repository', async () => {
    const clone = cleanClone();
    const worktree = join(clone, '.worktrees', 'unlinked');
    git(clone, 'worktree', 'add', '--quiet', '--detach', worktree, 'HEAD');
    writeFileSync(join(worktree, 'data.txt'), 'data\n');
    rmSync(join(worktree, '.git'));
    // Both the checked-out README.md and the new file are now untracked files of the main checkout.
    expect((await closeCheck()).data).toMatchObject({ uncommittedPaths: 2 });
  });

  it('reads a worktree path that contains a newline whole', async () => {
    const clone = cleanClone();
    git(clone, 'worktree', 'add', '--quiet', '--detach', join('.worktrees', 'odd\nname'), 'HEAD');
    expect((await closeCheck()).data).toEqual({ uncommittedPaths: 0, stashes: 0, unpushedCommits: 0 });
  });

  it('counts the commits of a worktree whose directory was removed', async () => {
    const clone = cleanClone();
    const worktree = join(clone, '.worktrees', 'gone');
    git(clone, 'worktree', 'add', '--quiet', '--detach', worktree, 'HEAD');
    git(worktree, 'commit', '--quiet', '--allow-empty', '-m', 'orphaned work');
    rmSync(worktree, { recursive: true, force: true });
    expect((await closeCheck()).data).toEqual({ uncommittedPaths: 0, stashes: 0, unpushedCommits: 1 });
  });
});

