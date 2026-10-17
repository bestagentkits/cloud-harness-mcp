import { describe, expect, it } from 'vitest';
import {
  AgentModelProfileMetadataSchema,
  MetadataRunnerRequestSchema,
  ModelConnectionVerifyInputSchema,
  ModelConnectionVerifyResultSchema,
  ModelLastVerificationSchema,
  ProviderCredentialMetadataSchema
} from '../src/index.js';

const credentialId = 'cred_12345678901234567890';
const revisionId = 'rev_12345678901234567890';

describe('model connection verification contracts', () => {
  it('accepts a saved profile or a draft, but not both or neither', () => {
    expect(ModelConnectionVerifyInputSchema.parse({ profileId: 'coding-fast' })).toEqual({ profileId: 'coding-fast' });
    expect(ModelConnectionVerifyInputSchema.parse({ profileId: 'coding-fast', checks: { tools: true } }).checks).toEqual({ tools: true });
    expect(ModelConnectionVerifyInputSchema.parse({
      credentialId, model: 'gpt-test', apiMode: 'responses', customUpstreamUrl: 'https://llm.example.org/v1/responses', checks: { inference: false }
    })).toMatchObject({ credentialId, apiMode: 'responses' });
    expect(ModelConnectionVerifyInputSchema.parse({ credentialId })).toEqual({ credentialId });

    expect(() => ModelConnectionVerifyInputSchema.parse({ profileId: 'coding-fast', credentialId })).toThrow();
    expect(() => ModelConnectionVerifyInputSchema.parse({})).toThrow();
    expect(() => ModelConnectionVerifyInputSchema.parse({ credentialId: 'not-a-credential' })).toThrow();
    expect(() => ModelConnectionVerifyInputSchema.parse({ credentialId, apiMode: 'completions' })).toThrow();
    expect(() => ModelConnectionVerifyInputSchema.parse({ credentialId, checks: { stream: true } })).toThrow();
    expect(() => ModelConnectionVerifyInputSchema.parse({ credentialId, apiKey: 'sk-should-not-be-accepted' })).toThrow();
  });

  it('is a registered metadata operation', () => {
    const request = MetadataRunnerRequestSchema.parse({
      version: 2, principal: { kind: 'owner', ownerId: 'owner' }, operation: 'model_connection_verify', input: { credentialId }
    });
    expect(request.operation).toBe('model_connection_verify');
  });

  it('validates a result with bounded, typed checks', () => {
    const result = {
      outcome: 'limited', checkedAt: 1, elapsedMs: 20, provider: 'openai', model: 'gpt-test', apiMode: 'chat-completions',
      checks: [
        { name: 'authentication', outcome: 'verified', elapsedMs: 5 },
        { name: 'streaming_inference', outcome: 'limited', elapsedMs: 9, errorCategory: 'rate_limited', httpStatus: 429, message: 'slow down' }
      ],
      usage: { inputTokens: 1, outputTokens: 1 },
      estimatedCostMicros: null
    };
    expect(ModelConnectionVerifyResultSchema.parse(result)).toEqual(result);
    expect(() => ModelConnectionVerifyResultSchema.parse({ ...result, outcome: 'ok' })).toThrow();
    expect(() => ModelConnectionVerifyResultSchema.parse({
      ...result, checks: [{ name: 'authentication', outcome: 'failed', elapsedMs: 1, message: 'x'.repeat(301) }]
    })).toThrow();
    expect(() => ModelConnectionVerifyResultSchema.parse({
      ...result, checks: [{ name: 'authentication', outcome: 'failed', elapsedMs: 1, errorCategory: 'mystery' }]
    })).toThrow();
    expect(() => ModelConnectionVerifyResultSchema.parse({ ...result, secret: 'x' })).toThrow();
  });

  it('adds lastVerification as an optional field to credential and profile metadata', () => {
    const lastVerification = { outcome: 'verified', checkedAt: 2, revisionId: null };
    expect(ModelLastVerificationSchema.parse(lastVerification)).toEqual(lastVerification);
    const credential = {
      id: credentialId, principalId: 'p', label: 'k', provider: 'openai', authMode: 'bearer', activeVersion: 1,
      status: 'ACTIVE', syncStatus: 'SYNCED', createdAt: 1, updatedAt: 1
    };
    expect(ProviderCredentialMetadataSchema.parse(credential)).toEqual(credential);
    expect(ProviderCredentialMetadataSchema.parse({ ...credential, lastVerification })).toMatchObject({ lastVerification });
    const profile = {
      id: 'coding-fast', principalId: 'p', displayName: 'Fast', credentialId, desiredRevisionId: revisionId, activeRevisionId: revisionId,
      generation: 1, status: 'ACTIVE', activeRevision: null, createdAt: 1, updatedAt: 1
    };
    expect(AgentModelProfileMetadataSchema.parse(profile)).toEqual(profile);
    expect(AgentModelProfileMetadataSchema.parse({ ...profile, lastVerification: { ...lastVerification, revisionId } }).lastVerification?.revisionId).toBe(revisionId);
    expect(() => AgentModelProfileMetadataSchema.parse({ ...profile, lastVerification: { outcome: 'unknown', checkedAt: 1, revisionId: null } })).toThrow();
  });
});
