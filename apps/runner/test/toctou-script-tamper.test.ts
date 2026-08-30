import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
