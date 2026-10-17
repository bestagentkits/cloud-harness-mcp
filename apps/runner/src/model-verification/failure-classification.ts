import type { ModelProviderKind, ModelVerificationErrorCategory, ModelVerificationOutcome } from '@cloud-harness/contracts';
import { ProviderHttpError, redactSecret } from '../model-provider-http.js';

// Maps provider answers onto the verification categories. The mapping follows
// each provider's documented failure statuses: Gemini reports a bad key as 400
// INVALID_ARGUMENT (sometimes 403), OpenRouter and DeepSeek report exhausted
// credit as 402, and an OpenRouter 403 is a key budget limit.

export const MESSAGE_LIMIT = 300;

export interface ClassifiedFailure {
  category: ModelVerificationErrorCategory;
  httpStatus?: number;
  message: string;
}

const QUOTA_TEXT = /insufficient[_ ]quota|insufficient[_ ]balance|insufficient credits|credit|balance|billing|quota|payment/iu;
const INVALID_KEY_TEXT = /api[_ ]?key[_ ]?(not valid|invalid)|invalid[_ ]api[_ ]?key|api_key_invalid|incorrect api key|invalid x-api-key|unauthenticated/iu;
const UNKNOWN_MODEL_TEXT = /model[^.]{0,80}(not found|not exist|does not exist|is not available|unknown|not supported|invalid)|(unknown|invalid|unsupported) model|no endpoints found/iu;
const TOOLS_UNSUPPORTED_TEXT = /tool|function/iu;

/** Categories that never prove a configuration wrong: the connection was only partly provable. */
const LIMITING_CATEGORIES = new Set<ModelVerificationErrorCategory>(['rate_limited', 'quota', 'timeout', 'network', 'upstream']);

export function outcomeForCategory(category: ModelVerificationErrorCategory): ModelVerificationOutcome {
  return LIMITING_CATEGORIES.has(category) ? 'limited' : 'failed';
}

// Provider keys that a provider may echo back in part (for example a masked
// prefix and suffix). They are removed even though the full key is redacted.
const KEY_LIKE = /\b(?:sk|rk|pk)-[A-Za-z0-9_*.-]{6,}|\bAIza[A-Za-z0-9_*-]{8,}|\b[A-Za-z0-9_-]{8,}\*{3,}[A-Za-z0-9_*-]*/gu;

/** Short, single-line, credential-free text for a check result. */
export function sanitizeMessage(text: string, secret: string): string {
  const cleaned = redactSecret(text, secret)
    .replace(KEY_LIKE, '[redacted]')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned.length > MESSAGE_LIMIT ? `${cleaned.slice(0, MESSAGE_LIMIT - 1)}…` : cleaned;
}

/** The provider's own error text, when the body carries one of the common error shapes. */
export function providerErrorText(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const error = record.error;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
      const nested = error as Record<string, unknown>;
      const parts = [nested.status, nested.code, nested.type, nested.message].filter((part): part is string => typeof part === 'string');
      if (parts.length > 0) return parts.join(': ');
    }
    if (typeof record.message === 'string') return record.message;
  }
  return undefined;
}

/** Classifies a non-2xx provider answer. */
export function classifyHttpFailure(provider: ModelProviderKind, status: number, body: string, secret: string): ClassifiedFailure {
  const detail = providerErrorText(body) ?? '';
  const text = `${detail} ${body.slice(0, 2_000)}`;
  const withDetail = (fallback: string) => sanitizeMessage(detail ? `${fallback}: ${detail}` : fallback, secret);
  // A rejected key gets fixed wording: providers sometimes echo a masked key in that answer.
  const auth = (): ClassifiedFailure => ({ category: 'auth', httpStatus: status, message: 'The provider rejected the API key.' });
  if (status === 401) return auth();
  if (status === 403) {
    if (provider === 'google' && INVALID_KEY_TEXT.test(text)) return auth();
    if (provider === 'openrouter' && QUOTA_TEXT.test(text)) return { category: 'quota', httpStatus: status, message: withDetail('The key reached its spending limit') };
    return { category: 'access', httpStatus: status, message: withDetail('The key is not allowed to use this resource') };
  }
  if (status === 400) {
    if (INVALID_KEY_TEXT.test(text)) return auth();
    if (/insufficient[_ ]quota|insufficient[_ ]balance|insufficient credits/iu.test(text)) {
      return { category: 'quota', httpStatus: status, message: withDetail('The account has no remaining credit') };
    }
    if (UNKNOWN_MODEL_TEXT.test(text)) return { category: 'not_found', httpStatus: status, message: withDetail('The provider does not recognize this model') };
    return { category: 'unsupported_protocol', httpStatus: status, message: withDetail('The provider rejected the request format') };
  }
  if (status === 404) return { category: 'not_found', httpStatus: status, message: withDetail('The provider answered not found') };
  if (status === 402) return { category: 'quota', httpStatus: status, message: withDetail('The account has no remaining credit') };
  if (status === 408) return { category: 'timeout', httpStatus: status, message: withDetail('The provider timed out') };
  if (status === 429) {
    if (/insufficient[_ ]quota|credits|balance|billing/iu.test(text)) {
      return { category: 'quota', httpStatus: status, message: withDetail('The account quota is exhausted') };
    }
    return { category: 'rate_limited', httpStatus: status, message: withDetail('The provider rate limited the check') };
  }
  const failure: ClassifiedFailure = { category: 'upstream', message: withDetail(`The provider answered HTTP ${status}`) };
  if (status >= 100 && status <= 599) failure.httpStatus = status;
  return failure;
}

/** Classifies a transport failure raised by the provider HTTP client. */
export function classifyTransportFailure(error: unknown, secret: string): ClassifiedFailure {
  if (error instanceof ProviderHttpError) {
    return { category: error.kind, message: sanitizeMessage(error.message, secret) };
  }
  return { category: 'network', message: 'The provider request failed.' };
}

/**
 * Whether a refused tool-call request is the provider or model declining tools rather than a key or
 * model problem. OpenRouter answers 404 "no endpoints found that support tool use"; others answer 400.
 */
export function isToolsUnsupported(failure: ClassifiedFailure, body: string): boolean {
  return (failure.httpStatus === 400 || failure.httpStatus === 404) && failure.category !== 'auth' && TOOLS_UNSUPPORTED_TEXT.test(body);
}
