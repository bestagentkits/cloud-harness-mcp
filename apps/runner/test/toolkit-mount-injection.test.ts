import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessError } from '@cloud-harness/contracts';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';
import { resolveOwnerPrincipal } from '../src/principal-store.js';
import { ToolkitCacheManager } from '../src/toolkit-cache-manager.js';
import { ToolkitService } from '../src/toolkit-service.js';

describe('Toolkit Mount Injection, Projection & Idempotency Fingerprint', () => {
  let tmpDir: string;
  let store: StateStore;
  let ownerId: string;
  let toolkitService: ToolkitService;
  let cacheManager: ToolkitCacheManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ch-mount-injection-test-'));
    const dbPath = join(tmpDir, 'state.sqlite3');
    store = new StateStore(dbPath);
    ownerId = resolveOwnerPrincipal(store.database, 'owner-proj-1');

    cacheManager = new ToolkitCacheManager(join(tmpDir, 'cache'), store);
    toolkitService = new ToolkitService({
      cacheManager,
      repoCacheManager: {} as any,
      store,
      executorImage: 'cloud-harness-executor:local',
      provisioningNetwork: 'test-net',
      allowedGitHosts: ['github.com'],
      instanceId: 'test-inst'
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('computes order-independent canonical request fingerprints', () => {
    const fp1 = toolkitService.computeRequestFingerprint([
      { kind: 'preset', id: 'mattpocock/skills', scope: 'owner' },
      { kind: 'preset', id: 'obra/superpowers', scope: 'owner' }
    ]);

    const fp2 = toolkitService.computeRequestFingerprint([
      { kind: 'preset', id: 'obra/superpowers', scope: 'owner' },
      { kind: 'preset', id: 'mattpocock/skills', scope: 'owner' }
    ]);

    expect(fp1).toBe(fp2);

    const fp3 = toolkitService.computeRequestFingerprint([
      { kind: 'preset', id: 'mattpocock/skills', scope: 'workspace' }
    ]);
    expect(fp3).not.toBe(fp1);
  });

  it('detects same-tier skill collisions with differing content', async () => {
    const bundleDir1 = join(tmpDir, 'bundle1');
    const bundleDir2 = join(tmpDir, 'bundle2');

    mkdirSync(join(bundleDir1, 'skills', 'deploy'), { recursive: true });
    writeFileSync(join(bundleDir1, 'skills', 'deploy', 'SKILL.md'), '# Deploy v1');

    mkdirSync(join(bundleDir2, 'skills', 'deploy'), { recursive: true });
    writeFileSync(join(bundleDir2, 'skills', 'deploy', 'SKILL.md'), '# Deploy v2 with different content');

    const wsPath = join(tmpDir, 'ws_test');
    mkdirSync(wsPath, { recursive: true });

    const ownerSkillsPath = join(wsPath, 'toolkit-projection', 'owner-skills');
    mkdirSync(ownerSkillsPath, { recursive: true });

    const seen = new Map<string, string>();
    const bundles = [
      { instanceId: 'b1', path: bundleDir1 },
      { instanceId: 'b2', path: bundleDir2 }
    ];

    let collisionError: Error | null = null;
    try {
      for (const b of bundles) {
        const skillsDir = join(b.path, 'skills');
        for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const md = join(skillsDir, entry.name, 'SKILL.md');
          const content = readFileSync(md, 'utf8');
          const hash = createHash('sha256').update(content).digest('hex');
          const prior = seen.get(entry.name);
          if (prior && prior !== hash) {
            throw new HarnessError('CONFLICT', `Same-tier toolkit skill collision: ${entry.name} is defined with conflicting content`, 409, false);
          }
          seen.set(entry.name, hash);
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        collisionError = err;
      }
    }

    expect(collisionError).not.toBeNull();
    expect(collisionError?.message).toContain('Same-tier toolkit skill collision: deploy');
  });

  it('enforces cache-only policy and fails before network fetch on uncached toolkit', async () => {
    const cacheOnlyService = new ToolkitService({
      cacheManager,
      repoCacheManager: {} as any,
      store,
      executorImage: 'cloud-harness-executor:local',
      provisioningNetwork: 'test-net',
      allowedGitHosts: ['github.com'],
      instanceId: 'test-inst',
      toolkitNetworkPolicy: 'cache-only'
    });

    await expect(cacheOnlyService.resolveToolkits(ownerId, [
      { kind: 'preset', id: 'mattpocock/skills' }
    ])).rejects.toThrow(/is not cached and toolkitNetworkPolicy is cache-only/);
  });
});
