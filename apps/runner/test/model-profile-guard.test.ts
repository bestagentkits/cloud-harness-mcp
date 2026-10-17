import { describe, expect, it } from 'vitest';
import {
  DEFAULT_USER_PRICE_PROVENANCE,
  type AgentModelPriceProvenance,
  type AgentModelProfileMetadata,
  type ModelProviderKind
} from '@cloud-harness/contracts';
import {
  customUpstreamBound,
  profileAuditDetails,
  profileChangeRefusedDetails,
  profileEscalations,
  type GuardedRevision
} from '../src/model-profile-guard.js';

const CATALOG: AgentModelPriceProvenance = { source: 'openrouter', sourceModelId: 'vendor/model', retrievedAt: 1, confidence: 'exact', isOverride: false };
const PROVIDER_CATALOG: AgentModelPriceProvenance = { ...CATALOG, source: 'provider' };
const CUSTOM_URL = 'https://llm.example.org/v1/chat/completions';

function revision(overrides: Partial<GuardedRevision> = {}): GuardedRevision {
  return {
    credentialId: 'cred_00000000000000000000000000000001',
    model: 'vendor/model',
    upstreamUrl: 'https://api.openai.com/v1/chat/completions',
    pricing: { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 },
    priceProvenance: DEFAULT_USER_PRICE_PROVENANCE,
    limits: { maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000 },
    maxProxyOperations: ['files_read', 'grep_search'],
    ...overrides
  };
}

const escalations = (next: GuardedRevision, current: GuardedRevision | null = revision(), provider: ModelProviderKind = 'openai', bound: string[] = []) =>
  profileEscalations({ current, next, provider, boundCustomUrls: bound });

describe('profile escalation classifier', () => {
  it('reports nothing for an unchanged revision', () => {
    expect(escalations(revision())).toEqual([]);
  });

  it('flags a raised limit on any field, and never an equal or lower one', () => {
    const base = revision().limits;
    expect(escalations(revision({ limits: { ...base } }))).toEqual([]);
    expect(escalations(revision({ limits: { ...base, maxInputTokens: base.maxInputTokens - 1 } }))).toEqual([]);
    for (const key of ['maxInputTokens', 'maxOutputTokens', 'maxCostMicros'] as const) {
      expect(escalations(revision({ limits: { ...base, [key]: base[key] + 1 } })), key).toEqual(['limits_raised']);
    }
  });

  it('flags a price lowered by one micro and never an equal or higher one', () => {
    const base = revision().pricing;
    expect(escalations(revision({ pricing: { ...base } }))).toEqual([]);
    expect(escalations(revision({ pricing: { ...base, outputMicrosPerMillionTokens: base.outputMicrosPerMillionTokens + 1 } }))).toEqual([]);
    expect(escalations(revision({ pricing: { ...base, inputMicrosPerMillionTokens: base.inputMicrosPerMillionTokens - 1 } }))).toEqual(['price_lowered']);
    expect(escalations(revision({ pricing: { ...base, outputMicrosPerMillionTokens: base.outputMicrosPerMillionTokens - 1 } }))).toEqual(['price_lowered']);
  });

  it('compares cache prices after unknown ones resolve to their defaults for the provider', () => {
    const base = revision().pricing;
    // An unknown cache read costs the input price, so stating it at that price changes nothing.
    expect(escalations(revision({ pricing: { ...base, cacheReadMicrosPerMillionTokens: base.inputMicrosPerMillionTokens } }))).toEqual([]);
    expect(escalations(revision({ pricing: { ...base, cacheReadMicrosPerMillionTokens: base.inputMicrosPerMillionTokens - 1 } }))).toEqual(['price_lowered']);
    // OpenRouter bills cache writes, so an unknown write costs twice the input price; stating less lowers it.
    expect(escalations(revision({ pricing: { ...base, cacheWriteMicrosPerMillionTokens: base.inputMicrosPerMillionTokens * 2 } }), revision(), 'openrouter')).toEqual([]);
    expect(escalations(revision({ pricing: { ...base, cacheWriteMicrosPerMillionTokens: base.inputMicrosPerMillionTokens } }), revision(), 'openrouter')).toEqual(['price_lowered']);
    // Forgetting a stated cache price never lowers it below the resolved default.
    const stated = revision({ pricing: { ...base, cacheReadMicrosPerMillionTokens: 300_000 } });
    expect(escalations(revision(), stated)).toEqual([]);
  });

  it('flags a lowered or dropped tier, compared at every tier threshold', () => {
    const tier = { minPromptTokens: 200_000, inputMicrosPerMillionTokens: 6_000_000, outputMicrosPerMillionTokens: 22_500_000 };
    const tiered = revision({ pricing: { ...revision().pricing, tiers: [tier] } });
    expect(escalations(tiered, tiered)).toEqual([]);
    expect(escalations(revision({ pricing: { ...tiered.pricing, tiers: [{ ...tier, outputMicrosPerMillionTokens: 22_499_999 }] } }), tiered)).toEqual(['price_lowered']);
    expect(escalations(revision(), tiered)).toEqual(['price_lowered']);
    // Moving a tier to a higher threshold lowers the price of prompts in between.
    expect(escalations(revision({ pricing: { ...tiered.pricing, tiers: [{ ...tier, minPromptTokens: 300_000 }] } }), tiered)).toEqual(['price_lowered']);
    // Adding a tier only raises long prompts.
    expect(escalations(tiered, revision())).toEqual([]);
  });

  it('allows a lower price that the runner matched against a catalog', () => {
    const lower = { ...revision().pricing, inputMicrosPerMillionTokens: 1 };
    expect(escalations(revision({ pricing: lower, priceProvenance: CATALOG }))).toEqual([]);
    expect(escalations(revision({ pricing: lower, priceProvenance: PROVIDER_CATALOG }))).toEqual([]);
    expect(escalations(revision({ pricing: lower, priceProvenance: { ...CATALOG, isOverride: true } }))).toEqual(['price_lowered']);
    expect(escalations(revision({ pricing: lower, priceProvenance: { ...DEFAULT_USER_PRICE_PROVENANCE, isOverride: false } }))).toEqual(['price_lowered']);
  });

  it('flags override prices carried to another model or credential, and not catalog ones', () => {
    expect(escalations(revision({ model: 'vendor/other' }))).toEqual(['price_unverified_for_new_route']);
    expect(escalations(revision({ credentialId: 'cred_00000000000000000000000000000002' }))).toEqual(['price_unverified_for_new_route']);
    expect(escalations(revision({ model: 'vendor/other', priceProvenance: CATALOG }))).toEqual([]);
    // Override prices on the same route are the current route's own prices.
    expect(escalations(revision())).toEqual([]);
  });

  it('flags proxy operations outside the current set, and never a subset', () => {
    expect(escalations(revision({ maxProxyOperations: ['files_read'] }))).toEqual([]);
    expect(escalations(revision({ maxProxyOperations: ['grep_search', 'files_read'] }))).toEqual([]);
    expect(escalations(revision({ maxProxyOperations: ['files_read', 'grep_search', 'files_list'] }))).toEqual(['proxy_operations_widened']);
  });

  it('flags a custom upstream no revision on the credential uses yet', () => {
    const custom = revision({ upstreamUrl: CUSTOM_URL });
    expect(escalations(custom, custom, 'custom', [CUSTOM_URL])).toEqual([]);
    expect(escalations(custom, custom, 'custom', [])).toEqual(['custom_upstream_unbound']);
    // Bound URLs are collected per credential, so another credential's URL is not in the list.
    expect(escalations(custom, custom, 'custom', ['https://other.example.org/v1/chat/completions'])).toEqual(['custom_upstream_unbound']);
    // Registry providers have fixed hosts and are never unbound.
    expect(escalations(revision(), revision(), 'openai', [])).toEqual([]);
    expect(customUpstreamBound(CUSTOM_URL, new Set([CUSTOM_URL]))).toBe(true);
    expect(customUpstreamBound(`${CUSTOM_URL}2`, [CUSTOM_URL])).toBe(false);
  });

  it('applies only the custom upstream rule to a create', () => {
    const generous = revision({
      upstreamUrl: CUSTOM_URL, model: 'vendor/other', limits: { maxInputTokens: 1e9, maxOutputTokens: 1e9, maxCostMicros: 1e12 },
      maxProxyOperations: ['files_read', 'files_list', 'grep_search']
    });
    expect(escalations(generous, null, 'openai')).toEqual([]);
    expect(escalations(generous, null, 'custom')).toEqual(['custom_upstream_unbound']);
  });

  it('returns every escalation sorted and once', () => {
    const next = revision({
      model: 'vendor/other', upstreamUrl: CUSTOM_URL,
      pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 },
      limits: { maxInputTokens: 20_000, maxOutputTokens: 4_000, maxCostMicros: 2_000_000 },
      maxProxyOperations: ['files_read', 'files_list']
    });
    expect(escalations(next, revision(), 'custom')).toEqual([
      'custom_upstream_unbound', 'limits_raised', 'price_lowered', 'price_unverified_for_new_route', 'proxy_operations_widened'
    ]);
  });
});

