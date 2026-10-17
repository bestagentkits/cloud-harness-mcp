import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HarnessError,
  ModelProfileIdSchema,
  ModelVerificationRefSchema,
  type AgentModelPriceProvenance,
  type AgentModelProfileMetadata,
  type MetadataRunnerRequest,
  type ModelCatalogSearchResult,
  type ModelCredentialId,
  type ModelProviderKind,
  type RunnerConfig
} from '@cloud-harness/contracts';
import { ArtifactStore } from '../src/artifact-store.js';
import { DashboardControlService } from '../src/dashboard-control-service.js';
import { MetadataStore } from '../src/metadata-store.js';
import { ModelProfileStateRepository } from '../src/model-profile-state-repository.js';
import type { ProviderHttpClient } from '../src/model-provider-http.js';
import type { WorkspaceService } from '../src/workspace-service.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore } from '../src/state-store.js';

describe('ModelProfileStateRepository', () => {
  const openStores: StateStore[] = [];
  const directories: string[] = [];

  afterEach(() => {
    for (const store of openStores.splice(0)) {
      try { store.close(); } catch { /* ignore */ }
    }
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function setup() {
    const directory = mkdtempSync(join(tmpdir(), 'model-profiles-'));
    directories.push(directory);
    const dbPath = join(directory, 'state.sqlite');
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
    expect(() => repo.updateProfile(p1, profile.id, { apiMode: 'responses', expectedGeneration: 3 }))
      .toThrow('customUpstreamUrl is required');
    const switched = repo.updateProfile(p1, profile.id, { apiMode: 'responses', customUpstreamUrl: 'https://llm2.example.com/v1/responses', expectedGeneration: 3 });
    expect(switched.activeRevision?.upstreamUrl).toBe('https://llm2.example.com/v1/responses');
  });

  it('decrypts one credential\'s active version only for its own principal', () => {
    const { repo, p1, p2 } = setup();
    const cred = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-first-secret' });
    expect(repo.decryptCredentialSecret(p1, cred.id)).toEqual({ activeVersion: 1, secret: 'sk-first-secret' });
    repo.rotateCredential(p1, cred.id, { apiKey: 'sk-second-secret', expectedGeneration: 1 });
    expect(repo.decryptCredentialSecret(p1, cred.id)).toEqual({ activeVersion: 2, secret: 'sk-second-secret' });
    expect(repo.getCredential(p1, cred.id)?.activeVersion).toBe(2);
    expect(repo.getCredential(p2, cred.id)).toBeUndefined();
    expect(() => repo.decryptCredentialSecret(p2, cred.id)).toThrow('was not found');
  });

  it('refuses to decrypt a credential that is not active', () => {
    const { store, repo, p1 } = setup();
    const cred = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-inactive-secret' });
    const setStatus = store.database.prepare('UPDATE model_provider_credentials SET status = ? WHERE id = ?');
    for (const status of ['DISABLED', 'REVOKED']) {
      setStatus.run(status, cred.id);
      expect(() => repo.decryptCredentialSecret(p1, cred.id)).toThrow('was not found');
    }
    setStatus.run('ACTIVE', cred.id);
    expect(repo.decryptCredentialSecret(p1, cred.id).secret).toBe('sk-inactive-secret');
  });

  it('stores nothing for a verification reference on its own; only the runner\'s attach step keeps a result', () => {
    const { store, repo, p1 } = setup();
    const cred = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-ref-secret' });
    const verificationRef = ModelVerificationRefSchema.parse('vref_0123456789abcdef0123456789abcdef');
    const created = repo.createProfile(p1, {
      profileId: ModelProfileIdSchema.parse('coding'), displayName: 'Coding', credentialId: cred.id, model: 'gpt-test', apiMode: 'chat-completions',
      pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 },
      limits: { maxInputTokens: 10, maxOutputTokens: 10, maxCostMicros: 10 },
      maxProxyOperations: ['files_read'], verificationRef
    });
    const updated = repo.updateProfile(p1, created.id, { model: 'gpt-other', expectedGeneration: created.generation, verificationRef });
    expect(created.lastVerification).toBeUndefined();
    expect(updated.lastVerification).toBeUndefined();
    expect(repo.listProfiles(p1)[0]?.lastVerification).toBeUndefined();
    expect(repo.listCredentials(p1)[0]?.lastVerification).toBeUndefined();
    expect((store.database.prepare('SELECT count(*) AS count FROM model_verification_results').get() as { count: number }).count).toBe(0);
  });
  describe('revision pricing and provenance', () => {
    const catalogProvenance: AgentModelPriceProvenance = {
      source: 'openrouter', sourceModelId: 'openai/gpt-5', retrievedAt: 1_700_000_000_000, confidence: 'estimate', isOverride: false
    };
    const tiers = [
      { minPromptTokens: 200_000, inputMicrosPerMillionTokens: 2_500, outputMicrosPerMillionTokens: 15_000, cacheReadMicrosPerMillionTokens: 625 }
    ];
    const pricedProfile = (credentialId: ModelCredentialId, profileId = 'priced') => ({
      profileId: ModelProfileIdSchema.parse(profileId),
      displayName: 'Priced',
      credentialId,
      model: 'gpt-5',
      apiMode: 'chat-completions' as const,
      pricing: { inputMicrosPerMillionTokens: 1_250, outputMicrosPerMillionTokens: 10_000, cacheReadMicrosPerMillionTokens: 125, tiers },
      limits: { maxInputTokens: 300_000, maxOutputTokens: 4_000, maxCostMicros: 900_000 },
      maxProxyOperations: ['files_read' as const]
    });

    it('round-trips cache prices, tiers, and service-supplied provenance', () => {
      const { repo, p1 } = setup();
      const cred = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-priced' });
      const created = repo.createProfile(p1, pricedProfile(cred.id), { priceProvenance: catalogProvenance });
      expect(created.activeRevision?.priceProvenance).toEqual(catalogProvenance);
      expect(created.activeRevision?.pricing).toEqual(pricedProfile(cred.id).pricing);

      const [listed] = repo.listProfiles(p1);
      expect(listed?.activeRevision).toEqual(created.activeRevision);
    });

    it('records prices without a service-supplied source as a user override and stores unknown cache prices as absent', () => {
      const { repo, p1 } = setup();
      const cred = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-user' });
      const created = repo.createProfile(p1, {
        ...pricedProfile(cred.id),
        pricing: { inputMicrosPerMillionTokens: 1_000, outputMicrosPerMillionTokens: 2_000, cacheReadMicrosPerMillionTokens: null, cacheWriteMicrosPerMillionTokens: null }
      });
      expect(created.activeRevision?.priceProvenance).toEqual({ source: 'user', sourceModelId: null, retrievedAt: null, confidence: 'unknown', isOverride: true });
      expect(created.activeRevision?.pricing).toEqual({ inputMicrosPerMillionTokens: 1_000, outputMicrosPerMillionTokens: 2_000 });
      expect(repo.listProfiles(p1)[0]?.activeRevision).toEqual(created.activeRevision);
    });

    it('pins prices, tiers, provenance, and limits when an edit omits pricing', () => {
      const { repo, p1 } = setup();
      const cred = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-pin' });
      const created = repo.createProfile(p1, pricedProfile(cred.id), { priceProvenance: catalogProvenance });
      // Provenance offered without prices does not replace the pinned source.
      const edited = repo.updateProfile(p1, created.id, { displayName: 'Renamed', expectedGeneration: 1 }, {
        priceProvenance: { ...catalogProvenance, source: 'provider', confidence: 'exact' }
      });
      expect(edited.activeRevisionId).not.toBe(created.activeRevisionId);
      expect(edited.activeRevision?.pricing).toEqual(created.activeRevision?.pricing);
      expect(edited.activeRevision?.priceProvenance).toEqual(catalogProvenance);
      expect(edited.activeRevision?.limits).toEqual(created.activeRevision?.limits);
      expect(repo.listProfiles(p1)[0]?.activeRevision).toEqual(edited.activeRevision);
    });

    it('marks kept prices as an override of unknown confidence when the model or credential changes', () => {
      const { repo, p1 } = setup();
      const cred = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-carry' });
      const other = repo.createCredential(p1, { label: 'OpenAI 2', provider: 'openai', apiKey: 'sk-carry-2' });
      const created = repo.createProfile(p1, pricedProfile(cred.id), { priceProvenance: catalogProvenance });
      const carriedOver = { ...catalogProvenance, isOverride: true, confidence: 'unknown' };

      const newModel = repo.updateProfile(p1, created.id, { model: 'gpt-5-mini', expectedGeneration: 1 }, {
        priceProvenance: { ...catalogProvenance, source: 'provider', confidence: 'exact' }
      });
      expect(newModel.activeRevision?.model).toBe('gpt-5-mini');
      expect(newModel.activeRevision?.pricing).toEqual(created.activeRevision?.pricing);
      expect(newModel.activeRevision?.priceProvenance).toEqual(carriedOver);

      const restored = repo.updateProfile(p1, created.id, { model: 'gpt-5', pricing: pricedProfile(cred.id).pricing, expectedGeneration: 2 }, {
        priceProvenance: catalogProvenance
      });
      const newCredential = repo.updateProfile(p1, created.id, { credentialId: other.id, expectedGeneration: restored.generation });
      expect(newCredential.activeRevision?.pricing).toEqual(created.activeRevision?.pricing);
      expect(newCredential.activeRevision?.priceProvenance).toEqual(carriedOver);
      expect(repo.listProfiles(p1)[0]?.activeRevision?.priceProvenance).toEqual(carriedOver);
    });

    it('treats a two-price edit that repeats the stored prices as no price change', () => {
      const { repo, p1 } = setup();
      const cred = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-same' });
      const created = repo.createProfile(p1, pricedProfile(cred.id), { priceProvenance: catalogProvenance });
      const same = { inputMicrosPerMillionTokens: 1_250, outputMicrosPerMillionTokens: 10_000 };
      const edited = repo.updateProfile(p1, created.id, { displayName: 'Renamed', pricing: same, expectedGeneration: 1 });
      expect(edited.activeRevision?.pricing).toEqual(created.activeRevision?.pricing);
      expect(edited.activeRevision?.priceProvenance).toEqual(catalogProvenance);

      // A changed price, or any cache price or tier list, is new pricing.
      const changed = repo.updateProfile(p1, created.id, { pricing: { ...same, outputMicrosPerMillionTokens: 10_001 }, expectedGeneration: 2 });
      expect(changed.activeRevision?.pricing).toEqual({ ...same, outputMicrosPerMillionTokens: 10_001 });
      expect(changed.activeRevision?.priceProvenance.isOverride).toBe(true);
      const restated = repo.updateProfile(p1, created.id, { pricing: { ...same, outputMicrosPerMillionTokens: 10_001, tiers: [] }, expectedGeneration: 3 });
      expect(restated.activeRevision?.pricing).toEqual({ ...same, outputMicrosPerMillionTokens: 10_001 });
    });

    it('refuses an edit without pricing when there is no current revision to copy prices from', () => {
      const { store, repo, p1 } = setup();
      const cred = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-none' });
      const created = repo.createProfile(p1, pricedProfile(cred.id));
      store.database.prepare('UPDATE agent_model_profiles SET active_revision_id = NULL WHERE id = ?').run(created.id);
      let caught: unknown;
      try {
        repo.updateProfile(p1, created.id, { displayName: 'No prices', expectedGeneration: 1 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(HarnessError);
      expect((caught as HarnessError).code).toBe('INVALID_INPUT');
      expect(repo.listProfiles(p1)[0]?.generation).toBe(1);
    });

    it('refuses tiers whose prices resolve below the level beneath them for the credential\'s provider', () => {
      const { repo, p1 } = setup();
      const credential = (provider: ModelProviderKind) => repo.createCredential(p1, { label: provider, provider, apiKey: `sk-${provider}` }).id;
      const tier = { minPromptTokens: 200_000, inputMicrosPerMillionTokens: 2_500, outputMicrosPerMillionTokens: 15_000 };
      const refused = [
        // The base's unstated read resolves to its input price, above the tier's stated read.
        { provider: 'google' as const, pricing: { inputMicrosPerMillionTokens: 1_250, outputMicrosPerMillionTokens: 10_000, tiers: [{ ...tier, cacheReadMicrosPerMillionTokens: 625 }] } },
        // OpenRouter doubles the base's unstated write above the tier's stated write.
        { provider: 'openrouter' as const, pricing: { inputMicrosPerMillionTokens: 2_000, outputMicrosPerMillionTokens: 10_000, tiers: [{ ...tier, cacheWriteMicrosPerMillionTokens: 3_125 }] } },
        // The tier's unstated write resolves to its input price, below the base's stated write.
        { provider: 'anthropic' as const, pricing: { inputMicrosPerMillionTokens: 2_000, outputMicrosPerMillionTokens: 10_000, cacheWriteMicrosPerMillionTokens: 3_000, tiers: [tier] } }
      ];
      refused.forEach(({ provider, pricing }, index) => {
        const input = { ...pricedProfile(credential(provider), `refused-${index}`), pricing };
        expect(() => repo.createProfile(p1, input), provider).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
      });
      expect(repo.listProfiles(p1)).toEqual([]);

      const cred = credential('openai');
      const created = repo.createProfile(p1, pricedProfile(cred, 'accepted'));
      expect(() => repo.updateProfile(p1, created.id, { pricing: refused[0]!.pricing, expectedGeneration: 1 }))
        .toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining('tiers[0].cacheReadMicrosPerMillionTokens') }));
      expect(repo.listProfiles(p1)[0]?.activeRevisionId).toBe(created.activeRevisionId);
    });

    it('refuses a credential change that leaves kept tiers below the level beneath them', () => {
      const { repo, p1 } = setup();
      const custom = repo.createCredential(p1, { label: 'Custom', provider: 'custom', apiKey: 'sk-custom' });
      const openai = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-switch' });
      // On custom the tier's unstated write doubles to 200; on OpenAI it is 100, below the base's 150.
      const created = repo.createProfile(p1, {
        ...pricedProfile(custom.id, 'switch'),
        customUpstreamUrl: 'https://llm.example.com/v1/chat/completions',
        pricing: {
          inputMicrosPerMillionTokens: 100, outputMicrosPerMillionTokens: 100, cacheWriteMicrosPerMillionTokens: 150,
          tiers: [{ minPromptTokens: 1_000, inputMicrosPerMillionTokens: 100, outputMicrosPerMillionTokens: 100 }]
        }
      });
      const switchTo = (pricing?: { inputMicrosPerMillionTokens: number; outputMicrosPerMillionTokens: number }) => () =>
        repo.updateProfile(p1, created.id, { credentialId: openai.id, ...(pricing ? { pricing } : {}), expectedGeneration: 1 });
      for (const attempt of [switchTo(), switchTo({ inputMicrosPerMillionTokens: 100, outputMicrosPerMillionTokens: 100 })]) {
        expect(attempt).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining('tiers[0].cacheWriteMicrosPerMillionTokens') }));
      }
      expect(repo.listProfiles(p1)[0]?.activeRevisionId).toBe(created.activeRevisionId);
    });

    it('gives revisions that differ only in price provenance different digests', () => {
      const { repo, p1 } = setup();
      const cred = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-prov-digest' });
      const input = pricedProfile(cred.id, 'provenance-digest');
      const fromCatalog = repo.createProfile(p1, input, { priceProvenance: catalogProvenance });
      const typed = repo.updateProfile(p1, fromCatalog.id, { pricing: input.pricing, expectedGeneration: 1 });
      expect(typed.activeRevision?.pricing).toEqual(fromCatalog.activeRevision?.pricing);
      expect(typed.activeRevision?.priceProvenance).not.toEqual(fromCatalog.activeRevision?.priceProvenance);
      expect(typed.activeRevision?.digest).not.toBe(fromCatalog.activeRevision?.digest);
    });

    it('reads stored tiers that carry keys this runner does not know', () => {
      const { store, repo, p1 } = setup();
      const cred = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-newer' });
      const created = repo.createProfile(p1, pricedProfile(cred.id));
      store.database.prepare('UPDATE agent_model_profile_revisions SET price_tiers_json = ? WHERE id = ?')
        .run(JSON.stringify([{ ...tiers[0], reasoningMicrosPerMillionTokens: 9_000 }]), created.activeRevisionId);
      expect(repo.listProfiles(p1)[0]?.activeRevision?.pricing.tiers).toEqual(tiers);
      expect(repo.getExportSnapshot(p1).profiles[created.activeRevisionId!]?.pricing.tiers).toHaveLength(1);
    });

    it('stores an empty tier list as flat pricing', () => {
      const { repo, p1 } = setup();
      const cred = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-flat' });
      const created = repo.createProfile(p1, { ...pricedProfile(cred.id), pricing: { inputMicrosPerMillionTokens: 1_000, outputMicrosPerMillionTokens: 2_000, tiers: [] } });
      expect(created.activeRevision?.pricing).toEqual({ inputMicrosPerMillionTokens: 1_000, outputMicrosPerMillionTokens: 2_000 });
      expect(repo.listProfiles(p1)[0]?.activeRevision?.pricing).toEqual(created.activeRevision?.pricing);
    });

    it('looks up one credential\'s provider for its own principal only', () => {
      const { repo, p1, p2 } = setup();
      const cred = repo.createCredential(p1, { label: 'OpenRouter', provider: 'openrouter', apiKey: 'sk-provider' });
      expect(repo.getCredentialProvider(p1, cred.id)).toBe('openrouter');
      expect(repo.getCredentialProvider(p2, cred.id)).toBeUndefined();
      expect(repo.getCredentialProvider(p1, 'cred_00000000000000000000000000000000')).toBeUndefined();
    });

    it('marks an edit that submits pricing as an override unless the service names a catalog source', () => {
      const { repo, p1 } = setup();
      const cred = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-override' });
      const created = repo.createProfile(p1, pricedProfile(cred.id), { priceProvenance: catalogProvenance });
      const typed = repo.updateProfile(p1, created.id, {
        pricing: { inputMicrosPerMillionTokens: 1_300, outputMicrosPerMillionTokens: 10_000 },
        expectedGeneration: 1
      });
      expect(typed.activeRevision?.priceProvenance).toEqual({ source: 'user', sourceModelId: null, retrievedAt: null, confidence: 'unknown', isOverride: true });
      // Tiers and cache prices are part of the submitted pricing, so omitting them drops them.
      expect(typed.activeRevision?.pricing).toEqual({ inputMicrosPerMillionTokens: 1_300, outputMicrosPerMillionTokens: 10_000 });

      const fromCatalog = repo.updateProfile(p1, created.id, { pricing: pricedProfile(cred.id).pricing, expectedGeneration: 2 }, { priceProvenance: catalogProvenance });
      expect(fromCatalog.activeRevision?.priceProvenance).toEqual(catalogProvenance);
      expect(repo.listProfiles(p1)[0]?.activeRevision?.priceProvenance).toEqual(catalogProvenance);
    });

    it('exports effective prices to the gateway in the snapshot shape it charges from', () => {
      const { repo, p1 } = setup();
      const openai = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-snap' });
      const openrouter = repo.createCredential(p1, { label: 'OpenRouter', provider: 'openrouter', apiKey: 'sk-or' });
      const direct = repo.createProfile(p1, pricedProfile(openai.id, 'direct'));
      const routed = repo.createProfile(p1, {
        ...pricedProfile(openrouter.id, 'routed'),
        pricing: { inputMicrosPerMillionTokens: 3_000, outputMicrosPerMillionTokens: 15_000 }
      });

      const snapshot = repo.getExportSnapshot(p1);
      // Unknown cache writes cost the input price where the provider bills no write premium.
      expect(snapshot.profiles[direct.activeRevisionId!]?.pricing).toEqual({
        inputMicrosPerMillionTokens: 1_250,
        outputMicrosPerMillionTokens: 10_000,
        cacheReadMicrosPerMillionTokens: 125,
        cacheWriteMicrosPerMillionTokens: 1_250,
        tiers: [{
          minPromptTokens: 200_000,
          inputMicrosPerMillionTokens: 2_500,
          outputMicrosPerMillionTokens: 15_000,
          cacheReadMicrosPerMillionTokens: 625,
          cacheWriteMicrosPerMillionTokens: 2_500
        }]
      });
      // Providers that bill cache writes default an unknown write price to twice the input.
      expect(snapshot.profiles[routed.activeRevisionId!]?.pricing).toEqual({
        inputMicrosPerMillionTokens: 3_000,
        outputMicrosPerMillionTokens: 15_000,
        cacheReadMicrosPerMillionTokens: 3_000,
        cacheWriteMicrosPerMillionTokens: 6_000
      });
      expect(snapshot.profiles[routed.activeRevisionId!]?.priceProvenance.isOverride).toBe(true);
      for (const revision of Object.values(snapshot.profiles)) {
        const prices = [revision.pricing, ...(revision.pricing.tiers ?? [])].flatMap((level) => [
          level.inputMicrosPerMillionTokens, level.outputMicrosPerMillionTokens,
          level.cacheReadMicrosPerMillionTokens, level.cacheWriteMicrosPerMillionTokens
        ]);
        for (const price of prices) expect(Number.isSafeInteger(price) && (price as number) >= 0).toBe(true);
      }
      // Listing still shows the pinned prices, not the resolved ones.
      expect(repo.listProfiles(p1).find((profile) => profile.id === 'routed')?.activeRevision?.pricing)
        .toEqual({ inputMicrosPerMillionTokens: 3_000, outputMicrosPerMillionTokens: 15_000 });
    });

    it('gives revisions that differ in any price, tier, or limit different digests', () => {
      const { repo, p1 } = setup();
      const cred = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-digest' });
      const input = { ...pricedProfile(cred.id, 'digest-shape'), pricing: { inputMicrosPerMillionTokens: 1_250, outputMicrosPerMillionTokens: 10_000 } };
      const flatTier = { minPromptTokens: 200_000, inputMicrosPerMillionTokens: 2_500, outputMicrosPerMillionTokens: 15_000 };
      const base = repo.createProfile(p1, input);
      const update = (changes: Record<string, unknown>, generation: number) => repo.updateProfile(p1, base.id, { ...changes, expectedGeneration: generation });
      const revisions = [
        base,
        update({ pricing: { ...input.pricing, inputMicrosPerMillionTokens: 1_251 } }, 1),
        update({ pricing: { ...input.pricing, outputMicrosPerMillionTokens: 10_001 } }, 2),
        update({ pricing: { ...input.pricing, cacheReadMicrosPerMillionTokens: 125 } }, 3),
        update({ pricing: { ...input.pricing, cacheReadMicrosPerMillionTokens: 126 } }, 4),
        update({ pricing: { ...input.pricing, tiers: [flatTier] } }, 5),
        update({ pricing: { ...input.pricing, tiers: [{ ...flatTier, minPromptTokens: 128_000 }] } }, 6),
        update({ pricing: input.pricing, limits: { ...input.limits, maxCostMicros: input.limits.maxCostMicros + 1 } }, 7)
      ];
      const digests = revisions.map((profile) => profile.activeRevision?.digest);
      expect(new Set(digests).size).toBe(digests.length);
      // The same settings always hash the same.
      const repeated = update({ limits: { ...input.limits, maxCostMicros: input.limits.maxCostMicros + 1 } }, 8);
      expect(repeated.activeRevisionId).not.toBe(revisions[7]?.activeRevisionId);
      expect(repeated.activeRevision?.digest).toBe(revisions[7]?.activeRevision?.digest);
    });
  });
});

