import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError, toolkitSelectionIdentity, type LicensedKitCatalogEntry, type ToolkitLockItem, type ToolkitSelection } from '@cloud-harness/contracts';
import { MattPocockAdapter } from './adapters/mattpocock-adapter.js';
import { SuperpowersAdapter } from './adapters/superpowers-adapter.js';
import { DeclarativeGitAdapter } from './adapters/git-adapter.js';
import { AgentKitRegistryAdapter } from './adapters/agentkit-adapter.js';
import { parseAgentKitPublicKey } from './agentkit-registry.js';
import type { MetadataStore } from './metadata-store.js';
import type { RepositoryCacheManager } from './repository-cache-manager.js';
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

export type LicensedKitDescriptor = {
  kitId: 'engineer' | 'marketing';
  name: string;
  description: string;
  defaultChannel: 'dev' | 'beta' | 'stable';
};

/**
 * Licensed kit display metadata for `toolkits_list`. The installable surface is
 * owned by the `agentkit` selection kind; this table only names the kits a
 * client can offer, and availability is decided per instance and per principal.
 */
export const LICENSED_KIT_CATALOG: Record<'engineer' | 'marketing', LicensedKitDescriptor> = {
  engineer: {
    kitId: 'engineer',
    name: 'AgentKit Engineer',
    description: 'Engineer-specialized licensed kit: extends the core kit with engineer-unique agents, skills, hooks, schemas, and scripts.',
    defaultChannel: 'stable'
  },
  marketing: {
    kitId: 'marketing',
    name: 'AgentKit Marketing',
    description: 'Marketing-specialized licensed kit: extends the core kit with marketing-unique agents, skills, hooks, and scripts.',
    defaultChannel: 'stable'
  }
};

export class ToolkitService {
  private readonly cacheManager: ToolkitCacheManager;
  private readonly repoCacheManager: RepositoryCacheManager;
  private readonly store: StateStore;
  private readonly metadata?: MetadataStore | undefined;
  private readonly mattPocockAdapter: MattPocockAdapter;
  private readonly superpowersAdapter: SuperpowersAdapter;
  private readonly gitAdapter: DeclarativeGitAdapter;
  private readonly agentkitAdapter?: AgentKitRegistryAdapter | undefined;
  private readonly agentkitCredentialSecretName: string;
  private readonly enableToolkitCache: boolean;
  private readonly toolkitNetworkPolicy: 'cache-only' | 'runner-fetch';

