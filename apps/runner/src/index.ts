import { createServer } from 'node:http';
import pino from 'pino';
import { createRunnerApp } from './app.js';
import { ArtifactStore } from './artifact-store.js';
import { ApiKeyService } from './api-key-service.js';
import { ApiKeyStore } from './api-key-store.js';
import { loadRunnerConfigWithReadiness } from './config.js';
import { DashboardControlService } from './dashboard-control-service.js';
import { GitHubApiInstallationVerifier } from './github-api-installation-verifier.js';
import { GitHubBindingService, GitHubSetupStateStore } from './github-binding-service.js';
import { SqliteGitHubInstallationStore } from './github-installation-sqlite-store.js';
import { MetadataStore } from './metadata-store.js';
import { McpEventService } from './mcp-event-service.js';
import { AutomationService } from './automation-service.js';
import { AgentPolicyService } from './agent-governance/policy-service.js';
import { HarnessError } from '@cloud-harness/contracts';
import { SecretKeyring } from './secret-keyring.js';
import { createRunnerDecisionPlane } from './decision-plane/runner-decision-plane.js';
import { ExecutionRiskAdvisor } from './decision-plane/execution-risk-advisor.js';
import { StateStore } from './state-store.js';
import { WorkspaceService } from './workspace-service.js';
import { DockerAgentGatewayControl } from './agent-gateway-control.js';
import { ModelProfileStateRepository } from './model-profile-state-repository.js';
import { CloudflareAccessOAuthProvider } from './cloudflare-access-oauth-provider.js';
import { OAuthGrantSettingsService } from './oauth-grant-settings-service.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const loaded = loadRunnerConfigWithReadiness();
const config = loaded.config;
const store = new StateStore(config.stateDb, { maxActiveWorkspacesPerOwner: config.maxActiveWorkspacesPerOwner });
let keyring: SecretKeyring | undefined;
let secretReadinessError = loaded.secretReadinessError;
try {
  keyring = config.secretKeyring ? new SecretKeyring(config.secretKeyring.activeVersion, config.secretKeyring.keys) : undefined;
} catch {
  secretReadinessError = 'secret keyring configuration is invalid';
  logger.error('secret operations disabled because the keyring configuration is invalid');
}
const metadata = new MetadataStore(config.stateDb, keyring, secretReadinessError);
const apiKeyStore = new ApiKeyStore(store.database, (database, principalId, action, key) => {
  metadata.recordAuditInTransaction(database, principalId, action, 'api_key', key.id, key.generation, {
    expiresAt: key.expiresAt
  });
});
const apiKeys = new ApiKeyService(store, apiKeyStore);
const events = new McpEventService({
  database: store.database,
  resolvePrincipal: (principal) => store.resolvePrincipal(principal),
  keyring,
  audit: (database, principalId, action, subscriptionId, generation, details) => {
    metadata.recordAuditInTransaction(database, principalId, action, 'mcp_event_subscription', subscriptionId, generation, details);
  }
});
const githubInstallations = new SqliteGitHubInstallationStore(store.database);
const githubBinding = config.githubApp
  ? new GitHubBindingService(new GitHubSetupStateStore(store.database), githubInstallations, new GitHubApiInstallationVerifier(config.githubApp))
  : undefined;
