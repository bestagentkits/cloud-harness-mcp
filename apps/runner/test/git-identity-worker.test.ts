import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeWorkerRequest } from '../../../worker/harness-worker.mjs';

const directories: string[] = [];

afterEach(() => {
  delete process.env.CH_WORKSPACE_ROOT;
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const SETUP_IDENTITY = ['-c', 'user.name=Setup Author', '-c', 'user.email=setup@example.com', '-c', 'commit.gpgsign=false'];

function run(root: string, args: string[]): string {
  return execFileSync('git', [...SETUP_IDENTITY, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_EDITOR: 'true' }
  }).trim();
}

/** A repository whose `feature` and `main` branches both changed `shared.txt` since their common base. */
function divergentRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'cloud-harness-git-identity-'));
  directories.push(root);
  process.env.CH_WORKSPACE_ROOT = root;
  run(root, ['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'shared.txt'), 'base\n');
  run(root, ['add', 'shared.txt']);
  run(root, ['commit', '-q', '-m', 'base']);
  run(root, ['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(root, 'shared.txt'), 'feature\n');
  run(root, ['commit', '-q', '-am', 'feature change']);
  run(root, ['checkout', '-q', 'main']);
  writeFileSync(join(root, 'main.txt'), 'main\n');
  run(root, ['add', 'main.txt']);
  run(root, ['commit', '-q', '-m', 'main change']);
  return root;
}

const head = (root: string) => run(root, ['log', '-1', '--format=%an|%ae|%cn|%ce']);
const localConfig = (root: string) => {
  try { return run(root, ['config', '--local', '--get-regexp', '^user\\.']); } catch { return ''; }
};

describe('git identity for commit-creating worker operations', () => {
  it('records the injected identity as author and committer of a merge commit, without writing Git config', async () => {
    const root = divergentRepository();
    run(root, ['checkout', '-q', 'feature']);

    const result = await executeWorkerRequest('git_merge', {
      ref: 'main', fastForward: 'allow', authorName: 'Workspace Agent', authorEmail: 'workspace@example.com'
    });

    expect(result.ok, result.message).toBe(true);
    expect(run(root, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ')).toHaveLength(3);
    expect(head(root)).toBe('Workspace Agent|workspace@example.com|Workspace Agent|workspace@example.com');
    expect(localConfig(root)).toBe('');
  });

  // The worker captures its Git environment at import, so an identity exported by the host would win.
  const hostIdentity = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].some((key) => process.env[key]);

  it.skipIf(hostIdentity)('falls back to the harness default identity when neither the runner nor the checkout provides one', async () => {
    const root = divergentRepository();
    run(root, ['checkout', '-q', 'feature']);

    const result = await executeWorkerRequest('git_merge', { ref: 'main', fastForward: 'never' });

    expect(result.ok, result.message).toBe(true);
    expect(head(root)).toBe('Cloud Harness Agent|agent@cloud-harness.local|Cloud Harness Agent|agent@cloud-harness.local');
  });

  it.skipIf(hostIdentity)('keeps an identity the checkout already configures when the runner injects none', async () => {
    const root = divergentRepository();
    run(root, ['checkout', '-q', 'feature']);
    run(root, ['config', 'user.name', 'Checkout Owner']);
    run(root, ['config', 'user.email', 'checkout@example.com']);

    const result = await executeWorkerRequest('git_merge', { ref: 'main', fastForward: 'never' });

    expect(result.ok, result.message).toBe(true);
    expect(head(root)).toBe('Checkout Owner|checkout@example.com|Checkout Owner|checkout@example.com');
  });

  it('continues a rebase when the checkout requires signed commits', async () => {
    const root = divergentRepository();
    run(root, ['checkout', '-q', 'feature']);
    run(root, ['config', 'commit.gpgsign', 'true']);

    const result = await executeWorkerRequest('git_rebase', {
      action: 'start', upstream: 'main', authorName: 'Workspace Agent', authorEmail: 'workspace@example.com'
    });

    expect(result.ok, result.message).toBe(true);
    expect(head(root)).toBe('Setup Author|setup@example.com|Workspace Agent|workspace@example.com');
  });

  it('continues a conflicted rebase with the injected committer while keeping the original author', async () => {
    const root = divergentRepository();
    writeFileSync(join(root, 'shared.txt'), 'main\n');
    run(root, ['commit', '-q', '-am', 'main edits shared']);
    run(root, ['checkout', '-q', 'feature']);

    const started = await executeWorkerRequest('git_rebase', {
      action: 'start', upstream: 'main', authorName: 'Workspace Agent', authorEmail: 'workspace@example.com'
    });
    expect(started.ok).toBe(false);
    expect(started.error?.code).toBe('CONFLICT');
    expect(started.error?.message).not.toContain('git_identity_set');

    writeFileSync(join(root, 'shared.txt'), 'resolved\n');
    run(root, ['add', 'shared.txt']);
    const continued = await executeWorkerRequest('git_rebase', {
      action: 'continue', authorName: 'Workspace Agent', authorEmail: 'workspace@example.com'
    });

    expect(continued.ok, continued.message).toBe(true);
    expect(head(root)).toBe('Setup Author|setup@example.com|Workspace Agent|workspace@example.com');
    expect(run(root, ['log', '-1', '--format=%s'])).toBe('feature change');
    expect(localConfig(root)).toBe('');
  });

  it('keeps the explicit git_commit author and reports it', async () => {
    const root = divergentRepository();
    writeFileSync(join(root, 'new.txt'), 'new\n');

    const result = await executeWorkerRequest('git_commit', {
      message: 'add new', all: true, authorName: 'Workspace Agent', authorEmail: 'workspace@example.com'
    });

    expect(result.ok, result.message).toBe(true);
    expect(result.data).toMatchObject({ authorName: 'Workspace Agent', authorEmail: 'workspace@example.com' });
    expect(head(root)).toBe('Workspace Agent|workspace@example.com|Workspace Agent|workspace@example.com');
  });
});
