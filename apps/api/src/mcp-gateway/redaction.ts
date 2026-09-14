import { createHash } from 'node:crypto';
import { HarnessError, type ErrorCode } from '@cloud-harness/contracts';

/**
 * Redaction and credential scoping for the MCP gateway.
 *
 * One place owns every transformation that keeps a resolved credential out of a
 * log line, an error message, or an outbound request that is not the configured
 * endpoint. Sanitization covers the raw value and its base64, base64url, hex, and
 * percent-encoded forms (upper- and lowercase hex digits) because upstreams and
 * SDKs freely re-encode a token.
 */

export type GatewayFetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type GatewayRedactedError = { code: ErrorCode; message: string };

const MAX_ERROR_CHARS = 500;
const MAX_SANITIZE_CHARS = 8_192;
const MIN_SECRET_CHARS = 4;
const CREDENTIAL_HEADER_LINE = /^(\s*(?:authorization|cookie|set-cookie|x-api-key|proxy-authorization)\s*:\s*).*$/gim;
const SCHEMA_MISMATCH = /output schema|structured content/i;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function readProperty(error: unknown, key: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as Record<string, unknown>)[key];
}

/** Walks `cause` and an SDK error's `data.cause` so a wrapped failure keeps its facts. */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth += 1) {
    chain.push(current);
    const direct = readProperty(current, 'cause');
    const sdkCause = readProperty(readProperty(current, 'data'), 'cause');
    current = direct ?? sdkCause;
  }
  return chain;
}

function findNumber(error: unknown, key: string): number | undefined {
  for (const entry of errorChain(error)) {
    const value = readProperty(entry, key);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function findName(error: unknown, name: string): boolean {
  return errorChain(error).some((entry) => readProperty(entry, 'name') === name);
}

function findStringCode(error: unknown, code: string): boolean {
  return errorChain(error).some((entry) => readProperty(entry, 'code') === code);
}

/** Every message on the error chain, for classifiers that must look through a wrapper. */
export function collectErrorMessages(error: unknown): string[] {
  return errorChain(error).map((entry) => errorMessage(entry));
}

/**
 * Strips every known encoding of a secret and every credential-shaped header line.
 * The text is bounded first so a hostile upstream cannot force unbounded work.
 */
export function sanitizeGatewayText(text: string, secrets: string[] = []): string {
  let output = String(text ?? '').slice(0, MAX_SANITIZE_CHARS);
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_CHARS) continue;
    const encoded = Buffer.from(secret, 'utf8');
    const percent = encodeURIComponent(secret);
    const forms = new Set<string>([
      secret,
      encoded.toString('base64'),
      encoded.toString('base64url'),
      encoded.toString('hex'),
      encoded.toString('hex').toUpperCase(),
      percent,
      percent.toLowerCase()
    ]);
    for (const form of forms) {
      if (form.length < MIN_SECRET_CHARS) continue;
      output = output.split(form).join('[REDACTED_SECRET]');
    }
  }
  return output.replace(CREDENTIAL_HEADER_LINE, '$1[REDACTED]');
}

/**
 * Normalizes any downstream failure into a stable `{ code, message }` pair with no
 * credential material. The message is capped and sanitized even when the code is
 * derived from a typed error.
 */
export function redactGatewayError(error: unknown, secrets: string[] = []): GatewayRedactedError {
  const sanitized = sanitizeGatewayText(errorMessage(error), secrets).slice(0, MAX_ERROR_CHARS);
  if (error instanceof HarnessError) return { code: error.code, message: sanitized };
  if (findName(error, 'AbortError')) return { code: 'CANCELLED', message: 'the downstream call was cancelled' };
  if (findName(error, 'TimeoutError') || findStringCode(error, 'REQUEST_TIMEOUT')) {
    return { code: 'TIMEOUT', message: 'the downstream call timed out' };
  }
  if (SCHEMA_MISMATCH.test(sanitized)) {
    return {
      code: 'EXECUTION_FAILED',
      message: 'the upstream declared a result schema that its response did not satisfy'
    };
  }
  const status = findNumber(error, 'status');
  if (status !== undefined) {
    if (status >= 500 && status <= 599) return { code: 'UNAVAILABLE', message: sanitized };
    if (status >= 400 && status <= 499) return { code: 'INVALID_INPUT', message: sanitized };
  }
  return { code: 'EXECUTION_FAILED', message: sanitized };
}

/**
 * Stable SHA-256 over the sorted resolved header names and values. Used only to key
 * the connection cache; it is a credential-derived value and must never be logged.
 */
export function headerFingerprint(headers: Record<string, string>): string {
  const sorted = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const material = sorted.map(([name, value]) => `${name}\u0000${value}`).join('\u0001');
  return createHash('sha256').update(material).digest('hex');
}

/** True only when `requestUrl` addresses the exact origin and pathname of the endpoint. */
export function isConfiguredEndpoint(requestUrl: string | URL, endpoint: URL): boolean {
  let url: URL;
  try {
    url = typeof requestUrl === 'string' ? new URL(requestUrl) : requestUrl;
  } catch {
    return false;
  }
  return url.origin === endpoint.origin && url.pathname === endpoint.pathname;
}

function mergeHeaders(initHeaders: HeadersInit | undefined, extra: Record<string, string>): Headers {
  const merged = new Headers(initHeaders);
  for (const [name, value] of Object.entries(extra)) merged.set(name, value);
  return merged;
}

/**
 * Wraps a transport fetch so the resolved credential headers are attached only to a
 * request whose origin and pathname equal the configured endpoint's — the MCP
 * requests the server is configured for. A request to any other origin or path goes
 * out without them, which is what keeps a redirect target, an SDK discovery probe,
 * or an OAuth metadata fetch from carrying the credential.
 */
export function guardedFetchOptions(
  endpointUrl: URL,
  headers: Record<string, string>,
  fetcher: GatewayFetchLike
): GatewayFetchLike {
  const hasHeaders = Object.keys(headers).length > 0;
  return async (input, init) => {
    if (!hasHeaders || !isConfiguredEndpoint(input, endpointUrl)) {
      return fetcher(input, init);
    }
    return fetcher(input, { ...init, headers: mergeHeaders(init?.headers, headers) });
  };
}
