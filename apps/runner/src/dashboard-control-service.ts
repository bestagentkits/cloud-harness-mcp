import {
  HarnessError, MetadataRunnerRequestSchema, qualifiedToolName,
  type MetadataRunnerRequest, type RunnerConfig, type RunnerResponse
} from '@cloud-harness/contracts';
import { ArtifactStoreError, type ArtifactStore } from './artifact-store.js';
import type { GitHubBindingService } from './github-binding-service.js';
import type { GitHubInstallationStore } from './github-installation-store.js';
import type { McpGatewayStoredHeader } from './mcp-gateway-store.js';
import type { MetadataStore } from './metadata-store.js';
import { SkillRegistryError, type PrivilegeGrantRecord, type StateStore } from './state-store.js';
import { resolveWorkspaceSkills, type SkillCandidate, type SkillTier } from './skill-resolver.js';
import type { WorkspaceService } from './workspace-service.js';
import type { ModelProfileStateRepository } from './model-profile-state-repository.js';
import type { AgentGatewayControl } from './agent-gateway-control.js';

export class DashboardControlService {
  private lastGatewaySync?: { synced: boolean; bootId: string | null; time: number; error: string | null };

  constructor(
    private readonly config: RunnerConfig,
    private readonly principals: StateStore,
    private readonly metadata: MetadataStore,
    private readonly artifacts: ArtifactStore,
    private readonly workspaces: WorkspaceService,
    private readonly githubInstallations?: GitHubInstallationStore,
    private readonly githubBinding?: GitHubBindingService,
    private readonly modelProfiles?: ModelProfileStateRepository,
    private readonly gatewayControl?: AgentGatewayControl
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
        case 'model_profile_list': return ok('Agent model profiles listed', { profiles: this.models().listProfiles(principalId) });
        case 'model_profile_create': {
          const created = this.models().createProfile(principalId, parsed.input);
          await this.syncGateway();
          return mutation('Agent model profile created', created);
        }
        case 'model_profile_update': {
          const updated = this.models().updateProfile(principalId, parsed.input.profileId, parsed.input);
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
        case 'model_config_status': {
          const activeProfiles = this.models().listProfiles(principalId).filter((p) => p.status === 'ACTIVE').length;
          const activeCreds = this.models().listCredentials(principalId).filter((c) => c.status === 'ACTIVE').length;
          let gatewaySynced = false;
          let gatewayBootId: string | null = null;
          let syncError: string | null = null;
          if (this.gatewayControl?.queryDigest) {
            try {
              const digest = await this.gatewayControl.queryDigest();
              gatewayBootId = digest.gatewayBootId;
              if (activeProfiles > 0 && digest.activeProfileCount === 0 && this.gatewayControl.applySnapshot) {
                const snapshot = this.models().getExportSnapshot();
                const ack = await this.gatewayControl.applySnapshot(snapshot);
                gatewayBootId = ack.gatewayBootId;
                gatewaySynced = true;
                this.lastGatewaySync = { synced: true, bootId: ack.gatewayBootId, time: Date.now(), error: null };
              } else {
                gatewaySynced = true;
              }
            } catch (err) {
              gatewaySynced = false;
              syncError = err instanceof Error ? err.message : 'gateway unreachable';
            }
          }
          return ok('Model configuration status', {
            status: {
              gatewaySynced,
              gatewayBootId,
              lastSyncTime: this.lastGatewaySync?.time ?? Date.now(),
              activeProfileCount: activeProfiles,
              activeCredentialCount: activeCreds,
              error: syncError
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
        case 'skill_get': return ok('Skill read', required(this.principals.getSkillSource(principalId, parsed.input.skillId), `Skill ${parsed.input.skillId} was not found`));
        case 'skill_revision_list': return ok('Skill revisions listed', { revisions: this.principals.listSkillRevisions(principalId, parsed.input.skillId, parsed.input.limit) });
        case 'skill_revision_get': {
          const revision = this.principals.listSkillRevisions(principalId, parsed.input.skillId, 200)
            .find((entry) => entry?.id === parsed.input.revisionId);
          if (!revision) throw new HarnessError('NOT_FOUND', `Revision ${parsed.input.revisionId} was not found for this skill`, 404, false);
          return ok('Skill revision read', revision);
        }
        case 'skill_usage': return ok('Skill usage listed', this.principals.listSkillUsage(principalId, parsed.input.skillId));
        case 'skill_search': {
          // Only the local registry is searched. Fanning out to skills.sh and SkillX belongs to the
          // adapter layer, and reporting a provider as returning zero results would be a claim this
          // code cannot back, so an unasked provider is reported as unavailable rather than empty.
          const needle = parsed.input.query.toLowerCase();
          const local = this.principals.listSkillSources(principalId, { limit: 200 })
            .filter((skill): skill is NonNullable<ReturnType<StateStore['getSkillSource']>> => skill !== undefined
              && (skill.slug.toLowerCase().includes(needle) || skill.displayName.toLowerCase().includes(needle)))
            .slice(0, parsed.input.limit);
          return ok('Skills searched', {
            local,
            providers: parsed.input.providers
              .filter((provider) => provider !== 'local')
              .map((provider) => ({ provider, status: 'unavailable', count: 0 }))
          });
        }
        case 'skill_set_list': return ok('Skill sets listed', { sets: this.principals.listSkillSets(principalId) });
        case 'skill_set_get': return ok('Skill set read', required(this.principals.getSkillSet(principalId, parsed.input.skillSetId), `Skill set ${parsed.input.skillSetId} was not found`));
        case 'skill_import_status': return ok('Import job read', required(this.principals.getSkillImportJob(principalId, parsed.input.jobId), `Import job ${parsed.input.jobId} was not found`));
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
        default:
          // Any internal operation that has no runner handler yet fails loudly instead of returning an
          // empty success, so a control-plane route can never look implemented while doing nothing.
          throw new HarnessError('NOT_FOUND', `operation ${parsed.operation} has no runner handler yet`, 404, false);
      }
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      if (error instanceof ArtifactStoreError) throw new HarnessError(error.code, error.message, statusFor(error.code), false);
      // The skill registry raises its own error type so the store stays free of HTTP concerns; the
      // service is where it becomes a status the control plane and the dashboard mapper understand.
      if (error instanceof SkillRegistryError) throw new HarnessError(error.code, error.message, statusFor(error.code), false);
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
    this.metadata.recordAudit(principalId, 'mcp_gateway.credentials_resolved', 'mcp_server', server.id, server.generation, {
      serverId: server.id,
      purpose: input.purpose,
      toolName: input.toolName ?? '',
      headerCount: Object.keys(headers).length
    });
    return ok('MCP credentials resolved', {
      allowed: true, transport: server.transport, endpoint: server.endpoint, headers
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
  private async syncGateway(): Promise<void> {
    if (this.modelProfiles && this.gatewayControl?.applySnapshot) {
      try {
        const snapshot = this.modelProfiles.getExportSnapshot();
        const ack = await this.gatewayControl.applySnapshot(snapshot);
        this.lastGatewaySync = { synced: true, bootId: ack.gatewayBootId, time: Date.now(), error: null };
      } catch (err) {
        this.lastGatewaySync = { synced: false, bootId: null, time: Date.now(), error: err instanceof Error ? err.message : 'sync failed' };
      }
    }
  }
}

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
const statusFor = (code: ArtifactStoreError['code'] | SkillRegistryError['code']) => code === 'NOT_FOUND' ? 404 : code === 'CONFLICT' ? 409 : code === 'LIMIT_EXCEEDED' ? 413 : 400;
