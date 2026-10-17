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
  it('routes each provider to its registry endpoint and rejects API modes the provider lacks', () => {
    const { repo, p1 } = setup();
    const base = {
      displayName: 'Profile',
      pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 },
      limits: { maxInputTokens: 1000, maxOutputTokens: 100, maxCostMicros: 1000 },
      maxProxyOperations: ['files_read' as const]
    };
    const gemini = repo.createCredential(p1, { label: 'Gemini', provider: 'google', apiKey: 'gm-key' });
    const geminiProfile = repo.createProfile(p1, { ...base, profileId: ModelProfileIdSchema.parse('gemini'), credentialId: gemini.id, model: 'gemini-2.5-flash', apiMode: 'chat-completions' });
    expect(geminiProfile.activeRevision?.upstreamUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(() => repo.createProfile(p1, { ...base, profileId: ModelProfileIdSchema.parse('gemini-responses'), credentialId: gemini.id, model: 'gemini-2.5-flash', apiMode: 'responses' }))
      .toThrow('does not support the responses API mode');

    const deepseek = repo.createCredential(p1, { label: 'DeepSeek', provider: 'deepseek', apiKey: 'ds-key' });
    const deepseekProfile = repo.createProfile(p1, { ...base, profileId: ModelProfileIdSchema.parse('deepseek'), credentialId: deepseek.id, model: 'deepseek-chat', apiMode: 'chat-completions' });
    expect(deepseekProfile.activeRevision?.upstreamUrl).toBe('https://api.deepseek.com/chat/completions');
    expect(deepseek.authMode).toBe('bearer');

    expect(() => repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', authMode: 'x-api-key', apiKey: 'sk-key' }))
      .toThrow('does not accept the x-api-key auth mode');
  });

  it('refuses to bind a profile to a stored credential whose auth mode the provider no longer accepts', () => {
    const { store, repo, p1 } = setup();
    const base = {
      displayName: 'Profile',
      model: 'gemini-2.5-flash',
      apiMode: 'chat-completions' as const,
      pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 },
      limits: { maxInputTokens: 1000, maxOutputTokens: 100, maxCostMicros: 1000 },
      maxProxyOperations: ['files_read' as const]
    };
    const gemini = repo.createCredential(p1, { label: 'Gemini', provider: 'google', apiKey: 'gm-key' });
    const profile = repo.createProfile(p1, { ...base, profileId: ModelProfileIdSchema.parse('gemini'), credentialId: gemini.id });
    // Simulates a credential saved before Gemini was limited to bearer auth.
    store.database.prepare('UPDATE model_provider_credentials SET auth_mode = ? WHERE id = ?').run('x-api-key', gemini.id);

    expect(() => repo.createProfile(p1, { ...base, profileId: ModelProfileIdSchema.parse('gemini-2'), credentialId: gemini.id }))
      .toThrow('add a new credential with bearer auth');
    expect(() => repo.updateProfile(p1, profile.id, { displayName: 'Gemini v2', expectedGeneration: 1 }))
      .toThrow('which Google Gemini does not accept');

    const replacement = repo.createCredential(p1, { label: 'Gemini bearer', provider: 'google', apiKey: 'gm-key-2' });
    const moved = repo.updateProfile(p1, profile.id, { credentialId: replacement.id, expectedGeneration: 1 });
    expect(moved.credentialId).toBe(replacement.id);
  });

  it('keeps a custom profile\'s upstream URL when an edit does not resubmit it', () => {
    const { repo, p1 } = setup();
    const cred = repo.createCredential(p1, { label: 'Custom', provider: 'custom', apiKey: 'custom-key' });
    const profile = repo.createProfile(p1, {
      profileId: ModelProfileIdSchema.parse('custom'),
      displayName: 'Custom',
      credentialId: cred.id,
      model: 'my-model',
      apiMode: 'chat-completions',
      customUpstreamUrl: 'https://llm.example.com/v1/chat/completions',
      pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 },
      limits: { maxInputTokens: 1000, maxOutputTokens: 100, maxCostMicros: 1000 },
      maxProxyOperations: ['files_read']
    });
    const updated = repo.updateProfile(p1, profile.id, { displayName: 'Custom v2', expectedGeneration: 1 });
    expect(updated.activeRevision?.upstreamUrl).toBe('https://llm.example.com/v1/chat/completions');
    const moved = repo.updateProfile(p1, profile.id, { customUpstreamUrl: 'https://llm2.example.com/v1/chat/completions', expectedGeneration: 2 });
    expect(moved.activeRevision?.upstreamUrl).toBe('https://llm2.example.com/v1/chat/completions');
  });
});
