import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import envCi from 'env-ci';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];

function createRepository(branch: string) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-release-ci-'));
  directories.push(directory);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory });
  git('init', '--initial-branch', branch);
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release-test@example.invalid');
  writeFileSync(join(directory, 'README.md'), '# fixture\n');
  git('add', 'README.md');
  git('commit', '-m', 'test: fixture');
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('release CI branch detection', () => {
  it('uses the checked-out dev branch when GitHub workflow-run metadata is disabled', () => {
    const directory = createRepository('dev');

    expect(envCi({ cwd: directory, env: { CI: 'true' } })).toMatchObject({ isCi: true, branch: 'dev' });
  });

  it('uses the checked-out main branch when GitHub workflow-run metadata is disabled', () => {
    const directory = createRepository('main');

    expect(envCi({ cwd: directory, env: { CI: 'true' } })).toMatchObject({ isCi: true, branch: 'main' });
  });
});
