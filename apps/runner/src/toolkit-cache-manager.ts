import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { StateStore, ToolkitCacheEntryRecord } from './state-store.js';

export type ToolkitAcquisitionSpec = {
  sourceIdentity: string;
  resolvedRevision: string;
  adapterVersion: number;
  configDigest: string;
};

export type CachedToolkitBundle = {
  cacheKey: string;
  ownerId: string;
  bundleSha256: string;
  bundlePath: string;
  byteCount: number;
  fileCount: number;
};

export class ToolkitCacheManager {
  private readonly root: string;
  private readonly store: StateStore;
  private readonly inFlight = new Map<string, Promise<CachedToolkitBundle>>();

  constructor(root: string | undefined, store: StateStore) {
    this.root = root || (process.env.TOOLKIT_CACHE_ROOT || join(tmpdir(), 'cloud-harness-toolkit-cache'));
    this.store = store;
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      mkdirSync(join(this.root, 'staging'), { recursive: true, mode: 0o700 });
    } catch {
      this.root = join(tmpdir(), 'cloud-harness-toolkit-cache');
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      mkdirSync(join(this.root, 'staging'), { recursive: true, mode: 0o700 });
    }
  }

  computeCacheKey(ownerId: string, spec: ToolkitAcquisitionSpec): string {
    const raw = [ownerId, spec.sourceIdentity, spec.resolvedRevision, spec.adapterVersion, spec.configDigest].join(':');
    return createHash('sha256').update(raw).digest('hex');
  }

  bundlePath(ownerId: string, bundleSha256: string): string {
    return join(this.root, ownerId, bundleSha256);
  }

  async reconcileStartup(): Promise<void> {
    const stagingRoot = join(this.root, 'staging');
    try {
      const entries = await readdir(stagingRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await rm(join(stagingRoot, entry.name), { recursive: true, force: true }).catch(() => undefined);
        }
      }
    } catch {
      // staging dir absent or inaccessible
    }
  }
  getExisting(ownerId: string, spec: ToolkitAcquisitionSpec): CachedToolkitBundle | undefined {
    const cacheKey = this.computeCacheKey(ownerId, spec);
    const existing = this.store.getToolkitCacheEntry(cacheKey);
    if (existing && existing.status === 'READY') {
      const targetPath = this.bundlePath(ownerId, existing.bundleSha256);
      if (existsSync(targetPath)) {
        return {
          cacheKey,
          ownerId,
          bundleSha256: existing.bundleSha256,
          bundlePath: targetPath,
          byteCount: existing.byteCount,
          fileCount: existing.fileCount
        };
      }
    }
    return undefined;
  }


  async getOrAcquire(
    ownerId: string,
    spec: ToolkitAcquisitionSpec,
    acquireFn: (stagingDir: string) => Promise<{ bundleSha256: string; byteCount: number; fileCount: number }>
  ): Promise<CachedToolkitBundle> {
    const cacheKey = this.computeCacheKey(ownerId, spec);
    const existing = this.store.getToolkitCacheEntry(cacheKey);

    if (existing && existing.status === 'READY') {
      const targetPath = this.bundlePath(ownerId, existing.bundleSha256);
      if (existsSync(targetPath)) {
        this.store.upsertToolkitCacheEntry({
          ...existing,
          lastUsedAt: Date.now()
        });
        return {
          cacheKey,
          ownerId,
          bundleSha256: existing.bundleSha256,
          bundlePath: targetPath,
          byteCount: existing.byteCount,
          fileCount: existing.fileCount
        };
      }
    }

    const pending = this.inFlight.get(cacheKey);
    if (pending) return pending;

    const task = this.executeAcquisition(cacheKey, ownerId, spec, acquireFn);
    this.inFlight.set(cacheKey, task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  private async executeAcquisition(
    cacheKey: string,
    ownerId: string,
    spec: ToolkitAcquisitionSpec,
    acquireFn: (stagingDir: string) => Promise<{ bundleSha256: string; byteCount: number; fileCount: number }>
  ): Promise<CachedToolkitBundle> {
    const tempId = `staging-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const stagingDir = join(this.root, 'staging', tempId);
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });

    const now = Date.now();
    this.store.upsertToolkitCacheEntry({
      cacheKey,
      ownerId,
      sourceIdentity: spec.sourceIdentity,
      resolvedRevision: spec.resolvedRevision,
      adapterVersion: spec.adapterVersion,
      bundleSha256: 'pending',
      status: 'INITIALIZING',
      byteCount: 0,
      fileCount: 0,
      createdAt: now,
      lastUsedAt: now,
      errorSummary: null
    });

    try {
      const { bundleSha256, byteCount, fileCount } = await acquireFn(stagingDir);
      const targetDir = this.bundlePath(ownerId, bundleSha256);
      await mkdir(dirname(targetDir), { recursive: true, mode: 0o700 });

      if (existsSync(targetDir)) {
        await rm(stagingDir, { recursive: true, force: true });
      } else {
        this.fsyncDirectoryRecursive(stagingDir);
        await rename(stagingDir, targetDir);
        this.fsyncDirectory(dirname(targetDir));
      }

      const publishedRecord: ToolkitCacheEntryRecord = {
        cacheKey,
        ownerId,
        sourceIdentity: spec.sourceIdentity,
        resolvedRevision: spec.resolvedRevision,
        adapterVersion: spec.adapterVersion,
        bundleSha256,
        status: 'READY',
        byteCount,
        fileCount,
        createdAt: now,
        lastUsedAt: Date.now(),
        errorSummary: null
      };
      this.store.upsertToolkitCacheEntry(publishedRecord);

      return {
        cacheKey,
        ownerId,
        bundleSha256,
        bundlePath: targetDir,
        byteCount,
        fileCount
      };
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      const message = error instanceof Error ? error.message : 'toolkit acquisition failed';
      this.store.upsertToolkitCacheEntry({
        cacheKey,
        ownerId,
        sourceIdentity: spec.sourceIdentity,
        resolvedRevision: spec.resolvedRevision,
        adapterVersion: spec.adapterVersion,
        bundleSha256: 'failed',
        status: 'FAILED',
        byteCount: 0,
        fileCount: 0,
        createdAt: now,
        lastUsedAt: Date.now(),
        errorSummary: message.slice(0, 1000)
      });
      throw error;
    }
  }

  private fsyncDirectory(dirPath: string): void {
    try {
      const fd = openSync(dirPath, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // Best-effort directory fsync across platforms
    }
  }

  private fsyncDirectoryRecursive(dirPath: string): void {
    try {
      const items = readdirSync(dirPath, { withFileTypes: true });
      for (const item of items) {
        const fullPath = join(dirPath, item.name);
        if (item.isDirectory()) {
          this.fsyncDirectoryRecursive(fullPath);
        } else if (item.isFile()) {
          try {
            const fd = openSync(fullPath, 'r');
            try {
              fsyncSync(fd);
            } finally {
              closeSync(fd);
            }
          } catch {
            // Ignore file sync error
          }
        }
      }
      this.fsyncDirectory(dirPath);
    } catch {
      // Ignore walk errors
    }
  }

  async garbageCollect(ownerId: string, maxBytesQuota: number): Promise<{ purgedCount: number; purgedBytes: number }> {
    const entries = this.store.listToolkitCacheEntries(ownerId);
    const liveBundleShas = this.store.listReferencedToolkitBundleShas();

    let totalBytes = entries.reduce((sum, e) => sum + (e.status === 'READY' ? e.byteCount : 0), 0);
    if (totalBytes <= maxBytesQuota) {
      return { purgedCount: 0, purgedBytes: 0 };
    }

    let purgedCount = 0;
    let purgedBytes = 0;
    // Oldest used first
    const sorted = [...entries].sort((a, b) => a.lastUsedAt - b.lastUsedAt);

    for (const entry of sorted) {
      if (totalBytes <= maxBytesQuota) break;
      if (liveBundleShas.has(entry.bundleSha256)) continue; // Pinned by active workspace

      const dir = this.bundlePath(ownerId, entry.bundleSha256);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      this.store.deleteToolkitCacheEntry(entry.cacheKey);
      purgedCount++;
      purgedBytes += entry.byteCount;
      totalBytes -= entry.byteCount;
    }

    return { purgedCount, purgedBytes };
  }
}
