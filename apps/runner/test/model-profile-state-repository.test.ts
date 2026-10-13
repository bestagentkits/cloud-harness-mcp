import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelProfileIdSchema } from '@cloud-harness/contracts';
import { ModelProfileStateRepository } from '../src/model-profile-state-repository.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore } from '../src/state-store.js';

const tempDbPath = () => join(tmpdir(), `test-model-profiles-${randomBytes(8).toString('hex')}.sqlite`);

describe('ModelProfileStateRepository', () => {
  const openStores: StateStore[] = [];

  afterEach(() => {
    for (const store of openStores.splice(0)) {
      try { store.close(); } catch { /* ignore */ }
    }
  });

  function setup() {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    openStores.push(store);
    const keyring = new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]);
    const repo = new ModelProfileStateRepository(store.database, keyring);
    const p1 = store.resolvePrincipal({ kind: 'owner', ownerId: 'user-1' });
    const p2 = store.resolvePrincipal({ kind: 'owner', ownerId: 'user-2' });
    return { store, keyring, repo, p1, p2 };
  }

  it('creates, lists, rotates, and deletes provider credentials with AES-GCM encryption and principal isolation', () => {
    const { repo, p1, p2 } = setup();

    // Create credential for p1
    const cred1 = repo.createCredential(p1, {
      label: 'OpenAI Prod',
      provider: 'openai',
      apiKey: 'sk-prod-secret-12345'
    });
    expect(cred1.label).toBe('OpenAI Prod');
    expect(cred1.provider).toBe('openai');
    expect(cred1.activeVersion).toBe(1);

    // List credentials for p1
    const list1 = repo.listCredentials(p1);
    expect('apiKey' in (list1[0] ?? {})).toBe(false);

    // Principal isolation: p2 sees zero credentials
    expect(repo.listCredentials(p2)).toHaveLength(0);

    // Rotate credential for p1
    const rotated = repo.rotateCredential(p1, cred1.id, {
      apiKey: 'sk-new-secret-67890',
      expectedGeneration: 1
    });
    expect(rotated.activeVersion).toBe(2);

    // Generation conflict
    expect(() => repo.rotateCredential(p1, cred1.id, {
      apiKey: 'sk-fail',
      expectedGeneration: 1
    })).toThrow();

    // Snapshot exports decrypted secret for Gateway
    const snapshot = repo.getExportSnapshot(p1);
    expect(snapshot.credentials[cred1.id]?.secret).toBe('sk-new-secret-67890');
    expect(snapshot.credentials[cred1.id]?.provider).toBe('openai');

    // Delete credential
    repo.deleteCredential(p1, cred1.id, 2);
    expect(repo.listCredentials(p1)).toHaveLength(0);
  });

  it('creates, lists, updates, activates, and disables model profiles with immutable revisions', () => {
    const { repo, p1, p2 } = setup();
    const cred = repo.createCredential(p1, {
      label: 'OpenAI Test',
      provider: 'openai',
      apiKey: 'sk-12345'
    });

    // Create profile
    const profile = repo.createProfile(p1, {
      profileId: ModelProfileIdSchema.parse('coding-fast'),
      displayName: 'Fast Coding',
      credentialId: cred.id,
      model: 'gpt-5.2-codex',
      apiMode: 'chat-completions',
      pricing: { inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000 },
      limits: { maxInputTokens: 10000, maxOutputTokens: 2000, maxCostMicros: 50000 },
      maxProxyOperations: ['files_read', 'grep_search']
    });
    expect(profile.displayName).toBe('Fast Coding');
    expect(profile.status).toBe('ACTIVE');
    expect(profile.activeRevision?.model).toBe('gpt-5.2-codex');

    // Cannot delete referenced credential
    expect(() => repo.deleteCredential(p1, cred.id, 1)).toThrow('referenced');

    // Update profile creates revision 2
    const updated = repo.updateProfile(p1, profile.id, {
      displayName: 'Fast Coding v2',
      pricing: { inputMicrosPerMillionTokens: 1200, outputMicrosPerMillionTokens: 2400 },
      expectedGeneration: 1
    });
    expect(updated.generation).toBe(2);
    expect(updated.activeRevision?.pricing.inputMicrosPerMillionTokens).toBe(1200);

    // Disable profile
    const disabled = repo.disableProfile(p1, profile.id, 2);
    expect(disabled.status).toBe('DISABLED');

    // Activate profile
    const activated = repo.activateProfile(p1, profile.id, 3);
    expect(activated.status).toBe('ACTIVE');

    // Principal isolation for profiles
    expect(repo.listProfiles(p2)).toHaveLength(0);

    // Export snapshot includes active profiles and credentials
    const snapshot = repo.getExportSnapshot();
    expect(Object.keys(snapshot.profiles)).toHaveLength(1);
    expect(snapshot.profiles[updated.activeRevisionId!]?.model).toBe('gpt-5.2-codex');

    // Delete profile
    repo.deleteProfile(p1, profile.id, 4);
    expect(repo.listProfiles(p1)).toHaveLength(0);
  });
});
