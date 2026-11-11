import { loadRunnerConfig } from './config.js';
import { MetadataStore } from './metadata-store.js';
import { SecretKeyring } from './secret-keyring.js';
import { rekeySecrets } from './secret-rekey.js';
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
  const counts = await rekeySecrets({ state, metadata, keyring }, controller.signal);
  const summary = `${counts.secretVersions} secret version(s) and ${counts.snapshots} snapshot(s) and ${counts.oauthRecords} OAuth record(s) and ${counts.eventSubscriptions} event subscription(s) and ${counts.githubUserAuthorizations} GitHub user authorization(s)`;
  if (controller.signal.aborted) {
    process.stderr.write(`Secret re-encryption interrupted after ${summary}. It is safe to resume.\n`);
    process.exitCode = 130;
  } else {
    process.stdout.write(`Re-encrypted ${summary}.\n`);
  }
} finally {
  metadata.close();
  keyring.close();
  state.close();
}
