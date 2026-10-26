import { loadRunnerConfig } from './config.js';
import { McpEventService } from './mcp-event-service.js';
import { AutomationService } from './automation-service.js';
import { MetadataStore } from './metadata-store.js';
import { SecretKeyring } from './secret-keyring.js';
import { StateStore } from './state-store.js';

const config = loadRunnerConfig();
if (!config.secretKeyring) throw new Error('secret keyring is required for re-encryption');

const state = new StateStore(config.stateDb);
const keyring = new SecretKeyring(config.secretKeyring.activeVersion, config.secretKeyring.keys);
const metadata = new MetadataStore(config.stateDb, keyring);
const controller = new AbortController();

process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

try {
  const changed = await metadata.secrets.reencrypt(controller.signal);
  const snapshotsChanged = state.reencryptSnapshots((item) => metadata.secrets.reencryptSnapshotItem(item));
  const oauthChanged = metadata.mcpOAuth.reencrypt(controller.signal);
  const eventsChanged = new McpEventService({
    database: state.database,
    resolvePrincipal: (principal) => state.resolvePrincipal(principal),
    keyring
  }).reencrypt(controller.signal);
  const automationsChanged = new AutomationService({
    database: state.database,
    enabled: false,
    maxConcurrentWorkflows: 1,
    resolvePrincipal: (principal) => state.resolvePrincipal(principal),
    operations: { execute: () => Promise.reject(new Error('automation operations are unavailable during re-encryption')) },
    keyring
  }).reencrypt(controller.signal);
  if (controller.signal.aborted) {
    process.stderr.write(`Secret re-encryption interrupted after ${changed} version(s) and ${snapshotsChanged} snapshot(s) and ${oauthChanged} OAuth record(s) and ${eventsChanged} event subscription(s) and ${automationsChanged} automation connection(s). It is safe to resume.\n`);
    process.exitCode = 130;
  } else {
    process.stdout.write(`Re-encrypted ${changed} secret version(s) and ${snapshotsChanged} snapshot(s) and ${oauthChanged} OAuth record(s) and ${eventsChanged} event subscription(s) and ${automationsChanged} automation connection(s).\n`);
  }
} finally {
  metadata.close();
  keyring.close();
  state.close();
}
