import { describe, expect, it } from 'vitest';
import {
  MEDIA_PART_RESERVE_TOKENS,
  ModelRequestError,
  pricesForPrompt,
  reconcileBudget,
  reserveBudget,
  settleFailedRequest,
  usageFromProvider
} from '../src/budget.js';
import { parsePricing } from '../src/config.js';
import { createLeaseGrant, LeaseRegistry } from '../src/lease-registry.js';
import { normalizeProviderUsage } from '../src/usage-normalizer.js';
import type { GatewayProfile, LeaseGrant, PriceTier, Usage } from '../src/types.js';

const AGENT_ID = 'agent_0123456789abcdefghij';

// 2 micros per input token, 8 per output token, 0.5 per cache read, 4 per cache write.
function profile(overrides: Partial<GatewayProfile> = {}): GatewayProfile {
  return {
    id: 'accounting-test',
    provider: 'custom',
    model: 'fixed-model',
    downstreamPath: '/v1/chat/completions',
    upstream: new URL('https://llm.example.net/v1/chat/completions'),
    credentialFile: '/dev/null',
    credentialHeader: 'authorization',
    credentialScheme: 'Bearer',
    inputMicrosPerMillionTokens: 2_000_000,
    outputMicrosPerMillionTokens: 8_000_000,
    cacheReadMicrosPerMillionTokens: 500_000,
    cacheWriteMicrosPerMillionTokens: 4_000_000,
    limits: {
      maxRequestBytes: 4_194_304,
      maxResponseBytes: 1_048_576,
      maxHeaderBytes: 8_192,
      maxHeaders: 24,
      deadlineMs: 5_000,
      maxInputTokens: 400_000,
      maxOutputTokens: 4_096,
      maxCostMicros: 100_000_000,
      maxStreamLineBytes: 65_536
    },
    testOnly: true,
    allowPrivateUpstream: true,
    ...overrides
  };
}

function lease(costMicros = 10_000_000, inputTokens = 400_000, outputTokens = 4_096): LeaseGrant {
  return createLeaseGrant({ agentId: AGENT_ID, profileId: 'accounting-test', expiresAt: Date.now() + 60_000, inputTokens, outputTokens, costMicros });
}

function usage(fields: Record<string, unknown>): unknown {
  return { choices: [], usage: fields };
}

