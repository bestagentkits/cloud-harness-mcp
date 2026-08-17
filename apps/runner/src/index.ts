import { createServer } from 'node:http';
import pino from 'pino';
import { createRunnerApp } from './app.js';
import { ArtifactStore } from './artifact-store.js';
import { loadRunnerConfigWithReadiness } from './config.js';
import { DashboardControlService } from './dashboard-control-service.js';
import { GitHubApiInstallationVerifier } from './github-api-installation-verifier.js';
import { GitHubBindingService, GitHubSetupStateStore } from './github-binding-service.js';
import { SqliteGitHubInstallationStore } from './github-installation-sqlite-store.js';
import { MetadataStore } from './metadata-store.js';
import { SecretKeyring } from './secret-keyring.js';
import { StateStore } from './state-store.js';
import { WorkspaceService } from './workspace-service.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const loaded = loadRunnerConfigWithReadiness();
const config = loaded.config;
const store = new StateStore(config.stateDb);
let keyring: SecretKeyring | undefined;
let secretReadinessError = loaded.secretReadinessError;
try {
  keyring = config.secretKeyring ? new SecretKeyring(config.secretKeyring.activeVersion, config.secretKeyring.keys) : undefined;
} catch {
  secretReadinessError = 'secret keyring configuration is invalid';
  logger.error('secret operations disabled because the keyring configuration is invalid');
}
const metadata = new MetadataStore(config.stateDb, keyring, secretReadinessError);
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
const artifactReaper = setInterval(() => {
  try {
    artifacts.reapExpired(Date.now(), 100, (database, principalId, artifact) => {
      metadata.recordAuditInTransaction(
        database, principalId, 'artifact.expired', 'artifact', artifact.artifactId, artifact.generation
      );
    });
  } catch (error) {
    logger.error({ error }, 'artifact retention sweep failed');
  }
}, config.reaperIntervalSeconds * 1_000);
artifactReaper.unref();
const service = new WorkspaceService(config, store, metadata, githubInstallations);
const controls = new DashboardControlService(config, store, metadata, artifacts, service, githubInstallations, githubBinding);
await service.start();
const server = createServer(createRunnerApp(config, service, controls));
server.listen(config.port, config.host, () => logger.info({ host: config.host, port: config.port }, 'runner listening'));

async function shutdown(signal: string) {
  logger.info({ signal }, 'runner shutting down');
  clearInterval(artifactReaper);
  server.close();
  await service.stop();
  metadata.close();
  keyring?.close();
  store.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
