import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The launchers are executed as real processes rather than imported, because the executable path is
 * what the executor image installs and what the dispatcher resolves. A unit import would pass even
 * if the file could not be run.
 */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const launcher = (name: string) => join(repoRoot, 'worker', 'bin', name);

let root: string;
let workspace: string;
let catalog: string;
let installTarget: string;

function run(name: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [launcher(name), ...args], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, CLOUD_HARNESS_CATALOG: catalog, CLOUD_HARNESS_SKILLS_TARGET: installTarget, ...env }
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cloud-harness-cli-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  catalog = join(root, 'skill-catalog.json');
  installTarget = join(workspace, '.cloud-harness', 'skills');

  const mirrored = join(root, 'owner-skills', 'tdd');
  mkdirSync(mirrored, { recursive: true });
  writeFileSync(join(mirrored, 'SKILL.md'), '# TDD\n\nWrite the test first.');
  const referenced = join(root, 'owner-skills', 'review');
  mkdirSync(referenced, { recursive: true });
  writeFileSync(join(referenced, 'SKILL.md'), '# Review');

  writeFileSync(catalog, JSON.stringify({
    skills: [
      { name: 'tdd', repository: 'mattpocock/skills', description: 'test driven development', path: 'owner-skills/tdd', references: ['review'] },
      { name: 'review', repository: 'mattpocock/skills', description: 'code review', path: 'owner-skills/review' }
    ]
  }));
});

afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore cleanup error */ }
});

describe('skills compatibility launcher', () => {
  it('installs a mirrored repository from the local catalog without touching the network', () => {
    const result = run('skills', ['add', 'mattpocock/skills', '--skill', 'tdd', '-y']);

    expect(result.status).toBe(0);
    expect(existsSync(join(installTarget, 'tdd', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(installTarget, 'tdd', 'SKILL.md'), 'utf8')).toContain('Write the test first');
    // Only the requested skill is installed, so a narrowed add stays narrow.
    expect(existsSync(join(installTarget, 'review'))).toBe(false);
  });

  it('lists what is installed and removes it again', () => {
    run('skills', ['add', 'mattpocock/skills', '--skill', 'tdd', '-y']);

    const listed = run('skills', ['list']);
    expect(listed.status).toBe(0);
    expect(listed.stdout.split('\n').filter(Boolean)).toEqual(['tdd']);

    const removed = run('skills', ['remove', 'tdd']);
    expect(removed.status).toBe(0);
    expect(existsSync(join(installTarget, 'tdd'))).toBe(false);
  });

  it('fails closed with CACHE_MISS and import instructions for an unmirrored repository', () => {
    const result = run('skills', ['add', 'unmirrored/repo', '-y']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CACHE_MISS');
    expect(result.stderr).toContain('unmirrored/repo');
    expect(result.stderr).toMatch(/import it from the dashboard skills page/i);
    expect(existsSync(installTarget)).toBe(false);
  });

  it('targets an agent directory when asked, so the copy lands where the agent reads', () => {
    const result = run('skills', ['add', 'mattpocock/skills', '--skill', 'tdd', '-y', '--agent', 'claude']);

    expect(result.status).toBe(0);
    expect(existsSync(join(workspace, '.claude', 'skills', 'tdd', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(installTarget, 'tdd'))).toBe(false);
  });

  it('explains itself instead of guessing when the command is unknown', () => {
    const result = run('skills', ['frobnicate']);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('usage: skills add');
  });
});

describe('skillx compatibility launcher', () => {
  it('prints the instructions snapshot for --raw without copying anything', () => {
    const result = run('skillx', ['use', 'tdd', '--raw']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Write the test first');
    expect(existsSync(installTarget)).toBe(false);
  });

  it('resolves a slug into the workspace and follows references only when asked', () => {
    const result = run('skillx', ['use', 'tdd']);
    expect(result.status).toBe(0);
    expect(existsSync(join(installTarget, 'tdd', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(installTarget, 'review'))).toBe(false);

    const withRefs = run('skillx', ['use', 'tdd', '--include-refs']);
    expect(withRefs.status).toBe(0);
    expect(existsSync(join(installTarget, 'review', 'SKILL.md'))).toBe(true);
  });

  it('searches the local catalog and fails closed when nothing matches', () => {
    const found = run('skillx', ['use', 'review', '--search']);
    expect(found.status).toBe(0);
    expect(found.stdout).toContain('review');

    const missing = run('skillx', ['use', 'nonexistent', '--search']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('CACHE_MISS');
  });

  it('fails closed for a slug that is not mirrored', () => {
    const result = run('skillx', ['use', 'absent']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CACHE_MISS');
  });
});

describe('npx dispatcher', () => {
  it('runs the local skills launcher instead of delegating', () => {
    const result = run('npx-dispatcher', ['skills', 'list'], { CLOUD_HARNESS_REAL_NPX: join(root, 'does-not-exist') });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('does-not-exist');
  });

  it('forwards an unrelated argument vector to the real npx unchanged', () => {
    const echo = join(root, 'echo-argv.mjs');
    writeFileSync(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');

    // Pointing the real path at this Node binary makes the delegation observable: the arguments the
    // dispatcher forwards are the arguments the delegated process receives.
    const result = run('npx-dispatcher', [echo, 'alpha', '--flag', 'beta'], { CLOUD_HARNESS_REAL_NPX: process.execPath });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(JSON.stringify(['alpha', '--flag', 'beta']));
  });

  it('reports a missing real npx instead of failing silently', () => {
    const result = run('npx-dispatcher', ['--version'], { CLOUD_HARNESS_REAL_NPX: join(root, 'no-such-npx') });

    expect(result.status).toBe(127);
    expect(result.stderr).toContain('npx:');
  });
});
