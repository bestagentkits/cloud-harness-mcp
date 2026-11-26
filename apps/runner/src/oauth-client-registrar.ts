import { z } from 'zod';
import {
  HarnessError,
  OAuthClientRegistrationInputSchema,
  OAuthClientRegistrationResultSchema,
  type OAuthClientRegistrationResult
} from '@cloud-harness/contracts';

/** RFC 8414 metadata: only the registration endpoint is used. */
const AuthorizationServerMetadataSchema = z.object({ registration_endpoint: z.string().max(2_048) });
/** RFC 7591 response fields this registration depends on; the client must come back exactly as requested. */
const RegistrationResponseSchema = z.object({
  client_id: z.string(),
  client_secret: z.string(),
  token_endpoint_auth_method: z.literal('client_secret_post'),
  redirect_uris: z.array(z.string()).length(1)
});

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const CLIENT_NAME = 'Gemini custom app (Cloud Harness Dashboard)';

type AuditSink = (ownerId: string, action: string, details: Record<string, string | number | boolean>) => void;

const ERRORS = {
  not_configured: { code: 'UNAVAILABLE', status: 503, retryable: false, message: 'Creating an OAuth client needs CLOUDFLARE_ACCESS_ISSUER on the runner in cloudflare-access mode.' },
  not_allowlisted: { code: 'INVALID_INPUT', status: 400, retryable: false, message: 'This redirect URI is not on the Allowed redirect URIs list. Tick "Gemini custom apps" under Allowed redirect URIs and save (or add https://oauth-redirect.googleusercontent.com/r/* in Cloudflare Zero Trust), then try again.' },
  rejected: { code: 'INVALID_INPUT', status: 400, retryable: false, message: 'Cloudflare refused to register the client. Check that the redirect URI is Gemini\'s and is on the Allowed redirect URIs list.' },
  throttled: { code: 'UNAVAILABLE', status: 503, retryable: true, message: 'Cloudflare is limiting client registrations right now. Wait a minute and try again.' },
  cancelled: { code: 'UNAVAILABLE', status: 503, retryable: true, message: 'The request ended before a client was registered. Try again.' },
  unreachable: { code: 'UNAVAILABLE', status: 502, retryable: true, message: 'Cloud Harness could not complete the request to the Cloudflare Access registration endpoint, so no credentials are shown. Try again shortly; a client Cloudflare may have created stays unusable without its secret.' },
  invalid_response: { code: 'UNAVAILABLE', status: 502, retryable: true, message: 'Cloudflare answered the registration in an unexpected form, so no credentials are shown. Try again; a client Cloudflare may have created stays unusable without its secret.' }
} as const satisfies Record<string, { code: ConstructorParameters<typeof HarnessError>[0]; status: number; retryable: boolean; message: string }>;

function refusal(reason: keyof typeof ERRORS): HarnessError {
  const error = ERRORS[reason];
  return new HarnessError(error.code, error.message, error.status, error.retryable, { reason: `oauth_client_${reason}` });
}

/** True when an allowlist entry admits `uri`: an exact match, or a trailing `/*` prefix. */
export function allowlistAdmits(entries: readonly string[], uri: string): boolean {
  return entries.some((entry) => entry === uri || (entry.endsWith('/*') && uri.startsWith(entry.slice(0, -1))));
}

/**
 * Registers an OAuth client at the Cloudflare Access Managed OAuth registration
 * endpoint for an MCP client whose own registration fails (Gemini). The endpoint
 * is discovered from the team domain and must share its origin, so the runner
 * never posts to a host it was not configured with. The returned secret is passed
 * through once: it is never stored, logged, or audited here.
 */
export class OAuthClientRegistrar {
  constructor(
    private readonly issuer: string | undefined,
    /** The provider's current allowlist, `null` when it cannot be read; omitted without an integration. */
    private readonly readAllowlist: (() => Promise<string[] | null>) | undefined,
    private readonly audit: AuditSink = () => undefined,
    private readonly request: typeof fetch = fetch
  ) {}

  async register(ownerId: string, rawInput: unknown, signal?: AbortSignal): Promise<OAuthClientRegistrationResult> {
    const input = OAuthClientRegistrationInputSchema.parse(rawInput);
    if (!this.issuer) throw refusal('not_configured');
    if (this.readAllowlist) {
      // A provider read failure is not a refusal: Cloudflare itself rejects an unlisted callback.
      const allowlist = await this.readAllowlist().catch(() => null);
      if (allowlist && !allowlistAdmits(allowlist, input.redirectUri)) throw refusal('not_allowlisted');
    }
    const endpoint = await this.registrationEndpoint(this.issuer, signal);
    // The caller may have gone while discovery ran; never start a registration nobody will see.
    if (signal?.aborted) throw refusal('cancelled');
    const answer = await this.send(endpoint, 'POST', signal, {
      client_name: CLIENT_NAME,
      redirect_uris: [input.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post'
    });
    const registered = RegistrationResponseSchema.safeParse(answer);
    if (!registered.success || registered.data.redirect_uris[0] !== input.redirectUri) throw refusal('invalid_response');
    const parsed = OAuthClientRegistrationResultSchema.safeParse({
      client: 'gemini',
      clientId: registered.data.client_id,
      clientSecret: registered.data.client_secret,
      clientName: CLIENT_NAME,
      redirectUri: input.redirectUri,
      tokenEndpointAuthMethod: registered.data.token_endpoint_auth_method
    });
    if (!parsed.success) throw refusal('invalid_response');
    // The callback is per Google account, so only the client id is recorded.
    this.audit(ownerId, 'oauth_client.registered', { client: 'gemini', clientId: parsed.data.clientId });
    return parsed.data;
  }

  private async registrationEndpoint(issuer: string, signal: AbortSignal | undefined): Promise<string> {
    const origin = new URL(issuer).origin;
    const metadata = AuthorizationServerMetadataSchema.safeParse(await this.send(`${origin}/.well-known/oauth-authorization-server`, 'GET', signal));
    if (!metadata.success) throw refusal('invalid_response');
    let url: URL;
    try { url = new URL(metadata.data.registration_endpoint); } catch { throw refusal('invalid_response'); }
    if (url.protocol !== 'https:' || url.origin !== origin) throw refusal('invalid_response');
    return url.href;
  }

  private async send(url: string, method: 'GET' | 'POST', signal: AbortSignal | undefined, body?: Record<string, unknown>): Promise<unknown> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.request(url, {
        method,
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout
      });
    } catch {
      throw refusal(signal?.aborted && method === 'GET' ? 'cancelled' : 'unreachable');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 429) throw refusal('throttled');
      if (method === 'POST' && response.status >= 400 && response.status < 500) throw refusal('rejected');
      throw refusal('unreachable');
    }
    const text = await readBounded(response);
    try { return JSON.parse(text) as unknown; } catch { throw refusal('invalid_response'); }
  }
}

/** Reads at most `MAX_RESPONSE_BYTES` of UTF-8 body, cancelling the stream as soon as it is exceeded. */
async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw refusal('invalid_response');
      }
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw refusal('invalid_response');
  }
}