const artifacts = new ArtifactStore(store.database, {
  root: config.artifactRoot, maxArtifactBytes: config.maxArtifactBytes,
  maxPrincipalBytes: config.maxPrincipalArtifactBytes,
  defaultRetentionMs: config.artifactRetentionSeconds * 1_000,
  maxRetentionMs: 2_592_000_000
});
const gatewayControl = config.agents ? new DockerAgentGatewayControl() : undefined;
const modelProfiles = keyring ? new ModelProfileStateRepository(store.database, keyring) : undefined;
const service = new WorkspaceService(config, store, metadata, githubInstallations, githubBinding, artifacts, { modelProfiles, ...(gatewayControl !== undefined ? { gateway: gatewayControl } : {}) });
const decisionPlane = createRunnerDecisionPlane({
  purposes: config.decisionPlanePurposes,
  typesafeEgress: config.typesafeEgress,
  database: metadata.database,
  keyring,
  modelProfiles,
  recordAudit: (principalId, action, subjectType, subjectId, generation, details) =>
    metadata.recordAudit(principalId, action, subjectType, subjectId, generation, details)
});
service.useDecisionPlane(decisionPlane);
const controls = new DashboardControlService(config, store, metadata, artifacts, service, githubInstallations, githubBinding, modelProfiles, gatewayControl, keyring, decisionPlane);
// A job row outlives the process that wrote it, so startup is where an import interrupted by a restart is
// turned into a terminal state rather than left as a spinner that never ends.
controls.reconcileInterruptedImports();
const oauthGrantSettings = new OAuthGrantSettingsService(
  store,
  config.cloudflareAccessOAuth ? new CloudflareAccessOAuthProvider(config.cloudflareAccessOAuth) : undefined,
  (ownerId, action, details) => metadata.recordAudit(ownerId, action, 'instance', 'oauth_grant_settings', 1, details)
);
for (const failure of await service.start()) {
  logger.warn(failure, 'workspace executor reconciliation failed during startup');
}
const automations = new AutomationService({
  database: store.database,
  enabled: config.automationsEnabled,
  maxConcurrentWorkflows: config.automationsMaxConcurrentWorkflows,
  resolvePrincipal: (principal) => store.resolvePrincipal(principal),
  keyring,
  selfLogin: config.githubApp?.appSlug ? `${config.githubApp.appSlug}[bot]` : undefined,
  operations: {
    execute: async (ownerId, operation, input) => {
      try {
        const result = await service.execute(ownerId, operation, input);
        return { ok: result.ok, data: result.data, error: result.error ? { code: result.error.code, retryable: result.error.retryable } : undefined };
      } catch (error) {
        if (error instanceof HarnessError) return { ok: false, error: { code: error.code, retryable: error.retryable } };
        throw error;
      }
    }
  },
  audit: (database, principalId, action, subjectType, subjectId, generation, details) => {
    metadata.recordAuditInTransaction(database, principalId, action, subjectType, subjectId, generation, details);
  },
  log: (record) => logger.warn(record, 'automation')
});
automations.start();
const agentPolicies = new AgentPolicyService({
  database: store.database,
  enabled: config.agentPoliciesEnabled,
  resolvePrincipal: (principal) => store.resolvePrincipal(principal),
  // Project identity is the metadata projects table, never a name or id taken from an event payload.
  projectState: (principalId, projectId) => (metadata.validateArtifactProvenance(principalId, { projectId }) ? 'active' : 'unknown'),
  activeProjectIds: (principalId) => metadata.activeProjectIds(principalId),
  audit: (database, principalId, action, subjectType, subjectId, generation, details) => {
    metadata.recordAuditInTransaction(database, principalId, action, subjectType, subjectId, generation, details);
  },
  // Consulted only when DECISION_PLANE_PURPOSES includes execution-risk, TypeSafe egress is on, the owner has
  // a TypeSafe credential and the policy enables the advisor; otherwise the policy fallback applies with no call.
  advisor: new ExecutionRiskAdvisor(decisionPlane)
});
// Agent trace retention: traces past their retention period are removed hourly in bounded,
// yielding batches, also while traces are disabled. A failure is logged and retried on the next
// tick, and a tick never overlaps a purge still in progress. Shutdown aborts the purge between
// batches and waits for it before the database closes.
const agentTracePurgeAbort = new AbortController();
let agentTracePurgeRunning: Promise<void> | undefined;
const purgeAgentTraces = async (): Promise<void> => {
  if (agentTracePurgeRunning || agentTracePurgeAbort.signal.aborted) return;
  agentTracePurgeRunning = (async () => {
    try {
      const removed = await service.purgeAgentTraces(Date.now(), agentTracePurgeAbort.signal);
      if (removed > 0) logger.info({ removed }, 'agent traces purged');
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : 'unknown' }, 'agent trace purge failed');
    }
  })();
  try {
    await agentTracePurgeRunning;
  } finally {
    agentTracePurgeRunning = undefined;
  }
};
void purgeAgentTraces();
const agentTracePurge = setInterval(() => { void purgeAgentTraces(); }, 3_600_000);
agentTracePurge.unref();
// New installs default to the provider-maximum grant. This never blocks startup and
// never overwrites a value an operator set explicitly; failures surface in Settings.
void oauthGrantSettings.reconcileDefault().then(
  (outcome) => logger.info({ outcome }, 'inbound OAuth grant default reconciled'),
  () => logger.warn({ outcome: 'failed' }, 'inbound OAuth grant default reconcile failed')
);
const server = createServer(createRunnerApp(config, service, controls, apiKeys, {
  settings: oauthGrantSettings,
  resolvePrincipal: (principal) => store.resolvePrincipal(principal)
}, events, automations, agentPolicies));
server.listen(config.port, config.host, () => logger.info({ host: config.host, port: config.port }, 'runner listening'));

async function shutdown(signal: string) {
  logger.info({ signal }, 'runner shutting down');
  server.close();
  clearInterval(agentTracePurge);
  agentTracePurgeAbort.abort();
  await agentTracePurgeRunning;
  await automations.stop();
  await service.stop();
  metadata.close();
  keyring?.close();
  store.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
