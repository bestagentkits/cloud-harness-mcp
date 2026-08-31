import { describe, expect, it } from 'vitest';
import {
  AgentModelProfileInputSchema,
  AgentModelProfileRevisionSchema,
  GatewayControlAckSchema,
  GatewayControlApplySnapshotSchema,
  GatewayControlDigestSchema,
  ModelConfigStatusSchema,
  ModelCredentialIdSchema,
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
      model: 'gpt-5.2-codex',
      apiMode: 'chat-completions',
      downstreamPath: '/v1/chat/completions',
      upstreamUrl: 'https://api.openai.com/v1/chat/completions',
      pricing: {
        inputMicrosPerMillionTokens: 1750000,
        outputMicrosPerMillionTokens: 14000000
      },
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
          model: 'gpt-5.2-codex',
          apiMode: 'chat-completions',
          downstreamPath: '/v1/chat/completions',
          upstreamUrl: 'https://api.openai.com/v1/chat/completions',
          pricing: { inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000 },
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
  });
});
