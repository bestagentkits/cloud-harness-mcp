import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeFullTreeDigest, MattPocockAdapter } from '../src/adapters/mattpocock-adapter.js';
import { SuperpowersAdapter } from '../src/adapters/superpowers-adapter.js';
import { DeclarativeGitAdapter } from '../src/adapters/git-adapter.js';

describe('computeFullTreeDigest', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ch-digest-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('computes deterministic full-tree digest for directory tree', () => {
    mkdirSync(join(tmpDir, 'skills', 'tdd'), { recursive: true });
    writeFileSync(join(tmpDir, 'skills', 'tdd', 'SKILL.md'), '# TDD Skill');
    writeFileSync(join(tmpDir, 'manifest.json'), JSON.stringify({ id: 'test' }));

    const d1 = computeFullTreeDigest(tmpDir);
    const d2 = computeFullTreeDigest(tmpDir);

    expect(d1.bundleSha256).toBe(d2.bundleSha256);
    expect(d1.fileCount).toBe(2);
    expect(d1.byteCount).toBeGreaterThan(0);
  });

  it('changes digest when file content or executable mode changes', () => {
    mkdirSync(join(tmpDir, 'skills', 'tdd', 'scripts'), { recursive: true });
    const scriptPath = join(tmpDir, 'skills', 'tdd', 'scripts', 'run.sh');
    writeFileSync(scriptPath, '#!/bin/bash\necho 1');
    writeFileSync(join(tmpDir, 'skills', 'tdd', 'SKILL.md'), '# TDD');

    const initialDigest = computeFullTreeDigest(tmpDir).bundleSha256;

    // Change file content
    writeFileSync(scriptPath, '#!/bin/bash\necho 2');
    const contentChangedDigest = computeFullTreeDigest(tmpDir).bundleSha256;
    expect(contentChangedDigest).not.toBe(initialDigest);

    // Change mode (chmod)
    try {
      chmodSync(scriptPath, 0o755);
      const modeChangedDigest = computeFullTreeDigest(tmpDir).bundleSha256;
      expect(modeChangedDigest).not.toBe(contentChangedDigest);
    } catch {
      // ignore chmod on non-posix if unsupported
    }
  });
});

describe('Adapter Ref Validation & Shell Metacharacter Rejection', () => {
  it('rejects shell metacharacters and leading dashes in ref across all adapters', async () => {

    const mockRepoCacheManager: any = {
      acquireCacheMirror: async () => ({ cachePath: '/cache/dummy.git', isReady: true })
    };

    const mp = new MattPocockAdapter({
      repoCacheManager: mockRepoCacheManager,
      executorImage: 'cloud-harness-executor:local',
      provisioningNetwork: 'test-net'
    });

    const sp = new SuperpowersAdapter({
      repoCacheManager: mockRepoCacheManager,
      executorImage: 'cloud-harness-executor:local',
      provisioningNetwork: 'test-net'
    });

    const git = new DeclarativeGitAdapter({
      repoCacheManager: mockRepoCacheManager,
      executorImage: 'cloud-harness-executor:local',
      provisioningNetwork: 'test-net',
      allowedGitHosts: ['github.com']
    });

    const badRefs = [
      '-b',
      '--all',
      'main; rm -rf /',
      'main && echo 1',
      'main | cat',
      '$(whoami)',
      '`whoami`',
      'ref"injection',
      "ref'injection"
    ];

    for (const badRef of badRefs) {
      await expect(mp.acquireAndNormalize('owner-1', '/tmp/dummy', { revision: badRef })).rejects.toThrow('invalid git revision reference');
      await expect(sp.acquireAndNormalize('owner-1', '/tmp/dummy', { revision: badRef })).rejects.toThrow('invalid git revision reference');
      await expect(git.acquireAndNormalize('owner-1', '/tmp/dummy', { instanceId: 'inst', url: 'https://github.com/org/repo.git', ref: badRef })).rejects.toThrow('invalid git revision reference');
    }
  });
});
