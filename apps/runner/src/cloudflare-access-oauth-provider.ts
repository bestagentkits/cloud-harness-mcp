import { createHash } from 'node:crypto';
import {
  HarnessError,
  formatOAuthDuration,
  parseOAuthDurationSeconds,
  type RunnerConfig
} from '@cloud-harness/contracts';
import type { OAuthGrantProvider, OAuthGrantProviderSnapshot } from './oauth-grant-provider.js';

type CloudflareConfig = NonNullable<RunnerConfig['cloudflareAccessOAuth']>;
type CloudflareEnvelope = { success?: unknown; result?: unknown };
type AccessApplication = Record<string, unknown>;

/**
 * Cloudflare documents a grant session of up to one month for Access sessions
 * and recommends one to two weeks for agent clients. The provider read-back is
 * still the authority: a value Cloudflare rejects fails the save visibly.
 */
export const CLOUDFLARE_DEFAULT_MAX_GRANT_SECONDS = 2_592_000;
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 10_000;
/** Fields Cloudflare owns; sending them back on PUT is at best ignored. */
const SERVER_OWNED_FIELDS = new Set(['id', 'uid', 'aud', 'created_at', 'updated_at']);

/**
 * Reads and updates `oauth_configuration.grant` of one Access application.
 * Cloudflare offers only a full-object PUT, so a write re-reads the current
 * application, refuses when its OAuth configuration changed since the caller
 * looked, changes nothing but the two grant fields, and reads the result back.
 * Provider response bodies and the API token never leave this class.
 */
export class CloudflareAccessOAuthProvider implements OAuthGrantProvider {
  readonly id = 'cloudflare-access' as const;
  readonly label = 'Cloudflare Access Managed OAuth';
  readonly canWrite: boolean;
  readonly maxGrantSeconds: number;

  constructor(
    private readonly config: CloudflareConfig,
    private readonly request: typeof fetch = fetch
  ) {
    this.canWrite = config.access === 'read-write';
    this.maxGrantSeconds = config.maxGrantSeconds ?? CLOUDFLARE_DEFAULT_MAX_GRANT_SECONDS;
  }

  async read(): Promise<OAuthGrantProviderSnapshot> {
    return snapshot(await this.getApplication());
  }

  async write(next: { grantSeconds: number; tokenLifetimeSeconds: number }, expectedRevision: string | null): Promise<OAuthGrantProviderSnapshot> {
    if (!this.canWrite) throw providerError('provider_read_only');
    const current = await this.getApplication();
    const before = snapshot(current);
    if (before.unsupportedReason) throw providerError(before.unsupportedReason);
    if (!before.oauthEnabled) throw providerError('managed_oauth_disabled');
    if (expectedRevision !== before.revision) throw providerError('revision_conflict');
    const oauth = current.oauth_configuration as Record<string, unknown>;
    const grant = isRecord(oauth.grant) ? oauth.grant : {};
    const body: AccessApplication = {
      ...writableApplication(current),
      oauth_configuration: {
        ...oauth,
        grant: {
          ...grant,
          session_duration: formatOAuthDuration(next.grantSeconds),
          access_token_lifetime: formatOAuthDuration(next.tokenLifetimeSeconds)
        }
      }
    };
    await this.send('PUT', body);
    // After a PUT the provider may hold the new value, so a failed read-back is
    // reported as unconfirmed, never as "nothing was changed".
    const after = snapshot(await this.getApplication().catch(() => { throw providerError('readback_mismatch'); }));
    if (after.grantSeconds !== next.grantSeconds || after.tokenLifetimeSeconds !== next.tokenLifetimeSeconds) {
      throw providerError('readback_mismatch');
    }
    return after;
  }

  private async getApplication(): Promise<AccessApplication> {
    const result = await this.send('GET');
    if (!isRecord(result)) throw providerError('provider_invalid_response');
    return result;
  }