  constructor(options: {
    cacheManager: ToolkitCacheManager;
    repoCacheManager: RepositoryCacheManager;
    metadata?: MetadataStore | undefined;
    store: StateStore;
    executorImage: string;
    provisioningNetwork: string;
    toolkitEgressProxy?: string | undefined;
    allowedGitHosts: string[];
    instanceId: string;
    enableToolkitCache?: boolean | undefined;
    toolkitNetworkPolicy?: ('cache-only' | 'runner-fetch') | undefined;
    agentkitRegistry?: {
      registryUrl: string;
      credentialSecretName: string;
      keyId?: string | undefined;
      publicKey?: string | undefined;
    } | undefined;
  }) {
    this.cacheManager = options.cacheManager;
    this.repoCacheManager = options.repoCacheManager;
    this.metadata = options.metadata;
    this.store = options.store;
    this.enableToolkitCache = options.enableToolkitCache ?? true;
    this.toolkitNetworkPolicy = options.toolkitNetworkPolicy ?? 'cache-only';
    const proxyOpts = options.toolkitEgressProxy ? { toolkitEgressProxy: options.toolkitEgressProxy } : {};

    this.agentkitCredentialSecretName = options.agentkitRegistry?.credentialSecretName ?? 'AGENTKIT_REGISTRY_TOKEN';
    if (options.agentkitRegistry?.keyId && options.agentkitRegistry.publicKey) {
      this.agentkitAdapter = new AgentKitRegistryAdapter({
        registryUrl: options.agentkitRegistry.registryUrl,
        credentialSecretName: this.agentkitCredentialSecretName,
        keyId: options.agentkitRegistry.keyId,
        publicKey: parseAgentKitPublicKey(options.agentkitRegistry.publicKey),
        executorImage: options.executorImage
      });
    }

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
    const canonical = [...toolkits].sort((a, b) =>
      toolkitSelectionIdentity(a).localeCompare(toolkitSelectionIdentity(b)));
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  listCatalogPresets(): ToolkitCatalogPreset[] {
    return Object.values(TOOLKIT_CATALOG);
  }

  /**
   * Licensed kits this instance can serve, with the two readiness gates a client
   * must know before offering them: `available` is instance key material and
   * `credentialReady` is this principal's stored licence token. Neither field
   * carries a credential value.
   */
  listLicensedKitCatalog(ownerId: string): LicensedKitCatalogEntry[] {
    let credentialReady = false;
    try {
      credentialReady = Boolean(this.metadata?.globalSecretValue(ownerId, this.agentkitCredentialSecretName));
    } catch {
      // An unavailable secret store cannot serve a credential, so the catalog
      // reports not-ready instead of failing the whole listing.
      credentialReady = false;
    }
    return Object.values(LICENSED_KIT_CATALOG).map((kit) => ({
      kind: 'agentkit' as const,
      kitId: kit.kitId,
      name: kit.name,
      description: kit.description,
      defaultChannel: kit.defaultChannel,
      available: Boolean(this.agentkitAdapter),
      credentialReady,
      requiresCredentialSecret: this.agentkitCredentialSecretName,
      supportedScopes: ['owner'] as ['owner'],
      activation: 'skills-only' as const,
      verification: 'registry-signed' as const
    }));
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
      } else if (item.kind === 'agentkit') {
        const adapter = this.agentkitAdapter;
        if (!adapter) {
          throw new HarnessError(
            'INVALID_INPUT',
            'AgentKit kits are not configured on this instance; set AGENTKIT_REGISTRY_KEY_ID and AGENTKIT_REGISTRY_PUBLIC_KEY',
            400,
            false
          );
        }
        const credential = this.metadata?.globalSecretValue(ownerId, adapter.credentialSecretName);
        if (!credential) {
          throw new HarnessError(
            'INVALID_INPUT',
            `The agentkit toolkit needs the ${adapter.credentialSecretName} secret stored for this principal`,
            400,
            false
          );
        }

        const instanceId = item.instanceId ?? `agentkit:${item.kitId}:${item.channel}`;
        // The signed manifest is resolved first, so the cache key names the exact
        // published artifact rather than the floating channel: a channel that
        // moves to a new release cannot be served from a stale cached bundle.
        const resolved = await adapter.resolveKit(item, { credential, signal: options?.signal });
        const configDigest = createHash('sha256').update(JSON.stringify({
          kitId: item.kitId,
          channel: item.channel,
          version: item.version ?? null,
          skills: item.skills ?? {}
        })).digest('hex');
        const spec = {
          sourceIdentity: `agentkit:${item.kitId}:${item.channel}`,
          resolvedRevision: resolved.artifact.sha256,
          adapterVersion: AgentKitRegistryAdapter.ADAPTER_VERSION,
          configDigest
        };
        const existing = this.cacheManager.getExisting(ownerId, spec);
        if (!existing && this.toolkitNetworkPolicy === 'cache-only') {
          throw new HarnessError(
            'NOT_FOUND',
            `Toolkit ${item.kitId}@${resolved.version} is not cached and toolkitNetworkPolicy is cache-only`,
            404,
            false
          );
        }

        const bundle = await this.cacheManager.getOrAcquire(ownerId, spec, async (stagingDir) => {
          const res = await adapter.materialize(stagingDir, item, resolved, {
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
          id: `agentkit:${item.kitId}`,
          requestedVersion: item.version ?? null,
          resolvedVersion: resolved.version,
          resolvedRevision: resolved.artifact.sha256,
          bundleSha256: bundle.bundleSha256,
          adapterVersion: AgentKitRegistryAdapter.ADAPTER_VERSION,
          scope: item.scope,
          status: 'ready',
          cache: existing ? 'hit' : 'miss',
          activation: item.activation,
          skillsCount: countBundleSkills(bundle.bundlePath),
          verification: 'registry-signed',
          ...(item.channel === 'stable' ? {} : { warnings: [`AgentKit ${item.channel} channel content`] })
        });
      }
    }

    return { lockItems, bundlePaths };
  }
}

/** Skill count is read from the cached bundle manifest so a cache hit reports it too. */
function countBundleSkills(bundlePath: string): number {
  try {
    const manifest = JSON.parse(readFileSync(join(bundlePath, 'manifest.json'), 'utf8')) as { skills?: unknown };
    return Array.isArray(manifest.skills) ? manifest.skills.length : 0;
  } catch {
    return 0;
  }
}
