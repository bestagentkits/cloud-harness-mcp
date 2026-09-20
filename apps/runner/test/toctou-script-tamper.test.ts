import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeWorkerRequest, sha256 } from '../../../worker/harness-worker.mjs';

/**
 * The worker stages a skill into a snapshot, verifies the digest of that snapshot, and then executes
 * from it. These tests pin the verification half, which is where a time-of-check to time-of-use gap
 * would show up: the expectation is checked against the bytes that are about to run, so a source that
 * changed since the caller computed the digest is refused rather than executed.
 *
 * Executing from the snapshot inside a container is covered by the Docker lane; a `.txt` script is
 * used here precisely so that execution is expected to fail on every platform, which makes "did
 * verification pass?" observable without depending on a shell.
 */
const temporaryDirectories: string[] = [];
let symlinksSupported = true;

afterEach(() => {
  delete process.env.CH_WORKSPACE_ROOT;
  for (const path of temporaryDirectories.splice(0)) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* ignore cleanup error */ }
  }
});

function setupSkill(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'cloud-harness-toctou-'));
  temporaryDirectories.push(root);
  process.env.CH_WORKSPACE_ROOT = root;
  const skillDir = join(root, '.cloud-harness', 'skills', 'tdd');
  mkdirSync(join(skillDir, 'scripts'), { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# TDD\n');
  for (const [relative, content] of Object.entries(files)) {
    const target = join(skillDir, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return { root, skillDir };
}

function probeSymlinkSupport() {
  const probeRoot = mkdtempSync(join(tmpdir(), 'cloud-harness-symlink-probe-'));
  try {
    symlinkSync(join(probeRoot, 'target'), join(probeRoot, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    try { rmSync(probeRoot, { recursive: true, force: true }); } catch { /* ignore cleanup error */ }
  }
}

symlinksSupported = probeSymlinkSupport();

describe('skills_run time-of-check to time-of-use', () => {
  it('refuses to run bytes that changed after the caller computed the digest', async () => {
    const original = '#!/bin/sh\necho original\n';
    const { skillDir } = setupSkill({ 'scripts/run.txt': original });
    const expected = sha256(original);

    // The source changes after the digest was taken, which is exactly the window a swap would use.
    writeFileSync(join(skillDir, 'scripts', 'run.txt'), '#!/bin/sh\necho tampered\n');

    const result = await executeWorkerRequest('skills_run', {
      name: 'tdd', script: 'run.txt', expectedContentSha256: expected
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CONFLICT');
    expect(result.error?.message).toContain('digest mismatch');
    expect(JSON.stringify(result)).not.toContain('tampered');
  });

  it('runs the verified bytes once the digest matches', async () => {
    const content = '# not an executable on any platform\n';
    setupSkill({ 'scripts/run.txt': content });

    const result = await executeWorkerRequest('skills_run', {
      name: 'tdd', script: 'run.txt', expectedContentSha256: sha256(content)
    });

    // This case is about verification passing, and it must not depend on whether the host can execute a
    // file with no shebang: Windows cannot, while a shell that runs the file as a script on Linux can.
    // So the assertion is that the outcome is not an integrity verdict, and that any failure is an
    // execution one rather than a digest one.
    expect(result.error?.code).not.toBe('CONFLICT');
    expect(result.error?.code).not.toBe('INVALID_INPUT');
    if (!result.ok) expect(result.error?.code).toBe('EXECUTION_FAILED');
  });

  it('requires a digest, so an unverified run cannot be requested at all', async () => {
    const content = '# whatever\n';
    setupSkill({ 'scripts/run.txt': content });

    const result = await executeWorkerRequest('skills_run', { name: 'tdd', script: 'run.txt' });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it.skipIf(!symlinksSupported)('refuses a skill whose tree contains a symlink escaping it', async () => {
    const { root, skillDir } = setupSkill({ 'scripts/run.txt': '# placeholder\n' });
    const outside = join(root, 'host-secret.txt');
    writeFileSync(outside, 'host secret');
    rmSync(join(skillDir, 'scripts', 'run.txt'));
    symlinkSync(outside, join(skillDir, 'scripts', 'run.txt'));

    const result = await executeWorkerRequest('skills_run', {
      name: 'tdd', script: 'run.txt', expectedContentSha256: sha256('# placeholder\n')
    });

    // The tree is refused while the inventory digest is computed, so the skill never becomes runnable
    // and the file it points at is never read. The assertion is on that property rather than on the
    // code, because refusing earlier than the staging step is the stronger outcome, not a different one.
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('host secret');
  });

  it.skipIf(!symlinksSupported)('refuses a skill whose tree contains a broken symlink', async () => {
    const { skillDir } = setupSkill({ 'scripts/run.txt': '# placeholder\n' });
    rmSync(join(skillDir, 'scripts', 'run.txt'));
    symlinkSync(join(skillDir, 'scripts', 'missing.sh'), join(skillDir, 'scripts', 'run.txt'));

    const result = await executeWorkerRequest('skills_run', {
      name: 'tdd', script: 'run.txt', expectedContentSha256: sha256('# placeholder\n')
    });

    expect(result.ok).toBe(false);
  });
});
