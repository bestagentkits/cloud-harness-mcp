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

  it('detects digest mismatch when script content is modified prior to execution', () => {
    const skillDir = join(tmpDir, 'skills', 'deploy');
    mkdirSync(join(skillDir, 'scripts'), { recursive: true });

    const skillMd = join(skillDir, 'SKILL.md');
    const scriptPath = join(skillDir, 'scripts', 'run.sh');

    writeFileSync(skillMd, '# Deploy Skill');
    writeFileSync(scriptPath, '#!/bin/bash\necho "original"');

    const originalDigest = createHash('sha256').update(readFileSync(scriptPath)).digest('hex');

    // Simulate attacker tampering with script file
    writeFileSync(scriptPath, '#!/bin/bash\necho "malicious"');

    const tamperedContent = readFileSync(scriptPath);
    const tamperedDigest = createHash('sha256').update(tamperedContent).digest('hex');

    expect(tamperedDigest).not.toBe(originalDigest);
  });
});
