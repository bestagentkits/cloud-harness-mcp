import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { RepositoryCacheManager } from '../src/repository-cache-manager.js';

const tempDir = () => {
  const dir = join(tmpdir(), `test-repo-cache-${randomBytes(8).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe('RepositoryCacheManager & Benchmark Protocol', () => {
  it('isolates cache paths per owner and computes deterministic hashes', () => {
    const root = tempDir();
    const dbPath = join(root, 'state.sqlite');
    const store = new StateStore(dbPath);
    const mgr = new RepositoryCacheManager(root, store, ['github.com']);

    try {
      const p1 = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.com', subject: 'owner-1' });
      const p2 = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.com', subject: 'owner-2' });
      const url = 'https://github.com/org/repo';

      const path1 = mgr.getCachePath(p1, url);
      const path2 = mgr.getCachePath(p2, url);

      expect(path1).toContain(p1);
      expect(path2).toContain(p2);
      expect(path1).not.toBe(path2);
      expect(path1.endsWith('.git')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('evaluates clone benchmarks and recommends mode based on 30% threshold', () => {
    const root = tempDir();
    const dbPath = join(root, 'state.sqlite');
    const store = new StateStore(dbPath);
    const mgr = new RepositoryCacheManager(root, store, ['github.com']);

    try {
      // Scenario A: 50% speedup -> recommends 'cache'
      const resA = mgr.benchmarkClone('https://github.com/org/large-repo', {
        independentCloneMs: 10_000,
        cachedCloneMs: 5_000,
        diskUsageBytes: 50_000_000
      });
      expect(resA.speedupPercent).toBe(50);
      expect(resA.recommendedMode).toBe('cache');

      // Scenario B: 10% speedup -> recommends 'independent'
      const resB = mgr.benchmarkClone('https://github.com/org/small-repo', {
        independentCloneMs: 1_000,
        cachedCloneMs: 900,
        diskUsageBytes: 5_000_000
      });
      expect(resB.speedupPercent).toBe(10);
      expect(resB.recommendedMode).toBe('independent');
    } finally {
      store.close();
    }
  });

  it('cleans up stale caches from disk and sqlite', async () => {
    const root = tempDir();
    const dbPath = join(root, 'state.sqlite');
    const store = new StateStore(dbPath);
    const mgr = new RepositoryCacheManager(root, store, ['github.com']);

    try {
      const p = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.com', subject: 'owner-clean' });
      const cachePath = mgr.getCachePath(p, 'https://github.com/org/old-repo');
      mkdirSync(cachePath, { recursive: true });
      writeFileSync(join(cachePath, 'HEAD'), 'ref: refs/heads/main\n');

      store.upsertRepoCache({
        id: 'rc_old',
        ownerId: p,
        repositoryUrl: 'https://github.com/org/old-repo',
        repositoryUrlHash: 'oldhash',
        cachePath,
        defaultBranch: 'main',
        lastFetchedAt: Date.now() - 100_000,
        sizeBytes: 100,
        status: 'READY',
        createdAt: Date.now() - 100_000,
        updatedAt: Date.now() - 100_000
      });

      expect(existsSync(cachePath)).toBe(true);
      const cleaned = await mgr.cleanupStaleCaches(Date.now() - 50_000);
      expect(cleaned).toBe(1);
      expect(existsSync(cachePath)).toBe(false);
      expect(store.getRepoCache(p, 'oldhash')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('rejects forbidden or non-allowlisted repository hosts during acquire', async () => {
    const root = tempDir();
    const dbPath = join(root, 'state.sqlite');
    const store = new StateStore(dbPath);
    const mgr = new RepositoryCacheManager(root, store, ['github.com']);

    try {
      const p = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.com', subject: 'owner-forbidden' });
      await expect(
        mgr.acquireCacheMirror(p, 'https://evil-host.com/repo')
      ).rejects.toThrow(/not allowlisted/);

      await expect(
        mgr.acquireCacheMirror(p, 'http://github.com/repo')
      ).rejects.toThrow(/HTTPS/);
    } finally {
      store.close();
    }
  });
});
