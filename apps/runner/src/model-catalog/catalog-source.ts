import type { ModelCatalogSourceError } from '@cloud-harness/contracts';
import { ProviderHttpError, type ProviderHttpResponse } from '../model-provider-http.js';

/**
 * A catalog source failure reduced to its category. The message is fixed text
 * per category, so neither provider response bodies nor credentials can reach a
 * log line or a dashboard result through it.
 */
export class CatalogSourceError extends Error {
  constructor(public readonly category: ModelCatalogSourceError) {
    super(`model catalog source failed: ${category}`);
    this.name = 'CatalogSourceError';
  }
}

export function catalogErrorFromHttp(error: unknown): CatalogSourceError {
  if (error instanceof CatalogSourceError) return error;
  if (error instanceof ProviderHttpError) return new CatalogSourceError(error.kind);
  return new CatalogSourceError('network');
}

/** Maps a provider status to a category; a 2xx with a complete body passes. */
export function assertCatalogResponse(response: ProviderHttpResponse, authenticationStatuses: readonly number[] = [401, 403]): void {
  if (authenticationStatuses.includes(response.status)) throw new CatalogSourceError('authentication');
  if (response.status === 429) throw new CatalogSourceError('rate_limited');
  if (response.status < 200 || response.status >= 300) throw new CatalogSourceError('upstream_error');
  if (response.truncated) throw new CatalogSourceError('invalid_response');
}

export function parseCatalogJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new CatalogSourceError('invalid_response');
  }
}

/** Provider strings are bounded before they are stored or returned. */
export function boundedText(value: unknown, max = 300): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

export function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

// Bounds on what one source may contribute; a real catalog is far smaller.
export const MAX_CATALOG_MODELS = 5_000;
export const MAX_MODEL_ID_LENGTH = 300;
