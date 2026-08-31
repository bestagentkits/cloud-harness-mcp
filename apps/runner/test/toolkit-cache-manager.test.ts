import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOwnerPrincipal } from '../src/principal-store.js';
import { StateStore } from '../src/state-store.js';
import { ToolkitCacheManager, type ToolkitAcquisitionSpec } from '../src/toolkit-cache-manager.js';
describe('ToolkitCacheManager', () => {
  let tmpDir: string;
  let cacheRoot: string;
  let dbPath: string;
  let store: StateStore;
  let cacheManager: ToolkitCacheManager;
  let ownerId: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ch-toolkit-cache-test-'));
    cacheRoot = join(tmpDir, 'cache');
    dbPath = join(tmpDir, 'state.sqlite3');
    store = new StateStore(dbPath);
    cacheManager = new ToolkitCacheManager(cacheRoot, store);
    ownerId = resolveOwnerPrincipal(store.database, 'owner-cache-1');
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('computes deterministic cache keys', () => {
    const spec: ToolkitAcquisitionSpec = {
      sourceIdentity: 'mattpocock/skills',
      resolvedRevision: 'commit-123456',
      adapterVersion: 1,
      configDigest: 'none'
    };
    const key1 = cacheManager.computeCacheKey(ownerId, spec);
    const key2 = cacheManager.computeCacheKey(ownerId, spec);
    expect(key1).toBe(key2);
    expect(key1.length).toBe(64);
  });

  it('acquires and publishes a bundle atomically with single-flight deduplication', async () => {
    const spec: ToolkitAcquisitionSpec = {
      sourceIdentity: 'mattpocock/skills',
      resolvedRevision: 'c'.repeat(40),
      adapterVersion: 1,
      configDigest: 'digest-1'
    };

    let acquireCallCount = 0;
    const acquireFn = async (stagingDir: string) => {
      acquireCallCount++;
      writeFileSync(join(stagingDir, 'SKILL.md'), '# Skill Content');
      writeFileSync(join(stagingDir, 'manifest.json'), JSON.stringify({ id: 'mattpocock/skills' }));
      return {
        bundleSha256: 'd'.repeat(64),
        byteCount: 1024,
        fileCount: 2
      };
    };

    // Run 3 concurrent acquisitions for the exact same spec
    const [res1, res2, res3] = await Promise.all([
      cacheManager.getOrAcquire(ownerId, spec, acquireFn),
      cacheManager.getOrAcquire(ownerId, spec, acquireFn),
      cacheManager.getOrAcquire(ownerId, spec, acquireFn)
    ]);

    expect(acquireCallCount).toBe(1); // Single-flight executed only once
    expect(res1.bundleSha256).toBe('d'.repeat(64));
    expect(res2.bundleSha256).toBe('d'.repeat(64));
    expect(res3.bundleSha256).toBe('d'.repeat(64));

    const dbRecord = store.getToolkitCacheEntry(res1.cacheKey);
    expect(dbRecord?.status).toBe('READY');
    expect(dbRecord?.byteCount).toBe(1024);

    // Warm getOrAcquire uses cache with zero acquire calls
    const warmRes = await cacheManager.getOrAcquire(ownerId, spec, acquireFn);
    expect(acquireCallCount).toBe(1);
    expect(warmRes.bundleSha256).toBe('d'.repeat(64));
  });

  it('cleans up staging directory and records FAILED status on error', async () => {
    const spec: ToolkitAcquisitionSpec = {
      sourceIdentity: 'broken/skills',
      resolvedRevision: 'f'.repeat(40),
      adapterVersion: 1,
      configDigest: 'err'
    };

    const failingAcquire = async () => {
      throw new Error('network connection timed out');
    };

    await expect(cacheManager.getOrAcquire(ownerId, spec, failingAcquire)).rejects.toThrow('network connection timed out');

    const cacheKey = cacheManager.computeCacheKey(ownerId, spec);
    const dbRecord = store.getToolkitCacheEntry(cacheKey);
    expect(dbRecord?.status).toBe('FAILED');
    expect(dbRecord?.errorSummary).toContain('network connection timed out');
  });

  it('reconciles orphaned staging directories at startup', async () => {
    const orphanDir = join(cacheRoot, 'staging', 'staging-orphaned-1234');
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, 'test.txt'), 'partial');

    await cacheManager.reconcileStartup();

    expect(existsSync(orphanDir)).toBe(false);
  });
  it('garbage collects unreferenced bundles when quota is exceeded while preserving referenced bundles', async () => {
    const spec1: ToolkitAcquisitionSpec = { sourceIdentity: 'pkg1', resolvedRevision: '1', adapterVersion: 1, configDigest: '1' };
    const spec2: ToolkitAcquisitionSpec = { sourceIdentity: 'pkg2', resolvedRevision: '2', adapterVersion: 1, configDigest: '2' };

    const sha1 = '1'.repeat(64);
    const sha2 = '2'.repeat(64);

    await cacheManager.getOrAcquire(ownerId, spec1, async (dir) => {
      writeFileSync(join(dir, 'file.txt'), 'data1');
      return { bundleSha256: sha1, byteCount: 5000, fileCount: 1 };
    });

    await cacheManager.getOrAcquire(ownerId, spec2, async (dir) => {
      writeFileSync(join(dir, 'file.txt'), 'data2');
      return { bundleSha256: sha2, byteCount: 5000, fileCount: 1 };
    });

    // Create a live workspace referencing sha2
    const wsId = 'ws_live_1234567890123456';
    store.create({
      id: wsId,
      ownerId,
      idempotencyKey: 'idem-live-1',
      repositoryUrl: 'https://github.com/test/repo',
      repositoryRef: 'main',
      containerName: 'cnt-1',
      workspacePath: join(tmpDir, 'ws'),
      environmentId: null,
      status: 'ACTIVE',
      networkMode: 'none',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      expiresAt: Date.now() + 100000,
      hardExpiresAt: Date.now() + 200000,
      gitAuthorName: null,
      gitAuthorEmail: null,
      mutationLockedUntil: null,
      generation: 1,
      error: null
    });

    store.saveWorkspaceToolkits(wsId, ownerId, [
      {
        ordinal: 0,
        toolkitId: 'pkg2',
        scope: 'owner',
        requestedJson: '{}',
        resolvedJson: '{}',
        bundleSha256: sha2
      }
    ]);

    // Total bytes = 10000. Quota = 6000.
    // sha1 is unreferenced -> should be purged.
    // sha2 is referenced by active workspace wsId -> MUST BE PRESERVED.
    const result = await cacheManager.garbageCollect(ownerId, 6000);
    expect(result.purgedCount).toBe(1);
    expect(result.purgedBytes).toBe(5000);

    const entries = store.listToolkitCacheEntries(ownerId);
    expect(entries.length).toBe(1);
    expect(entries[0]!.bundleSha256).toBe(sha2);
  });
});
