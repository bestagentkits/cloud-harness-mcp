import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretKeyring } from '../src/secret-keyring.js';
import { MetadataStore } from '../src/metadata-store.js';
import { StateStore } from '../src/state-store.js';
import { resolveOwnerPrincipal } from '../src/principal-store.js';

describe('Adversarial Secret Leakage & Purpose Isolation Audit', () => {
  let tmpDir: string;
  let metadataStore: MetadataStore;
  let stateStore: StateStore;
  let keyring: SecretKeyring;
  let ownerId: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ch-secret-leakage-test-'));
    keyring = new SecretKeyring(1, [
      { version: 1, key: Buffer.alloc(32, 7) }
    ]);
    const dbPath = join(tmpDir, 'state.sqlite3');
    stateStore = new StateStore(dbPath);
    metadataStore = new MetadataStore(dbPath, keyring);
    ownerId = resolveOwnerPrincipal(stateStore.database, 'owner-canary-1');
  });

  afterEach(() => {
    metadataStore.close();
    stateStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });
  it('strictly excludes provisioning-purpose global secrets from runtime injection queries', () => {
    const canaryKey = 'ak_live_canary_0123456789abcdef0123456789';

    // Create a global secret with purpose = 'provisioning'
    metadataStore.createGlobalSecret(ownerId, 'AGENTKIT_API_KEY', canaryKey, 0, null, 'provisioning');

    // 1. hasActiveGlobalSecrets MUST be false (since no purpose = 'runtime' secrets exist)
    expect(metadataStore.hasActiveGlobalSecrets(ownerId)).toBe(false);

    // 2. globalSecretEnvelopes MUST be empty
    const runtimeEnvelopes = metadataStore.globalSecretEnvelopes(ownerId);
    expect(runtimeEnvelopes.length).toBe(0);

    // 3. Create another global secret with purpose = 'runtime' (e.g. CUSTOM_DEPLOY_KEY)
    metadataStore.createGlobalSecret(ownerId, 'CUSTOM_DEPLOY_KEY', 'sec_legitimate_runtime_token_1234567890', 0, null, 'runtime');

    // 4. hasActiveGlobalSecrets MUST now be true
    expect(metadataStore.hasActiveGlobalSecrets(ownerId)).toBe(true);

    // 5. globalSecretEnvelopes MUST contain ONLY CUSTOM_DEPLOY_KEY and NOT AGENTKIT_API_KEY
    const updatedEnvelopes = metadataStore.globalSecretEnvelopes(ownerId);
    expect(updatedEnvelopes.length).toBe(1);
    expect(updatedEnvelopes[0]!.name).toBe('CUSTOM_DEPLOY_KEY');
    expect(updatedEnvelopes.some((e) => e.name === 'AGENTKIT_API_KEY')).toBe(false);
  });
});
