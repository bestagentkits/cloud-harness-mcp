import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessError, LicensedKitCatalogEntrySchema } from '@cloud-harness/contracts';
import { StateStore } from '../src/state-store.js';
import { resolveOwnerPrincipal } from '../src/principal-store.js';
import { MetadataStore } from '../src/metadata-store.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { ToolkitCacheManager } from '../src/toolkit-cache-manager.js';
import { ToolkitService } from '../src/toolkit-service.js';
import { computeWorkspaceOpenFingerprint } from '../src/workspace-service.js';

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

    // Verify computeWorkspaceOpenFingerprint covers repository, ref, network, environment, and toolkits
    const baseInput = {
      repositoryUrl: 'https://github.com/org/repo.git',
      ref: 'main',
      environmentId: 'env_12345678901234567890',
      networkProfile: 'network-none',
      toolkits: [{ kind: 'preset' as const, id: 'mattpocock/skills' as const, scope: 'owner' as const }]
    };

    const wsFp1 = computeWorkspaceOpenFingerprint(baseInput);
    const wsFp2 = computeWorkspaceOpenFingerprint({
      ...baseInput,
      ref: 'v2.0.0'
    });
    expect(wsFp2).not.toBe(wsFp1);

    const wsFp3 = computeWorkspaceOpenFingerprint({
      ...baseInput,
      repositoryUrl: 'https://github.com/org/other-repo.git'
    });
    expect(wsFp3).not.toBe(wsFp1);

    const wsFp4 = computeWorkspaceOpenFingerprint({
      ...baseInput,
      networkProfile: 'dependency-access'
    });
    expect(wsFp4).not.toBe(wsFp1);

    const wsFp5 = computeWorkspaceOpenFingerprint({
      ...baseInput,
      environmentId: 'env_different9876543210'
    });
    expect(wsFp5).not.toBe(wsFp1);
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

  it('fails closed when licensed AgentKit kits are not configured on the instance', async () => {
    await expect(toolkitService.resolveToolkits(ownerId, [
      { kind: 'agentkit', kitId: 'engineer', channel: 'stable', scope: 'owner', activation: 'skills-only' }
    ])).rejects.toThrow('AgentKit kits are not configured on this instance');

    expect(computeWorkspaceOpenFingerprint({
      repositoryUrl: 'https://github.com/org/repo.git',
      toolkits: [{ kind: 'agentkit', kitId: 'engineer', channel: 'stable', scope: 'owner', activation: 'skills-only' }]
    })).toMatch(/^[a-f0-9]{64}$/);
  });

  it('names the missing registry secret for a licensed AgentKit selection', async () => {
    const configured = new ToolkitService({
      cacheManager,
      repoCacheManager: {} as any,
      store,
      executorImage: 'cloud-harness-executor:local',
      provisioningNetwork: 'test-net',
      allowedGitHosts: ['github.com'],
      instanceId: 'test-inst',
      toolkitNetworkPolicy: 'runner-fetch',
      agentkitRegistry: {
        registryUrl: 'https://agentkit.best',
        credentialSecretName: 'AGENTKIT_REGISTRY_TOKEN',
        keyId: 'agentkit-registry-2026',
        publicKey: generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
      }
    });

    await expect(configured.resolveToolkits(ownerId, [
      { kind: 'agentkit', kitId: 'engineer', channel: 'stable', scope: 'owner', activation: 'skills-only' }
    ])).rejects.toThrow('AGENTKIT_REGISTRY_TOKEN');
  });

  it('advertises licensed kits with separate instance and per-principal readiness gates', () => {
    const unconfigured = toolkitService.listLicensedKitCatalog(ownerId);
    expect(unconfigured.map((entry) => entry.kitId).sort()).toEqual(['engineer', 'marketing']);
    for (const entry of unconfigured) {
      // The catalog entry is a contract: parse it rather than trusting the shape.
      expect(LicensedKitCatalogEntrySchema.parse(entry)).toEqual(entry);
      expect(entry.available).toBe(false);
      expect(entry.credentialReady).toBe(false);
      expect(entry.requiresCredentialSecret).toBe('AGENTKIT_REGISTRY_TOKEN');
      expect(entry.supportedScopes).toEqual(['owner']);
      expect(entry.defaultChannel).toBe('stable');
      expect(entry.verification).toBe('registry-signed');
    }

    const keyring = new SecretKeyring(1, [{ version: 1, key: Buffer.alloc(32, 1) }]);
    const metadata = new MetadataStore(join(tmpDir, 'state.sqlite3'), keyring);
    try {
      const configured = new ToolkitService({
        cacheManager,
        repoCacheManager: {} as any,
        metadata,
        store,
        executorImage: 'cloud-harness-executor:local',
        provisioningNetwork: 'test-net',
        allowedGitHosts: ['github.com'],
        instanceId: 'test-inst',
        agentkitRegistry: {
          registryUrl: 'https://agentkit.best',
          credentialSecretName: 'LICENCE_TOKEN',
          keyId: 'agentkit-registry-2026',
          publicKey: generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
        }
      });

      expect(configured.listLicensedKitCatalog(ownerId)[0]).toMatchObject({
        available: true,
        credentialReady: false,
        requiresCredentialSecret: 'LICENCE_TOKEN'
      });

      metadata.secrets.globalBulkApply(ownerId, [
        { name: 'LICENCE_TOKEN', value: 'ak_dev_test_credential', action: 'create', expectedGeneration: 0, purpose: 'provisioning' }
      ]);

      const ready = configured.listLicensedKitCatalog(ownerId);
      expect(ready).toHaveLength(2);
      expect(ready.every((entry) => entry.available && entry.credentialReady)).toBe(true);
      // Readiness is reported, never the credential itself.
      expect(JSON.stringify(ready)).not.toContain('ak_dev_test_credential');
    } finally {
      metadata.close();
      keyring.close();
    }
  });

  it('refuses a runtime-purpose AgentKit credential and never reaches the registry', async () => {
    const keyring = new SecretKeyring(1, [{ version: 1, key: Buffer.alloc(32, 2) }]);
    const metadata = new MetadataStore(join(tmpDir, 'state.sqlite3'), keyring);
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      // A runtime secret is exactly the kind that is injected into executor environments, so it must
      // never be accepted as the licence token.
      metadata.secrets.globalBulkApply(ownerId, [
        { name: 'LICENCE_TOKEN', value: 'ak_dev_runtime_token', action: 'create', expectedGeneration: 0, purpose: 'runtime' }
      ]);
      const service = new ToolkitService({
        cacheManager,
        repoCacheManager: {} as any,
        metadata,
        store,
        executorImage: 'cloud-harness-executor:local',
        provisioningNetwork: 'test-net',
        allowedGitHosts: ['github.com'],
        instanceId: 'test-inst',
        toolkitNetworkPolicy: 'runner-fetch',
        agentkitRegistry: {
          registryUrl: 'https://agentkit.best',
          credentialSecretName: 'LICENCE_TOKEN',
          keyId: 'agentkit-registry-2026',
          publicKey: generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
        }
      });

      expect(service.listLicensedKitCatalog(ownerId).every((entry) => !entry.credentialReady)).toBe(true);
      await expect(service.resolveToolkits(ownerId, [
        { kind: 'agentkit', kitId: 'engineer', channel: 'stable', scope: 'owner', activation: 'skills-only' }
      ])).rejects.toThrow(/purpose 'provisioning'/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      metadata.close();
      keyring.close();
    }
  });

  it('accepts a provisioning-purpose credential and keeps it out of executor secret envelopes', async () => {
    const keyring = new SecretKeyring(1, [{ version: 1, key: Buffer.alloc(32, 3) }]);
    const metadata = new MetadataStore(join(tmpDir, 'state.sqlite3'), keyring);
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ status: 'inactive', errorCode: 'registry_disabled' }), {
      status: 503,
      headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      metadata.secrets.globalBulkApply(ownerId, [
        { name: 'LICENCE_TOKEN', value: 'ak_dev_provisioning_token', action: 'create', expectedGeneration: 0, purpose: 'provisioning' }
      ]);
      const service = new ToolkitService({
        cacheManager,
        repoCacheManager: {} as any,
        metadata,
        store,
        executorImage: 'cloud-harness-executor:local',
        provisioningNetwork: 'test-net',
        allowedGitHosts: ['github.com'],
        instanceId: 'test-inst',
        toolkitNetworkPolicy: 'runner-fetch',
        agentkitRegistry: {
          registryUrl: 'https://agentkit.best',
          credentialSecretName: 'LICENCE_TOKEN',
          keyId: 'agentkit-registry-2026',
          publicKey: generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
        }
      });

      expect(service.listLicensedKitCatalog(ownerId).every((entry) => entry.credentialReady)).toBe(true);
      // The provisioning secret must not reach the runtime envelope set a workspace executor receives.
      expect(metadata.globalSecretEnvelopes(ownerId).map((entry) => entry.name)).not.toContain('LICENCE_TOKEN');

      // The credential gate passes: the call proceeds to the registry (which the stub then fails).
      let failure: Error | undefined;
      try {
        await service.resolveToolkits(ownerId, [
          { kind: 'agentkit', kitId: 'engineer', channel: 'stable', scope: 'owner', activation: 'skills-only' }
        ]);
      } catch (error) {
        failure = error as Error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure?.message).not.toMatch(/provisioning/);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      metadata.close();
      keyring.close();
    }
  });

  it('cache-only AgentKit resolution performs zero registry network I/O', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const service = new ToolkitService({
        cacheManager,
        repoCacheManager: {} as any,
        store,
        executorImage: 'cloud-harness-executor:local',
        provisioningNetwork: 'test-net',
        allowedGitHosts: ['github.com'],
        instanceId: 'test-inst',
        toolkitNetworkPolicy: 'cache-only',
        agentkitRegistry: {
          registryUrl: 'https://agentkit.best',
          credentialSecretName: 'LICENCE_TOKEN',
          keyId: 'agentkit-registry-2026',
          publicKey: generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
        }
      });

      // No cached bundle: fail closed with no registry request at all.
      await expect(service.resolveToolkits(ownerId, [
        { kind: 'agentkit', kitId: 'engineer', channel: 'stable', scope: 'owner', activation: 'skills-only' }
      ])).rejects.toThrow(/cache-only/);
      expect(fetchSpy).not.toHaveBeenCalled();

      // Seed the cache exactly as a previous runner-fetch acquisition would have recorded it.
      const digest = 'e'.repeat(64);
      const packed = await cacheManager.getOrAcquire(ownerId, {
        sourceIdentity: 'agentkit:engineer:stable',
        resolvedRevision: digest,
        adapterVersion: 1,
        configDigest: 'seed'
      }, async (stagingDir) => {
        mkdirSync(join(stagingDir, 'skills', 'deploy'), { recursive: true });
        writeFileSync(join(stagingDir, 'skills', 'deploy', 'SKILL.md'), '# Deploy');
        writeFileSync(join(stagingDir, 'manifest.json'), JSON.stringify({
          version: '2.17.0',
          skills: [{ name: 'deploy', contentSha256: 'f'.repeat(64) }]
        }));
        return { bundleSha256: digest, byteCount: 10, fileCount: 2 };
      });

      const resolved = await service.resolveToolkits(ownerId, [
        { kind: 'agentkit', kitId: 'engineer', channel: 'stable', scope: 'owner', activation: 'skills-only' }
      ]);
      expect(resolved.lockItems).toHaveLength(1);
      expect(resolved.lockItems[0]).toMatchObject({ cache: 'hit', verification: 'registry-signed', skillsCount: 1 });
      expect(resolved.bundlePaths[0]?.path).toBe(packed.bundlePath);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
