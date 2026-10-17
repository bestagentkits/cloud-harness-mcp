import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  HarnessError, MetadataRunnerRequestSchema, ModelCatalogRefreshResultSchema, ModelCatalogSearchResultSchema,
  listModelProviders, qualifiedToolName,
  type AgentModelPricing, type AgentModelProfileMetadata, type MetadataRunnerRequest, type ModelCatalogPriceRef, type RunnerConfig,
  type RunnerResponse
} from '@cloud-harness/contracts';
import { ArtifactStoreError, type ArtifactStore } from './artifact-store.js';
import type { GitHubBindingService } from './github-binding-service.js';
import type { GitHubInstallationStore } from './github-installation-store.js';
import type { McpGatewayStoredHeader } from './mcp-gateway-store.js';
import { McpOAuthStoreError } from './mcp-oauth-store.js';
import type { MetadataStore } from './metadata-store.js';
import { readSkillArchive } from './skill-archive.js';
import { SkillExtensionService } from './skill-extension-service.js';
import { SkillRegistryError, type PrivilegeGrantRecord, type StateStore } from './state-store.js';
import { compareSemver, isSemver, parseSkillVersion, trustedSkillVersion } from './skill-version.js';
import { IntegrationCredentialError, IntegrationCredentialRepository } from './integration-credential-repository.js';
import type { SecretKeyring } from './secret-keyring.js';
import { FITS_THRESHOLD, GATE_THRESHOLD, TYPESAFE_DEFAULT_ENDPOINT, TYPESAFE_DEFAULT_MODEL } from './typesafe-questions.js';

/**
 * The version a revision should carry. An explicit contract value wins because the operator chose it
 * deliberately; otherwise the document's own declaration is used. A malformed declaration is refused
 * rather than stored, because a version that cannot be parsed could never be compared for drift.
 */
function resolveSkillVersion(instructions: string, explicit?: string): string | null {
  const declared = parseSkillVersion(instructions);
  if (declared !== undefined && !isSemver(declared)) {
    throw new HarnessError('INVALID_INPUT', `metadata.version "${declared}" is not a semantic version`, 400, false);
  }
  return explicit ?? declared ?? null;
}

/**
 * Advisory text when a revision does not advance the declared version. This is deliberately not a
 * rejection: keeping a version is a legitimate operator choice, so drift only ever warns.
 */
function skillVersionDriftWarning(previous: string | null, next: string | null): string | undefined {
  if (previous === null || next === null || compareSemver(next, previous) > 0) return undefined;
  return `declared version ${next} does not advance the current revision's ${previous}`;
}
import { TypesafeSkillSuggester, type RosterEntry } from './typesafe-skill-suggester.js';
import type { DecisionPlane } from './decision-plane/decision-plane.js';
import { providerCredentialSecrets } from './decision-plane/runner-decision-plane.js';
import { rerankTools } from './decision-plane/tool-router.js';
import { TOOLKIT_CATALOG } from './toolkit-service.js';
import { diffRevisionText, formatRevisionDiff } from './revision-diff.js';
import { fetchRegistrySearch } from './adapters/registry-search.js';
import { parseSkillsShSearchResults } from './adapters/skills-sh-adapter.js';
import { parseSkillXSearchResults } from './adapters/skillx-adapter.js';

/** A revision's content is prose, so the read is bounded rather than trusting the file size. */
const MAX_REVISION_BYTES = 262_144;
import { resolveWorkspaceSkills, type SkillCandidate, type SkillTier } from './skill-resolver.js';
import type { WorkspaceService } from './workspace-service.js';
import type { ModelProfileStateRepository, ProfileRevisionOptions } from './model-profile-state-repository.js';
import { ModelCatalogService } from './model-catalog/model-catalog-service.js';
import { reviewPricing, savedPriceProvenance } from './model-catalog/pricing-review.js';
import { createProviderHttpClient, type ProviderHttpClient } from './model-provider-http.js';
import { ModelConnectionVerifier } from './model-verification/model-connection-verifier.js';
import type { AgentGatewayControl } from './agent-gateway-control.js';
import { ModelSpendLedger, type ModelSpendPolicyHooks } from './model-spend-ledger.js';
import { packageApprovalUnavailable } from './config.js';
import {
  PACKAGE_HISTORY_DEPTH, PackageStore, packageApplyView, packagePlanSummary,
  type PackageApplyRecord, type PackagePlanRecord, type PackageReleaseRecord
} from './package-store.js';

export class DashboardControlService {
  private connectionVerifier?: ModelConnectionVerifier;

  constructor(
    private readonly config: RunnerConfig,
    private readonly principals: StateStore,
    private readonly metadata: MetadataStore,
    private readonly artifacts: ArtifactStore,
    private readonly workspaces: WorkspaceService,
    private readonly githubInstallations?: GitHubInstallationStore,
    private readonly githubBinding?: GitHubBindingService,
    private readonly modelProfiles?: ModelProfileStateRepository,
    private readonly gatewayControl?: AgentGatewayControl,
    private readonly keyring?: SecretKeyring,
    private readonly decisionPlane?: DecisionPlane,
    private readonly providerHttp?: ProviderHttpClient,
    private spendLedger?: ModelSpendLedger
  ) {}

  /**
   * Runs one import to completion and records every transition on the job row, because that row is what
   * survives a restart. An import of a skill that is already present adds a revision rather than
   * replacing the source, so a launch that pinned the previous revision keeps resolving to the bytes it
   * verified. A failure is recorded rather than thrown: the caller already holds the job id and there is
   * no request left for the error to answer.
   */
  /**
   * A job row outlives the process that wrote it, which is the point of the table, but a job left in
   * `running` when the runner stopped would never reach a terminal state on its own. Startup turns those
   * into failures, so the dashboard reports an interrupted import instead of a spinner that never ends.
   */
  reconcileInterruptedImports(): number {
    const interrupted = this.principals.listInterruptedSkillImportJobs();
    for (const job of interrupted) {
      this.principals.advanceSkillImportJob({
        ownerId: job.ownerId,
        id: job.id,
        state: 'failed',
        errorCode: 'INTERRUPTED',
        resultJson: JSON.stringify({ message: 'the runner restarted while this import was in flight' })
      });
    }
    return interrupted.length;
  }

