import {
  HarnessError, MetadataRunnerRequestSchema,
  type MetadataRunnerRequest, type RunnerConfig, type RunnerResponse
} from '@cloud-harness/contracts';
import { ArtifactStoreError, type ArtifactStore } from './artifact-store.js';
import type { GitHubBindingService } from './github-binding-service.js';
import type { GitHubInstallationStore } from './github-installation-store.js';
import type { MetadataStore } from './metadata-store.js';
import type { PrivilegeGrantRecord, StateStore } from './state-store.js';
import type { WorkspaceService } from './workspace-service.js';
import type { ModelProfileStateRepository } from './model-profile-state-repository.js';

export class DashboardControlService {
  constructor(
    private readonly config: RunnerConfig,
    private readonly principals: StateStore,
    private readonly metadata: MetadataStore,
    private readonly artifacts: ArtifactStore,
    private readonly workspaces: WorkspaceService,
    private readonly githubInstallations?: GitHubInstallationStore,
    private readonly githubBinding?: GitHubBindingService,
    private readonly modelProfiles?: ModelProfileStateRepository
  ) {}

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
        case 'model_credential_list': return ok('Model provider credentials listed', { credentials: this.models().listCredentials(principalId) });
        case 'model_credential_create': return mutation('Model provider credential created', this.models().createCredential(principalId, parsed.input));
        case 'model_credential_rotate': return mutation('Model provider credential rotated', this.models().rotateCredential(principalId, parsed.input.credentialId, parsed.input));
        case 'model_credential_delete': {
          this.models().deleteCredential(principalId, parsed.input.credentialId, parsed.input.expectedGeneration);
          return ok('Model provider credential deleted', { deleted: true });
        }
        case 'model_profile_list': return ok('Agent model profiles listed', { profiles: this.models().listProfiles(principalId) });
        case 'model_profile_create': return mutation('Agent model profile created', this.models().createProfile(principalId, parsed.input));
        case 'model_profile_update': return mutation('Agent model profile updated', this.models().updateProfile(principalId, parsed.input.profileId, parsed.input));
        case 'model_profile_activate': return mutation('Agent model profile activated', this.models().activateProfile(principalId, parsed.input.profileId, parsed.input.expectedGeneration));
        case 'model_profile_disable': return mutation('Agent model profile disabled', this.models().disableProfile(principalId, parsed.input.profileId, parsed.input.expectedGeneration));
        case 'model_profile_delete': {
          this.models().deleteProfile(principalId, parsed.input.profileId, parsed.input.expectedGeneration);
          return ok('Agent model profile deleted', { deleted: true });
        }
        case 'model_config_status': {
          const activeProfiles = this.models().listProfiles(principalId).filter((p) => p.status === 'ACTIVE').length;
          const activeCreds = this.models().listCredentials(principalId).filter((c) => c.status === 'ACTIVE').length;
          return ok('Model configuration status', {
            status: {
              gatewaySynced: true,
              gatewayBootId: null,
              lastSyncTime: Date.now(),
              activeProfileCount: activeProfiles,
              activeCredentialCount: activeCreds,
              error: null
            }
          });
        }
      }
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      if (error instanceof ArtifactStoreError) throw new HarnessError(error.code, error.message, statusFor(error.code), false);
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
}

const ok = (message: string, data: unknown, cursor?: string): RunnerResponse => ({ ok: true, message, data, truncated: false, ...(cursor ? { cursor } : {}) });
function mutation(message: string, value: unknown): RunnerResponse {
  if (!value) throw new HarnessError('CONFLICT', 'resource generation changed or resource is unavailable', 409, false);
  return ok(message, value);
}
const statusFor = (code: ArtifactStoreError['code']) => code === 'NOT_FOUND' ? 404 : code === 'CONFLICT' ? 409 : code === 'LIMIT_EXCEEDED' ? 413 : 400;
