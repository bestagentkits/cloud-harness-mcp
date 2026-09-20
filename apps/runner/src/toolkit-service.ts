import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError, type ToolkitLockItem, type ToolkitSelection } from '@cloud-harness/contracts';
import { MattPocockAdapter } from './adapters/mattpocock-adapter.js';
import { SuperpowersAdapter } from './adapters/superpowers-adapter.js';
import { DeclarativeGitAdapter } from './adapters/git-adapter.js';
import { SkillsShAdapter } from './adapters/skills-sh-adapter.js';
import { SkillXAdapter } from './adapters/skillx-adapter.js';
import type { RepositoryCacheManager } from './repository-cache-manager.js';
import type { SecretMetadataStore } from './secret-metadata-store.js';
import type { StateStore } from './state-store.js';
import type { ToolkitCacheManager } from './toolkit-cache-manager.js';

export type ToolkitCatalogPreset = {
  id: 'mattpocock/skills' | 'obra/superpowers';
  name: string;
  description: string;
  defaultRevision: string;
  adapterVersion: number;
  license: string;
  sourceUrl: string;
  supportedScopes: Array<'owner' | 'workspace'>;
  supportedTargets?: string[];
  requiredSecret?: string;
  activation: 'skills-only' | 'toolkit-default';
};

export const TOOLKIT_CATALOG: Record<string, ToolkitCatalogPreset> = {
  'mattpocock/skills': {
    id: 'mattpocock/skills',
    name: 'Matt Pocock Skills',
    description: '53 real engineering skills including TDD, diagnosing bugs, and codebase architecture.',
    defaultRevision: 'main',
    adapterVersion: 1,
    license: 'MIT',
    sourceUrl: 'https://github.com/mattpocock/skills.git',
    supportedScopes: ['owner', 'workspace'],
    activation: 'toolkit-default'
  },
  'obra/superpowers': {
    id: 'obra/superpowers',
    name: 'Superpowers',
    description: 'Agentic skills framework and session-start tool mapping instructions.',
    defaultRevision: 'main',
    adapterVersion: 1,
    license: 'MIT',
    sourceUrl: 'https://github.com/obra/superpowers.git',
    supportedScopes: ['owner', 'workspace'],
    activation: 'toolkit-default'
  },

};

export class ToolkitService {
  private readonly cacheManager: ToolkitCacheManager;
  private readonly repoCacheManager: RepositoryCacheManager;
  private readonly secretStore?: SecretMetadataStore;
  private readonly store: StateStore;
  private readonly mattPocockAdapter: MattPocockAdapter;
  private readonly superpowersAdapter: SuperpowersAdapter;
  private readonly gitAdapter: DeclarativeGitAdapter;
  private readonly skillsShAdapter: SkillsShAdapter;
  private readonly skillXAdapter: SkillXAdapter;
  private readonly enableToolkitCache: boolean;
  private readonly toolkitNetworkPolicy: 'cache-only' | 'runner-fetch';

  constructor(options: {
    cacheManager: ToolkitCacheManager;
    repoCacheManager: RepositoryCacheManager;
    secretStore?: SecretMetadataStore | undefined;
    store: StateStore;
    executorImage: string;
    provisioningNetwork: string;
    toolkitEgressProxy?: string | undefined;
    allowedGitHosts: string[];
    instanceId: string;
    enableToolkitCache?: boolean | undefined;
    toolkitNetworkPolicy?: ('cache-only' | 'runner-fetch') | undefined;
  }) {
    this.cacheManager = options.cacheManager;
    this.repoCacheManager = options.repoCacheManager;
    if (options.secretStore) {
      this.secretStore = options.secretStore;
    }
    this.store = options.store;
    this.enableToolkitCache = options.enableToolkitCache ?? true;
    this.toolkitNetworkPolicy = options.toolkitNetworkPolicy ?? 'cache-only';
    const proxyOpts = options.toolkitEgressProxy ? { toolkitEgressProxy: options.toolkitEgressProxy } : {};

    this.mattPocockAdapter = new MattPocockAdapter({
      repoCacheManager: options.repoCacheManager,
      executorImage: options.executorImage,
      provisioningNetwork: options.provisioningNetwork,
      ...proxyOpts
    });

    this.superpowersAdapter = new SuperpowersAdapter({
      repoCacheManager: options.repoCacheManager,
      executorImage: options.executorImage,
      provisioningNetwork: options.provisioningNetwork,
      ...proxyOpts
    });

    this.gitAdapter = new DeclarativeGitAdapter({
      repoCacheManager: options.repoCacheManager,
      executorImage: options.executorImage,
      provisioningNetwork: options.provisioningNetwork,
      allowedGitHosts: options.allowedGitHosts,
      ...proxyOpts
    });
    // Registry acquisition reuses the same provisioning path and allowlist as the Git adapter, so a
    // skills.sh import cannot reach a host the operator has not approved for toolkit egress.
    this.skillsShAdapter = new SkillsShAdapter({
      repoCacheManager: options.repoCacheManager,
      executorImage: options.executorImage,
      provisioningNetwork: options.provisioningNetwork,
      allowedGitHosts: options.allowedGitHosts,
      ...proxyOpts
    });
    this.skillXAdapter = new SkillXAdapter();
  }