  private async runSkillImport(
    ownerId: string,
    jobId: string,
    input: { sourceKind: 'skills-sh' | 'skillx' | 'git'; sourceRef: string; ref?: string | undefined; subdirectory?: string | undefined }
  ): Promise<void> {
    try {
      this.principals.advanceSkillImportJob({
        ownerId, id: jobId, state: 'running', progressJson: JSON.stringify({ phase: 'acquiring' })
      });
      if (input.sourceKind === 'git') {
        throw new HarnessError('INVALID_INPUT', 'this path acquires from a registry, so a git source is not supported here', 400, false);
      }
      const acquired = await this.workspaces.toolkitService.importSkillPackage(ownerId, {
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        ...(input.ref ? { ref: input.ref } : {}),
        ...(input.subdirectory ? { subdirectory: input.subdirectory } : {})
      });
      const first = acquired.skills[0];
      if (!first) {
        throw new HarnessError('NOT_FOUND', `${input.sourceRef} resolved to no skills`, 404, false);
      }
      this.principals.advanceSkillImportJob({
        ownerId, id: jobId, state: 'running',
        progressJson: JSON.stringify({ phase: 'publishing', skills: acquired.skills.length, resolvedRevision: acquired.resolvedRevision })
      });
      const slug = first.name.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120) || 'imported-skill';
      const existing = this.principals.listSkillSources(ownerId, { limit: 200 })
        .find((skill) => skill !== undefined && skill.slug === slug);
      const revisionId = existing
        ? this.principals.addSkillRevision({
          ownerId,
          skillSourceId: existing.id,
          bundleSha256: acquired.bundleSha256,
          contentSha256: first.contentSha256,
          hasExecutableAssets: acquired.hasExecutableAssets,
          origin: 'import'
        })
        : this.principals.createSkillSource({
          ownerId,
          slug,
          displayName: first.name,
          kind: 'owner',
          provider: input.sourceKind,
          description: '',
          revision: {
            bundleSha256: acquired.bundleSha256,
            contentSha256: first.contentSha256,
            hasExecutableAssets: acquired.hasExecutableAssets,
            origin: 'import'
          }
        }).revisionId;
      this.principals.advanceSkillImportJob({
        ownerId, id: jobId, state: 'succeeded', skillRevisionId: revisionId,
        resultJson: JSON.stringify({
          slug,
          resolvedRevision: acquired.resolvedRevision,
          skills: acquired.skills.map((skill) => skill.name)
        })
      });
    } catch (error) {
      this.principals.advanceSkillImportJob({
        ownerId, id: jobId, state: 'failed',
        errorCode: error instanceof HarnessError ? error.code : 'INTERNAL_ERROR',
        resultJson: JSON.stringify({ message: error instanceof Error ? error.message : 'import failed' })
      });
    }
  }

  /**
   * A provider that fails is reported as a warning rather than as zero results, because an empty list is
   * a claim about a catalogue while a failure is a claim about the request. Each lookup is isolated so
   * that one unreachable provider cannot hide the local results or the other provider's hits.
   */
  private async searchRemoteRegistries(
    requested: Array<'local' | 'skills-sh' | 'skillx'>,
    query: string,
    limit: number
  ): Promise<Array<{ provider: string; status: string; warning?: string; count: number; results: unknown[] }>> {
    return await Promise.all(requested.filter((provider) => provider !== 'local').map(async (provider) => {
      const base = provider === 'skills-sh' ? 'https://skills.sh' : 'https://skillx.sh';
      try {
        const payload = await fetchRegistrySearch(`${base}/api/search?q=${encodeURIComponent(query)}`, globalThis.fetch);
        const results = provider === 'skills-sh'
          ? parseSkillsShSearchResults(payload, limit)
          : parseSkillXSearchResults(payload, limit);
        return { provider, status: 'ok', count: results.length, results };
      } catch (error) {
        return {
          provider,
          status: 'unavailable',
          warning: error instanceof Error ? error.message : String(error),
          count: 0,
          results: []
        };
      }
    }));
  }

  /**
   * from the secret snapshot, while a provider credential lives in the model credential tables and would
   * otherwise never be redacted. The enumeration is deliberately not wrapped in a catch: if it cannot be
   * read, redaction cannot be complete, and the engine must fail closed rather than send.
   */
  private suggester(ownerId: string, workspaceId: string, apiKey: string): TypesafeSkillSuggester {
    return new TypesafeSkillSuggester({
      apiKey: () => apiKey,
      enabled: () => this.config.typesafeEgress !== 'off',
      secrets: () => ({
        ...this.workspaces.redactionSecrets(workspaceId),
        ...this.providerCredentialSecrets(ownerId)
      })
    });
  }

  private providerCredentialSecrets(ownerId: string): Record<string, string> {
    return providerCredentialSecrets(this.modelProfiles, ownerId);
  }

  /**
   * The content a revision pinned, read from the bundle it names in the cache.
   *
   * A bundle holds its skills under `skills/<name>`, so the known layouts are tried in order. The check
   * is `isFile()` rather than existence on purpose: a Docker mount point can leave a directory where a
   * file is expected, and reading it would raise rather than fall through to the next layout.
   */
  private readRevisionText(ownerId: string, bundleSha256: string, slug: string | undefined): string | undefined {
    const bundlePath = this.workspaces.toolkitCacheManager.bundlePath(ownerId, bundleSha256);
    const candidates = [
      ...(slug ? [join(bundlePath, 'skills', slug, 'SKILL.md'), join(bundlePath, slug, 'SKILL.md')] : []),
      join(bundlePath, 'SKILL.md')
    ];
    for (const candidate of candidates) {
      try {
        const stats = statSync(candidate);
        if (stats.isFile() && stats.size <= MAX_REVISION_BYTES) return readFileSync(candidate, 'utf8');
      } catch { /* try the next known layout */ }
    }
    return undefined;
  }

  private integrationCredentialRepository?: IntegrationCredentialRepository;
  private skillExtensionService?: SkillExtensionService;

  /**
   * Serves built-in skills and the calling principal's own owner skills through the skills extension,
   * plus, for a request bound to one of the principal's open workspaces, that workspace's workspace and
   * repository skills read from its checkout.
   */
  private skillExtension(): SkillExtensionService {
    this.skillExtensionService ??= new SkillExtensionService({
      builtinSkillsRoot: this.config.builtinSkillsRoot,
      store: this.principals,
      bundlePath: (ownerId, bundleSha256) => this.workspaces.toolkitCacheManager.bundlePath(ownerId, bundleSha256),
      checkoutRoot: (ownerId, workspaceId) => this.workspaces.readableCheckoutRoot(ownerId, workspaceId)
    });
    return this.skillExtensionService;
  }

  /**
   * Integration credentials are stored with the same keyring the provider credentials use, so a runner
   * without a keyring cannot store or read one, and says so rather than failing at the call site.
   */
  private integrationCredentials(): IntegrationCredentialRepository {
    if (!this.keyring) {
      throw new HarnessError('UNAVAILABLE', 'the secret keyring is unavailable, so integration credentials cannot be read or written', 503, true);
    }
    this.integrationCredentialRepository ??= new IntegrationCredentialRepository(this.metadata.database, this.keyring);
    return this.integrationCredentialRepository;
  }
  async execute(request: MetadataRunnerRequest): Promise<RunnerResponse> {
    const parsed = MetadataRunnerRequestSchema.parse(request);
    const principalId = this.principals.resolvePrincipal(parsed.principal);
    try {
      switch (parsed.operation) {
        case 'project_list': return ok('Projects listed', { projects: this.metadata.listProjects(principalId) });
        case 'project_create': return mutation('Project created', this.metadata.createProject(principalId, parsed.input.name, 0));
        case 'project_update': return mutation('Project updated', this.metadata.updateProject(principalId, parsed.input.projectId, parsed.input.expectedGeneration, parsed.input.name));
        case 'project_delete': return mutation('Project deleted', this.metadata.deleteProject(principalId, parsed.input.projectId, parsed.input.expectedGeneration));
        case 'environment_list': return ok('Environments listed', { environments: this.metadata.listEnvironments(principalId, parsed.input.projectId) });
        case 'environment_create': return mutation('Environment created', this.metadata.createEnvironment(principalId, parsed.input.projectId, parsed.input.name, 0));
        case 'environment_update': return mutation('Environment updated', this.metadata.updateEnvironment(principalId, parsed.input.environmentId, parsed.input.expectedGeneration, parsed.input.name));
        case 'environment_delete': return mutation('Environment deleted', this.metadata.deleteEnvironment(principalId, parsed.input.environmentId, parsed.input.expectedGeneration));
        case 'secret_list': return ok('Secret references listed', {
          secrets: this.metadata.listSecretReferences(principalId, parsed.input.environmentId),
          readiness: this.metadata.secretReadiness()
        });
        case 'secret_create': return mutation('Secret reference created', this.secrets().create(principalId, parsed.input.environmentId, parsed.input.name, parsed.input.value, 0, parsed.input.description ?? null, parsed.input.purpose ?? 'runtime'));
        case 'secret_rotate': return mutation('Secret reference rotated', this.secrets().rotate(principalId, parsed.input.environmentId, parsed.input.name, parsed.input.value, parsed.input.expectedGeneration, parsed.input.description));
        case 'secret_update': return mutation('Secret reference updated', this.secrets().updateMetadata(principalId, parsed.input.environmentId, parsed.input.name, parsed.input.description ?? null, parsed.input.expectedGeneration));
        case 'secret_delete': return mutation('Secret reference deleted', this.secrets().delete(principalId, parsed.input.environmentId, parsed.input.name, parsed.input.expectedGeneration));
        case 'secret_bulk_apply': return ok('Secrets bulk applied', { secrets: this.secrets().bulkApply(principalId, parsed.input.environmentId, parsed.input.items) });
        case 'global_secret_list': return ok('Global secrets listed', {
          secrets: this.metadata.listGlobalSecrets(principalId),
          readiness: this.metadata.secretReadiness()
        });
        case 'global_secret_create': return mutation('Global secret created', this.secrets().globalCreate(principalId, parsed.input.name, parsed.input.value, 0, parsed.input.description ?? null, parsed.input.purpose ?? 'runtime'));
        case 'global_secret_rotate': return mutation('Global secret rotated', this.secrets().globalRotate(principalId, parsed.input.name, parsed.input.value, parsed.input.expectedGeneration, parsed.input.description));
        case 'global_secret_update': return mutation('Global secret updated', this.secrets().globalUpdateMetadata(principalId, parsed.input.name, parsed.input.description ?? null, parsed.input.expectedGeneration));
        case 'global_secret_delete': return mutation('Global secret deleted', this.secrets().globalDelete(principalId, parsed.input.name, parsed.input.expectedGeneration));
        case 'global_secret_bulk_apply': return ok('Global secrets bulk applied', { secrets: this.secrets().globalBulkApply(principalId, parsed.input.items) });
        case 'audit_list': {
          const events = this.metadata.listAudit(principalId, parsed.input.limit, parsed.input.cursor);
          return ok('Audit events listed', { events }, events.length === parsed.input.limit ? events.at(-1)?.id : undefined);
        }
        case 'artifact_list': {
          const page = this.artifacts.list(principalId, {
            limit: parsed.input.limit, ...(parsed.input.cursor ? { cursor: parsed.input.cursor } : {})
          });
          return ok('Artifacts listed', { artifacts: page.artifacts }, page.cursor);
        }
        case 'artifact_snapshot': {
          const provenance = {
            ...(parsed.input.projectId ? { projectId: parsed.input.projectId } : {}),
            ...(parsed.input.environmentId ? { environmentId: parsed.input.environmentId } : {})
          };
          if (!this.metadata.validateArtifactProvenance(principalId, provenance)) {
            throw new HarnessError('NOT_FOUND', 'artifact provenance is unavailable', 404, false);
          }
          const source = await this.workspaces.readArtifactSource(parsed.principal, parsed.input);
          const created = this.artifacts.create(source.ownerId, {
            logicalName: parsed.input.logicalName, content: source.content, workspaceId: parsed.input.workspaceId,
            ...(parsed.input.projectId ? { projectId: parsed.input.projectId } : {}),
            ...(parsed.input.environmentId ? { environmentId: parsed.input.environmentId } : {}),
            ...(parsed.input.retentionSeconds ? { retentionMs: parsed.input.retentionSeconds * 1_000 } : {})
          }, (database, _owner, artifact) => {
            if (!this.metadata.validateArtifactProvenance(principalId, provenance)) {
              throw new HarnessError('NOT_FOUND', 'artifact provenance is unavailable', 404, false);
            }
            this.metadata.recordAuditInTransaction(
              database, principalId, 'artifact.created', 'artifact', artifact.artifactId,
              artifact.generation, { sizeBytes: artifact.sizeBytes }
            );
          });
          return ok('Artifact snapshot created', created);
        }
        case 'artifact_read': {
          const chunk = this.artifacts.read(principalId, parsed.input);
          return ok('Artifact read', chunk, chunk.eof ? undefined : String(chunk.offset + chunk.bytesReturned));
        }
        case 'artifact_restore': {
          const restored = await this.workspaces.restoreArtifact(parsed.principal, parsed.input);
          return ok('Artifact restored to workspace', restored);
        }
        case 'artifact_delete': {
          const deleted = this.artifacts.delete(
            principalId, parsed.input.artifactId, parsed.input.expectedGeneration,
            (database, _owner, artifact) => this.metadata.recordAuditInTransaction(
              database, principalId, 'artifact.deleted', 'artifact', artifact.artifactId, artifact.generation
            )
          );
          return ok('Artifact deleted', deleted);
        }
        case 'github_status': return ok('GitHub authorization status', this.githubStatus(principalId));
        case 'github_setup_begin': return ok('GitHub setup started', this.beginGitHubSetup(principalId, parsed.input.expectedAccountId));
        case 'github_setup_complete': {
          await this.requireGitHubBinding().completeSetup(
            { principalId, ...parsed.input },
            (record) => this.metadata.recordAuditInTransaction(
              this.principals.database, principalId, 'github.bound', 'github_installation',
              record.installationId, record.generation, { accountLogin: record.accountLogin }
            )
          );
          return ok('GitHub installation connected', this.githubStatus(principalId));
        }
        case 'github_reconcile': {
          await this.requireGitHubBinding().reconcile(
            principalId,
            (record) => this.metadata.recordAuditInTransaction(
              this.principals.database, principalId,
              record.status === 'uninstalled' ? 'github.uninstalled' : 'github.reconciled',
              'github_installation', record.installationId, record.generation, { status: record.status }
            ),
            parsed.input.installationId
          );
          return ok('GitHub authorization reconciled', this.githubStatus(principalId));
        }
        case 'github_disconnect': {
          this.requireGitHubBinding().disconnect(
            principalId,
            parsed.input.installationId,
            (record) => this.metadata.recordAuditInTransaction(
              this.principals.database, principalId, 'github.disconnected', 'github_installation',
              record.installationId, record.generation, { accountLogin: record.accountLogin }
            )
          );
          return ok('GitHub installation disconnected', this.githubStatus(principalId));
        }
        case 'privilege_grant_list': {
          return ok('Privilege grants listed', {
            grants: this.principals.listPrivilegeGrants(principalId, parsed.input.workspaceId)
          });
        }
        case 'privilege_grant_approve': {
          let approvedGrant: PrivilegeGrantRecord | undefined;
          const approved = this.principals.approvePrivilegeGrant(
            principalId,
            parsed.input.grantId,
            (database, grant) => {
              approvedGrant = grant;
              this.metadata.recordAuditInTransaction(
                database, principalId, 'privilege_grant.approved', 'privilege_grant',
                grant.id, 1,
                { workspaceId: grant.workspaceId, commandSha256: grant.commandSha256 }
              );
            }
          );
          if (!approved) {
            throw new HarnessError('NOT_FOUND', 'privilege grant not found, expired, or already approved/consumed', 404, false);
          }
          return ok('Privilege grant approved', { grant: approvedGrant });
        }
        case 'privilege_grant_reject': {
          let rejectedGrant: PrivilegeGrantRecord | undefined;
          const rejected = this.principals.rejectPrivilegeGrant(
            principalId,
            parsed.input.grantId,
            (database, grant) => {
              rejectedGrant = grant;
              this.metadata.recordAuditInTransaction(
                database, principalId, 'privilege_grant.rejected', 'privilege_grant',
                grant.id, 1,
                { workspaceId: grant.workspaceId, commandSha256: grant.commandSha256 }
              );
            }
          );
          if (!rejected) {
            throw new HarnessError('NOT_FOUND', 'privilege grant not found or not in pending state', 404, false);
          }
          return ok('Privilege grant rejected', { grant: rejectedGrant });
        }
        case 'package_overview': return ok('Managed packages listed', this.packageOverview(principalId, await this.currentPackageImageId()));
        case 'package_plan_list': return ok('Package plans listed', this.packagePlanList(principalId));
        case 'package_plan_approve': {
          const plan = this.requirePackages().approvePlan({
            ownerId: principalId, planId: parsed.input.planId, planDigest: parsed.input.planDigest,
            decidedBy: principalId, now: Date.now()
          });
          return ok('Package plan approved', { plan: this.packagePlanView(principalId, plan, Date.now()) });
        }
        case 'package_plan_reject': {
          const plan = this.requirePackages().rejectPlan({
            ownerId: principalId, planId: parsed.input.planId, decidedBy: principalId, now: Date.now()
          });
          return ok('Package plan rejected', { plan: this.packagePlanView(principalId, plan, Date.now()) });
        }
        case 'package_rollback': {
          const { binding, replayed } = this.requirePackages().rollback({
            ownerId: principalId, bindingId: parsed.input.bindingId, releaseId: parsed.input.releaseId,
            expectedGeneration: parsed.input.expectedGeneration, actor: 'dashboard', now: Date.now(),
            releasePresent: (release) => this.packageReleasePresent(release)
          });
          return ok(replayed ? 'Package rollback already applied' : 'Package rolled back', {
            binding: {
              bindingId: binding.id, scope: binding.scope, ...(binding.workspaceId ? { workspaceId: binding.workspaceId } : {}),
              ecosystem: binding.ecosystem, name: binding.packageName, generation: binding.generation, releaseId: binding.releaseId
            },
            replayed
          });
        }
        case 'package_remove': {
          this.requirePackages();
          const removed = await this.workspaces.packages.removeBinding(principalId, {
            bindingId: parsed.input.bindingId, expectedGeneration: parsed.input.expectedGeneration
          }, 'dashboard');
          return ok('Package uninstalled', removed);
        }
        case 'model_credential_list': return ok('Model provider credentials listed', { credentials: this.models().listCredentials(principalId) });
        case 'model_credential_create': {
          const created = this.models().createCredential(principalId, parsed.input);
          await this.syncGateway();
          return mutation('Model provider credential created', created);
        }
        case 'model_credential_rotate': {
          const rotated = this.models().rotateCredential(principalId, parsed.input.credentialId, parsed.input);
          await this.syncGateway();
          return mutation('Model provider credential rotated', rotated);
        }
        case 'model_credential_delete': {
          this.models().deleteCredential(principalId, parsed.input.credentialId, parsed.input.expectedGeneration);
          await this.syncGateway();
          return ok('Model provider credential deleted', { deleted: true });
        }
        case 'model_profile_list': return ok('Agent model profiles listed', { profiles: this.reviewedProfiles(principalId) });
        case 'model_profile_create': {
          const { input } = parsed;
          const options = this.submittedPriceProvenance(principalId, input.credentialId, input.model, input.pricing, input.catalogPriceRef);
          const created = this.verifier().attachDraftVerification(principalId, input.verificationRef, this.models().createProfile(principalId, input, options));
          await this.syncGateway();
          return mutation('Agent model profile created', created);
        }
        case 'model_profile_update': {
          const { input } = parsed;
          const current = input.pricing && input.catalogPriceRef ? this.models().getProfileRoute(principalId, input.profileId) : undefined;
          // An unknown profile gets no provenance here; the repository reports it as not found.
          const options = current
            ? this.submittedPriceProvenance(
              principalId, input.credentialId ?? current.credentialId, input.model ?? current.model ?? 'default', input.pricing, input.catalogPriceRef
            )
            : {};
          const updated = this.verifier().attachDraftVerification(principalId, input.verificationRef, this.models().updateProfile(principalId, input.profileId, input, options));
          await this.syncGateway();
          return mutation('Agent model profile updated', updated);
        }
        case 'model_profile_activate': {
          const activated = this.models().activateProfile(principalId, parsed.input.profileId, parsed.input.expectedGeneration);
          await this.syncGateway();
          return mutation('Agent model profile activated', activated);
        }
        case 'model_profile_disable': {
          const disabled = this.models().disableProfile(principalId, parsed.input.profileId, parsed.input.expectedGeneration);
          await this.syncGateway();
          return mutation('Agent model profile disabled', disabled);
        }
        case 'model_profile_delete': {
          this.models().deleteProfile(principalId, parsed.input.profileId, parsed.input.expectedGeneration);
          await this.syncGateway();
          return ok('Agent model profile deleted', { deleted: true });
        }
        case 'model_provider_list': return ok('Model providers listed', { providers: listModelProviders() });
        case 'model_catalog_search': return ok('Model catalog searched', ModelCatalogSearchResultSchema.parse(await this.catalog().search(principalId, parsed.input)));
        case 'model_catalog_refresh': return ok('Model catalog refreshed', ModelCatalogRefreshResultSchema.parse(await this.catalog().refresh(principalId, parsed.input)));
        case 'model_connection_verify': return ok('Model connection checked', await this.verifier().verify(principalId, parsed.input));
        case 'model_spend_summary': {
          const summary = this.spend().summary(principalId, Date.now());
          // Every policy has a window, so the list is built from the same read as the windows and
          // can never disagree with them.
          return ok('Model spend summarized', { summary, policies: summary.windows.flatMap((window) => (window.policy ? [window.policy] : [])) });
        }
        case 'model_spend_policy_list': return ok('Model spend policies listed', { policies: this.spend().listPolicies(principalId) });
        case 'model_spend_policy_set': return mutation('Model spend policy saved', this.spend().setPolicy(principalId, parsed.input, Date.now(), {
          // A policy can name only one of the principal's saved profiles when it is created.
          profileExists: (profileId) => this.modelProfiles?.getProfileRoute(principalId, profileId) !== undefined,
          record: this.recordSpendPolicyChange(principalId)
        }));
        case 'model_spend_policy_delete': return mutation('Model spend policy deleted', this.spend().deletePolicy(principalId, parsed.input, {
          record: this.recordSpendPolicyChange(principalId)
        }));
        case 'model_config_status': {
          let gatewaySynced = false;
          let gatewayBootId: string | null = null;
          let gatewayError: string | null = null;
          const control = this.gatewayControl;
          const models = this.models();
          if (control) {
            try {
              // One serialized section: query the gateway, build the whole-instance snapshot the
              // runner pushes, and repair a mismatch with one push. The expected digest comes from
              // a snapshot built after any earlier push landed, and a repair never overwrites a newer push.
              const sync = await control.syncSnapshot(() => models.getExportSnapshot(), {
                onlyIfMismatch: true,
                onQueried: (digest) => { gatewayBootId = digest.gatewayBootId; }
              });
              gatewayBootId = sync.gatewayBootId;
              gatewaySynced = sync.gatewayDigest === sync.expectedDigest;
            } catch (err) {
              gatewayError = err instanceof Error ? err.message : 'gateway unreachable';
            }
          }
          // Every push, from this service or the agent manager, is recorded on the shared control.
          const push = control?.snapshotPushState?.() ?? { lastSuccessAt: null, lastError: null };
          // Counted after the sync, so they describe the same state the expected digest does.
          const activeProfiles = models.listProfiles(principalId).filter((p) => p.status === 'ACTIVE').length;
          const activeCreds = models.listCredentials(principalId).filter((c) => c.status === 'ACTIVE').length;
          return ok('Model configuration status', {
            status: {
              gatewaySynced,
              gatewayBootId,
              lastSyncTime: push.lastSuccessAt,
              activeProfileCount: activeProfiles,
              activeCredentialCount: activeCreds,
              // Once the gateway's last applied snapshot matches, an earlier failed push is moot.
              error: gatewayError ?? (gatewaySynced ? null : push.lastError)
            }
          });
        }
        case 'knowledge_dashboard_list': {
          const { items, nextCursor } = this.principals.knowledge.listItems({
            principalId,
            ...(parsed.input.kind ? { kind: parsed.input.kind } : {}),
            ...(parsed.input.scope ? { scope: parsed.input.scope } : {}),
            ...(parsed.input.projectId ? { projectId: parsed.input.projectId } : {}),
            ...(parsed.input.journalType ? { journalType: parsed.input.journalType } : {}),
            ...(parsed.input.tags ? { tags: parsed.input.tags } : {}),
            ...(parsed.input.tagMatch ? { tagMatch: parsed.input.tagMatch } : {}),
            ...(parsed.input.limit ? { limit: parsed.input.limit } : {}),
            ...(parsed.input.cursor ? { cursor: parsed.input.cursor } : {})
          });
          return ok('Knowledge items listed', { items }, nextCursor);
        }
        case 'knowledge_dashboard_get': {
          const item = this.principals.knowledge.readItem({ principalId, id: parsed.input.id });
          if (!item) throw new HarnessError('NOT_FOUND', 'Knowledge item not found', 404, false);
          return ok('Knowledge item retrieved', item);
        }
        case 'knowledge_dashboard_create': {
          const item = this.principals.knowledge.createItem({
            principalId,
            kind: parsed.input.kind,
            scope: parsed.input.scope,
            projectId: parsed.input.projectId ?? null,
            workspaceId: parsed.input.workspaceId ?? null,
            title: parsed.input.title,
            content: parsed.input.content,
            journalType: parsed.input.journalType ?? null,
            occurredAt: parsed.input.occurredAt ?? null,
            tags: parsed.input.tags,
            retentionSeconds: parsed.input.retentionSeconds ?? null,
            expectedGeneration: parsed.input.expectedGeneration
          });
          return mutation('Knowledge item created', item);
        }
        case 'knowledge_dashboard_update': {
          const res = this.principals.knowledge.updateItem({
            principalId,
            id: parsed.input.id,
            expectedGeneration: parsed.input.expectedGeneration,
            ...(parsed.input.title ? { title: parsed.input.title } : {}),
            ...(parsed.input.content !== undefined ? { content: parsed.input.content } : {}),
            ...(parsed.input.journalType ? { journalType: parsed.input.journalType } : {}),
            ...(parsed.input.occurredAt !== undefined ? { occurredAt: parsed.input.occurredAt } : {}),
            ...(parsed.input.tags ? { tags: parsed.input.tags } : {}),
            ...(parsed.input.retentionSeconds !== undefined ? { retentionSeconds: parsed.input.retentionSeconds } : {})
          });
          if (!res.success) {
            throw new HarnessError('CONFLICT', 'Knowledge item generation conflict', 409, false);
          }
          return mutation('Knowledge item updated', res.item);
        }
        case 'knowledge_dashboard_delete': {
          const res = this.principals.knowledge.deleteItem({
            principalId,
            id: parsed.input.id,
            expectedGeneration: parsed.input.expectedGeneration
          });
          if (!res.success) {
            throw new HarnessError('CONFLICT', 'Knowledge item generation conflict', 409, false);
          }
          return ok('Knowledge item deleted', { deleted: true });
        }
        case 'knowledge_dashboard_search': {
          const { results, nextCursor } = this.principals.knowledge.searchItems({
            principalId,
            query: parsed.input.query,
            ...(parsed.input.kinds ? { kinds: parsed.input.kinds } : {}),
            ...(parsed.input.scope ? { scope: parsed.input.scope } : {}),
            ...(parsed.input.projectId ? { projectId: parsed.input.projectId } : {}),
            ...(parsed.input.journalType ? { journalType: parsed.input.journalType } : {}),
            ...(parsed.input.tags ? { tags: parsed.input.tags } : {}),
            ...(parsed.input.tagMatch ? { tagMatch: parsed.input.tagMatch } : {}),
            ...(parsed.input.limit ? { limit: parsed.input.limit } : {}),
            ...(parsed.input.cursor ? { cursor: parsed.input.cursor } : {})
          });
          return ok('Knowledge search results', { results }, nextCursor);
        }
        case 'knowledge_dashboard_graph': {
          const graph = this.principals.knowledge.getGraph({
            principalId,
            ...(parsed.input.rootId ? { rootId: parsed.input.rootId } : {}),
            ...(parsed.input.depth ? { depth: parsed.input.depth } : {}),
            ...(parsed.input.maxNodes ? { maxNodes: parsed.input.maxNodes } : {}),
            ...(parsed.input.kinds ? { kinds: parsed.input.kinds } : {}),
            ...(parsed.input.projectId ? { projectId: parsed.input.projectId } : {})
          });
          return ok('Knowledge graph retrieved', graph);
        }
        case 'knowledge_dashboard_link_create': {
          const link = this.principals.knowledge.createLink({
            principalId,
            sourceId: parsed.input.sourceId,
            targetId: parsed.input.targetId,
            relation: parsed.input.relation,
            expectedGeneration: parsed.input.expectedGeneration
          });
          return mutation('Knowledge link created', link);
        }
        case 'knowledge_dashboard_link_delete': {
          const unlinked = this.principals.knowledge.deleteLink({
            principalId,
            ...(parsed.input.linkId ? { linkId: parsed.input.linkId } : {}),
            ...(parsed.input.sourceId ? { sourceId: parsed.input.sourceId } : {}),
            ...(parsed.input.targetId ? { targetId: parsed.input.targetId } : {}),
            ...(parsed.input.relation ? { relation: parsed.input.relation } : {}),
            ...(parsed.input.expectedGeneration ? { expectedGeneration: parsed.input.expectedGeneration } : {})
          });
          return ok('Knowledge link deleted', { unlinked });
        }
        case 'mcp_server_list': return ok('MCP servers listed', { servers: this.mcp().listServers(principalId) });
        case 'mcp_server_get': {
          const server = this.mcp().getServer(principalId, parsed.input.serverId);
          if (!server) throw new HarnessError('NOT_FOUND', 'MCP server not found', 404, false);
          return ok('MCP server retrieved', { server, tools: this.mcp().getServerTools(principalId, server.id) });
        }
        case 'mcp_server_create': return mutation('MCP server created', this.mcp().createServer(principalId, {
          name: parsed.input.name,
          description: parsed.input.description,
          transport: parsed.input.transport,
          endpoint: parsed.input.endpoint,
          headers: storedMcpHeaders(parsed.input.headers),
          ...(parsed.input.oauth ? { oauth: parsed.input.oauth } : {}),
          permissionDefault: parsed.input.permissionDefault,
          enabled: parsed.input.enabled
        }, 0));
        case 'mcp_server_update': return mutation('MCP server updated', this.mcp().updateServer(
          principalId, parsed.input.serverId, parsed.input.expectedGeneration, {
            ...(parsed.input.name !== undefined ? { name: parsed.input.name } : {}),
            ...(parsed.input.description !== undefined ? { description: parsed.input.description } : {}),
            ...(parsed.input.transport !== undefined ? { transport: parsed.input.transport } : {}),
            ...(parsed.input.endpoint !== undefined ? { endpoint: parsed.input.endpoint } : {}),
            ...(parsed.input.headers !== undefined ? { headers: storedMcpHeaders(parsed.input.headers) } : {}),
            ...(parsed.input.oauth !== undefined ? { oauth: parsed.input.oauth } : {}),
            ...(parsed.input.permissionDefault !== undefined ? { permissionDefault: parsed.input.permissionDefault } : {})
          }
        ));
        case 'mcp_server_delete': return mutation('MCP server deleted', this.mcp().deleteServer(
          principalId, parsed.input.serverId, parsed.input.expectedGeneration
        ));
        case 'mcp_server_set_enabled': return mutation(
          parsed.input.enabled ? 'MCP server enabled' : 'MCP server disabled',
          this.mcp().setEnabled(principalId, parsed.input.serverId, parsed.input.enabled, parsed.input.expectedGeneration)
        );
        case 'mcp_server_set_permissions': return mutation('MCP permissions updated', this.mcp().setPermissions(principalId, {
          serverId: parsed.input.serverId,
          permissionDefault: parsed.input.permissionDefault,
          tools: parsed.input.tools,
          expectedGeneration: parsed.input.expectedGeneration
        }));
        case 'mcp_server_replace_tools': {
          const tools = this.mcp().replaceTools(
            principalId, parsed.input.serverId, parsed.input.tools, parsed.input.cap, parsed.input.status
          );
          const server = this.mcp().getServer(principalId, parsed.input.serverId);
          if (!server) throw new HarnessError('NOT_FOUND', 'MCP server not found', 404, false);
          return ok('MCP tools replaced', { server, tools });
        }
        case 'mcp_server_connection_result': return mutation('MCP connection result recorded', this.mcp().recordConnectionResult(
          principalId, parsed.input.serverId, parsed.input.status, parsed.input.error
        ));
        case 'mcp_server_get_credentials': return this.mcpCredentials(principalId, parsed.input);
        case 'mcp_oauth_status': return ok('MCP OAuth status', { status: this.mcpOAuthStatus(principalId, parsed.input.serverId) });
        case 'mcp_oauth_flow_begin': {
          this.requireMcpOAuthServer(principalId, parsed.input.serverId);
          const begun = this.mcpOAuthCall(() => this.oauthStore().beginFlow(principalId, parsed.input.serverId, {
            stateHash: parsed.input.stateHash,
            expectedIssuer: parsed.input.expectedIssuer,
            scopes: parsed.input.scopes,
            blob: parsed.input.blob
          }));
          return ok('MCP OAuth flow started', begun);
        }
        case 'mcp_oauth_flow_consume': {
          const flow = this.mcpOAuthCall(() => this.oauthStore().consumeFlow(principalId, parsed.input.stateHash));
          // The server may have been deleted or OAuth disabled while the browser was away.
          this.requireMcpOAuthServer(principalId, flow.serverId);
          return ok('MCP OAuth flow consumed', flow);
        }
        case 'mcp_oauth_grant_load': {
          this.requireMcpOAuthServer(principalId, parsed.input.serverId);
          return ok('MCP OAuth grant', { grant: this.oauthStore().loadGrant(principalId, parsed.input.serverId) ?? null });
        }
        case 'mcp_oauth_grant_save': {
          this.requireMcpOAuthServer(principalId, parsed.input.serverId);
          const { serverId, ...grant } = parsed.input;
          const generation = this.mcpOAuthCall(() => this.oauthStore().saveGrant(principalId, serverId, grant));
          return ok('MCP OAuth grant saved', { generation });
        }
        case 'mcp_oauth_grant_mark': {
          this.requireMcpOAuthServer(principalId, parsed.input.serverId);
          const marked = this.oauthStore().markGrant(principalId, parsed.input.serverId, parsed.input.state, parsed.input.error);
          if (!marked) this.oauthStore().recordFailure(principalId, parsed.input.serverId, parsed.input.error ?? parsed.input.state);
          return ok('MCP OAuth state recorded', { marked });
        }
        case 'mcp_oauth_disconnect': {
          this.requireMcpOAuthServer(principalId, parsed.input.serverId);
          const grant = this.oauthStore().loadGrantIssuer(principalId, parsed.input.serverId);
          if (grant && parsed.input.revocation) this.oauthStore().recordRevocationAttempt(principalId, parsed.input.serverId, grant, parsed.input.revocation);
          return ok('MCP OAuth disconnected', { disconnected: this.oauthStore().disconnect(principalId, parsed.input.serverId) });
        }
        case 'mcp_gateway_catalog': return ok('MCP gateway catalog', this.mcp().catalog(principalId, {
          ...(parsed.input.serverId ? { serverId: parsed.input.serverId } : {}),
          ...(parsed.input.qualifiedName ? { qualifiedName: parsed.input.qualifiedName } : {})
        }));
        case 'mcp_gateway_trace_append': {
          const trace = this.mcp().appendTrace(principalId, {
            serverId: parsed.input.serverId,
            serverName: parsed.input.serverName,
            tool: parsed.input.tool,
            operation: parsed.input.operation,
            clientId: parsed.input.clientId,
            durationMs: parsed.input.durationMs,
            status: parsed.input.status,
            errorCode: parsed.input.errorCode,
            errorMessage: parsed.input.errorMessage,
            requestBytes: parsed.input.requestBytes,
            responseBytes: parsed.input.responseBytes,
            secrets: parsed.input.secrets
          }, parsed.input.maxRows);
          return ok('MCP trace recorded', { trace });
        }
        case 'mcp_gateway_trace_list': {
          const page = this.mcp().listTraces(principalId, {
            ...(parsed.input.serverId ? { serverId: parsed.input.serverId } : {}),
            limit: parsed.input.limit,
            ...(parsed.input.cursor ? { cursor: parsed.input.cursor } : {})
          });
          return ok('MCP traces listed', { traces: page.traces }, page.cursor);
        }
        case 'skill_list': return ok('Skills listed', { skills: this.principals.listSkillSources(principalId) });
        case 'skills_ext_list': {
          const page = await this.skillExtension().list(principalId, parsed.input);
          return ok('Skills listed', { skills: page.skills }, page.nextCursor);
        }
        case 'skills_ext_get': return ok('Skill read', await this.skillExtension().get(principalId, parsed.input));
        case 'skills_ext_read': return ok('Skill resource read', await this.skillExtension().read(principalId, parsed.input));
        case 'skill_get': return ok('Skill read', required(this.principals.getSkillSource(principalId, parsed.input.skillId), `Skill ${parsed.input.skillId} was not found`));
        case 'skill_revision_list': return ok('Skill revisions listed', { revisions: this.principals.listSkillRevisions(principalId, parsed.input.skillId, parsed.input.limit) });
        case 'skill_revision_get': return ok('Skill revision read', required(
          this.principals.getSkillRevision(principalId, parsed.input.skillId, parsed.input.revisionId),
          `Revision ${parsed.input.revisionId} was not found for this skill`
        ));
        case 'skill_usage': return ok('Skill usage listed', this.principals.listSkillUsage(principalId, parsed.input.skillId));
        case 'skill_search': {
          const needle = parsed.input.query.toLowerCase();
          const local = this.principals.listSkillSources(principalId, { limit: 200 })
            .filter((skill): skill is NonNullable<ReturnType<StateStore['getSkillSource']>> => skill !== undefined
              && (skill.slug.toLowerCase().includes(needle) || skill.displayName.toLowerCase().includes(needle)))
            .slice(0, parsed.input.limit);
          const providers = await this.searchRemoteRegistries(parsed.input.providers, parsed.input.query, parsed.input.limit);
          return ok('Skills searched', {
            local,
            // The per-provider summary deliberately carries no hits of its own, so the dashboard reads the
            // counts here and the hits from the flat list below without having to join the two.
            providers: providers.map((entry) => ({
              provider: entry.provider,
              status: entry.status,
              count: entry.count,
              ...(entry.warning ? { warning: entry.warning } : {})
            })),
            results: providers.flatMap((entry) => entry.results)
          });
        }
        case 'skill_set_list': return ok('Skill sets listed', { sets: this.principals.listSkillSets(principalId) });
        case 'skill_set_get': return ok('Skill set read', required(this.principals.getSkillSet(principalId, parsed.input.skillSetId), `Skill set ${parsed.input.skillSetId} was not found`));
        case 'skill_import_status': return ok('Import job read', required(this.principals.getSkillImportJob(principalId, parsed.input.jobId), `Import job ${parsed.input.jobId} was not found`));
        case 'skill_import_start': {
          const jobId = this.principals.createSkillImportJob({
            ownerId: principalId,
            sourceKind: parsed.input.sourceKind,
            sourceRef: parsed.input.sourceRef
          });
          // The row is written before any work starts, so the caller gets an id it can poll and a restart
          // reports the job instead of losing it. The acquisition therefore runs detached: there is no
          // request left to fail, and every outcome is recorded as a state on that row.
          void this.runSkillImport(principalId, jobId, parsed.input);
          return mutation('Skill import started', required(
            this.principals.getSkillImportJob(principalId, jobId),
            `Import job ${jobId} was not found`
          ));
        }
        case 'skill_import_cancel': {
          const job = required(
            this.principals.getSkillImportJob(principalId, parsed.input.jobId),
            `Import job ${parsed.input.jobId} was not found`
          );
          // Only a job that has not reached a terminal state can be cancelled, so a finished import is
          // reported as a conflict rather than silently rewritten into a state it never had.
          if (job.state !== 'queued' && job.state !== 'running') {
            throw new HarnessError('CONFLICT', `Import job ${job.id} is ${job.state} and cannot be cancelled`, 409, false);
          }
          this.principals.advanceSkillImportJob({ ownerId: principalId, id: job.id, state: 'cancelled' });
          return mutation('Import job cancelled', required(
            this.principals.getSkillImportJob(principalId, job.id),
            `Import job ${job.id} was not found`
          ));
        }
        case 'skill_update': return mutation('Skill updated', this.principals.updateSkillMetadata({
          ownerId: principalId,
          id: parsed.input.skillId,
          expectedGeneration: parsed.input.expectedGeneration,
          ...(parsed.input.displayName === undefined ? {} : { displayName: parsed.input.displayName }),
          ...(parsed.input.description === undefined ? {} : { description: parsed.input.description }),
          ...(parsed.input.tags === undefined ? {} : { tags: parsed.input.tags })
        }));
        case 'skill_archive': return mutation('Skill archived', {
          skillId: parsed.input.skillId,
          ...this.principals.setSkillState(principalId, parsed.input.skillId, 'archived', parsed.input.expectedGeneration)
        });
        case 'skill_set_create': return mutation('Skill set created', {
          skillSetId: this.principals.createSkillSet({
            ownerId: principalId,
            name: parsed.input.name,
            description: parsed.input.description,
            items: parsed.input.items
          })
        });
        case 'skill_set_update': return mutation('Skill set updated', {
          skillSetId: parsed.input.skillSetId,
          ...this.principals.updateSkillSet({
            ownerId: principalId,
            id: parsed.input.skillSetId,
            expectedGeneration: parsed.input.expectedGeneration,
            ...(parsed.input.name === undefined ? {} : { name: parsed.input.name }),
            ...(parsed.input.description === undefined ? {} : { description: parsed.input.description }),
            ...(parsed.input.items === undefined ? {} : { items: parsed.input.items })
          })
        });
        case 'skill_set_delete':
          this.principals.deleteSkillSet(principalId, parsed.input.skillSetId, parsed.input.expectedGeneration);
          return ok('Skill set deleted', { skillSetId: parsed.input.skillSetId, deleted: true });
        case 'skill_bulk': {
          const state = parsed.input.action === 'enable' ? 'enabled' : parsed.input.action === 'disable' ? 'disabled' : 'archived';
          // Each skill is applied on its own so one stale or locked item reports a per-item failure
          // instead of discarding the work already done for the rest of the batch.
          const results = parsed.input.skillIds.map((skillId) => {
            try {
              this.principals.setSkillState(principalId, skillId, state, parsed.input.expectedGeneration);
              return { skillId, ok: true };
            } catch (error) {
              return { skillId, ok: false, error: error instanceof SkillRegistryError ? error.code : 'INTERNAL_ERROR' };
            }
          });
          return ok('Skills updated in bulk', { results });
        }
        case 'skill_create_custom': {
          // The package is published before the source row is written, so a created skill always has
          // content behind it. A row pointing at missing bytes would resolve and then fail at launch,
          // which is the failure this ordering exists to prevent.
          let published: { bundleSha256: string; byteCount: number; fileCount: number; bundlePath: string };
          try {
            published = await this.workspaces.toolkitCacheManager.publishLocalBundle(principalId, {
              [`skills/${parsed.input.slug}/SKILL.md`]: parsed.input.instructions
            });
          } catch (error) {
            throw new HarnessError('INVALID_INPUT', error instanceof Error ? error.message : 'the skill package could not be published', 400, false);
          }

          const created = this.principals.createSkillSource({
            ownerId: principalId,
            slug: parsed.input.slug,
            displayName: parsed.input.displayName,
            kind: 'owner',
            provider: 'custom',
            description: parsed.input.description,
            tags: parsed.input.tags,
            revision: {
              bundleSha256: published.bundleSha256,
              // The bundle digest covers the whole tree; this digest is the authored instructions.
              contentSha256: createHash('sha256').update(parsed.input.instructions).digest('hex'),
              hasExecutableAssets: parsed.input.hasExecutableAssets,
              origin: 'edit',
              version: resolveSkillVersion(parsed.input.instructions, parsed.input.version)
            }
          });
          return mutation('Custom skill created', { ...created, bundleSha256: published.bundleSha256 });
        }
        case 'skill_archive_import': {
          // The whole archive is validated before anything is written, so a malformed archive cannot
          // leave a half-created library.
          const skills = readSkillArchive(Buffer.from(parsed.input.archiveBase64, 'base64'));

          const results: { slug: string; ok: boolean; skillId?: string; error?: string; message?: string }[] = [];
          for (const entry of skills) {
            // A skill over a per-skill bound is refused on its own rather than published without the
            // files that did not fit, and the message says which bound so the operator can fix it.
            if (entry.rejection !== undefined) {
              results.push({ slug: entry.slug, ok: false, error: 'LIMIT_EXCEEDED', message: entry.rejection });
              continue;
            }
            try {
              // The package is published before the source row, the order the single-skill path uses:
              // a row naming bytes that do not exist would resolve and then fail at launch. The whole
              // skill directory is published, so references, scripts, and assets survive the import.
              const published = await this.workspaces.toolkitCacheManager.publishLocalBundle(principalId, Object.fromEntries(
                Object.entries(entry.files).map(([relative, bytes]) => [`skills/${entry.slug}/${relative}`, bytes])
              ));
              const created = this.principals.createSkillSource({
                ownerId: principalId,
                slug: entry.slug,
                displayName: entry.displayName,
                kind: 'owner',
                provider: 'custom',
                description: '',
                tags: [],
                revision: {
                  bundleSha256: published.bundleSha256,
                  contentSha256: createHash('sha256').update(entry.instructions).digest('hex'),
                  hasExecutableAssets: entry.hasExecutableAssets,
                  origin: 'edit',
                  version: trustedSkillVersion(entry.instructions) ?? null
                }
              });
              results.push({ slug: entry.slug, ok: true, skillId: created.sourceId });
            } catch (error) {
              // A slug that already exists is a per-item conflict, not a failure of the whole upload,
              // so the entries that could be created stay created.
              results.push({
                slug: entry.slug,
                ok: false,
                error: error instanceof SkillRegistryError ? error.code : 'INTERNAL_ERROR'
              });
            }
          }
          return mutation('Skills imported from the archive', { results });
        }
        case 'skill_set_preview': {
          const sources = this.principals.listSkillSources(principalId, { limit: 200 })
            .filter((skill): skill is NonNullable<ReturnType<StateStore['getSkillSource']>> => skill !== undefined);
          const byId = new Map(sources.map((skill) => [skill.id, skill]));
          const candidates: SkillCandidate[] = [];
          let generation = 0;

          for (const requested of parsed.input.skillSets) {
            const set = this.principals.getSkillSet(principalId, requested.skillSetId);
            if (!set) throw new HarnessError('NOT_FOUND', `Skill set ${requested.skillSetId} was not found`, 404, false);
            // A preview the operator never saw must not be acted on, so a set that moved since the
            // preview request is refused rather than resolved against the newer contents.
            if (set.generation !== requested.expectedGeneration) {
              throw new HarnessError('STALE_GENERATION', `Skill set ${requested.skillSetId} is at generation ${set.generation} but the preview expected ${requested.expectedGeneration}`, 409, false);
            }
            generation = Math.max(generation, set.generation);
            for (const item of set.items) {
              const source = byId.get(item.skillSourceId);
              // A registry skill is installed into the owner tier, so its source kind is not its tier.
              const kind = source?.kind ?? 'owner';
              const tier: SkillTier = kind === 'registry' ? 'owner' : kind;
              candidates.push({
                name: item.name,
                tier,
                sourceId: item.skillSourceId,
                revisionId: item.revisionId,
                // The revision pins the content, so two items agree exactly when they name the same
                // revision; a differing revision at the same tier is the collision the resolver reports.
                contentSha256: item.revisionId,
                ...(source?.state === undefined ? {} : { state: source.state })
              });
            }
          }

          const resolution = resolveWorkspaceSkills({ candidates, overrides: parsed.input.skillOverrides });
          return ok('Skill set preview', {
            generation,
            resolved: resolution.resolved,
            excluded: resolution.excluded,
            conflicts: resolution.conflicts
          });
        }
        case 'toolkit_registry_list':
          // The four fields this tab exists to show come from the records that actually hold them: cache state
          // and pinned commit from the cache entry, skill count from the lock item a workspace resolved, and
          // lock state from whether any live workspace still pins those bytes. Reading the catalogue table
          // instead, which holds none of the four, is what made every row a placeholder.
          return ok('Registry catalog listed', {
            entries: this.principals.listToolkitCacheEntries(principalId)
              .filter((entry) => parsed.input.provider === undefined || entry.sourceIdentity.includes(`:${parsed.input.provider}:`))
              .map((entry) => {
                const pins = this.principals.listOwnerToolkitPins(principalId)
                  .filter((pin) => pin.bundleSha256 === entry.bundleSha256);
                let skillCount = 0;
                for (const pin of pins) {
                  try {
                    const resolved = JSON.parse(pin.resolvedJson) as { skillsCount?: unknown };
                    if (typeof resolved.skillsCount === 'number') {
                      skillCount = resolved.skillsCount;
                      break;
                    }
                  } catch {
                    // A lock row that cannot be read contributes no count rather than failing the listing.
                  }
                }
                const [, provider = 'toolkit', ...rest] = entry.sourceIdentity.split(':');
                const slug = rest.join(':') || entry.sourceIdentity;
                return {
                  id: entry.cacheKey,
                  provider,
                  slug,
                  displayName: slug,
                  description: '',
                  fetchedAt: entry.lastUsedAt,
                  cacheState: entry.status,
                  pinnedCommit: entry.resolvedRevision,
                  skillCount,
                  lockState: pins.length > 0 ? 'locked' : 'unlocked'
                };
              }),
            // A preset is offered as something a launch could install, not as something the workspace can
            // already resolve. Listing it beside cached entries without that distinction would let a row
            // read as an available skill, which is the reading this field exists to prevent.
            presets: Object.values(TOOLKIT_CATALOG).map((preset) => ({
              id: preset.id,
              name: preset.name,
              description: preset.description,
              sourceUrl: preset.sourceUrl,
              license: preset.license,
              defaultRevision: preset.defaultRevision,
              supportedScopes: preset.supportedScopes,
              installable: true
            }))
          });
        case 'toolkit_registry_update': {
          // The catalogue entry is what the dashboard reads back, so an action is recorded on that entry
          // rather than returned as a claim about a store that was never written.
          this.principals.upsertSkillCatalogEntry({
            ownerId: principalId,
            provider: parsed.input.provider,
            slug: parsed.input.slug,
            displayName: parsed.input.slug,
            metadataJson: JSON.stringify({
              action: parsed.input.action,
              ...(parsed.input.revisionId ? { revisionId: parsed.input.revisionId } : {})
            })
          });
          return mutation('Registry entry updated', {
            provider: parsed.input.provider,
            slug: parsed.input.slug,
            action: parsed.input.action,
            ...(parsed.input.revisionId ? { revisionId: parsed.input.revisionId } : {})
          });
        }
        case 'toolkit_registry_refresh':
          // The catalogue this owner has recorded is what the dashboard shows, so a refresh reports that
          // set. Fetching a provider's whole catalogue is the import path's job, and returning entries this
          // operation did not fetch would be a claim it cannot back.
          return ok('Registry catalogue read', {
            entries: this.principals.listSkillCatalogEntries(principalId, parsed.input.provider)
          });
        case 'skill_restore': {
          const revision = required(
            this.principals.getSkillRevision(principalId, parsed.input.skillId, parsed.input.revisionId),
            `Revision ${parsed.input.revisionId} was not found for this skill`
          );
          // The bytes that revision pinned already exist, so a restore publishes a new immutable row
          // that points back at them instead of rewriting the revision it came from.
          const revisionId = this.principals.addSkillRevision({
            ownerId: principalId,
            skillSourceId: parsed.input.skillId,
            bundleSha256: revision.bundleSha256,
            contentSha256: revision.contentSha256,
            hasExecutableAssets: revision.hasExecutableAssets,
            origin: 'restore',
            parentRevisionId: revision.id,
            expectedGeneration: parsed.input.expectedGeneration
          });
          return mutation('Skill restored', { skillId: parsed.input.skillId, revisionId });
        }
        case 'skill_revision_fork': {
          const revision = required(
            this.principals.getSkillRevision(principalId, parsed.input.skillId, parsed.input.revisionId),
            `Revision ${parsed.input.revisionId} was not found for this skill`
          );
          const source = required(
            this.principals.getSkillSource(principalId, parsed.input.skillId),
            `Skill ${parsed.input.skillId} was not found`
          );
          // A fork is a new source that starts from the bytes the chosen revision pinned, so the two can
          // then diverge without either one rewriting the other's history.
          const created = this.principals.createSkillSource({
            ownerId: principalId,
            slug: parsed.input.slug,
            displayName: parsed.input.displayName,
            kind: 'owner',
            provider: 'custom',
            description: source.description,
            tags: source.tags,
            revision: {
              bundleSha256: revision.bundleSha256,
              contentSha256: revision.contentSha256,
              hasExecutableAssets: revision.hasExecutableAssets,
              origin: 'fork'
            }
          });
          return mutation('Skill forked', { ...created, forkedFrom: { skillId: source.id, revisionId: revision.id } });
        }
        case 'skill_revision_create': {
          const source = required(
            this.principals.getSkillSource(principalId, parsed.input.skillId),
            `Skill ${parsed.input.skillId} was not found`
          );
          const version = resolveSkillVersion(parsed.input.instructions, parsed.input.version);
          // The package is published before the revision row is written, for the same reason a created
          // skill publishes first: a revision that pointed at missing bytes would resolve and then fail.
          let published: { bundleSha256: string };
          try {
            published = await this.workspaces.toolkitCacheManager.publishLocalBundle(principalId, {
              [`skills/${source.slug}/SKILL.md`]: parsed.input.instructions
            });
          } catch (error) {
            throw new HarnessError('INVALID_INPUT', error instanceof Error ? error.message : 'the skill package could not be published', 400, false);
          }
          const revisionId = this.principals.addSkillRevision({
            ownerId: principalId,
            skillSourceId: source.id,
            bundleSha256: published.bundleSha256,
            // The bundle digest covers the whole tree; this digest is the authored instructions.
            contentSha256: createHash('sha256').update(parsed.input.instructions).digest('hex'),
            // Edited instructions carry no scripts, so the new revision reports that it has nothing to
            // execute rather than inheriting the previous revision's claim about executable assets.
            hasExecutableAssets: false,
            origin: 'edit',
            expectedGeneration: parsed.input.expectedGeneration,
            version
          });
          const previousVersion = source.currentRevisionId
            ? this.principals.getSkillRevision(principalId, source.id, source.currentRevisionId)?.version ?? null
            : null;
          const warning = skillVersionDriftWarning(previousVersion, version);
          return mutation('Skill revision created', { sourceId: source.id, revisionId, ...(warning ? { warning } : {}) });
        }
        case 'integration_credential_list':
          return ok('Integration credentials listed', { credentials: this.integrationCredentials().list(principalId) });
        case 'integration_credential_create': return mutation('Integration credential created', this.integrationCredentials().create({
          principalId,
          integration: parsed.input.integration,
          label: parsed.input.label,
          value: parsed.input.value
        }));
        case 'integration_credential_rotate': return mutation('Integration credential rotated', this.integrationCredentials().rotate({
          principalId,
          id: parsed.input.credentialId,
          value: parsed.input.value,
          expectedGeneration: parsed.input.expectedGeneration
        }));
        case 'integration_credential_delete':
          this.integrationCredentials().delete({ principalId, id: parsed.input.credentialId, expectedGeneration: parsed.input.expectedGeneration });
          return ok('Integration credential deleted', { id: parsed.input.credentialId, deleted: true });
        case 'typesafe_status': {
          // Status never carries the key; it reports whether one exists, which is all a caller needs.
          const credentials = this.keyring ? this.integrationCredentials().list(principalId) : [];
          return ok('TypeSafe status', {
            configured: credentials.some((credential) => credential.integration === 'typesafe' && credential.status === 'ACTIVE'),
            enabled: this.config.typesafeEgress !== 'off',
            endpoint: TYPESAFE_DEFAULT_ENDPOINT,
            model: TYPESAFE_DEFAULT_MODEL
          });
        }
        case 'decision_rerank_tools': {
          // The plane can only reorder the candidates it was given; the gateway validates that the
          // ordering is a permutation of its own pool before it uses any of it.
          if (!this.decisionPlane) {
            return ok('Lexical ranking kept', { applied: false, decisionId: null, ordering: [], relevance: {}, reason: 'purpose_disabled' });
          }
          const reranked = await rerankTools(this.decisionPlane, principalId, parsed.input);
          return ok(reranked.applied ? 'Semantic ranking applied' : 'Lexical ranking kept', reranked);
        }
        case 'decision_plane_status': {
          // Counters and latency only: no state text, answer, or credential is ever part of status.
          const status = this.decisionPlane?.status() ?? { purposes: [], metrics: {} };
          const credentials = this.keyring ? this.integrationCredentials().list(principalId) : [];
          return ok('Decision Plane status', {
            enabled: status.purposes.length > 0,
            purposes: status.purposes,
            provider: 'typesafe-jev',
            configured: credentials.some((credential) => credential.integration === 'typesafe' && credential.status === 'ACTIVE'),
            metrics: status.metrics
          });
        }
        case 'skill_suggest': {
          // A missing key is not an error and costs nothing: the engine is never constructed and no
          // request is made, which is the behaviour the phase requires of an unconfigured owner.
          const apiKey = this.keyring ? this.integrationCredentials().decryptValue(principalId, 'typesafe') : undefined;
          const workspaceId = parsed.input.workspaceId;
          if (!apiKey || !workspaceId) {
            return ok('No suggestion', {
              suggested: null,
              reason: apiKey ? 'empty_roster' : 'not_configured',
              cached: false, latencyMs: 0, outboundCalls: 0, redactionCount: 0
            });
          }
          const roster = await this.workspaces.skillRoster(parsed.principal, workspaceId);
          const outcome = await this.suggester(principalId, workspaceId, apiKey).suggest({
            ownerId: principalId,
            workspaceId,
            prompt: parsed.input.prompt,
            roster: roster.entries as RosterEntry[],
            rosterDigest: roster.rosterDigest
          });
          // One audit row per suggestion, carrying only scalars: the audit surface is flat, and neither
          // the prompt nor the model's answer text may appear here or anywhere else.
          this.metadata?.recordAudit(
            principalId,
            'skill.suggested',
            'skill_suggestion',
            outcome.suggested ? outcome.suggested.name : 'none',
            0,
            {
              rosterDigest: roster.rosterDigest,
              gateThreshold: GATE_THRESHOLD,
              fitsThreshold: FITS_THRESHOLD,
              skill: outcome.suggested ? outcome.suggested.name : '',
              gate: outcome.suggested ? outcome.suggested.gate : 0,
              fit: outcome.suggested ? outcome.suggested.fit : 0,
              confidence: outcome.suggested ? outcome.suggested.confidence : 0,
              reason: outcome.reason ?? 'suggested',
              cached: outcome.cached,
              latencyMs: outcome.latencyMs,
              outboundCalls: outcome.outboundCalls,
              redactionCount: outcome.redactionCount
            }
          );
          return ok(outcome.suggested ? `Suggested ${outcome.suggested.name}` : 'No suggestion', outcome);
        }
        case 'skill_revision_diff': {
          const from = required(
            this.principals.getSkillRevision(principalId, parsed.input.skillId, parsed.input.fromRevisionId),
            `Revision ${parsed.input.fromRevisionId} was not found for this skill`
          );
          const to = required(
            this.principals.getSkillRevision(principalId, parsed.input.skillId, parsed.input.toRevisionId),
            `Revision ${parsed.input.toRevisionId} was not found for this skill`
          );
          const slug = this.principals.getSkillSource(principalId, parsed.input.skillId)?.slug;
          const before = this.readRevisionText(principalId, from.bundleSha256, slug);
          const after = this.readRevisionText(principalId, to.bundleSha256, slug);
          // A revision whose bundle is gone cannot be compared. Reporting that is better than an empty
          // diff, which a reader would take to mean nothing changed.
          if (before === undefined || after === undefined) {
            throw new HarnessError('NOT_FOUND', 'one of these revisions has no readable content in the cache', 404, false);
          }
          const diff = diffRevisionText(before, after);
          return ok('Revision diff', {
            diff: formatRevisionDiff(diff),
            changed: diff.added > 0 || diff.removed > 0,
            added: diff.added,
            removed: diff.removed,
            truncated: diff.truncated,
            fromRevisionId: from.id,
            toRevisionId: to.id
          });
        }
        default:
          // The cases above now cover every metadata operation, which is why the narrowing reports this
          // branch as unreachable. It stays as a guard for a future operation added to the schema without a
          // handler: an internal operation must fail loudly rather than return an empty success that makes a
          // control-plane route look implemented while doing nothing.
          throw new HarnessError('NOT_FOUND', 'this operation has no runner handler yet', 404, false);
      }
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      if (error instanceof ArtifactStoreError) throw new HarnessError(error.code, error.message, statusFor(error.code), false);
      // The skill registry raises its own error type so the store stays free of HTTP concerns; the
      // service is where it becomes a status the control plane and the dashboard mapper understand.
      if (error instanceof SkillRegistryError) throw new HarnessError(error.code, error.message, statusFor(error.code), false);
      // A stale generation or a second create is a conflict the dashboard recovers from, not a 500.
      if (error instanceof IntegrationCredentialError) throw new HarnessError(error.code, error.message, statusFor(error.code), false);
      throw error;
    }
  }

  private githubStatus(principalId: string) {
    const installations = this.githubInstallations?.listInstallations(principalId) ?? [];
    const record = this.githubInstallations?.getInstallation(principalId);
    return {
      configured: Boolean(this.config.githubApp?.appSlug),
      installations,
      installation: record ?? null,
      repositories: this.githubInstallations?.listRepositoryGrants(principalId) ?? []
    };
  }
  private secrets() {
    if (!this.metadata.secretReadiness().ready) {
      throw new HarnessError('UNAVAILABLE', 'Secret operations are temporarily unavailable', 503, false);
    }
    return this.metadata.secrets;
  }
  private mcp() {
    return this.metadata.mcpGateway;
  }
  private oauthStore() {
    if (!this.metadata.secretReadiness().ready) {
      throw new HarnessError('UNAVAILABLE', 'MCP OAuth storage is temporarily unavailable', 503, false);
    }
    return this.metadata.mcpOAuth;
  }
  private requireMcpOAuthServer(principalId: string, serverId: string) {
    const server = this.mcp().getServer(principalId, serverId);
    if (!server) throw new HarnessError('NOT_FOUND', 'MCP server is unavailable', 404, false);
    if (!server.oauth) throw new HarnessError('INVALID_INPUT', 'OAuth is not enabled for this MCP server', 400, false);
    return server;
  }
  private mcpOAuthStatus(principalId: string, serverId: string) {
    const server = this.mcp().getServer(principalId, serverId);
    if (!server) throw new HarnessError('NOT_FOUND', 'MCP server is unavailable', 404, false);
    return this.oauthStore().status(principalId, serverId, {
      configured: server.oauth !== null,
      redirectUrl: null,
      requestedScopes: server.oauth?.scopes ?? null
    });
  }
  private mcpOAuthCall<T>(action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (!(error instanceof McpOAuthStoreError)) throw error;
      if (error.code === 'CONFLICT') throw new HarnessError('CONFLICT', error.message, 409, false);
      if (error.code === 'EXPIRED') throw new HarnessError('EXPIRED', error.message, 410, false);
      throw new HarnessError('NOT_FOUND', error.message, 404, false);
    }
  }
  /**
   * Resolve one server's referenced credentials for an explicit purpose. `execute` is
   * gated by the cached tool's effective permission; `connect` is the audited
   * server-level grant that keeps a deny-by-default server testable. No value ever
   * reaches the audit trail or a disabled server.
   */
  private mcpCredentials(
    principalId: string,
    input: { serverId: string; toolName?: string | undefined; purpose: 'execute' | 'connect' }
  ): RunnerResponse {
    const server = this.mcp().getServer(principalId, input.serverId);
    if (!server) throw new HarnessError('NOT_FOUND', 'MCP server is unavailable', 404, false);
    if (!server.enabled) return ok('MCP server is disabled', { allowed: false, reason: 'server_disabled' });
    if (input.purpose === 'execute') {
      const tool = input.toolName
        ? this.mcp().getTool(principalId, qualifiedToolName(server.name, input.toolName))
        : undefined;
      if (!tool || tool.permission !== 'allow') {
        return ok('MCP tool access denied', { allowed: false, reason: 'tool_denied' });
      }
    }
    const headers: Record<string, string> = {};
    for (const header of server.headers) {
      if (header.kind === 'secret') {
        const reference = header.secretRef;
        const value = reference ? this.metadata.globalSecretValue(principalId, reference) : undefined;
        if (value === undefined) {
          // Name the reference, never a value: the missing grant must be actionable.
          throw new HarnessError('NOT_FOUND', `referenced secret ${reference ?? header.name} is unavailable`, 404, false);
        }
        headers[header.name] = value;
      } else if (header.value !== undefined) {
        headers[header.name] = header.value;
      }
    }
    let oauth: { scopes: string | null; clientId: string | null; clientSecret: string | null } | undefined;
    if (server.oauth) {
      const reference = server.oauth.clientSecretRef;
      const clientSecret = reference ? this.metadata.globalSecretValue(principalId, reference) : undefined;
      if (reference && clientSecret === undefined) {
        throw new HarnessError('NOT_FOUND', `referenced secret ${reference} is unavailable`, 404, false);
      }
      oauth = { scopes: server.oauth.scopes ?? null, clientId: server.oauth.clientId ?? null, clientSecret: clientSecret ?? null };
    }
    this.metadata.recordAudit(principalId, 'mcp_gateway.credentials_resolved', 'mcp_server', server.id, server.generation, {
      serverId: server.id,
      purpose: input.purpose,
      toolName: input.toolName ?? '',
      headerCount: Object.keys(headers).length
    });
    return ok('MCP credentials resolved', {
      allowed: true, transport: server.transport, endpoint: server.endpoint, headers, ...(oauth ? { oauth } : {})
    });
  }
  private beginGitHubSetup(principalId: string, expectedAccountId?: string) {
    const binding = this.requireGitHubBinding(); const github = this.config.githubApp;
    if (!github?.appSlug) throw new HarnessError('UNAVAILABLE', 'GitHub App setup is not configured', 503, false);
    const created = binding.beginSetup({ principalId, expectedAppId: github.appId, ...(expectedAccountId ? { expectedAccountId } : {}) });
    return { ...created, url: `https://github.com/apps/${github.appSlug}/installations/new?state=${encodeURIComponent(created.state)}` };
  }
  private requireGitHubBinding(): GitHubBindingService {
    if (!this.githubBinding) throw new HarnessError('UNAVAILABLE', 'GitHub App setup is not configured', 503, false);
    return this.githubBinding;
  }
  private models(): ModelProfileStateRepository {
    if (!this.modelProfiles) {
      throw new HarnessError('UNAVAILABLE', 'Model profile operations are temporarily unavailable', 503, false);
    }
    return this.modelProfiles;
  }
  /**
   * Profiles with each active revision's prices reviewed against the cached
   * catalog price of the model it routes to. The cache is peeked once per list, so
   * listing never makes a provider request, and the review is never stored.
   */
  private reviewedProfiles(principalId: string): AgentModelProfileMetadata[] {
    const providers = new Map(this.models().listCredentials(principalId).map((credential) => [credential.id, credential.provider]));
    const cachedPrice = this.catalog().cachedPrices();
    return this.models().listProfiles(principalId).map((profile) => {
      const revision = profile.activeRevision;
      if (!revision) return profile;
      const provider = providers.get(revision.credentialId);
      const catalogPrice = provider ? cachedPrice(provider, revision.model) : undefined;
      return { ...profile, pricingReview: reviewPricing(revision, catalogPrice) };
    });
  }

  /**
   * Provenance for submitted prices that name a catalog model. The runner looks up
   * its own cached price for the model the revision routes to and accepts the
   * reference only when it names that model; without a reference, or for a
   * credential it cannot find, the repository records the operator's override.
   */
  private submittedPriceProvenance(
    principalId: string,
    credentialId: string,
    model: string,
    pricing: AgentModelPricing | undefined,
    ref: ModelCatalogPriceRef | undefined
  ): ProfileRevisionOptions {
    if (!pricing || !ref) return {};
    const credential = this.models().getCredential(principalId, credentialId);
    if (!credential) return {};
    return { priceProvenance: savedPriceProvenance(pricing, ref, this.catalog().cachedPrice(credential.provider, model)) };
  }

  /** The ledger shares the state database, so it is created on first use rather than wired by the caller. */
  private spend(): ModelSpendLedger {
    this.spendLedger ??= new ModelSpendLedger(this.principals.database);
    return this.spendLedger;
  }

  /** Audits a policy change in the same transaction as the change, with ids, the period, and the limit only. */
  private recordSpendPolicyChange(principalId: string): NonNullable<ModelSpendPolicyHooks['record']> {
    return (action, policy) => this.metadata.recordAuditInTransaction(
      this.principals.database, principalId, `model_spend_policy.${action}`, 'model_spend_policy', policy.id, policy.generation,
      {
        ...(policy.profileId === null ? {} : { profileId: policy.profileId }),
        period: policy.period,
        limitMicros: policy.limitMicros,
        warnPercent: policy.warnPercent
      }
    );
  }

  private catalogService?: ModelCatalogService;
  private catalog(): ModelCatalogService {
    this.catalogService ??= new ModelCatalogService({
      database: this.principals.database, credentials: this.models(), http: this.providerHttp ?? createProviderHttpClient()
    });
    return this.catalogService;
  }

  private verifier(): ModelConnectionVerifier {
    this.connectionVerifier ??= new ModelConnectionVerifier({
      repository: this.models(),
      http: this.providerHttp ?? createProviderHttpClient(),
      audit: (principalId, action, subjectType, subjectId, generation, details) =>
        this.metadata.recordAudit(principalId, action, subjectType, subjectId, generation, details)
    });
    return this.connectionVerifier;
  }

  private async syncGateway(): Promise<void> {
    const control = this.gatewayControl;
    const modelProfiles = this.modelProfiles;
    if (!modelProfiles || !control) return;
    try {
      // Built inside the push queue, so the push carries the state as of the push, not of this call.
      await control.syncSnapshot(() => modelProfiles.getExportSnapshot(), { onlyIfMismatch: false });
    } catch {
      // The gateway control records the failure; model_config_status reports it instead of failing the mutation.
    }
  }

  /* Managed toolbox packages. The store shares the state database with the MCP package tools. */

  private packageStoreInstance?: PackageStore;

  private packageStore(): PackageStore {
    this.packageStoreInstance ??= new PackageStore(
      this.principals.database,
      (database, principalId, action, subjectType, subjectId, generation, details) => this.metadata.recordAuditInTransaction(
        database, principalId, action, subjectType, subjectId, generation, details
      )
    );
    return this.packageStoreInstance;
  }

  /** A decision or rollback while the feature is off is refused rather than silently recorded. */
  private requirePackages(): PackageStore {
    if (!this.config.packagesEnabled) throw new HarnessError('FORBIDDEN', PACKAGES_DISABLED_MESSAGE, 403, false);
    return this.packageStore();
  }

  /** A release is usable only while its verified tree is still on disk under the packages root. */
  private packageReleasePresent(release: PackageReleaseRecord): boolean {
    try {
      return statSync(join(this.config.packagesRoot, release.relPath)).isDirectory();
    } catch {
      return false;
    }
  }

  private packageSettings() {
    const approvalMode = packageApprovalUnavailable(this.config)
      ? 'unavailable'
      : this.config.packagesApprovalMode === 'none' ? 'not_required' : 'required';
    return {
      enabled: this.config.packagesEnabled,
      approvalMode,
      ecosystems: [...(this.config.packagesEcosystems ?? [])],
      lifecycleScripts: this.config.packagesNpmLifecycleScripts,
      quotas: {
        maxReleaseBytes: this.config.packagesMaxReleaseBytes,
        maxOwnerBytes: this.config.packagesMaxOwnerBytes,
        maxBindings: this.config.packagesMaxBindings
      }
    };
  }

  /** An owner-scoped package reaches every retained workspace; a workspace-scoped one reaches only its own. */
  private packageAffectedWorkspaces(ownerId: string, scope: string, workspaceId: string | null, retained?: string[]): string[] {
    if (scope === 'workspace') return workspaceId ? [workspaceId] : [];
    return retained ?? this.packageStore().retainedWorkspaceIds(ownerId);
  }

  /**
   * The plan as an operator reviews it. The owner identity is never projected, and a decision is shown in
   * role terms (`policy` or `dashboard`) rather than as the raw principal.
   */
  private packagePlanView(ownerId: string, plan: PackagePlanRecord, now: number, retained?: string[]) {
    const store = this.packageStore();
    const binding = store.findBinding(ownerId, plan.scope, plan.workspaceId, plan.ecosystem, plan.packageName);
    const current = binding?.releaseId ? store.getRelease(ownerId, binding.releaseId) : undefined;
    const open = plan.status === 'PENDING_APPROVAL' || plan.status === 'APPROVED';
    const bindingMoved = (binding?.generation ?? 0) !== plan.bindingGeneration
      || (plan.bindingId !== null && binding !== undefined && binding.id !== plan.bindingId);
    const body = plan.body;
    return {
      ...packagePlanSummary(plan),
      status: open && plan.expiresAt <= now ? 'EXPIRED' : plan.status,
      requestedSpec: plan.requestedSpec,
      source: body.source,
      integrity: body.integrity,
      dependencyCount: body.dependencyCount,
      sizeEstimateBytes: body.sizeEstimateBytes,
      binaries: body.binaries,
      conflicts: body.conflicts.map((conflict) => ({
        binary: conflict.binary, scope: conflict.scope, ...(conflict.workspaceId ? { workspaceId: conflict.workspaceId } : {}),
        ecosystem: conflict.ecosystem, name: conflict.name
      })),
      lifecycleScripts: body.lifecycleScripts,
      runtime: { node: body.runtime.node, npm: body.runtime.npm, uv: body.runtime.uv, python: body.runtime.python },
      bindingGeneration: plan.bindingGeneration,
      currentRelease: binding && current ? { releaseId: current.id, version: current.version, generation: binding.generation } : null,
      stale: open && bindingMoved,
      affectedWorkspaces: this.packageAffectedWorkspaces(ownerId, plan.scope, plan.workspaceId, retained),
      ...(plan.decidedAt !== null ? { decidedAt: new Date(plan.decidedAt).toISOString() } : {}),
      ...(plan.decidedBy !== null ? { decidedBy: plan.decidedBy === 'policy' ? 'policy' : 'dashboard' } : {}),
      ...(plan.applyId ? { applyId: plan.applyId } : {})
    };
  }

  private packagePlanList(ownerId: string) {
    const settings = this.packageSettings();
    if (!settings.enabled) return { enabled: false, approvalMode: settings.approvalMode, plans: [] };
    const now = Date.now();
    const retained = this.packageStore().retainedWorkspaceIds(ownerId);
    const plans = this.packageStore().listPlans(ownerId, undefined, PACKAGE_DASHBOARD_PLAN_LIMIT)
      .map((plan) => this.packagePlanView(ownerId, plan, now, retained));
    return { enabled: true, approvalMode: settings.approvalMode, plans };
  }

  /** The executor image releases are compared with; undefined when it cannot be read, so nothing is marked stale. */
  private async currentPackageImageId(): Promise<string | undefined> {
    if (!this.config.packagesEnabled) return undefined;
    return await this.workspaces.packages.currentImageId();
  }

  private packageOverview(ownerId: string, currentImageId?: string) {
    const settings = this.packageSettings();
    if (!settings.enabled) {
      return {
        ...settings, usage: { ownerBytes: 0, bindings: 0 },
        bindings: [], releases: [], inFlight: [], recentApplies: [], pendingPlans: []
      };
    }
    const store = this.packageStore();
    const now = Date.now();
    const retained = store.retainedWorkspaceIds(ownerId);
    const listed = store.overview(ownerId, { includeHistory: true, ...(currentImageId !== undefined ? { currentImageId } : {}) });
    const records = new Map<string, PackageReleaseRecord>();
    const record = (releaseId: string) => {
      if (!records.has(releaseId)) {
        const found = store.getRelease(ownerId, releaseId);
        if (found) records.set(releaseId, found);
      }
      return records.get(releaseId);
    };
    const bindings = listed.bindings.map((binding) => ({
      ...binding,
      affectedWorkspaces: this.packageAffectedWorkspaces(ownerId, binding.scope, binding.workspaceId ?? null, retained),
      history: store.history(ownerId, binding.bindingId).slice(0, PACKAGE_HISTORY_DEPTH).map((entry) => {
        const release = record(entry.releaseId);
        return {
          generation: entry.generation, releaseId: entry.releaseId, version: release?.version ?? null,
          reason: entry.reason, actor: entry.actor, createdAt: new Date(entry.createdAt).toISOString(),
          available: release?.status === 'VERIFIED'
        };
      })
    }));
    const releases = listed.releases.map((release) => {
      const stored = record(release.releaseId);
      const plan = stored ? store.getPlan(ownerId, stored.planId) : undefined;
      return {
        releaseId: release.releaseId, ecosystem: release.ecosystem, name: release.name, version: release.version,
        treeDigest: release.treeDigest, sizeBytes: release.sizeBytes, fileCount: stored?.fileCount ?? 0,
        binaries: release.binaries, createdAt: release.createdAt, status: release.status, stale: release.stale,
        runtime: { node: release.runtime.node, npm: release.runtime.npm, uv: release.runtime.uv, python: release.runtime.python },
        dependencyCount: plan?.body.dependencyCount ?? null,
        lifecycleScripts: plan?.body.lifecycleScripts ?? false,
        source: plan?.body.source ?? null,
        integrity: plan?.body.integrity ?? null
      };
    });
    const describeApply = (apply: PackageApplyRecord) => {
      const plan = store.getPlan(ownerId, apply.planId);
      return {
        ...packageApplyView(apply),
        ...(plan ? { scope: plan.scope, ecosystem: plan.ecosystem, name: plan.packageName, version: plan.version } : {})
      };
    };
    const inFlight = store.inFlightApplies(ownerId).map(describeApply);
    const inFlightIds = new Set(inFlight.map((apply) => apply.applyId));
    const recentApplies = store.listPlans(ownerId, ['CONSUMED'], PACKAGE_DASHBOARD_RECENT_APPLIES).flatMap((plan) => {
      const apply = plan.applyId ? store.getApply(ownerId, plan.applyId) : undefined;
      return apply && !inFlightIds.has(apply.id) ? [describeApply(apply)] : [];
    });
    const pendingPlans = store.pendingPlans(ownerId, now).map((plan) => this.packagePlanView(ownerId, plan, now, retained));
    const used = this.principals.database.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM package_releases
      WHERE owner_id = ? AND status = 'VERIFIED'`).get(ownerId) as { bytes: number | bigint };
    return {
      ...settings,
      usage: { ownerBytes: Number(used.bytes), bindings: store.listBindings(ownerId).length },
      bindings, releases, inFlight, recentApplies, pendingPlans
    };
  }
}

const PACKAGES_DISABLED_MESSAGE = 'Managed packages are off. Operators enable them with PACKAGES_ENABLED=true.';
const PACKAGE_DASHBOARD_PLAN_LIMIT = 100;
const PACKAGE_DASHBOARD_RECENT_APPLIES = 20;

const ok = (message: string, data: unknown, cursor?: string): RunnerResponse => ({ ok: true, message, data, truncated: false, ...(cursor ? { cursor } : {}) });

/**
 * A store lookup that finds nothing returns `undefined` rather than throwing, so a handler that
 * forwards the result blindly answers `ok: true` with no data and the dashboard renders an empty
 * record instead of a 404. Every single-record read goes through this.
 */
function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new HarnessError('NOT_FOUND', message, 404, false);
  return value;
}
function mutation(message: string, value: unknown): RunnerResponse {
  if (!value) throw new HarnessError('CONFLICT', 'resource generation changed or resource is unavailable', 409, false);
  return ok(message, value);
}
/** Split the contract's header union into the store's literal/secretRef row shape. */
function storedMcpHeaders(
  headers: Array<{ name: string; value: string | { secretRef: string } }>
): McpGatewayStoredHeader[] {
  return headers.map((header) => typeof header.value === 'string'
    ? { name: header.name, value: header.value }
    : { name: header.name, secretRef: header.value.secretRef });
}
const statusFor = (code: ArtifactStoreError['code'] | SkillRegistryError['code'] | IntegrationCredentialError['code']) => code === 'NOT_FOUND' ? 404 : code === 'CONFLICT' ? 409 : code === 'LIMIT_EXCEEDED' ? 413 : 400;
