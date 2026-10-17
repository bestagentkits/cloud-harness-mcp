import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelProfileIdSchema, ModelVerificationRefSchema, type AgentModelPriceProvenance, type ModelCredentialId } from '@cloud-harness/contracts';
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
      const edited = repo.updateProfile(p1, created.id, { displayName: 'Renamed', model: 'gpt-5-mini', expectedGeneration: 1 }, {
        priceProvenance: { ...catalogProvenance, source: 'provider', confidence: 'exact' }
      });
      expect(edited.activeRevisionId).not.toBe(created.activeRevisionId);
      expect(edited.activeRevision?.model).toBe('gpt-5-mini');
      expect(edited.activeRevision?.pricing).toEqual(created.activeRevision?.pricing);
      expect(edited.activeRevision?.priceProvenance).toEqual(catalogProvenance);
      expect(edited.activeRevision?.limits).toEqual(created.activeRevision?.limits);
      expect(repo.listProfiles(p1)[0]?.activeRevision).toEqual(edited.activeRevision);
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

    it('keeps the legacy digest for legacy-shaped pricing and covers cache prices and tiers when present', () => {
      const { repo, p1 } = setup();
      const cred = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-digest' });
      const legacyInput = { ...pricedProfile(cred.id, 'legacy-shape'), pricing: { inputMicrosPerMillionTokens: 1_250, outputMicrosPerMillionTokens: 10_000 } };
      const legacy = repo.createProfile(p1, legacyInput);
      const fields = {
        profileId: legacyInput.profileId,
        credentialId: legacyInput.credentialId,
        model: legacyInput.model,
        apiMode: legacyInput.apiMode,
        downstreamPath: '/v1/chat/completions',
        upstreamUrl: 'https://api.openai.com/v1/chat/completions',
        pricing: legacyInput.pricing,
        limits: legacyInput.limits,
        maxProxyOperations: legacyInput.maxProxyOperations
      };
      const legacyDigest = `sha256:${createHash('sha256').update(JSON.stringify(fields, Object.keys(fields).sort()), 'utf8').digest('hex')}`;
      expect(legacy.activeRevision?.digest).toBe(legacyDigest);

      const withCache = repo.updateProfile(p1, legacy.id, { pricing: { ...legacyInput.pricing, cacheReadMicrosPerMillionTokens: 125 }, expectedGeneration: 1 });
      const withOtherCache = repo.updateProfile(p1, legacy.id, { pricing: { ...legacyInput.pricing, cacheReadMicrosPerMillionTokens: 126 }, expectedGeneration: 2 });
      const withTiers = repo.updateProfile(p1, legacy.id, { pricing: { ...legacyInput.pricing, tiers }, expectedGeneration: 3 });
      const withOtherTiers = repo.updateProfile(p1, legacy.id, { pricing: { ...legacyInput.pricing, tiers: [{ ...tiers[0]!, minPromptTokens: 128_000 }] }, expectedGeneration: 4 });
      const digests = [legacy, withCache, withOtherCache, withTiers, withOtherTiers].map((profile) => profile.activeRevision?.digest);
      expect(new Set(digests).size).toBe(digests.length);
    });
  });
});