describe('provider usage normalisation', () => {
  it('prices OpenAI chat cached and reasoning detail, with reasoning inside the output total', () => {
    expect(usageFromProvider(usage({
      prompt_tokens: 1_000,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 600 },
      completion_tokens_details: { reasoning_tokens: 50 }
    }), profile())).toEqual({
      // 400 uncached x 2 + 600 read x 0.5 + 200 output x 8
      inputTokens: 1_000, cacheReadTokens: 600, cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 50, costMicros: 2_700
    });
  });

  it('prices OpenRouter cache writes and uses the reported cost only as a floor', () => {
    const base = {
      prompt_tokens: 1_000,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 }
    };
    // 300 uncached x 2 + 600 x 0.5 + 100 x 4 + 1600 output
    expect(usageFromProvider(usage({ ...base, cost: 0.001 }), profile())).toMatchObject({ cacheWriteTokens: 100, costMicros: 2_900 });
    expect(usageFromProvider(usage({ ...base, cost: 0.01 }), profile())).toMatchObject({ costMicros: 10_000 });
    expect(usageFromProvider(usage({ ...base, cost: 0.1 }), profile())).toMatchObject({ costMicros: 100_000 });
  });

  it('reads Responses usage at the top level and nested under response.usage', () => {
    const fields = {
      input_tokens: 1_000,
      input_tokens_details: { cached_tokens: 600 },
      output_tokens: 200,
      output_tokens_details: { reasoning_tokens: 150 }
    };
    const expected = { inputTokens: 1_000, cacheReadTokens: 600, cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 150, costMicros: 2_700 };
    expect(usageFromProvider({ usage: fields }, profile())).toEqual(expected);
    expect(usageFromProvider({ type: 'response.completed', response: { id: 'resp_1', usage: fields } }, profile())).toEqual(expected);
    expect(usageFromProvider({ type: 'response.created', response: { id: 'resp_1', usage: null } }, profile())).toBeUndefined();
  });

  it('reads DeepSeek cache hits when the OpenAI-style detail is absent', () => {
    expect(usageFromProvider(usage({
      prompt_tokens: 1_000, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400, completion_tokens: 200
    }), profile())).toMatchObject({ inputTokens: 1_000, cacheReadTokens: 600, costMicros: 2_700 });
    expect(usageFromProvider(usage({
      prompt_tokens: 1_000, prompt_cache_hit_tokens: 600, prompt_tokens_details: { cached_tokens: 500 }, completion_tokens: 200
    }), profile())).toMatchObject({ cacheReadTokens: 500 });
  });

  it('treats Anthropic native cache names as additive to input_tokens', () => {
    expect(usageFromProvider(usage({
      input_tokens: 400, cache_read_input_tokens: 600, cache_creation_input_tokens: 100, output_tokens: 200
    }), profile())).toEqual({
      // 400 x 2 + 600 x 0.5 + 100 x 4 + 200 x 8
      inputTokens: 1_100, cacheReadTokens: 600, cacheWriteTokens: 100, outputTokens: 200, reasoningTokens: 0, costMicros: 3_100
    });
  });

  it('charges the larger interpretation when Anthropic cache names appear next to prompt_tokens', () => {
    // Inclusive: 400 x 2 + 600 x 0.5 + 1600 = 2700. Additive: 1000 x 2 + 600 x 0.5 + 1600 = 3900.
    expect(usageFromProvider(usage({ prompt_tokens: 1_000, cache_read_input_tokens: 600, completion_tokens: 200 }), profile()))
      .toMatchObject({ inputTokens: 1_600, cacheReadTokens: 600, costMicros: 3_900 });
  });

  it('switches to the additive reading when cache reads and writes exceed the prompt total', () => {
    expect(usageFromProvider(usage({
      prompt_tokens: 500, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 200 }
    }), profile())).toMatchObject({
      // 500 x 2 + 400 x 0.5 + 200 x 4 + 10 x 8
      inputTokens: 1_100, costMicros: 2_080
    });
  });

  it('charges reasoning reported separately from output, and output implied by total_tokens', () => {
    expect(usageFromProvider(usage({
      prompt_tokens: 10, completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 300 }
    }), profile())).toMatchObject({ outputTokens: 400, reasoningTokens: 300 });
    expect(usageFromProvider(usage({ prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_500 }), profile()))
      .toMatchObject({ outputTokens: 500 });
  });

  it('keeps the legacy price semantics when no cache prices are configured', () => {
    const flat = profile({ cacheReadMicrosPerMillionTokens: undefined, cacheWriteMicrosPerMillionTokens: undefined });
    expect(usageFromProvider(usage({
      prompt_tokens: 1_000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 }
    }), flat)).toMatchObject({ costMicros: 1_000 * 2 + 200 * 8 });
  });

  it('reports no usage for missing or malformed fields', () => {
    for (const event of [
      undefined, null, 'text', [], {}, { usage: null }, { usage: [] }, { response: { usage: 'x' } },
      usage({ completion_tokens: 1 }),
      usage({ prompt_tokens: 1 }),
      usage({ prompt_tokens: -1, completion_tokens: 1 }),
      usage({ prompt_tokens: 1.5, completion_tokens: 1 }),
      usage({ prompt_tokens: '10', completion_tokens: 1 }),
      usage({ prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: -2 } }),
      usage({ prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: 'cached' }),
      usage({ prompt_tokens: 10, completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 0.5 } }),
      usage({ prompt_tokens: 10, completion_tokens: 1, cost: -0.01 }),
      usage({ prompt_tokens: 10, completion_tokens: 1, cost: '0.01' })
    ]) {
      expect(normalizeProviderUsage(event), JSON.stringify(event)).toBeUndefined();
    }
  });
});

