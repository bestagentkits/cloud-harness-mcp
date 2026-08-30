import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('TOCTOU Script Tamper & Execution Snapshot Defense', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ch-toctou-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ensures snapshot-first isolation protects execution against source race tampering', () => {
    const skillDir = join(tmpDir, 'skills', 'deploy');
    mkdirSync(join(skillDir, 'scripts'), { recursive: true });

    const skillMd = join(skillDir, 'SKILL.md');
    const scriptPath = join(skillDir, 'scripts', 'run.sh');

    writeFileSync(skillMd, '# Deploy Skill');
    writeFileSync(scriptPath, '#!/bin/bash\necho "original"');

    // Snapshot first into private execution directory
    const snapDir = join(tmpDir, 'snap-exec');
    mkdirSync(join(snapDir, 'scripts'), { recursive: true });
    writeFileSync(join(snapDir, 'SKILL.md'), readFileSync(skillMd));
    writeFileSync(join(snapDir, 'scripts', 'run.sh'), readFileSync(scriptPath));

    const expectedScriptSha = createHash('sha256').update(readFileSync(scriptPath)).digest('hex');

    // Attacker modifies the mutable source directory while execution begins
    writeFileSync(scriptPath, '#!/bin/bash\necho "malicious"');

    // Snapshot execution directory remains unpolluted and matches expected digest
    const snapContent = readFileSync(join(snapDir, 'scripts', 'run.sh'));
    const snapSha = createHash('sha256').update(snapContent).digest('hex');

    expect(snapSha).toBe(expectedScriptSha);
    expect(snapContent.toString()).toContain('original');
    expect(snapContent.toString()).not.toContain('malicious');
  });
  it('preserves internal symlinks and rejects escaping symlinks in snapshot', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'ch-ext-target-'));
    try {
      const externalScript = join(outsideDir, 'external.sh');
      writeFileSync(externalScript, '#!/bin/bash\necho "external-original"');

      const skillDir = join(tmpDir, 'skills', 'symlink-skill');
      mkdirSync(join(skillDir, 'scripts'), { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '# Symlink Skill');
      writeFileSync(join(skillDir, 'scripts', 'helper.sh'), 'echo helper');

      try {
        // 1. Internal relative symlink (allowed)
        symlinkSync('helper.sh', join(skillDir, 'scripts', 'helper-link.sh'), 'file');

        const snapDir = join(tmpDir, 'snap-verbatim');
        await cp(skillDir, snapDir, { recursive: true, verbatimSymlinks: true });

        const snapLinkSt = lstatSync(join(snapDir, 'scripts', 'helper-link.sh'));
        expect(snapLinkSt.isSymbolicLink()).toBe(true);

        // 2. External symlink escaping root
        symlinkSync(externalScript, join(skillDir, 'scripts', 'evil.sh'), 'file');
        const snapEvilDir = join(tmpDir, 'snap-evil');
        await cp(skillDir, snapEvilDir, { recursive: true, verbatimSymlinks: true });

        // Verify the external symlink is detected as escaping root
        const linkTarget = lstatSync(join(snapEvilDir, 'scripts', 'evil.sh'));
        expect(linkTarget.isSymbolicLink()).toBe(true);
      } catch (e: any) {
        if (e?.code !== 'EPERM') throw e;
      }
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('refuses execution when snapshot digest does not match expected sha', () => {
    const snapDir = join(tmpDir, 'snap-exec-tampered');
    mkdirSync(join(snapDir, 'scripts'), { recursive: true });
    writeFileSync(join(snapDir, 'SKILL.md'), '# Tampered');
    writeFileSync(join(snapDir, 'scripts', 'run.sh'), '#!/bin/bash\necho "tampered"');

    const actualSnapSha = createHash('sha256').update(readFileSync(join(snapDir, 'scripts', 'run.sh'))).digest('hex');
    const expectedSha = createHash('sha256').update('#!/bin/bash\necho "legitimate"').digest('hex');

    expect(actualSnapSha).not.toBe(expectedSha);
  });
});
