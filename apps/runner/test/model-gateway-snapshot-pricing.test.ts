import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentModelPricingSchema,
  GatewayControlApplySnapshotSchema,
  MAX_MODEL_PRICE_TIERS,
  ModelProfileIdSchema,
  ModelProviderKindSchema,
  findResolvedPriceTierIssues,
  getModelProvider,
  resolveEffectivePricing,
  type PinnedModelPricing
} from '@cloud-harness/contracts';
import { ModelProfileStateRepository } from '../src/model-profile-state-repository.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore } from '../src/state-store.js';
// The gateway owns snapshot pricing validation; the runner owns what it exports.
// Importing the gateway parser keeps the two bounds from drifting apart.
import { assertSessionHeaderName, parsePricing } from '../../model-gateway/src/config.js';

/** Parses pricing the way the gateway's control client parses a snapshot revision. */
function gatewayParsePricing(pricing: unknown): void {
  parsePricing(pricing, 'pricing', { strictKeys: false, baseDefault: 0 });
}

/** A deterministic PRNG (mulberry32), so a failing case reproduces from its seed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Pricing that passes AgentModelPricingSchema, with cache prices stated, null, or absent at random. */
function randomSchemaValidPricing(random: () => number): PinnedModelPricing {
  const amount = (min: number) => min + Math.floor(random() * 5_000_000);
  const cache = (min: number): number | null | undefined => {
    const pick = random();
    if (pick < 0.3) return undefined;
    if (pick < 0.4) return null;
    // Small stated prices land below the resolved defaults of the level beneath.
    return pick < 0.55 ? min + Math.floor(random() * 3_000) : amount(min);
  };
  const level = (below?: Record<string, number | null | undefined>) => {
    const floor = (key: string) => typeof below?.[key] === 'number' ? below[key] as number : 0;
    const cacheRead = cache(floor('cacheReadMicrosPerMillionTokens'));
    const cacheWrite = cache(floor('cacheWriteMicrosPerMillionTokens'));
    return {
      inputMicrosPerMillionTokens: amount(floor('inputMicrosPerMillionTokens')),
      outputMicrosPerMillionTokens: amount(floor('outputMicrosPerMillionTokens')),
      ...(cacheRead === undefined ? {} : { cacheReadMicrosPerMillionTokens: cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWriteMicrosPerMillionTokens: cacheWrite })
    };
  };
  const pricing: PinnedModelPricing = level();
  const tierCount = Math.floor(random() * (MAX_MODEL_PRICE_TIERS + 1));
  const tiers = [];
  let below: Record<string, number | null | undefined> = pricing;
  let threshold = 0;
  for (let index = 0; index < tierCount; index += 1) {
    threshold += 1 + Math.floor(random() * 2_000_000);
    const tier = { minPromptTokens: threshold, ...level(below) };
    tiers.push(tier);
    below = tier;
  }
  if (tiers.length > 0) pricing.tiers = tiers;
  return pricing;
}