describe('profile pricing provenance and repricing review through the dashboard service', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  const MODEL = 'anthropic/claude-sonnet-4.5';
  const openRouterModel = (prompt: string, completion: string) => ({
    id: MODEL, name: 'Claude Sonnet 4.5',
    pricing: {
      prompt, completion, input_cache_read: '0.0000003', input_cache_write: '0.00000375', input_cache_write_1h: '0.000006',
      overrides: [{ min_prompt_tokens: 200_000, prompt: '0.000006', completion: '0.0000225', input_cache_read: '0.0000006', input_cache_write_1h: '0.000012' }]
    }
  });

  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'model-profile-pricing-'));
    const databasePath = join(root, 'state.db');
    const principals = new StateStore(databasePath);
    const keyring = new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]);
    const metadata = new MetadataStore(databasePath, keyring);
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    cleanups.push(() => { metadata.database.close(); principals.close(); });
    const artifacts = new ArtifactStore(principals.database, {
      root: join(root, 'artifacts'), maxArtifactBytes: 1024, maxPrincipalBytes: 4096, defaultRetentionMs: 60_000, maxRetentionMs: 120_000
    });
    const repo = new ModelProfileStateRepository(principals.database, keyring);
    const upstream = { models: [openRouterModel('0.000003', '0.000015')], requests: 0 };
    const http: ProviderHttpClient = {
      request: async (request) => {
        upstream.requests += 1;
        if (new URL(request.url).hostname !== 'openrouter.ai') throw new Error(`unexpected request to ${request.url}`);
        return { status: 200, headers: {}, body: JSON.stringify({ data: upstream.models }), truncated: false };
      }
    };
    const controls = new DashboardControlService(
      { artifactRetentionSeconds: 60 } as RunnerConfig, principals, metadata, artifacts, {} as WorkspaceService,
      undefined, undefined, repo, undefined, keyring, undefined, http
    );
    const principal = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'operator-a' };
    const call = async (operation: MetadataRunnerRequest['operation'], input: Record<string, unknown>) =>
      (await controls.execute({ version: 2, principal, operation, input } as MetadataRunnerRequest)).data;
    return { principals, upstream, call };
  }

  const LIMITS = { maxInputTokens: 300_000, maxOutputTokens: 10_000, maxCostMicros: 5_000_000 };

  async function catalogPricing(call: ReturnType<typeof setup>['call']) {
    const result = await call('model_catalog_search', { provider: 'openrouter', query: 'claude' }) as ModelCatalogSearchResult;
    const pricing = result.entries[0]!.pricing;
    return {
      fetchedAt: pricing.provenance.retrievedAt,
      pricing: {
        inputMicrosPerMillionTokens: pricing.inputMicrosPerMillionTokens, outputMicrosPerMillionTokens: pricing.outputMicrosPerMillionTokens,
        cacheReadMicrosPerMillionTokens: pricing.cacheReadMicrosPerMillionTokens, cacheWriteMicrosPerMillionTokens: pricing.cacheWriteMicrosPerMillionTokens,
        tiers: pricing.tiers
      }
    };
  }

  async function createProfile(call: ReturnType<typeof setup>['call'], profileId: string, credentialId: string, extra: Record<string, unknown>) {
    return await call('model_profile_create', {
      profileId, displayName: profileId, credentialId, model: MODEL, apiMode: 'chat-completions', limits: LIMITS, maxProxyOperations: ['files_read'], ...extra
    }) as AgentModelProfileMetadata;
  }

  const listProfiles = async (call: ReturnType<typeof setup>['call']) =>
    ((await call('model_profile_list', {})) as { profiles: AgentModelProfileMetadata[] }).profiles;

  it('records catalog provenance only for an unchanged catalog price', async () => {
    const { call } = setup();
    const credential = await call('model_credential_create', { label: 'OpenRouter', provider: 'openrouter', apiKey: 'sk-or-secret' }) as { id: string };
    const { pricing, fetchedAt } = await catalogPricing(call);
    const ref = { sourceModelId: MODEL };

    const accepted = await createProfile(call, 'catalog', credential.id, { pricing, catalogPriceRef: ref });
    expect(accepted.activeRevision?.pricing).toEqual(pricing);
    expect(accepted.activeRevision?.priceProvenance).toEqual({ source: 'openrouter', sourceModelId: MODEL, retrievedAt: fetchedAt, confidence: 'exact', isOverride: false });

    const edited = await createProfile(call, 'edited', credential.id, { pricing: { ...pricing, outputMicrosPerMillionTokens: 14_000_000 }, catalogPriceRef: ref });
    expect(edited.activeRevision?.priceProvenance).toEqual({ source: 'user', sourceModelId: MODEL, retrievedAt: fetchedAt, confidence: 'unknown', isOverride: true });

    // A reference the runner has no cached price for, and a save without one, are the operator's prices.
    const unknownRef = await createProfile(call, 'unknown-ref', credential.id, { pricing, catalogPriceRef: { sourceModelId: 'vendor/not-listed' } });
    expect(unknownRef.activeRevision?.priceProvenance).toEqual({ source: 'user', sourceModelId: null, retrievedAt: null, confidence: 'unknown', isOverride: true });
    const noRef = await createProfile(call, 'no-ref', credential.id, { pricing });
    expect(noRef.activeRevision?.priceProvenance.isOverride).toBe(true);

    // A client cannot state provenance or confidence itself.
    await expect(createProfile(call, 'asserted', credential.id, {
      pricing, priceProvenance: { source: 'openrouter', sourceModelId: MODEL, retrievedAt: fetchedAt, confidence: 'exact', isOverride: false }
    })).rejects.toThrow();
    await expect(createProfile(call, 'asserted-ref', credential.id, { pricing, catalogPriceRef: { ...ref, confidence: 'exact' } })).rejects.toThrow();

    // An edit applies the same rule; an edit that only renames keeps the stored prices and provenance.
    const updated = await call('model_profile_update', {
      profileId: 'edited', expectedGeneration: edited.generation, pricing, catalogPriceRef: ref
    }) as AgentModelProfileMetadata;
    expect(updated.activeRevision?.priceProvenance).toMatchObject({ source: 'openrouter', isOverride: false });
    const reedited = await call('model_profile_update', {
      profileId: 'edited', expectedGeneration: updated.generation, pricing: { ...pricing, tiers: [] }, catalogPriceRef: ref
    }) as AgentModelProfileMetadata;
    expect(reedited.activeRevision?.priceProvenance).toMatchObject({ source: 'user', sourceModelId: MODEL, isOverride: true });
    const renamed = await call('model_profile_update', {
      profileId: 'catalog', expectedGeneration: accepted.generation, displayName: 'Renamed', catalogPriceRef: { sourceModelId: 'vendor/other' }
    }) as AgentModelProfileMetadata;
    expect(renamed.activeRevision?.priceProvenance).toEqual(accepted.activeRevision?.priceProvenance);
  });

  it('flags a repriced catalog on list without ever changing saved prices, provenance, or limits', async () => {
    const { principals, upstream, call } = setup();
    const credential = await call('model_credential_create', { label: 'OpenRouter', provider: 'openrouter', apiKey: 'sk-or-secret' }) as { id: string };
    const { pricing } = await catalogPricing(call);
    await createProfile(call, 'catalog', credential.id, { pricing, catalogPriceRef: { sourceModelId: MODEL } });
    // A profile saved before provenance existed is matched to the catalog by its model ID.
    await createProfile(call, 'legacy', credential.id, { pricing: { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 } });

    const requestsBeforeList = upstream.requests;
    const before = await listProfiles(call);
    expect(upstream.requests).toBe(requestsBeforeList);
    const reviewOf = (profiles: AgentModelProfileMetadata[], id: string) => profiles.find((profile) => profile.id === id)?.pricingReview;
    expect(reviewOf(before, 'catalog')).toMatchObject({ state: 'current', changes: [], isOverride: false });
    // The legacy profile lacks the catalog's long-prompt tier.
    expect(reviewOf(before, 'legacy')).toMatchObject({ state: 'repriced', isOverride: true, changes: [{ field: 'tier', minPromptTokens: 200_000 }] });

    const revisionRows = () => principals.database.prepare('SELECT * FROM agent_model_profile_revisions ORDER BY id').all();
    const rowsBefore = JSON.stringify(revisionRows());
    upstream.models = [openRouterModel('0.0000036', '0.000015')];
    await call('model_catalog_refresh', { provider: 'openrouter' });
    const after = await listProfiles(call);

    const pinned = (profiles: AgentModelProfileMetadata[]) => JSON.stringify(profiles.map((profile) => ({ ...profile, pricingReview: undefined })));
    expect(pinned(after)).toBe(pinned(before));
    expect(JSON.stringify(revisionRows())).toBe(rowsBefore);
    expect(reviewOf(after, 'catalog')).toMatchObject({
      state: 'repriced', isOverride: false,
      changes: [{ field: 'input', minPromptTokens: null, pinned: 3_000_000, catalog: 3_600_000, percent: 20 }]
    });

    // Only the list attaches a review, and nothing stores it.
    const mutated = await call('model_profile_disable', { profileId: 'catalog', expectedGeneration: before.find((profile) => profile.id === 'catalog')!.generation });
    expect(mutated).not.toHaveProperty('pricingReview');
    expect(JSON.stringify(revisionRows())).not.toContain('pricingReview');
  });

  it('keeps catalog code free of revision writes', () => {
    const directory = new URL('../src/model-catalog/', import.meta.url);
    const sources = readdirSync(directory).filter((name) => name.endsWith('.ts'));
    expect(sources.length).toBeGreaterThan(0);
    for (const name of sources) {
      expect(readFileSync(new URL(name, directory), 'utf8'), name).not.toMatch(/agent_model_profile|\.(?:create|update|activate)Profile\(/u);
    }
  });
});
