import { describe, expect, it } from 'vitest';
import {
  AgentModelProfileInputSchema,
  AgentModelProfileMetadataSchema,
  AgentModelProfileRevisionSchema,
  AgentModelProfileUpdateInputSchema,
  GatewayControlAckSchema,
  GatewayControlApplySnapshotSchema,
  GatewayControlDigestSchema,
  ModelConfigStatusSchema,
  ModelCredentialIdSchema,
  ModelPricingReviewSchema,
  ModelProfileIdSchema,
  ModelRevisionIdSchema,
  ProviderCredentialInputSchema,
  ProviderCredentialMetadataSchema,
  ProviderCredentialRotateInputSchema
} from '../src/index.js';

describe('Model Profile & Credential Contracts', () => {
  it('validates provider credential input and rotation schema', () => {
    const valid = ProviderCredentialInputSchema.parse({
      label: 'OpenAI Prod',
      provider: 'openai',
      apiKey: 'sk-1234567890abcdef'
    });
    expect(valid.provider).toBe('openai');
    expect(valid.authMode).toBeUndefined();

    const custom = ProviderCredentialInputSchema.parse({
      label: 'Custom vLLM',
      provider: 'custom',
      authMode: 'x-api-key',
      apiKey: 'secret-custom-token'
    });
    expect(custom.authMode).toBe('x-api-key');

    const rotate = ProviderCredentialRotateInputSchema.parse({
      apiKey: 'sk-new-key-12345',
      expectedGeneration: 2
    });
    expect(rotate.expectedGeneration).toBe(2);

    expect(() => ProviderCredentialInputSchema.parse({ label: '', provider: 'openai', apiKey: 'x' })).toThrow();
  });

  it('validates provider credential metadata output shape', () => {
    const credId = ModelCredentialIdSchema.parse('cred_12345678901234567890');
    const metadata = ProviderCredentialMetadataSchema.parse({
      id: credId,
      principalId: 'p_user_1',
      label: 'OpenAI Test',
      provider: 'openai',
      authMode: 'bearer',
      activeVersion: 1,
      status: 'ACTIVE',
      syncStatus: 'SYNCED',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    expect(metadata.id).toBe(credId);
  });

  it('validates model profile input and revision schemas with proxy tool constraints', () => {
    const profileId = ModelProfileIdSchema.parse('coding-fast');
    const credId = ModelCredentialIdSchema.parse('cred_12345678901234567890');
    const revId = ModelRevisionIdSchema.parse('rev_12345678901234567890');

    const input = AgentModelProfileInputSchema.parse({
      profileId,
      displayName: 'Fast Coding Agent',
      credentialId: credId,
      model: 'gpt-5.2-codex',
      apiMode: 'chat-completions',
      pricing: {
        inputMicrosPerMillionTokens: 1750000,
        outputMicrosPerMillionTokens: 14000000
      },
      limits: {
        maxInputTokens: 200000,
        maxOutputTokens: 32000,
        maxCostMicros: 5000000
      },
      maxProxyOperations: ['files_read', 'grep_search', 'symbols_search']
    });
    expect(input.profileId).toBe('coding-fast');

    const revision = AgentModelProfileRevisionSchema.parse({
      id: revId,
      profileId,
      principalId: 'p_user_1',
      credentialId: credId,
      model: 'gpt-5.2-codex',
      apiMode: 'chat-completions',
      downstreamPath: '/v1/chat/completions',
      upstreamUrl: 'https://api.openai.com/v1/chat/completions',
      pricing: {
        inputMicrosPerMillionTokens: 1750000,
        outputMicrosPerMillionTokens: 14000000
      },
      priceProvenance: { source: 'user', sourceModelId: null, retrievedAt: null, confidence: 'unknown', isOverride: true },
      limits: {
        maxInputTokens: 200000,
        maxOutputTokens: 32000,
        maxCostMicros: 5000000
      },
      maxProxyOperations: ['files_read', 'grep_search'],
      digest: 'sha256:abcdef123456',
      createdAt: Date.now()
    });
    expect(revision.downstreamPath).toBe('/v1/chat/completions');
  });

  it('accepts a catalog price reference but never client-stated provenance', () => {
    const input = {
      profileId: 'coding', displayName: 'Coding', credentialId: `cred_${'a'.repeat(24)}`, model: 'gpt-5', apiMode: 'responses',
      pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 2 },
      limits: { maxInputTokens: 1, maxOutputTokens: 1, maxCostMicros: 1 },
      maxProxyOperations: ['files_read']
    };
    expect(AgentModelProfileInputSchema.parse({ ...input, catalogPriceRef: { sourceModelId: ' openai/gpt-5 ' } }).catalogPriceRef)
      .toEqual({ sourceModelId: 'openai/gpt-5' });
    expect(AgentModelProfileUpdateInputSchema.parse({ expectedGeneration: 1, catalogPriceRef: { sourceModelId: 'openai/gpt-5' } }).catalogPriceRef)
      .toEqual({ sourceModelId: 'openai/gpt-5' });
    for (const ref of [{ sourceModelId: '' }, { sourceModelId: 'x'.repeat(301) }, { sourceModelId: 'openai/gpt-5', confidence: 'exact' }]) {
      expect(AgentModelProfileInputSchema.safeParse({ ...input, catalogPriceRef: ref }).success).toBe(false);
    }
    const provenance = { source: 'openrouter', sourceModelId: 'openai/gpt-5', retrievedAt: 1, confidence: 'exact', isOverride: false };
    expect(AgentModelProfileInputSchema.safeParse({ ...input, priceProvenance: provenance }).success).toBe(false);
    expect(AgentModelProfileUpdateInputSchema.safeParse({ expectedGeneration: 1, priceProvenance: provenance }).success).toBe(false);
  });

  it('describes a repricing review on listed profile metadata', () => {
    const review = {
      state: 'repriced', catalogRetrievedAt: 1_800_000_000_000, isOverride: false, catalogHasConditionalPricing: true,
      changes: [
        { field: 'input', minPromptTokens: null, pinned: 1_000_000, catalog: 1_100_000, percent: 10 },
        { field: 'tier', minPromptTokens: 200_000, pinned: null, catalog: 2_000_000, percent: null }
      ]
    };
    expect(ModelPricingReviewSchema.parse(review)).toEqual(review);
    expect(ModelPricingReviewSchema.safeParse({ ...review, state: 'stale' }).success).toBe(false);
    expect(ModelPricingReviewSchema.safeParse({ ...review, changes: [{ ...review.changes[0], field: 'request' }] }).success).toBe(false);
    // Conditional pricing is a flag, never a change, and the flag is required.
    expect(ModelPricingReviewSchema.safeParse({ ...review, changes: [{ ...review.changes[0], field: 'conditionalPricing' }] }).success).toBe(false);
    expect(ModelPricingReviewSchema.safeParse({ ...review, catalogHasConditionalPricing: undefined }).success).toBe(false);
    const metadata = {
      id: 'coding', principalId: 'p1', displayName: 'Coding', credentialId: `cred_${'a'.repeat(24)}`, desiredRevisionId: null, activeRevisionId: null,
      generation: 1, status: 'ACTIVE', activeRevision: null, createdAt: 1, updatedAt: 1
    };
    expect(AgentModelProfileMetadataSchema.parse(metadata)).not.toHaveProperty('pricingReview');
    expect(AgentModelProfileMetadataSchema.parse({ ...metadata, pricingReview: review }).pricingReview).toEqual(review);
  });

  it('accepts an optional provider session header on a snapshot credential and refuses a malformed one', () => {
    const snapshot = (credential: Record<string, unknown>) => ({
      type: 'apply_snapshot',
      sequence: 1,
      generation: 1,
      credentials: { cred_12345678901234567890: { provider: 'opencode-go', authMode: 'bearer', secret: 'sk-test', ...credential } },
      profiles: {}
    });
    const parsed = GatewayControlApplySnapshotSchema.parse(snapshot({ sessionHeader: 'x-opencode-session' }));
    expect(parsed.credentials.cred_12345678901234567890?.sessionHeader).toBe('x-opencode-session');
    expect(GatewayControlApplySnapshotSchema.parse(snapshot({})).credentials.cred_12345678901234567890).not.toHaveProperty('sessionHeader');
    expect(GatewayControlApplySnapshotSchema.safeParse(snapshot({ sessionHeader: 'X-Session' })).success).toBe(false);
    expect(GatewayControlApplySnapshotSchema.safeParse(snapshot({ sessionHeader: 'x-session\r\nx-evil' })).success).toBe(false);
  });

  it('validates framed control transport messages (apply_snapshot, ack, digest, status)', () => {
    const revId = ModelRevisionIdSchema.parse('rev_12345678901234567890');
    const profileId = ModelProfileIdSchema.parse('coding-fast');

    const snapshot = GatewayControlApplySnapshotSchema.parse({
      type: 'apply_snapshot',
      sequence: 1,
      generation: 1,
      credentials: {
        cred_12345678901234567890: {
          provider: 'openai',
          authMode: 'bearer',
          secret: 'sk-real-secret'
        }
      },
      profiles: {
        rev_12345678901234567890: {
          id: revId,
          profileId,
          principalId: 'p_user_1',
          credentialId: ModelCredentialIdSchema.parse('cred_12345678901234567890'),
          model: 'gpt-5.2-codex',
          apiMode: 'chat-completions',
          downstreamPath: '/v1/chat/completions',
          upstreamUrl: 'https://api.openai.com/v1/chat/completions',
          pricing: { inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000 },
          priceProvenance: { source: 'user', sourceModelId: null, retrievedAt: null, confidence: 'unknown', isOverride: true },
          limits: { maxInputTokens: 1000, maxOutputTokens: 500, maxCostMicros: 10000 },
          maxProxyOperations: ['files_read'],
          digest: 'digest-1',
          createdAt: Date.now()
        }
      }
    });
    expect(snapshot.type).toBe('apply_snapshot');

    const ack = GatewayControlAckSchema.parse({
      type: 'ack',
      sequence: 1,
      generation: 1,
      gatewayBootId: 'boot_123',
      snapshotDigest: 'digest-1',
      activeProfileCount: 1,
      activeCredentialCount: 1
    });
    expect(ack.gatewayBootId).toBe('boot_123');

    const digest = GatewayControlDigestSchema.parse({
      type: 'digest',
      gatewayBootId: 'boot_123',
      snapshotDigest: 'digest-1',
      activeLeaseCount: 0
    });
    expect(digest.activeLeaseCount).toBe(0);

    const status = ModelConfigStatusSchema.parse({
      gatewaySynced: true,
      gatewayBootId: 'boot_123',
      lastSyncTime: Date.now(),
      activeProfileCount: 1,
      activeCredentialCount: 1,
      error: null
    });
    expect(status.gatewaySynced).toBe(true);
    // No successful push yet is null rather than a made-up time.
    expect(ModelConfigStatusSchema.parse({ ...status, gatewaySynced: false, lastSyncTime: null, error: 'model gateway control request failed' }).lastSyncTime).toBeNull();
  });
});
