import { McpEventService } from './mcp-event-service.js';
import type { MetadataStore } from './metadata-store.js';
import type { SecretKeyring } from './secret-keyring.js';
import type { StateStore } from './state-store.js';

export type SecretRekeyCounts = {
  secretVersions: number;
  snapshots: number;
  oauthRecords: number;
  eventSubscriptions: number;
  githubUserAuthorizations: number;
};

/**
 * Moves every sealed secret the runner stores onto the keyring's active key. It is the one place that
 * names each encrypted table, so a table that holds ciphertext is either listed here or never rekeyed.
 * Each store re-seals only rows still on an older key and only while they are unchanged, so an
 * interrupted run is safe to resume and a concurrent write is never overwritten.
 */
export async function rekeySecrets(
  input: { state: StateStore; metadata: MetadataStore; keyring: SecretKeyring },
  signal?: AbortSignal
): Promise<SecretRekeyCounts> {
  const { state, metadata, keyring } = input;
  const secretVersions = await metadata.secrets.reencrypt(signal);
  const snapshots = state.reencryptSnapshots((item) => metadata.secrets.reencryptSnapshotItem(item));
  const oauthRecords = metadata.mcpOAuth.reencrypt(signal);
  const eventSubscriptions = new McpEventService({
    database: state.database,
    resolvePrincipal: (principal) => state.resolvePrincipal(principal),
    keyring
  }).reencrypt(signal);
  const githubUserAuthorizations = metadata.githubUserAuthorizations.reencrypt(signal);
  return { secretVersions, snapshots, oauthRecords, eventSubscriptions, githubUserAuthorizations };
}