  computeRequestFingerprint(toolkits: ToolkitSelection[]): string {
    const canonical = [...toolkits].sort((a, b) => {
      const idA = a.kind === 'preset' ? (a.instanceId || a.id) : a.instanceId;
      const idB = b.kind === 'preset' ? (b.instanceId || b.id) : b.instanceId;
      return idA.localeCompare(idB);
    });
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  listCatalogPresets(): ToolkitCatalogPreset[] {
    return Object.values(TOOLKIT_CATALOG);
  }

  /**
   * Acquires one skill from a registry into the cache and reports the bundle that holds it. A launch
   * resolves a whole repository; an import resolves a single skill. Both go through the same adapters and
   * the same cache, so a skill imported here is the same bytes a launch would later resolve, and a
   * cache-only deployment refuses the import for the same reason it refuses a launch.
   */
  async importSkillPackage(
    ownerId: string,
    input: { sourceKind: 'skills-sh' | 'skillx'; sourceRef: string; ref?: string | undefined; subdirectory?: string | undefined },
    signal?: AbortSignal
  ): Promise<{
    bundleSha256: string;
    byteCount: number;
    fileCount: number;
    resolvedRevision: string;
    hasExecutableAssets: boolean;
    skills: Array<{ name: string; contentSha256: string }>;
  }> {
    const ref = input.ref || 'HEAD';
    const configDigest = createHash('sha256').update(JSON.stringify({
      provider: input.sourceKind,
      reference: input.sourceRef,
      ref: input.ref ?? null,
      subdirectory: input.subdirectory ?? null
    })).digest('hex');
    const adapterVersion = input.sourceKind === 'skillx' ? SkillXAdapter.ADAPTER_VERSION : SkillsShAdapter.ADAPTER_VERSION;
    const spec = {
      sourceIdentity: `registry:${input.sourceKind}:${input.sourceRef}`,
      resolvedRevision: ref,
      adapterVersion,
      configDigest
    };
    if (!this.cacheManager.getExisting(ownerId, spec) && this.toolkitNetworkPolicy === 'cache-only') {
      throw new HarnessError('NOT_FOUND', `Skill ${input.sourceRef} is not cached and toolkitNetworkPolicy is cache-only`, 404, false);
    }

    // The adapter resolves a mutable ref to a full commit OID, and that resolved value is what the caller
    // records, so an imported revision names the commit that was actually read rather than the ref asked for.
    let resolvedRevision = ref;
    let skills: Array<{ name: string; contentSha256: string }> = [];
    let hasExecutableAssets = false;
    const bundle = await this.cacheManager.getOrAcquire(ownerId, spec, async (stagingDir) => {
      const result = input.sourceKind === 'skillx'
        ? await this.skillXAdapter.acquireAndNormalize(ownerId, stagingDir, { reference: input.sourceRef, signal })
        : await this.skillsShAdapter.acquireAndNormalize(ownerId, stagingDir, {
          reference: input.sourceRef,
          ...(input.ref ? { ref: input.ref } : {}),
          ...(input.subdirectory ? { subdirectory: input.subdirectory } : {}),
          ...(signal ? { signal } : {})
        });
      resolvedRevision = result.manifest.resolvedRevision;
      skills = result.manifest.skills;
      // The adapters report a tree digest, not whether that tree carries anything to execute, so the
      // answer is read from the staged tree. It decides whether a later run is allowed to look for a
      // script at all, so it is measured here rather than assumed by the caller.
      hasExecutableAssets = existsSync(join(stagingDir, 'scripts'));
      return result;
    });

    return {
      bundleSha256: bundle.bundleSha256,
      byteCount: bundle.byteCount,
      fileCount: bundle.fileCount,
      resolvedRevision,
      hasExecutableAssets,
      skills
    };
  }

  async resolveToolkits(
    ownerId: string,
    toolkits: ToolkitSelection[],
    options?: { signal?: AbortSignal | undefined } | undefined
  ): Promise<{ lockItems: ToolkitLockItem[]; bundlePaths: Array<{ instanceId: string; path: string; scope: 'owner' | 'workspace' }> }> {
    const lockItems: ToolkitLockItem[] = [];
    const bundlePaths: Array<{ instanceId: string; path: string; scope: 'owner' | 'workspace' }> = [];

    for (const item of toolkits) {
      if (item.kind === 'preset') {
        const catalogPreset = TOOLKIT_CATALOG[item.id];
        if (!catalogPreset) {
          throw new Error(`Unknown toolkit preset: ${item.id}`);
        }

        const instanceId = item.instanceId || item.id;
        const resolvedVersion = item.version || catalogPreset.defaultRevision;

        if (item.id === 'mattpocock/skills') {
          const configDigest = createHash('sha256').update(JSON.stringify(item.skills ?? {})).digest('hex');
          const spec = {
            sourceIdentity: catalogPreset.sourceUrl,
            resolvedRevision: resolvedVersion,
            adapterVersion: MattPocockAdapter.ADAPTER_VERSION,
            configDigest
          };
          const existing = this.cacheManager.getExisting(ownerId, spec);
          if (!existing && this.toolkitNetworkPolicy === 'cache-only') {
            throw new HarnessError('NOT_FOUND', `Toolkit ${item.id} is not cached and toolkitNetworkPolicy is cache-only`, 404, false);
          }

          const bundle = await this.cacheManager.getOrAcquire(ownerId, spec, async (stagingDir) => {
            const res = await this.mattPocockAdapter.acquireAndNormalize(ownerId, stagingDir, {
              revision: resolvedVersion,
              skillFilter: item.skills,
              signal: options?.signal
            });
            return {
              bundleSha256: res.bundleSha256,
              byteCount: res.byteCount,
              fileCount: res.fileCount
            };
          });

          bundlePaths.push({ instanceId, path: bundle.bundlePath, scope: item.scope });
          lockItems.push({
            instanceId,
            id: item.id,
            requestedVersion: item.version ?? null,
            resolvedVersion,
            resolvedRevision: resolvedVersion,
            bundleSha256: bundle.bundleSha256,
            adapterVersion: MattPocockAdapter.ADAPTER_VERSION,
            scope: item.scope,
            status: 'ready',
            cache: 'hit',
            activation: item.activation,
            skillsCount: bundle.fileCount > 0 ? 53 : 0,
            verification: 'catalog-pinned'
          });
        } else if (item.id === 'obra/superpowers') {
          const configDigest = createHash('sha256').update(JSON.stringify(item.skills ?? {})).digest('hex');
          const spec = {
            sourceIdentity: catalogPreset.sourceUrl,
            resolvedRevision: resolvedVersion,
            adapterVersion: SuperpowersAdapter.ADAPTER_VERSION,
            configDigest
          };
          const existing = this.cacheManager.getExisting(ownerId, spec);
          if (!existing && this.toolkitNetworkPolicy === 'cache-only') {
            throw new HarnessError('NOT_FOUND', `Toolkit ${item.id} is not cached and toolkitNetworkPolicy is cache-only`, 404, false);
          }

          const bundle = await this.cacheManager.getOrAcquire(ownerId, spec, async (stagingDir) => {
            const res = await this.superpowersAdapter.acquireAndNormalize(ownerId, stagingDir, {
              revision: resolvedVersion,
              skillFilter: item.skills,
              signal: options?.signal
            });
            return {
              bundleSha256: res.bundleSha256,
              byteCount: res.byteCount,
              fileCount: res.fileCount
            };
          });

          bundlePaths.push({ instanceId, path: bundle.bundlePath, scope: item.scope });
          lockItems.push({
            instanceId,
            id: item.id,
            requestedVersion: item.version ?? null,
            resolvedVersion,
            resolvedRevision: resolvedVersion,
            bundleSha256: bundle.bundleSha256,
            adapterVersion: SuperpowersAdapter.ADAPTER_VERSION,
            scope: item.scope,
            status: 'ready',
            cache: 'hit',
            activation: item.activation,
            skillsCount: 14,
            verification: 'catalog-pinned'
          });
        }
      } else if (item.kind === 'git') {
        const configDigest = createHash('sha256').update(JSON.stringify({ layout: item.layout, skills: item.skills })).digest('hex');
        const ref = item.ref || 'HEAD';
        const spec = {
            sourceIdentity: item.url,
            resolvedRevision: ref,
            adapterVersion: DeclarativeGitAdapter.ADAPTER_VERSION,
            configDigest
        };
        const existing = this.cacheManager.getExisting(ownerId, spec);
        if (!existing && this.toolkitNetworkPolicy === 'cache-only') {
          throw new HarnessError('NOT_FOUND', `Toolkit ${item.instanceId} is not cached and toolkitNetworkPolicy is cache-only`, 404, false);
        }

        const bundle = await this.cacheManager.getOrAcquire(ownerId, spec, async (stagingDir) => {
          const res = await this.gitAdapter.acquireAndNormalize(ownerId, stagingDir, {
            instanceId: item.instanceId,
            url: item.url,
            ref,
            subdirectory: item.subdirectory,
            layout: item.layout,
            skills: item.skills
          }, options?.signal ? { signal: options.signal } : undefined);
          return {
            bundleSha256: res.bundleSha256,
            byteCount: res.byteCount,
            fileCount: res.fileCount
          };
        });

        bundlePaths.push({ instanceId: item.instanceId, path: bundle.bundlePath, scope: item.scope });
        lockItems.push({
          instanceId: item.instanceId,
          id: `git:${item.instanceId}`,
          requestedVersion: item.ref ?? null,
          resolvedVersion: ref,
          resolvedRevision: ref,
          bundleSha256: bundle.bundleSha256,
          adapterVersion: DeclarativeGitAdapter.ADAPTER_VERSION,
          scope: item.scope,
          status: 'ready',
          cache: 'hit',
          activation: item.activation,
          skillsCount: bundle.fileCount,
          verification: 'custom-unverified'
        });
      } else if (item.kind === 'registry') {
        const ref = item.ref || 'HEAD';
        const configDigest = createHash('sha256').update(JSON.stringify({
          provider: item.provider,
          reference: item.reference,
          ref: item.ref ?? null,
          subdirectory: item.subdirectory ?? null,
          skills: item.skills ?? null
        })).digest('hex');
        const adapterVersion = item.provider === 'skillx' ? SkillXAdapter.ADAPTER_VERSION : SkillsShAdapter.ADAPTER_VERSION;
        const spec = {
          sourceIdentity: `registry:${item.provider}:${item.reference}`,
          resolvedRevision: ref,
          adapterVersion,
          configDigest
        };
        const existing = this.cacheManager.getExisting(ownerId, spec);
        if (!existing && this.toolkitNetworkPolicy === 'cache-only') {
          throw new HarnessError('NOT_FOUND', `Toolkit ${item.instanceId} is not cached and toolkitNetworkPolicy is cache-only`, 404, false);
        }

        // The adapters resolve a mutable ref to a full commit OID. That resolved value is captured here
        // so the lock records the commit that was actually pinned rather than the ref that was asked for.
        let resolvedRevision = ref;
        const bundle = await this.cacheManager.getOrAcquire(ownerId, spec, async (stagingDir) => {
          const res = item.provider === 'skillx'
            ? await this.skillXAdapter.acquireAndNormalize(ownerId, stagingDir, { reference: item.reference, signal: options?.signal })
            : await this.skillsShAdapter.acquireAndNormalize(ownerId, stagingDir, {
              reference: item.reference,
              revision: item.ref,
              skillFilter: item.skills,
              signal: options?.signal
            });
          resolvedRevision = res.manifest.resolvedRevision;
          return {
            bundleSha256: res.bundleSha256,
            byteCount: res.byteCount,
            fileCount: res.fileCount
          };
        });

        bundlePaths.push({ instanceId: item.instanceId, path: bundle.bundlePath, scope: item.scope });
        lockItems.push({
          instanceId: item.instanceId,
          id: `registry:${item.provider}:${item.reference}`,
          requestedVersion: item.ref ?? null,
          resolvedVersion: ref,
          resolvedRevision,
          bundleSha256: bundle.bundleSha256,
          adapterVersion,
          scope: item.scope,
          status: 'ready',
          cache: 'hit',
          activation: item.activation,
          skillsCount: bundle.fileCount,
          // Provenance stays 'custom-unverified' because a registry import is a remote, operator-chosen
          // source that is not in the built-in catalog. The pin is carried by `resolvedRevision`, which
          // holds the full commit OID the adapter resolved, not the mutable ref that was requested.
          verification: 'custom-unverified'
        });
      }
    }

    return { lockItems, bundlePaths };
  }
}