describe('profile audit details', () => {
  const SENTINEL = 'sk-sentinel-never-recorded-0123456789';
  const profile = (provider: ModelProviderKind, upstreamUrl: string): Pick<AgentModelProfileMetadata, 'credentialId' | 'status' | 'activeRevision'> => ({
    credentialId: 'cred_00000000000000000000000000000001' as AgentModelProfileMetadata['credentialId'],
    status: 'ACTIVE',
    activeRevision: {
      ...revision({ upstreamUrl }),
      id: 'rev_00000000000000000000000000000001',
      profileId: 'coding',
      principalId: 'principal',
      apiMode: 'chat-completions',
      downstreamPath: '/v1/chat/completions',
      digest: `sha256:${SENTINEL}`,
      createdAt: 1,
      maxProxyOperations: ['files_read']
    } as AgentModelProfileMetadata['activeRevision']
  });

  it('records the actor, route, limits, and price source, never prices, paths, or keys', () => {
    const details = profileAuditDetails(profile('openai', 'https://api.openai.com/v1/chat/completions'), 'openai', 'dashboard');
    expect(details).toEqual({
      actor: 'dashboard', status: 'ACTIVE', credentialId: 'cred_00000000000000000000000000000001', provider: 'openai',
      revisionId: 'rev_00000000000000000000000000000001', model: 'vendor/model', apiMode: 'chat-completions',
      maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000, priceSource: 'user', isOverride: true
    });
    expect(JSON.stringify(details)).not.toContain(SENTINEL);
  });

  it('names a custom upstream by its host only', () => {
    const details = profileAuditDetails(profile('custom', `https://llm.example.org/v1/${SENTINEL}/chat/completions`), 'custom', 'mcp');
    expect(details).toMatchObject({ actor: 'mcp', provider: 'custom', upstreamHost: 'llm.example.org' });
    expect(JSON.stringify(details)).not.toContain(SENTINEL);
    expect(JSON.stringify(details)).not.toContain('/v1/');
  });

  it('joins refused escalations into one flat detail', () => {
    expect(profileChangeRefusedDetails('mcp', 'update', ['limits_raised', 'price_lowered'])).toEqual({
      actor: 'mcp', attempted: 'update', escalations: 'limits_raised,price_lowered'
    });
  });
});