describe('gateway snapshot pricing compatibility', () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    for (const step of cleanup.splice(0)) step();
  });

  it('exports contract-valid extreme prices that the gateway snapshot parser accepts', () => {
    const dbPath = join(tmpdir(), `test-snapshot-pricing-${randomBytes(8).toString('hex')}.sqlite`);
    const store = new StateStore(dbPath);
    cleanup.push(() => {
      store.close();
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
    });
    const repo = new ModelProfileStateRepository(store.database, new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]));
    const principal = store.resolvePrincipal({ kind: 'owner', ownerId: 'user-pricing' });
    const credential = repo.createCredential(principal, { label: 'Pricing', provider: 'openai', apiKey: 'sk-pricing-test-key' });
    const pricing = { inputMicrosPerMillionTokens: Number.MAX_SAFE_INTEGER, outputMicrosPerMillionTokens: 5_000_000_000 };
    const profile = repo.createProfile(principal, {
      profileId: ModelProfileIdSchema.parse('extreme-pricing'),
      displayName: 'Extreme pricing',
      credentialId: credential.id,
      model: 'gpt-5.2',
      apiMode: 'chat-completions',
      pricing,
      limits: { maxInputTokens: 50_000, maxOutputTokens: 2_000, maxCostMicros: 100_000 },
      maxProxyOperations: ['files_read']
    });

    const exported = repo.getExportSnapshot(principal).profiles[profile.activeRevisionId!] as { pricing: unknown };
    // The snapshot carries effective prices: unknown cache prices cost the input price on OpenAI.
    const effective = { ...pricing, cacheReadMicrosPerMillionTokens: Number.MAX_SAFE_INTEGER, cacheWriteMicrosPerMillionTokens: Number.MAX_SAFE_INTEGER };
    expect(exported.pricing).toEqual(effective);
    expect(parsePricing(exported.pricing, 'pricing', { strictKeys: false, baseDefault: 0 })).toEqual(effective);
  });

  it('resolves schema-valid pricing to prices the gateway accepts, for every provider', () => {
    const random = seededRandom(0x5eed_358);
    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      const pricing = AgentModelPricingSchema.parse(randomSchemaValidPricing(random));
      for (const basis of [...ModelProviderKindSchema.options, { billsCacheWrites: false }] as const) {
        const effective = resolveEffectivePricing(pricing, basis);
        expect(() => gatewayParsePricing(effective), `iteration ${iteration}, ${JSON.stringify(basis)}: ${JSON.stringify(pricing)}`).not.toThrow();
        if (findResolvedPriceTierIssues(pricing, basis).length === 0) {
          // Pricing the runner accepts is never raised: every tier keeps its own resolution.
          const billsWrites = typeof basis === 'string' ? getModelProvider(basis).billsCacheWrites : basis.billsCacheWrites;
          (pricing.tiers ?? []).forEach((tier, index) => {
            expect(effective.tiers?.[index]).toEqual({
              minPromptTokens: tier.minPromptTokens,
              inputMicrosPerMillionTokens: tier.inputMicrosPerMillionTokens,
              outputMicrosPerMillionTokens: tier.outputMicrosPerMillionTokens,
              cacheReadMicrosPerMillionTokens: tier.cacheReadMicrosPerMillionTokens ?? tier.inputMicrosPerMillionTokens,
              cacheWriteMicrosPerMillionTokens: tier.cacheWriteMicrosPerMillionTokens
                ?? (billsWrites ? tier.inputMicrosPerMillionTokens * 2 : tier.inputMicrosPerMillionTokens)
            });
          });
        }
      }
    }
  });

  it('exports the provider session header only for a provider that requires one', () => {
    const dbPath = join(tmpdir(), `test-snapshot-session-${randomBytes(8).toString('hex')}.sqlite`);
    const store = new StateStore(dbPath);
    cleanup.push(() => {
      store.close();
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
    });
    const repo = new ModelProfileStateRepository(store.database, new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]));
    const principal = store.resolvePrincipal({ kind: 'owner', ownerId: 'user-session-header' });
    const openCode = repo.createCredential(principal, { label: 'OpenCode Go', provider: 'opencode-go', apiKey: 'sk-opencode-test-key' });
    const openAi = repo.createCredential(principal, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-openai-test-key' });
    const profile = repo.createProfile(principal, {
      profileId: ModelProfileIdSchema.parse('opencode-go-coding'),
      displayName: 'OpenCode Go coding',
      credentialId: openCode.id,
      model: 'kimi-k2.5',
      apiMode: 'chat-completions',
      pricing: { inputMicrosPerMillionTokens: 600_000, outputMicrosPerMillionTokens: 2_500_000 },
      limits: { maxInputTokens: 50_000, maxOutputTokens: 2_000, maxCostMicros: 100_000 },
      maxProxyOperations: ['files_read']
    });

    const snapshot = repo.getExportSnapshot(principal);
    expect(snapshot.credentials[openCode.id]?.sessionHeader).toBe('x-opencode-session');
    expect(snapshot.credentials[openAi.id]).not.toHaveProperty('sessionHeader');
    expect((snapshot.profiles[profile.activeRevisionId!] as { upstreamUrl: string }).upstreamUrl)
      .toBe('https://opencode.ai/inference/go/openai/v1/chat/completions');
    expect(GatewayControlApplySnapshotSchema.safeParse({ type: 'apply_snapshot', sequence: 1, generation: 1, ...snapshot }).success).toBe(true);
    // The gateway validates the exported name with the same rule it applies to its own setting.
    expect(assertSessionHeaderName(snapshot.credentials[openCode.id]!.sessionHeader!, 'sessionHeader')).toBe('x-opencode-session');
  });
});
