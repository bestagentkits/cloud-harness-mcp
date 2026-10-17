import { describe, expect, it } from 'vitest';
import {
  MetadataRunnerOperationSchema,
  MetadataRunnerRequestSchema,
  MODEL_SPEND_LIMIT_MAX_MICROS,
  ModelSpendSummarySchema
} from '../src/index.js';

const policyId = `msp_${'a'.repeat(32)}`;

function request(operation: string, input: unknown) {
  return MetadataRunnerRequestSchema.safeParse({ version: 2, principal: { kind: 'owner', ownerId: 'owner' }, operation, input });
}

describe('model spend operation contracts', () => {
  it('registers the summary, list, set, and delete operations', () => {
    for (const operation of ['model_spend_summary', 'model_spend_policy_list', 'model_spend_policy_set', 'model_spend_policy_delete']) {
      expect(MetadataRunnerOperationSchema.safeParse(operation).success).toBe(true);
    }
    expect(request('model_spend_summary', {}).success).toBe(true);
    expect(request('model_spend_policy_list', {}).success).toBe(true);
    expect(request('model_spend_summary', { principalId: 'other' }).success).toBe(false);
  });

  it('accepts a policy limit from one micro to the maximum and a warning percentage from 1 to 100', () => {
    expect(request('model_spend_policy_set', { period: 'day', limitMicros: 1 }).success).toBe(true);
    expect(request('model_spend_policy_set', { period: 'month', limitMicros: MODEL_SPEND_LIMIT_MAX_MICROS, warnPercent: 100 }).success).toBe(true);
    expect(request('model_spend_policy_set', { policyId, profileId: 'coding-fast', period: 'day', limitMicros: 5, warnPercent: 1, expectedGeneration: 3 }).success).toBe(true);
    for (const input of [
      { period: 'day', limitMicros: 0 },
      { period: 'day', limitMicros: MODEL_SPEND_LIMIT_MAX_MICROS + 1 },
      { period: 'day', limitMicros: 1.5 },
      { period: 'day', limitMicros: 10, warnPercent: 0 },
      { period: 'day', limitMicros: 10, warnPercent: 101 },
      { period: 'week', limitMicros: 10 },
      { limitMicros: 10 },
      { period: 'day', limitMicros: 10, expectedGeneration: 0 },
      { period: 'day', limitMicros: 10, profileId: 'not a profile' },
      { period: 'day', limitMicros: 10, principalId: 'other' }
    ]) {
      expect(request('model_spend_policy_set', input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('updates only when the policy id and its generation are sent together', () => {
    expect(request('model_spend_policy_set', { policyId, period: 'day', limitMicros: 1, expectedGeneration: 1 }).success).toBe(true);
    for (const input of [
      { policyId, period: 'day', limitMicros: 1 },
      { period: 'day', limitMicros: 1, expectedGeneration: 1 },
      { policyId: 'msp_short', period: 'day', limitMicros: 1, expectedGeneration: 1 },
      { policyId: `pol_${'a'.repeat(32)}`, period: 'day', limitMicros: 1, expectedGeneration: 1 }
    ]) {
      expect(request('model_spend_policy_set', input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('deletes only by policy id and a positive generation', () => {
    expect(request('model_spend_policy_delete', { policyId, expectedGeneration: 1 }).success).toBe(true);
    expect(request('model_spend_policy_delete', { policyId, expectedGeneration: 0 }).success).toBe(false);
    expect(request('model_spend_policy_delete', { policyId: 'msp_short', expectedGeneration: 1 }).success).toBe(false);
    expect(request('model_spend_policy_delete', { policyId }).success).toBe(false);
  });

  it('marks every summary as an estimate', () => {
    expect(ModelSpendSummarySchema.safeParse({ isEstimate: true, windows: [] }).success).toBe(true);
    expect(ModelSpendSummarySchema.safeParse({ isEstimate: false, windows: [] }).success).toBe(false);
  });
});
