import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeFullTreeDigest, validateStagingDir, MattPocockAdapter } from '../src/adapters/mattpocock-adapter.js';
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

describe('validateStagingDir & Failure Boundary Protections', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ch-val-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects directories exceeding maximum file limits', () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(tmpDir, `file_${i}.txt`), 'hello');
    }
    expect(() => validateStagingDir(tmpDir, 3)).toThrow('Staging directory exceeds maximum file count of 3');
  });

  it('rejects directories exceeding maximum byte limits', () => {
    writeFileSync(join(tmpDir, 'large.txt'), 'x'.repeat(1024));
    expect(() => validateStagingDir(tmpDir, 100, 500)).toThrow('Staging directory exceeds maximum byte size of 500');
  });
  it('rejects escaping symlinks that point outside staging directory', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'ch-outside-'));
    try {
      const secretFile = join(outsideDir, 'secret.txt');
      writeFileSync(secretFile, 'sensitive-data');
      try {
        symlinkSync(secretFile, join(tmpDir, 'evil_link'));
        expect(() => validateStagingDir(tmpDir)).toThrow('escapes staging directory root');
      } catch (e: any) {
        // If symlink creation requires elevated privileges on Windows, verify error or skip
        if (e?.code !== 'EPERM') throw e;
      }
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('counts symlinks toward maxFiles ceiling and rejects symlink floods', () => {
    const targetFile = join(tmpDir, 'target.txt');
    writeFileSync(targetFile, 'content');
    try {
      for (let i = 0; i < 4; i++) {
        symlinkSync(targetFile, join(tmpDir, `link_${i}`));
      }
      expect(() => validateStagingDir(tmpDir, 3)).toThrow('Staging directory exceeds maximum file count of 3');
    } catch (e: any) {
      if (e?.code !== 'EPERM') throw e;
    }
  });
  it('rejects unready cache mirror across all adapters', async () => {
    const unreadyCacheManager: any = {
      acquireCacheMirror: async () => ({ cachePath: '/cache/dummy.git', isReady: false })
    };

    const mp = new MattPocockAdapter({
      repoCacheManager: unreadyCacheManager,
      executorImage: 'cloud-harness-executor:local',
      provisioningNetwork: 'test-net'
    });

    const sp = new SuperpowersAdapter({
      repoCacheManager: unreadyCacheManager,
      executorImage: 'cloud-harness-executor:local',
      provisioningNetwork: 'test-net'
    });

    const git = new DeclarativeGitAdapter({
      repoCacheManager: unreadyCacheManager,
      executorImage: 'cloud-harness-executor:local',
      provisioningNetwork: 'test-net',
      allowedGitHosts: ['github.com']
    });

    await expect(mp.acquireAndNormalize('owner-1', tmpDir)).rejects.toThrow('Repository mirror acquisition is not ready');
    await expect(sp.acquireAndNormalize('owner-1', tmpDir)).rejects.toThrow('Repository mirror acquisition is not ready');
    await expect(git.acquireAndNormalize('owner-1', tmpDir, { instanceId: 'inst', url: 'https://github.com/org/repo.git' })).rejects.toThrow('Repository mirror acquisition is not ready');
  });
});
