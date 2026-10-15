import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Agent, fetch as undiciFetch } from 'undici';
import type { McpEventCallbackError } from '@cloud-harness/contracts';
import type { GatewayFetchLike } from '../mcp-gateway/redaction.js';
import { createPinnedLookup, validateGatewayEndpoint, type ResolvedAddress } from '../mcp-gateway/url-policy.js';
import { signWebhook } from './webhook-signature.js';

/**
 * Outbound HTTPS for MCP Events callbacks. Runs only in the API process, on its egress network:
 * the runner never dials a callback. Every request re-validates the callback against the public
 * address policy, connects to exactly the addresses that validation returned (so a rebinding
 * resolver cannot answer differently at connect time), refuses redirects, and bounds time and
 * response size. Failures surface as server-generated categories, never response content.
 */

export type WebhookSenderOptions = {
  /** Test seam: replaces DNS resolution for callback hostnames. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Test seam: replaces the undici transport. */
  fetchImpl?: GatewayFetchLike;
  timeoutMs?: number;
};

export type WebhookRequest = {
  url: string;
  webhookId: string;
  subscriptionId: string;
  secrets: readonly string[];
  body: string;
  signal?: AbortSignal;
};

export type WebhookOutcome =
  | { ok: true; status: number; body: Uint8Array }
  | { ok: false; reason: McpEventCallbackError; status?: number };

export type CallbackUrlCheck = { ok: true; url: string } | { ok: false; message: string };

export interface WebhookSender {
  /** Static checks plus a public-address resolution; used to refuse a subscription before storing it. */
  checkUrl(url: string): Promise<CallbackUrlCheck>;
  post(request: WebhookRequest): Promise<WebhookOutcome>;
  /** Signed verification handshake: the endpoint must echo a fresh single-use challenge. */
  verify(request: Omit<WebhookRequest, 'webhookId' | 'body'>): Promise<{ ok: true } | { ok: false; reason: McpEventCallbackError }>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const TLS_CODES = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/u;
const TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT']);

/** The address policy never sees the query (it refuses one for gateway endpoints); fragments stay refused. */
function policyTarget(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

export function parseCallbackUrl(raw: string): CallbackUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: 'delivery.url must be an absolute https URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, message: 'delivery.url must use https' };
  if (url.username !== '' || url.password !== '') return { ok: false, message: 'delivery.url must not embed credentials' };
  if (url.hash !== '') return { ok: false, message: 'delivery.url must not contain a fragment' };
  if (url.href.length > 2_048) return { ok: false, message: 'delivery.url is too long' };
  return { ok: true, url: url.href };
}

function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function categorizeTransportError(error: unknown): McpEventCallbackError {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout';
  const code = errorCode(error);
  if (code && TIMEOUT_CODES.has(code)) return 'timeout';
  if (code && TLS_CODES.test(code)) return 'tls_error';
  return 'connection_refused';
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error as Error); }
    );
  });
}

async function readCapped(response: Response): Promise<Uint8Array | undefined> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > MAX_RESPONSE_BYTES) {
      void reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function createWebhookSender(options: WebhookSenderOptions = {}): WebhookSender {
  const transport = options.fetchImpl ?? (undiciFetch as unknown as GatewayFetchLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const policy = {
    allowInsecureHttp: false,
    allowPrivateEndpoints: false,
    ...(options.resolve ? { resolve: options.resolve } : {})
  };

  const checkUrl = async (raw: string): Promise<CallbackUrlCheck> => {
    const parsed = parseCallbackUrl(raw);
    if (!parsed.ok) return parsed;
    const validation = await validateGatewayEndpoint(policyTarget(new URL(parsed.url)), policy);
    if (!validation.ok) return { ok: false, message: `delivery.url refused: ${validation.error}` };
    return parsed;
  };

  const post = async (request: WebhookRequest): Promise<WebhookOutcome> => {
    const parsed = parseCallbackUrl(request.url);
    if (!parsed.ok) return { ok: false, reason: 'connection_refused' };
    const target = new URL(parsed.url);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    // Re-resolved and re-checked on every attempt: a callback that now points inward is refused.
    // Resolution counts against the same deadline as the request.
    let validation: Awaited<ReturnType<typeof validateGatewayEndpoint>>;
    try {
      validation = await abortable(validateGatewayEndpoint(policyTarget(target), policy), signal);
    } catch (error) {
      return { ok: false, reason: categorizeTransportError(error) };
    }
    if (!validation.ok) return { ok: false, reason: 'connection_refused' };
    const agent = new Agent({ connect: { lookup: createPinnedLookup(validation.addresses) } });
    const timestamp = Math.floor(Date.now() / 1_000);
    try {
      const response = await transport(target.href, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': request.webhookId,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': signWebhook(request.secrets, request.webhookId, timestamp, request.body),
          'x-mcp-subscription-id': request.subscriptionId,
          'user-agent': 'cloud-harness-mcp-events/1'
        },
        body: request.body,
        signal,
        dispatcher: agent,
        // Redirects are returned, never followed, and count as a client error below.
        redirect: 'manual'
      } as RequestInit);
      if (response.status < 200 || response.status >= 300) {
        void response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: response.status >= 500 ? 'http_5xx' : 'http_4xx', status: response.status };
      }
      const body = await readCapped(response);
      return { ok: true, status: response.status, body: body ?? new Uint8Array() };
    } catch (error) {
      return { ok: false, reason: categorizeTransportError(error) };
    } finally {
      void agent.close().catch(() => undefined);
    }
  };

  const verify: WebhookSender['verify'] = async (request) => {
    const challenge = randomBytes(24).toString('base64url');
    const outcome = await post({
      ...request,
      webhookId: `msg_verification_${randomBytes(12).toString('base64url')}`,
      body: JSON.stringify({ type: 'verification', challenge })
    });
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    let echoed: unknown;
    try {
      echoed = (JSON.parse(Buffer.from(outcome.body).toString('utf8')) as { challenge?: unknown }).challenge;
    } catch {
      return { ok: false, reason: 'challenge_failed' };
    }
    if (typeof echoed !== 'string') return { ok: false, reason: 'challenge_failed' };
    const expected = Buffer.from(challenge, 'utf8');
    const actual = Buffer.from(echoed, 'utf8');
    return expected.length === actual.length && timingSafeEqual(expected, actual)
      ? { ok: true }
      : { ok: false, reason: 'challenge_failed' };
  };

  return { checkUrl, post, verify };
}
