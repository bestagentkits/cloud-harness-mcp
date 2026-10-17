import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AgentProxyOperationSchema,
  MODEL_TOOL_OPERATIONS,
  MODEL_TOOL_RESULT_SCHEMAS,
  ModelSpendPolicySchema,
  ModelSpendSummarySchema,
  ModelSpendSummaryToolResultSchema,
  RunnerOperationSchema,
  TOOL_SCHEMA_BY_NAME,
  TOOL_SPECS,
  ToolResultSchema,
  isModelToolOperation,
  listModelProviders
} from '../src/index.js';

const CREDENTIAL = `cred_${'a'.repeat(32)}`;
const PRICING = { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 };
const LIMITS = { maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000 };
const CREATE = {
  profileId: 'coding', displayName: 'Coding', credentialId: CREDENTIAL, model: 'gpt-test', apiMode: 'chat-completions',
  pricing: PRICING, limits: LIMITS, maxProxyOperations: ['files_read'], idempotencyKey: 'create-key-0001'
};
const UPDATE = { profileId: 'coding', expectedGeneration: 1, idempotencyKey: 'update-key-0001', displayName: 'Renamed' };

describe('model tool contract', () => {
  it('registers every model tool as a public operation with its annotations', () => {
    const expected = {
      model_provider_list: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
      model_catalog_search: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
      model_connection_verify: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
      model_profile_list: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
      model_profile_validate: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
      model_profile_create: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
      model_profile_update: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
      model_spend_summary: { readOnly: true, destructive: false, idempotent: true, openWorld: false }
    };
    expect([...MODEL_TOOL_OPERATIONS].sort()).toEqual(Object.keys(expected).sort());
    for (const name of MODEL_TOOL_OPERATIONS) {
      expect(RunnerOperationSchema.options, name).toContain(name);
      expect(isModelToolOperation(name), name).toBe(true);
      const spec = TOOL_SPECS.find((candidate) => candidate.name === name);
      expect(spec, name).toMatchObject(expected[name]);
      expect(spec?.title, name).toBeTruthy();
      expect(spec?.description.length, name).toBeGreaterThan(80);
    }
    expect(isModelToolOperation('agent_spawn')).toBe(false);
  });

  it('never lets an agent proxy a model tool', () => {
    for (const name of MODEL_TOOL_OPERATIONS) expect(AgentProxyOperationSchema.options as readonly string[]).not.toContain(name);
  });

  it('exposes no credential, activation, deletion, catalog refresh, or spend-policy tool', () => {
    const forbidden = /^model_(?:credential|spend_policy)_|^model_profile_(?:activate|disable|delete)$|^model_catalog_refresh$|^model_config_status$/;
    for (const name of RunnerOperationSchema.options) expect(name, name).not.toMatch(forbidden);
  });

  it('refuses unknown fields on every model tool and accepts a minimal valid input', () => {
    const valid: Record<typeof MODEL_TOOL_OPERATIONS[number], Record<string, unknown>> = {
      model_provider_list: {},
      model_catalog_search: { provider: 'openrouter' },
      model_connection_verify: { credentialId: CREDENTIAL, model: 'gpt-test' },
      model_profile_list: {},
      model_profile_validate: { action: 'update', profileId: 'coding', expectedGeneration: 1 },
      model_profile_create: CREATE,
      model_profile_update: UPDATE,
      model_spend_summary: {}
    };
    for (const name of MODEL_TOOL_OPERATIONS) {
      expect(() => TOOL_SCHEMA_BY_NAME[name].parse(valid[name]), name).not.toThrow();
      expect(() => TOOL_SCHEMA_BY_NAME[name].parse({ ...valid[name], apiKey: 'sk-should-not-be-accepted' }), name).toThrow();
    }
  });

  it('requires an idempotency key and a positive generation on saves', () => {
    const create = TOOL_SCHEMA_BY_NAME.model_profile_create;
    const update = TOOL_SCHEMA_BY_NAME.model_profile_update;
    expect(() => create.parse({ ...CREATE, idempotencyKey: undefined })).toThrow();
    expect(() => create.parse({ ...CREATE, idempotencyKey: 'short' })).toThrow();
    expect(() => update.parse({ ...UPDATE, idempotencyKey: undefined })).toThrow();
    expect(() => update.parse({ ...UPDATE, expectedGeneration: undefined })).toThrow();
    expect(() => update.parse({ ...UPDATE, expectedGeneration: 0 })).toThrow();
    expect(() => update.parse({ ...UPDATE, profileId: undefined })).toThrow();
    // Status is never set through a save.
    expect(() => update.parse({ ...UPDATE, status: 'ACTIVE' })).toThrow();
    expect(() => create.parse({ ...CREATE, status: 'ACTIVE' })).toThrow();
  });

  it('checks the flat verify and validate inputs against the Dashboard unions', () => {
    const verify = TOOL_SCHEMA_BY_NAME.model_connection_verify;
    expect(verify.parse({ profileId: 'coding', checks: { tools: true } })).toEqual({ profileId: 'coding', checks: { tools: true } });
    expect(() => verify.parse({})).toThrow(/exactly one of profileId/);
    expect(() => verify.parse({ profileId: 'coding', credentialId: CREDENTIAL })).toThrow(/exactly one of profileId/);
    expect(() => verify.parse({ profileId: 'coding', model: 'gpt-test' })).toThrow(/draft route/);

    const validate = TOOL_SCHEMA_BY_NAME.model_profile_validate;
    const { idempotencyKey: _unused, ...createFields } = CREATE;
    void _unused;
    expect(validate.parse({ action: 'create', ...createFields })).toMatchObject({ action: 'create', profileId: 'coding' });
    expect(() => validate.parse({ action: 'update', profileId: 'coding' })).toThrow();
    expect(() => validate.parse({ action: 'create', profileId: 'coding' })).toThrow();
    expect(() => validate.parse({ action: 'delete', profileId: 'coding', expectedGeneration: 1 })).toThrow();
    expect(() => validate.parse({ action: 'create', ...createFields, idempotencyKey: 'create-key-0001' })).toThrow();
  });

  it('publishes every model tool input as one object for MCP clients', () => {
    for (const name of MODEL_TOOL_OPERATIONS) {
      const schema = z.toJSONSchema(TOOL_SCHEMA_BY_NAME[name], { io: 'input' });
      expect(schema.type, name).toBe('object');
      expect(schema.anyOf ?? schema.oneOf, name).toBeUndefined();
      expect(Object.keys(schema.properties ?? {}).length, name).toBeGreaterThan(0);
    }
  });

  it('names no secret-bearing field in any result schema', () => {
    // A provider's apiKeyUrl is the provider's page for creating a key, never a key.
    const allowed = new Set(['apiKeyUrl']);
    const secretLike = /api_?key|secret|ciphertext|password|authorization|bearer|(?:^|[^a-z])token$/i;
    const fieldNames = (schema: unknown, names = new Set<string>()): Set<string> => {
      if (Array.isArray(schema)) for (const entry of schema) fieldNames(entry, names);
      else if (schema && typeof schema === 'object') {
        for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
          if (key === 'properties' && value && typeof value === 'object') for (const name of Object.keys(value)) names.add(name);
          fieldNames(value, names);
        }
      }
      return names;
    };
    for (const name of MODEL_TOOL_OPERATIONS) {
      const names = fieldNames(z.toJSONSchema(MODEL_TOOL_RESULT_SCHEMAS[name], { io: 'output', unrepresentable: 'any' }));
      expect(names.size, name).toBeGreaterThan(0);
      for (const field of names) if (!allowed.has(field)) expect(field, `${name}.${field}`).not.toMatch(secretLike);
    }
  });

  it('describes every registered provider with the strict provider schema', () => {
    expect(() => MODEL_TOOL_RESULT_SCHEMAS.model_provider_list.parse({ providers: listModelProviders(), credentials: [] })).not.toThrow();
  });

  it('only accepts a disabled profile in a create result', () => {
    const profile = {
      id: 'coding', principalId: 'principal', displayName: 'Coding', credentialId: CREDENTIAL, desiredRevisionId: null,
      activeRevisionId: null, generation: 1, status: 'DISABLED', activeRevision: null, createdAt: 1, updatedAt: 1
    };
    const result = MODEL_TOOL_RESULT_SCHEMAS.model_profile_create;
    expect(() => result.parse({ profile, replayed: false, activation: 'dashboard_required' })).not.toThrow();
    expect(() => result.parse({ profile: { ...profile, status: 'ACTIVE' }, replayed: false, activation: 'dashboard_required' })).toThrow();
  });

  it('reuses the spend schemas for the spend summary result so the two cannot drift', () => {
    expect(MODEL_TOOL_RESULT_SCHEMAS.model_spend_summary).toBe(ModelSpendSummaryToolResultSchema);
    expect(ModelSpendSummaryToolResultSchema.shape.summary).toBe(ModelSpendSummarySchema);
    expect(ModelSpendSummaryToolResultSchema.shape.policies.element).toBe(ModelSpendPolicySchema);
  });

  it('carries OWNER_APPROVAL_REQUIRED in the result envelope', () => {
    expect(ToolResultSchema.parse({
      ok: false, message: 'needs approval', truncated: false,
      error: { code: 'OWNER_APPROVAL_REQUIRED', message: 'needs approval', retryable: false, resumeAction: 'dashboard:models' }
    }).error?.code).toBe('OWNER_APPROVAL_REQUIRED');
  });
});