describe('price tiers', () => {
  const tiers: PriceTier[] = [
    { minPromptTokens: 1_000, inputMicrosPerMillionTokens: 4_000_000, outputMicrosPerMillionTokens: 16_000_000, cacheReadMicrosPerMillionTokens: 1_000_000, cacheWriteMicrosPerMillionTokens: 8_000_000 },
    { minPromptTokens: 5_000, inputMicrosPerMillionTokens: 6_000_000, outputMicrosPerMillionTokens: 24_000_000, cacheReadMicrosPerMillionTokens: 1_500_000, cacheWriteMicrosPerMillionTokens: 12_000_000 }
  ];
  const tiered = profile({ tiers });

  it('selects the highest tier whose threshold the prompt total reaches', () => {
    expect(pricesForPrompt(tiered, 999).inputMicrosPerMillionTokens).toBe(2_000_000);
    expect(pricesForPrompt(tiered, 1_000).inputMicrosPerMillionTokens).toBe(4_000_000);
    expect(pricesForPrompt(tiered, 4_999).inputMicrosPerMillionTokens).toBe(4_000_000);
    expect(pricesForPrompt(tiered, 5_000).inputMicrosPerMillionTokens).toBe(6_000_000);
    expect(usageFromProvider(usage({ prompt_tokens: 999, completion_tokens: 1 }), tiered)).toMatchObject({ costMicros: 999 * 2 + 8 });
    expect(usageFromProvider(usage({ prompt_tokens: 1_000, completion_tokens: 1 }), tiered)).toMatchObject({ costMicros: 1_000 * 4 + 16 });
    // The tier follows the prompt total, cached tokens included.
    expect(usageFromProvider(usage({
      prompt_tokens: 1_000, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 1_000 }
    }), tiered)).toMatchObject({ costMicros: 1_000 + 16 });
  });

  it('validates tiers and defaults unknown cache prices to the input price', () => {
    const parsed = parsePricing({
      inputMicrosPerMillionTokens: 2, outputMicrosPerMillionTokens: 8,
      tiers: [{ minPromptTokens: 10, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 9 }]
    }, 'pricing', { strictKeys: true });
    expect(parsed).toEqual({
      inputMicrosPerMillionTokens: 2, outputMicrosPerMillionTokens: 8,
      tiers: [{ minPromptTokens: 10, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 9, cacheReadMicrosPerMillionTokens: 3, cacheWriteMicrosPerMillionTokens: 3 }]
    });
    const base = { inputMicrosPerMillionTokens: 2, outputMicrosPerMillionTokens: 8 };
    const tier = (minPromptTokens: number, extra: Record<string, unknown> = {}) => ({
      minPromptTokens, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 9, ...extra
    });
    for (const [tierList, message] of [
      [[tier(10), tier(10)], 'strictly ascending'],
      [[tier(20), tier(10)], 'strictly ascending'],
      [[tier(0)], 'minPromptTokens'],
      [[tier(10, { inputMicrosPerMillionTokens: 1 })], 'must not be lower'],
      [[tier(10, { cacheWriteMicrosPerMillionTokens: 4 }), tier(20)], 'must not be lower'],
      [[tier(10), tier(20), tier(30), tier(40), tier(50)], 'at most 4'],
      [[tier(10, { surprise: 1 })], 'unsupported field surprise'],
      [[tier(10, { outputMicrosPerMillionTokens: -1 })], 'outputMicrosPerMillionTokens'],
      ['tiers', 'at most 4']
    ] as const) {
      expect(() => parsePricing({ ...base, tiers: tierList }, 'pricing', { strictKeys: true }), message).toThrow(message);
    }
    expect(() => parsePricing({ ...base, cacheReadMicrosPerMillionTokens: 1.5 }, 'pricing', { strictKeys: true })).toThrow('cacheRead');
    expect(() => parsePricing({ ...base, extra: 1 }, 'pricing', { strictKeys: true })).toThrow('unsupported field extra');
    expect(parsePricing({ extra: 1 }, 'pricing', { strictKeys: false, baseDefault: 0 }))
      .toEqual({ inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 });
  });
});

