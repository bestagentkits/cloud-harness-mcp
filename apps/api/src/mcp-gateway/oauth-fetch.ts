import { Agent, fetch as undiciFetch } from 'undici';
import { HarnessError } from '@cloud-harness/contracts';
import type { GatewayFetchLike } from './redaction.js';
import { createPinnedLookup, validateGatewayEndpoint, type GatewayEndpointOptions } from './url-policy.js';

/**
 * Hardened HTTP layer for downstream OAuth traffic (protected-resource and
 * authorization-server discovery, client registration, token exchange, revocation).
 *
 * Every request is validated against the gateway URL policy and pinned to the
 * addresses that validation returned, on its own undici `Agent`, so an OAuth
 * metadata document can never steer a request at an address the policy refuses and a
 * rebinding resolver cannot answer differently at connect time. Redirects are refused,
 * the body is read under a byte and time cap, and no header is added here: static MCP
 * headers are attached only by the endpoint-scoped fetcher and never reach this path.
 */

export type OAuthFetchOptions = GatewayEndpointOptions & {
  timeoutMs: number;
  maxResponseBytes: number;
  fetchImpl?: GatewayFetchLike;
};

export const OAUTH_REDIRECT_ERROR_MESSAGE =
  'OAuth endpoint returned an HTTP redirect; HTTP redirects are refused for OAuth discovery and token traffic';

async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    void response.body?.cancel().catch(() => undefined);
    throw new HarnessError('LIMIT_EXCEEDED', `OAuth response exceeds the ${limit} byte limit`, 413, false);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > limit) {
      void reader.cancel().catch(() => undefined);
      throw new HarnessError('LIMIT_EXCEEDED', `OAuth response exceeds the ${limit} byte limit`, 413, false);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function createOAuthFetch(options: OAuthFetchOptions): GatewayFetchLike {
  const transport = options.fetchImpl ?? (undiciFetch as unknown as GatewayFetchLike);
  const policy: GatewayEndpointOptions = {
    allowInsecureHttp: options.allowInsecureHttp,
    allowPrivateEndpoints: options.allowPrivateEndpoints,
    ...(options.resolve ? { resolve: options.resolve } : {})
  };
  return async (input, init) => {
    const target = typeof input === 'string' ? input : input.toString();
    const validation = await validateGatewayEndpoint(target, policy);
    if (!validation.ok) throw new HarnessError('INVALID_INPUT', `OAuth URL refused: ${validation.error}`, 400, false);
    const agent = new Agent({ connect: { lookup: createPinnedLookup(validation.addresses) } });
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      const response = await transport(target, {
        ...(init ?? {}),
        signal,
        dispatcher: agent,
        redirect: 'error'
      } as RequestInit);
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => undefined);
        throw new HarnessError('UNAVAILABLE', OAUTH_REDIRECT_ERROR_MESSAGE, 502, false);
      }
      const body = await readCapped(response, options.maxResponseBytes);
      return new Response(body.byteLength > 0 ? new Blob([body as BlobPart]) : null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } finally {
      void agent.close().catch(() => undefined);
    }
  };
}
