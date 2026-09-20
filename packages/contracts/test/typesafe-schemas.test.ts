import { describe, expect, it } from 'vitest';
import {
  IntegrationCredentialSchema,
  SkillSuggestInputSchema,
  SkillSuggestResultSchema,
  TYPESAFE_EGRESS_CEILING,
  TypesafeConfigSchema,
  TypesafeEndpointSchema,
  TypesafeStatusSchema
} from '../src/typesafe-schemas.js';

const VALID_ID = `icr_${'a'.repeat(24)}`;
const WORKSPACE_ID = `ws_${'b'.repeat(24)}`;

describe('typesafe endpoint', () => {
  it('accepts an https endpoint and refuses a plaintext or malformed one', () => {
    expect(TypesafeEndpointSchema.safeParse('https://api.typesafe.ai/v1/systemone').success).toBe(true);
    // A plaintext endpoint would send the prompt in the clear, so it is refused by the schema.
    expect(TypesafeEndpointSchema.safeParse('http://api.typesafe.ai/v1/systemone').success).toBe(false);
    expect(TypesafeEndpointSchema.safeParse('not a url').success).toBe(false);
  });
});

describe('typesafe config', () => {
  const base = { endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', enabled: true };

  it('allows the ceiling and refuses anything above it', () => {
    expect(TypesafeConfigSchema.safeParse({ ...base, maxEgressBytes: TYPESAFE_EGRESS_CEILING }).success).toBe(true);
    expect(TypesafeConfigSchema.safeParse({ ...base, maxEgressBytes: TYPESAFE_EGRESS_CEILING + 1 }).success).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(TypesafeConfigSchema.safeParse({ ...base, maxEgressBytes: 4_096, extra: true }).success).toBe(false);
  });
});

describe('skill suggestion input', () => {
  it('bounds the prompt in bytes rather than in characters', () => {
    // Four-byte characters: this prompt is within the ceiling as characters and over it as bytes.
    const fourByte = '😀'.repeat(TYPESAFE_EGRESS_CEILING / 2);
    expect(fourByte.length).toBeLessThanOrEqual(TYPESAFE_EGRESS_CEILING);
    expect(SkillSuggestInputSchema.safeParse({ prompt: fourByte }).success).toBe(false);
    expect(SkillSuggestInputSchema.safeParse({ prompt: 'x'.repeat(TYPESAFE_EGRESS_CEILING) }).success).toBe(true);
  });

  it('rejects an empty prompt and unknown fields', () => {
    expect(SkillSuggestInputSchema.safeParse({ prompt: '' }).success).toBe(false);
    expect(SkillSuggestInputSchema.safeParse({ prompt: 'hello', extra: 1 }).success).toBe(false);
    expect(SkillSuggestInputSchema.safeParse({ prompt: 'hello', workspaceId: WORKSPACE_ID }).success).toBe(true);
  });
});

describe('suggestion result', () => {
  const healthy = {
    suggested: { name: 'tdd', gate: 0.8, fit: 0.7, confidence: 0.56 },
    cached: false,
    latencyMs: 12,
    outboundCalls: 2,
    redactionCount: 0
  };

  it('carries a validated name and its numbers and nothing else', () => {
    expect(SkillSuggestResultSchema.safeParse(healthy).success).toBe(true);
    expect(SkillSuggestResultSchema.safeParse({ suggested: null, reason: 'below_gate', cached: false, latencyMs: 3, outboundCalls: 1, redactionCount: 0 }).success).toBe(true);
  });

  it('refuses model prose and extra fields, so the injection surface cannot carry text', () => {
    expect(SkillSuggestResultSchema.safeParse({ ...healthy, answer: 'model prose' }).success).toBe(false);
    expect(SkillSuggestResultSchema.safeParse({ ...healthy, suggested: { ...healthy.suggested, extra: 1 } }).success).toBe(false);
  });

  it('refuses a score outside the unit interval', () => {
    expect(SkillSuggestResultSchema.safeParse({ ...healthy, suggested: { ...healthy.suggested, gate: 1.4 } }).success).toBe(false);
  });
});

describe('status and credential schemas', () => {
  it('describes status without a key and never carries one', () => {
    const status = { configured: true, enabled: true, endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' };
    expect(TypesafeStatusSchema.safeParse(status).success).toBe(true);
    expect(TypesafeStatusSchema.safeParse({ ...status, apiKey: 'ts_live_key' }).success).toBe(false);
  });

  it('has no value field on a credential, so a value cannot be smuggled into a response', () => {
    const record = {
      id: VALID_ID,
      integration: 'typesafe',
      label: 'TypeSafe',
      status: 'ACTIVE',
      activeVersion: 1,
      generation: 1,
      createdAt: 1,
      updatedAt: 1
    };
    expect(IntegrationCredentialSchema.safeParse(record).success).toBe(true);
    expect(IntegrationCredentialSchema.safeParse({ ...record, value: 'ts_live_key' }).success).toBe(false);
  });
});
