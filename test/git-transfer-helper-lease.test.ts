import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const helper = resolve(import.meta.dirname, '../worker/git-transfer-helper.sh');
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Builds a bare "remote", a checkout with two commits on `feature`, and the staged transfer clone the
 * runner pushes from, then drives the real helper in push mode against the local remote. The lease is
 * enforced by the receiving git, so these cases exercise the same compare-and-swap GitHub applies.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'transfer-lease-'));
  directories.push(root);
  const remote = join(root, 'remote.git');
  const checkout = join(root, 'checkout');
  const transfer = join(root, 'transfer.git');
  git(root, 'init', '--bare', remote);
  git(root, 'init', checkout);
  git(checkout, 'commit', '--allow-empty', '-m', 'base');
  const base = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'push', remote, 'HEAD:refs/heads/main');
  git(checkout, 'checkout', '-b', 'feature');
  git(checkout, 'commit', '--allow-empty', '-m', 'next');
  const next = git(checkout, 'rev-parse', 'HEAD');
  expect(spawnSync('bash', [helper, 'stage-push', remote, checkout, transfer], { input: '\n', encoding: 'utf8' }).status).toBe(0);

  const push = (refspec: string, lease = '') =>
    spawnSync('bash', [helper, 'push', remote, checkout, transfer, refspec, lease], { input: '\n', encoding: 'utf8' });
  const remoteRef = (name: string) => {
    const result = spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', name], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  return { base, next, push, remoteRef };
}

// The helper is a POSIX shell script that runs only inside the Linux executor container.
describe.skipIf(process.platform === 'win32')('git-transfer-helper push leases', () => {
  it('creates a ref only while it is absent, so a second create-only push collides', () => {
    const { base, next, push, remoteRef } = fixture();
    const created = push('refs/heads/main:refs/heads/merge-lock', 'absent');
    expect(created.status).toBe(0);
    expect(remoteRef('refs/heads/merge-lock')).toBe(base);

    const collision = push('refs/heads/feature:refs/heads/merge-lock', 'absent');
    expect(collision.status).not.toBe(0);
    expect(collision.stdout + collision.stderr).toContain('stale info');
    expect(remoteRef('refs/heads/merge-lock')).toBe(base);
    expect(next).not.toBe(base);
  });

  it('rejects a create-only push when the branch already holds the pushed commit', () => {
    const { base, push, remoteRef } = fixture();
    expect(push('refs/heads/main:refs/heads/merge-lock', 'absent').status).toBe(0);

    const sameCommit = push('refs/heads/main:refs/heads/merge-lock', 'absent');
    expect(sameCommit.status).not.toBe(0);
    expect(sameCommit.stderr).toContain('lease rejected');
    expect(remoteRef('refs/heads/merge-lock')).toBe(base);
  });

  it('rejects a compare-and-swap push whose stale lease names an older commit than the branch already holds', () => {
    const { base, next, push, remoteRef } = fixture();
    expect(push('refs/heads/feature:refs/heads/main', base).status).toBe(0);

    const stale = push('refs/heads/feature:refs/heads/main', base);
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain('lease rejected');
    expect(push('refs/heads/feature:refs/heads/main', next).status).toBe(0);
    expect(remoteRef('refs/heads/main')).toBe(next);
  });

  it('reports a lost lease as a porcelain status line on stdout', () => {
    const { next, push } = fixture();
    const mismatch = push('refs/heads/feature:refs/heads/main', next);
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stdout).toMatch(/^!\t\S+\t\[rejected\] \(stale info\)$/m);
    expect(mismatch.stderr).toContain('failed to push some refs');
  });

  it('updates a ref only when it still holds the expected object ID', () => {
    const { base, next, push, remoteRef } = fixture();
    const mismatch = push('refs/heads/feature:refs/heads/main', next);
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stdout + mismatch.stderr).toContain('stale info');
    expect(remoteRef('refs/heads/main')).toBe(base);

    expect(push('refs/heads/feature:refs/heads/main', base).status).toBe(0);
    expect(remoteRef('refs/heads/main')).toBe(next);
  });

  it('deletes a ref only when it still holds the expected object ID', () => {
    const { base, next, push, remoteRef } = fixture();
    expect(push('refs/heads/main:refs/heads/merge-lock', 'absent').status).toBe(0);

    const mismatch = push(':refs/heads/merge-lock', next);
    expect(mismatch.status).not.toBe(0);
    expect(remoteRef('refs/heads/merge-lock')).toBe(base);

    expect(push(':refs/heads/merge-lock', base).status).toBe(0);
    expect(remoteRef('refs/heads/merge-lock')).toBeNull();
  });

  it('refuses unleased deletes, create-only deletes, malformed leases, and non-branch destinations', () => {
    const { base, push, remoteRef } = fixture();
    expect(push(':refs/heads/main').stderr).toContain('requires an expected object ID lease');
    expect(push(':refs/heads/main', 'absent').stderr).toContain('cannot delete a branch');
    expect(push('refs/heads/feature:refs/heads/main', 'HEAD~1').stderr).toContain('invalid expected remote object ID');
    expect(push('refs/heads/feature:refs/tags/v1', base).stderr).toContain('destination must be a branch');
    expect(push('refs/heads/feature', base).stderr).toContain('explicit destination ref');
    expect(remoteRef('refs/heads/main')).toBe(base);
  });
});
