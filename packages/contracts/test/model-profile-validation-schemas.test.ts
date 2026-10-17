import { describe, expect, it } from 'vitest';
import {
  MetadataRunnerRequestSchema,
  ModelProfileEscalationSchema,
  ModelProfileValidateInputSchema,
  ModelProfileValidateResultSchema
} from '../src/index.js';

const createBody = {
  profileId: 'coding',
  displayName: 'Coding',
  credentialId: 'cred_00000000000000000000000000000001',
  model: 'gpt-test',
  apiMode: 'chat-completions',
  pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 2 },
  limits: { maxInputTokens: 10, maxOutputTokens: 10, maxCostMicros: 10 },
  maxProxyOperations: ['files_read']
};

const validResult = {
  valid: true,
  action: 'create',
  profileId: 'coding',
  issues: [],
  revision: {
    credentialId: 'cred_00000000000000000000000000000001',
    provider: 'openai',
    model: 'gpt-test',
    apiMode: 'chat-completions',
    upstreamUrl: 'https://api.openai.com/v1/chat/completions',
    pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 2 },
    priceProvenance: { source: 'user', sourceModelId: null, retrievedAt: null, confidence: 'unknown', isOverride: true },
    limits: { maxInputTokens: 10, maxOutputTokens: 10, maxCostMicros: 10 },
    maxProxyOperations: ['files_read']
  },
  pricingReview: null,
  verificationAttachable: false,
  escalations: [],
  ownerApprovalRequiredOverMcp: false,
  statusAfterSaveOverMcp: 'DISABLED',
  currentGeneration: null
};

describe('model profile validation contracts', () => {
  it('accepts exactly a create or update save body with its action', () => {
    expect(ModelProfileValidateInputSchema.parse({ action: 'create', ...createBody }).action).toBe('create');
    expect(ModelProfileValidateInputSchema.parse({ action: 'update', profileId: 'coding', expectedGeneration: 2, model: 'gpt-other' }))
      .toMatchObject({ action: 'update', profileId: 'coding' });

    // Each branch is strict and carries the save's own requirements.
    expect(ModelProfileValidateInputSchema.safeParse({ action: 'create', ...createBody, extra: true }).success).toBe(false);
    expect(ModelProfileValidateInputSchema.safeParse({ action: 'update', profileId: 'coding' }).success).toBe(false);
    expect(ModelProfileValidateInputSchema.safeParse({ action: 'update', expectedGeneration: 1 }).success).toBe(false);
    expect(ModelProfileValidateInputSchema.safeParse({ action: 'update', profileId: 'coding', expectedGeneration: 1, displayName: 'x', priceProvenance: {} }).success).toBe(false);
    expect(ModelProfileValidateInputSchema.safeParse({ action: 'delete', profileId: 'coding' }).success).toBe(false);
    expect(ModelProfileValidateInputSchema.safeParse(createBody).success).toBe(false);
  });

  it('is an internal metadata operation', () => {
    const request = MetadataRunnerRequestSchema.parse({
      version: 2, principal: { kind: 'owner', ownerId: 'owner' }, operation: 'model_profile_validate', input: { action: 'create', ...createBody }
    });
    expect(request.operation).toBe('model_profile_validate');
  });

  it('keeps the result strict and bounded', () => {
    expect(ModelProfileValidateResultSchema.parse(validResult)).toEqual(validResult);
    expect(ModelProfileValidateResultSchema.safeParse({ ...validResult, secret: 'x' }).success).toBe(false);
    expect(ModelProfileValidateResultSchema.safeParse({ ...validResult, revision: { ...validResult.revision, digest: 'sha256:x' } }).success).toBe(false);
    const issue = { code: 'INVALID_INPUT', message: 'refused' };
    expect(ModelProfileValidateResultSchema.safeParse({ ...validResult, valid: false, revision: null, issues: Array(16).fill(issue) }).success).toBe(true);
    expect(ModelProfileValidateResultSchema.safeParse({ ...validResult, valid: false, revision: null, issues: Array(17).fill(issue) }).success).toBe(false);
    expect(ModelProfileValidateResultSchema.safeParse({ ...validResult, issues: [{ code: 'INTERNAL_ERROR', message: 'x' }] }).success).toBe(false);
    expect(ModelProfileValidateResultSchema.safeParse({ ...validResult, statusAfterSaveOverMcp: 'ACTIVE' }).success).toBe(false);
  });

  it('names every escalation the guard can report', () => {
    expect(ModelProfileEscalationSchema.options).toEqual([
      'custom_upstream_unbound', 'limits_raised', 'price_lowered', 'price_unverified_for_new_route', 'proxy_operations_widened'
    ]);
  });
});