  private async send(method: 'GET' | 'PUT', body?: AccessApplication): Promise<unknown> {
    const url = `${CLOUDFLARE_API}/accounts/${this.config.accountId}/access/apps/${this.config.appId}`;
    let response: Response;
    try {
      response = await this.request(url, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.config.apiToken}`,
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      // A PUT that timed out or lost its connection may still have been applied.
      throw providerError(method === 'PUT' ? 'write_unconfirmed' : 'provider_unreachable');
    }
    if (response.status === 401 || response.status === 403) throw providerError(method === 'PUT' ? 'provider_write_denied' : 'provider_permission_denied');
    if (response.status === 404) throw providerError('provider_application_not_found');
    if (response.status === 400 || response.status === 409 || response.status === 422) throw providerError('provider_rejected');
    if (!response.ok) throw providerError(method === 'PUT' ? 'write_unconfirmed' : 'provider_unreachable');
    let envelope: CloudflareEnvelope;
    try {
      envelope = await response.json() as CloudflareEnvelope;
    } catch {
      throw providerError(method === 'PUT' ? 'write_unconfirmed' : 'provider_invalid_response');
    }
    if (!isRecord(envelope) || envelope.success !== true) throw providerError(method === 'PUT' ? 'provider_rejected' : 'provider_invalid_response');
    return envelope.result;
  }
}

function snapshot(application: AccessApplication): OAuthGrantProviderSnapshot {
  const oauth = isRecord(application.oauth_configuration) ? application.oauth_configuration : undefined;
  const grant = oauth && isRecord(oauth.grant) ? oauth.grant : undefined;
  const sessionDuration = grant?.session_duration;
  const tokenLifetime = grant?.access_token_lifetime;
  return {
    oauthEnabled: oauth?.enabled === true,
    grantSeconds: parseOAuthDurationSeconds(sessionDuration) ?? null,
    grantExplicitlyConfigured: typeof sessionDuration === 'string' && sessionDuration.trim().length > 0,
    tokenLifetimeSeconds: parseOAuthDurationSeconds(tokenLifetime) ?? null,
    tokenLifetimeExplicitlyConfigured: typeof tokenLifetime === 'string' && tokenLifetime.trim().length > 0,
    revision: createHash('sha256').update(canonicalJson(oauth ?? null)).digest('hex'),
    unsupportedReason: unsupportedReason(application)
  };
}

/**
 * Cloudflare's PUT replaces the whole application. Shapes whose full state a
 * GET cannot round-trip are refused rather than risked: a SaaS or
 * non-self-hosted application, and SCIM provisioning whose credentials are
 * write-only.
 */
function unsupportedReason(application: AccessApplication): string | null {
  if (application.type !== 'self_hosted') return 'provider_unsupported_application';
  if (isRecord(application.scim_config) && application.scim_config.enabled === true) return 'provider_unsupported_application';
  return null;
}

function writableApplication(application: AccessApplication): AccessApplication {
  const body: AccessApplication = {};
  for (const [key, value] of Object.entries(application)) {
    if (SERVER_OWNED_FIELDS.has(key)) continue;
    body[key] = key === 'policies' && Array.isArray(value) ? value.map(policyReference) : value;
  }
  return body;
}

/** Keep each policy attached by reference so a PUT never re-creates or edits a policy. */
function policyReference(policy: unknown): unknown {
  if (!isRecord(policy) || typeof policy.id !== 'string') return policy;
  return typeof policy.precedence === 'number' ? { id: policy.id, precedence: policy.precedence } : { id: policy.id };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const PROVIDER_ERRORS: Record<string, { code: ConstructorParameters<typeof HarnessError>[0]; status: number; retryable: boolean; message: string }> = {
  provider_unreachable: { code: 'UNAVAILABLE', status: 502, retryable: true, message: 'Cloud Harness could not reach Cloudflare. Nothing was changed; try again shortly.' },
  provider_invalid_response: { code: 'UNAVAILABLE', status: 502, retryable: true, message: 'Cloudflare returned a response Cloud Harness could not read. Nothing was changed.' },
  provider_permission_denied: { code: 'FORBIDDEN', status: 403, retryable: false, message: 'The Cloudflare API token cannot read this Access application. Grant it Access: Apps and Policies Read or Write.' },
  provider_write_denied: { code: 'FORBIDDEN', status: 403, retryable: false, message: 'The Cloudflare API token cannot update this Access application. Grant it Access: Apps and Policies Write.' },
  provider_application_not_found: { code: 'NOT_FOUND', status: 404, retryable: false, message: 'Cloudflare has no Access application with the configured account and application ID.' },
  provider_rejected: { code: 'INVALID_INPUT', status: 400, retryable: false, message: 'Cloudflare rejected the update to the Access application. Nothing was changed; check the values and the application in Cloudflare Zero Trust.' },
  provider_read_only: { code: 'FORBIDDEN', status: 403, retryable: false, message: 'The Cloudflare integration is configured read-only. Set CLOUDFLARE_ACCESS_OAUTH_ACCESS=read-write to change it here.' },
  provider_unsupported_application: { code: 'CONFLICT', status: 409, retryable: false, message: 'This Access application uses settings Cloud Harness cannot safely round-trip (SCIM or a non-self-hosted type). Change the grant duration in Cloudflare Zero Trust.' },
  managed_oauth_disabled: { code: 'CONFLICT', status: 409, retryable: false, message: 'Managed OAuth is turned off for this Access application. Turn it on in Cloudflare Zero Trust first.' },
  revision_conflict: { code: 'CONFLICT', status: 409, retryable: false, message: 'The Cloudflare OAuth configuration changed since this page loaded. Reload to see the current values.' },
  write_unconfirmed: { code: 'UNAVAILABLE', status: 502, retryable: true, message: 'Cloudflare did not answer the update clearly, so it may or may not have been applied. Reload to see the effective values.' },
  readback_mismatch: { code: 'UNAVAILABLE', status: 502, retryable: true, message: 'Cloudflare did not confirm the new OAuth grant settings on read-back. Reload to see the effective values.' }
};

export function providerError(reason: string): HarnessError {
  const entry = PROVIDER_ERRORS[reason] ?? PROVIDER_ERRORS.provider_unreachable!;
  return new HarnessError(entry.code, entry.message, entry.status, entry.retryable, { reason });
}

export function providerErrorMessage(reason: string): string {
  return (PROVIDER_ERRORS[reason] ?? PROVIDER_ERRORS.provider_unreachable!).message;
}