describe('reservation', () => {
  it('reserves one token per body byte priced at the highest input-side price', () => {
    const grant = lease();
    const body: Record<string, unknown> = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 };
    const reservation = reserveBudget(body, 1_000, grant, profile());
    expect(reservation.inputTokens).toBe(1_000);
    // 1000 tokens at the 4-micro cache-write price, plus 10 output tokens at 8.
    expect(reservation.costMicros).toBe(4_000 + 80);
    expect(grant.remainingCostMicros).toBe(10_000_000 - 4_080);
  });

  it('reserves at the tier the byte estimate falls in', () => {
    const tiered = profile({
      tiers: [{ minPromptTokens: 1_000, inputMicrosPerMillionTokens: 4_000_000, outputMicrosPerMillionTokens: 16_000_000, cacheReadMicrosPerMillionTokens: 1_000_000, cacheWriteMicrosPerMillionTokens: 8_000_000 }]
    });
    expect(reserveBudget({ messages: [], max_tokens: 10 }, 999, lease(), tiered).costMicros).toBe(999 * 4 + 80);
    expect(reserveBudget({ messages: [], max_tokens: 10 }, 1_000, lease(), tiered).costMicros).toBe(1_000 * 8 + 160);
  });

  it('adds a fixed surcharge for every image, file, or audio part, including data URLs', () => {
    const body: Record<string, unknown> = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } },
          { type: 'file', file: { file_data: 'AAAA' } }
        ]
      }],
      max_tokens: 10
    };
    expect(reserveBudget(body, 300, lease(), profile()).inputTokens).toBe(300 + 3 * MEDIA_PART_RESERVE_TOKENS);
    const responses = profile({ downstreamPath: '/v1/responses' });
    const input = { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.net/a.png' }, { type: 'input_file', file_id: 'f' }] }] };
    expect(reserveBudget(input, 200, lease(), responses).inputTokens).toBe(200 + 2 * MEDIA_PART_RESERVE_TOKENS);
  });

  it('refuses stateful Responses fields that pull in unbounded server-side context', () => {
    const responses = profile({ downstreamPath: '/v1/responses' });
    for (const [field, value] of [
      ['previous_response_id', 'resp_123'],
      ['conversation', 'conv_123'],
      ['conversation', { id: 'conv_123' }],
      ['prompt', { id: 'pmpt_123' }]
    ] as const) {
      const grant = lease();
      const call = () => reserveBudget({ input: 'hi', [field]: value }, 100, grant, responses);
      expect(call, field).toThrow(ModelRequestError);
      expect(call, field).toThrow(field === 'prompt' ? 'object-valued prompt' : field);
      expect(grant.remainingCostMicros).toBe(10_000_000);
    }
    expect(() => reserveBudget({ input: 'hi', previous_response_id: null, prompt: 'inline' }, 100, lease(), responses)).not.toThrow();
    // Chat Completions has no such stored context, so the fields are left alone.
    expect(() => reserveBudget({ messages: [], previous_response_id: 'x' }, 100, lease(), profile())).not.toThrow();
  });
});

describe('reconciliation', () => {
  const reported = (fields: Partial<Usage>): Usage => ({
    inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, costMicros: 0, ...fields
  });

  it('charges the reservation when usage is missing', () => {
    const grant = lease();
    const reservation = reserveBudget({ messages: [], max_tokens: 10 }, 100, grant, profile());
    const result = reconcileBudget(reservation, undefined);
    expect(result.charged).toMatchObject({ inputTokens: 100, outputTokens: 10, costMicros: reservation.costMicros });
    expect(result.overrunCostMicros).toBe(0);
    expect(grant.remainingCostMicros).toBe(10_000_000 - reservation.costMicros);
    expect(grant.accounting.requestsWithoutUsage).toBe(1);
  });

  it('refunds at most the reservation', () => {
    const grant = lease();
    const reservation = reserveBudget({ messages: [], max_tokens: 10 }, 100, grant, profile());
    reconcileBudget(reservation, reported({}));
    expect(grant).toMatchObject({ remainingInputTokens: 400_000, remainingOutputTokens: 4_096, remainingCostMicros: 10_000_000 });
  });

  it('takes an overrun from the remaining budget and records it', () => {
    const grant = lease(1_000);
    const reservation = reserveBudget({ messages: [], max_tokens: 10 }, 100, grant, profile());
    expect(reservation.costMicros).toBe(480);
    const result = reconcileBudget(reservation, reported({ inputTokens: 120, outputTokens: 12, costMicros: 700 }));
    expect(result.overrunCostMicros).toBe(220);
    expect(grant.remainingCostMicros).toBe(1_000 - 700);
    expect(grant.accounting).toMatchObject({ overrunCostMicros: 220, unabsorbedOverrunCostMicros: 0, promptTokens: 120, outputTokens: 12 });

    // An overrun beyond what is left floors the budget at 0 and keeps the excess for the settlement.
    const second = reserveBudget({ messages: [], max_tokens: 10 }, 10, grant, profile());
    reconcileBudget(second, reported({ costMicros: second.costMicros + 500 }));
    expect(grant.remainingCostMicros).toBe(0);
    expect(grant.accounting.overrunCostMicros).toBe(720);
    expect(grant.accounting.unabsorbedOverrunCostMicros).toBe(500 - (300 - second.costMicros));
  });

  it('keeps the full reservation for a failed request and adds any reported overrun', () => {
    const grant = lease();
    const reservation = reserveBudget({ messages: [], max_tokens: 10 }, 100, grant, profile());
    settleFailedRequest(reservation, reported({ costMicros: 1 }));
    expect(grant.remainingCostMicros).toBe(10_000_000 - reservation.costMicros);
    const second = reserveBudget({ messages: [], max_tokens: 10 }, 100, grant, profile());
    const result = settleFailedRequest(second, reported({ outputTokens: 50, costMicros: second.costMicros + 300 }));
    expect(result.overrunCostMicros).toBe(300);
    expect(grant.remainingCostMicros).toBe(10_000_000 - 2 * reservation.costMicros - 300);
  });
});

