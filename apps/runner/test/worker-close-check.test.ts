import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const closeCheck = async () => await executeWorkerRequest('workspace_recover', { mode: 'close_check' });

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
});
