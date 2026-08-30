import { createHash } from 'node:crypto';
import { HarnessError, type ToolkitLockItem, type ToolkitSelection } from '@cloud-harness/contracts';
import { MattPocockAdapter } from './adapters/mattpocock-adapter.js';
import { SuperpowersAdapter } from './adapters/superpowers-adapter.js';
import { DeclarativeGitAdapter } from './adapters/git-adapter.js';
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
  }

  computeRequestFingerprint(toolkits: ToolkitSelection[]): string {
    const canonical = [...toolkits].sort((a, b) => {
      const idA = a.kind === 'git' ? a.instanceId : a.id;
      const idB = b.kind === 'git' ? b.instanceId : b.id;
      return idA.localeCompare(idB);
    });
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  listCatalogPresets(): ToolkitCatalogPreset[] {
    return Object.values(TOOLKIT_CATALOG);
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
            verification: 'catalog-pinned',
            compatibility: 'context-ready'
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
      }
    }

    return { lockItems, bundlePaths };
  }
}