describe('lease settlement', () => {
  function registry(now: { value: number }) {
    return new LeaseRegistry({ now: () => now.value });
  }
  const input = (leaseId: string) => ({
    leaseId, agentId: AGENT_ID, profileId: 'accounting-test', ttlMs: 60_000, maxInputTokens: 400_000, maxOutputTokens: 4_096, maxCostMicros: 1_000
  });

  it('settles a revoked lease from what it consumed, counting failures at their reservation and unabsorbed overrun', () => {
    const now = { value: 1_000 };
    const leases = registry(now);
    const token = leases.issue(input('lease-settle'), profile());
    const grant = leases.consume(token, AGENT_ID, 'accounting-test');
    const completed = reserveBudget({ messages: [], max_tokens: 10 }, 100, grant, profile());
    reconcileBudget(completed, {
      inputTokens: 90, cacheReadTokens: 40, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: 2, costMicros: 200
    });
    const failed = reserveBudget({ messages: [], max_tokens: 10 }, 50, grant, profile());
    settleFailedRequest(failed, undefined);
    const overrun = reserveBudget({ messages: [], max_tokens: 1 }, 10, grant, profile());
    reconcileBudget(overrun, { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, reasoningTokens: 0, costMicros: 1_000 });

    expect(leases.revoke('lease-settle')).toBe(true);
    const settlement = leases.settlementFor('lease-settle');
    expect(settlement).toEqual({
      leaseId: 'lease-settle',
      reason: 'revoked',
      settledAt: 1_000,
      initialInputTokens: 400_000,
      initialOutputTokens: 4_096,
      initialCostMicros: 1_000,
      costMicros: 200 + failed.costMicros + 1_000,
      overrunCostMicros: 1_000 - overrun.costMicros,
      promptTokens: 90 + 50 + 10,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      outputTokens: 5 + 10 + 1,
      reasoningTokens: 2,
      requests: 3,
      requestsWithoutUsage: 1
    });
    // Revoking again is idempotent and returns the same settlement; the lease id cannot be reused meanwhile.
    expect(leases.revoke('lease-settle')).toBe(false);
    expect(leases.settlementFor('lease-settle')).toEqual(settlement);
    expect(() => leases.issue(input('lease-settle'), profile())).toThrow('already registered');
  });

  it('keeps an expired lease settlement for the retention horizon', () => {
    const now = { value: 1_000 };
    const leases = registry(now);
    const token = leases.issue(input('lease-expire'), profile());
    const grant = leases.consume(token, AGENT_ID, 'accounting-test');
    reserveBudget({ messages: [], max_tokens: 10 }, 100, grant, profile());
    now.value += 60_000;
    expect(leases.revoke('lease-expire')).toBe(false);
    expect(leases.settlementFor('lease-expire')).toMatchObject({ reason: 'expired', settledAt: 61_000, costMicros: 480, requests: 1 });
    now.value += 86_400_001;
    expect(leases.settlementFor('lease-expire')).toBeUndefined();
    expect(() => leases.issue(input('lease-expire'), profile())).not.toThrow();
  });

  it('counts retained settlements toward the registry capacity', () => {
    const leases = new LeaseRegistry({ maxEntries: 1 });
    leases.issue(input('lease-cap'), profile());
    leases.revoke('lease-cap');
    expect(leases.settlementFor('lease-cap')).toBeDefined();
    expect(() => leases.issue(input('lease-cap-2'), profile())).toThrow('capacity');
  });
});
