import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError, toolkitSelectionIdentity, type LicensedKitCatalogEntry, type ToolkitLockItem, type ToolkitSelection } from '@cloud-harness/contracts';
import { MattPocockAdapter } from './adapters/mattpocock-adapter.js';
import { SuperpowersAdapter } from './adapters/superpowers-adapter.js';
import { DeclarativeGitAdapter } from './adapters/git-adapter.js';
import { SkillsShAdapter } from './adapters/skills-sh-adapter.js';
import { SkillXAdapter } from './adapters/skillx-adapter.js';
import { AgentKitRegistryAdapter } from './adapters/agentkit-adapter.js';
import { normalizeAgentKitVersion, parseAgentKitPublicKey } from './agentkit-registry.js';
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
  private readonly skillsShAdapter: SkillsShAdapter;
  private readonly skillXAdapter: SkillXAdapter;
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
      credentialReady = Boolean(this.metadata?.secrets
        .consumeProvisioningSecret(ownerId, 'global', undefined, this.agentkitCredentialSecretName)
        .plaintext);
    } catch {
      // An unavailable secret store, or a token stored without `purpose: provisioning`, cannot serve
      // a credential, so the catalog reports not-ready instead of failing the whole listing.
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

  /**
   * Resolves the AgentKit licence token from a `provisioning`-purpose global secret. A `runtime`
   * secret is refused: runtime secrets are injected into executor environments, so accepting one here
   * would let untrusted repository code read the licence token.
   */
  private consumeAgentKitCredential(ownerId: string, secretName: string): string {
    let credential: string | undefined;
    try {
      credential = this.metadata?.secrets
        .consumeProvisioningSecret(ownerId, 'global', undefined, secretName)
        .plaintext;
    } catch {
      credential = undefined;
    }
    if (!credential) {
      throw new HarnessError(
        'INVALID_INPUT',
        `The agentkit toolkit needs the ${secretName} secret stored for this principal with purpose 'provisioning'; a runtime-purpose secret is refused because runtime secrets are injected into executors`,
        400,
        false
      );
    }
    return credential;
  }

  /**
   * Finds the most recently used cached AgentKit bundle for a selection without any registry call.
   * `listToolkitCacheEntries` is ordered newest-first, and the requested version and skill filter must
   * match the cached bundle's manifest so a cache-only start cannot serve a different selection.
   */
  private findCachedAgentKitBundle(
    ownerId: string,
    item: Extract<ToolkitSelection, { kind: 'agentkit' }>
  ): { bundlePath: string; bundleSha256: string; resolvedRevision: string; version: string; skillsCount: number } | undefined {
    const sourceIdentity = `agentkit:${item.kitId}:${item.channel}`;
    for (const entry of this.store.listToolkitCacheEntries(ownerId)) {
      if (entry.status !== 'READY') continue;
      if (entry.sourceIdentity !== sourceIdentity) continue;
      if (entry.adapterVersion !== AgentKitRegistryAdapter.ADAPTER_VERSION) continue;
      const bundlePath = this.cacheManager.bundlePath(ownerId, entry.bundleSha256);
      if (!existsSync(bundlePath)) continue;
      const manifest = readAgentKitBundleManifest(bundlePath);
      if (!manifest) continue;
      if (item.version && normalizeAgentKitVersion(manifest.version) !== normalizeAgentKitVersion(item.version)) continue;
      if (!matchesAgentKitSkillFilter(manifest.skills.map((skill) => skill.name), item.skills)) continue;
      return {
        bundlePath,
        bundleSha256: entry.bundleSha256,
        resolvedRevision: entry.resolvedRevision,
        version: manifest.version,
        skillsCount: manifest.skills.length
      };
    }
    return undefined;
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
        const instanceId = item.instanceId ?? `agentkit:${item.kitId}:${item.channel}`;

        // `cache-only` deployments never contact the registry: the bundle an earlier runner-fetch
        // acquisition recorded is reused by its stable source identity, so a warm cache starts with
        // zero toolkit network egress.
        if (this.toolkitNetworkPolicy === 'cache-only') {
          const cached = this.findCachedAgentKitBundle(ownerId, item);
          if (!cached) {
            throw new HarnessError(
              'NOT_FOUND',
              `Toolkit ${item.kitId}@${item.channel} is not cached and toolkitNetworkPolicy is cache-only; set TOOLKIT_NETWORK_POLICY=runner-fetch to acquire it`,
              404,
              false
            );
          }
          bundlePaths.push({ instanceId, path: cached.bundlePath, scope: item.scope });
          lockItems.push({
            instanceId,
            id: `agentkit:${item.kitId}`,
            requestedVersion: item.version ?? null,
            resolvedVersion: cached.version,
            resolvedRevision: cached.resolvedRevision,
            bundleSha256: cached.bundleSha256,
            adapterVersion: AgentKitRegistryAdapter.ADAPTER_VERSION,
            scope: item.scope,
            status: 'ready',
            cache: 'hit',
            activation: item.activation,
            skillsCount: cached.skillsCount,
            verification: 'registry-signed',
            ...(item.channel === 'stable' ? {} : { warnings: [`AgentKit ${item.channel} channel content`] })
          });
          continue;
        }

        const credential = this.consumeAgentKitCredential(ownerId, adapter.credentialSecretName);
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

type AgentKitBundleManifest = { version: string; skills: Array<{ name: string }> };

/** Reads the manifest the AgentKit adapter wrote into a cached bundle, or `undefined` if unusable. */
function readAgentKitBundleManifest(bundlePath: string): AgentKitBundleManifest | undefined {
  let parsed: { version?: unknown; skills?: unknown };
  try {
    parsed = JSON.parse(readFileSync(join(bundlePath, 'manifest.json'), 'utf8')) as { version?: unknown; skills?: unknown };
  } catch {
    return undefined;
  }
  if (typeof parsed.version !== 'string' || !Array.isArray(parsed.skills)) return undefined;
  const skills: Array<{ name: string }> = [];
  for (const skill of parsed.skills) {
    if (!skill || typeof skill !== 'object') return undefined;
    const name = (skill as { name?: unknown }).name;
    if (typeof name !== 'string') return undefined;
    skills.push({ name });
  }
  return { version: parsed.version, skills };
}

/** A cached bundle satisfies the selection only when the requested include/exclude names all match. */
function matchesAgentKitSkillFilter(
  names: string[],
  filter: { include?: string[] | undefined; exclude?: string[] | undefined } | undefined
): boolean {
  if (!filter) return true;
  const available = new Set(names);
  if (filter.include && filter.include.some((name) => !available.has(name))) return false;
  if (filter.exclude && filter.exclude.some((name) => available.has(name))) return false;
  return true;
}
