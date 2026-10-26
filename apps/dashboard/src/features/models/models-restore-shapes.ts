import type { CatalogEntry, PriceProvenance, VerifyResult } from './models-types';

/**
 * Allowlist shapes for the nested objects the profile wizard restores after a reload. A
 * restored object is rebuilt from the listed keys only, each checked against its type, so
 * a field injected into `sessionStorage` (an `apiKey`, a token) is never read back or
 * written again. `null` is accepted wherever a value is.
 */
type Shape = 'string' | 'number' | 'boolean' | readonly [Shape] | { readonly [key: string]: Shape };

function pick(value: unknown, shape: Shape): unknown {
  if (value === null) return null;
  if (shape === 'string' || shape === 'number' || shape === 'boolean') return typeof value === shape ? value : undefined;
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return undefined;
    return value.map((item) => pick(item, shape[0] as Shape)).filter((item) => item !== undefined);
  }
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(shape as Record<string, Shape>)) {
    const picked = pick(source[key], inner);
    if (picked !== undefined) result[key] = picked;
  }
  return result;
}

const PROVENANCE = { source: 'string', sourceModelId: 'string', retrievedAt: 'number', confidence: 'string', isOverride: 'boolean' } as const;
const LEVEL = { inputMicrosPerMillionTokens: 'number', outputMicrosPerMillionTokens: 'number', cacheReadMicrosPerMillionTokens: 'number', cacheWriteMicrosPerMillionTokens: 'number' } as const;
const CATALOG_ENTRY = {
  providerModelId: 'string', displayName: 'string', contextWindow: 'number', availability: 'string',
  capabilities: { tools: 'string', reasoning: 'string', vision: 'string' },
  pricing: { ...LEVEL, provenance: PROVENANCE, tiers: [{ ...LEVEL, minPromptTokens: 'number' }], hasConditionalPricing: 'boolean' }
} as const;
const VERIFY_RESULT = {
  outcome: 'string', checkedAt: 'number', elapsedMs: 'number', verificationRef: 'string',
  checks: [{ name: 'string', outcome: 'string', elapsedMs: 'number', errorCategory: 'string', httpStatus: 'number', message: 'string' }],
  usage: { inputTokens: 'number', outputTokens: 'number' }
} as const;

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function restoreCatalogEntry(value: unknown): CatalogEntry | null {
  const entry = pick(value, CATALOG_ENTRY);
  return isObject(entry) && typeof entry.providerModelId === 'string' ? entry as CatalogEntry : null;
}

export function restoreProvenance(value: unknown): PriceProvenance | null {
  const provenance = pick(value, PROVENANCE);
  return isObject(provenance) && typeof provenance.source === 'string' ? provenance as PriceProvenance : null;
}

export function restoreVerifyResult(value: unknown): VerifyResult | null {
  const result = pick(value, VERIFY_RESULT);
  return isObject(result) && typeof result.outcome === 'string' ? result as VerifyResult : null;
}
