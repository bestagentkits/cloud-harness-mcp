import { createHash, randomBytes } from 'node:crypto';
import {
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens
} from '@modelcontextprotocol/client';
import {
  HarnessError,
  type McpGatewayOAuthRegistrationMode,
  type RunnerResponse,
  type RunnerPrincipalSelector
} from '@cloud-harness/contracts';
import type { RunnerClient } from '../runner-client.js';

/**
 * Cloud Harness implementation of the SDK `OAuthClientProvider`, backed by the runner's
 * encrypted, principal-scoped OAuth store. The provider owns persistence only; the SDK
 * performs discovery, PKCE, issuer validation, code exchange, and refresh.
 *
 * Two modes exist:
 * - `background` (Test, Refresh, Execute): never navigates a browser. When the SDK
 *   cannot refresh and would redirect, `redirectToAuthorization` throws
 *   `McpOAuthAuthorizationRequiredError` so the caller can report a structured result.
 * - `interactive` (explicit Connect): captures the authorization URL, persists the
 *   single-use pending flow keyed by the hash of `state`, and returns the URL to the
 *   dashboard, which hands it to the user's browser.
 */

export class McpOAuthAuthorizationRequiredError extends Error {
  constructor(message = 'downstream MCP server requires OAuth authorization') {
    super(message);
    this.name = 'McpOAuthAuthorizationRequiredError';
  }
}

export function isAuthorizationRequired(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 6; depth += 1) {
    if (current instanceof McpOAuthAuthorizationRequiredError) return true;
    const named = current as { name?: unknown; cause?: unknown; data?: { cause?: unknown } };
    if (named.name === 'UnauthorizedError') return true;
    current = named.cause ?? named.data?.cause;
  }
  return false;
}

export type McpOAuthManualClient = { clientId: string; clientSecret: string | null };

export type McpOAuthProviderOptions = {
  runner: RunnerClient;
  principal: RunnerPrincipalSelector;
  serverId: string;
  scopes: string | null;
  manualClient: McpOAuthManualClient | null;
  redirectUrl: string;
  clientMetadataUrl: string | null;
  mode: 'background' | 'interactive';
  now?: () => number;
  /** Preloaded state of a consumed pending flow (callback completion). */
  flow?: { blob: string; expectedIssuer: string };
};

type GrantBlob = {
  clientInformation?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  tokensObtainedAt?: number;
  discoveryState?: OAuthDiscoveryState;
  resourceUrl?: string;
};

type FlowBlob = GrantBlob & { codeVerifier?: string };

export function hashState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

function parse<T>(blob: string): T {
  try {
    const value = JSON.parse(blob) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as T;
  } catch {
    // fall through
  }
  throw new HarnessError('INTERNAL_ERROR', 'stored OAuth state is unreadable', 500, false);
}

function issuerOf(discovery: OAuthDiscoveryState | undefined): string | undefined {
  return discovery?.authorizationServerMetadata?.issuer ?? discovery?.authorizationServerUrl;
}

export class DownstreamOAuthProvider implements OAuthClientProvider {
  private readonly now: () => number;
  private loaded = false;
  private generation = 0;
  private grant: GrantBlob = {};
  private verifier: string | undefined;
  private stateValue: string | undefined;
  private pendingRegistrationMode: McpGatewayOAuthRegistrationMode | undefined;
  private authorizationUrlValue: URL | undefined;
  private refreshedSinceLoad = false;
  /** Set when the SDK discarded tokens or client information, so the grant is rewritten. */
  private dirty = false;

  clientMetadataUrl?: string;

  constructor(private readonly options: McpOAuthProviderOptions) {
    if (options.clientMetadataUrl) this.clientMetadataUrl = options.clientMetadataUrl;
    this.now = options.now ?? (() => Date.now());
    if (options.flow) {
      const flow = parse<FlowBlob>(options.flow.blob);
      this.verifier = flow.codeVerifier;
      this.grant = { ...(flow.clientInformation ? { clientInformation: flow.clientInformation } : {}),
        ...(flow.discoveryState ? { discoveryState: flow.discoveryState } : {}),
        ...(flow.resourceUrl ? { resourceUrl: flow.resourceUrl } : {}) };
    }
  }

  /** The URL the dashboard hands to the user's browser; set only in interactive mode. */
  get authorizationUrl(): URL | undefined {
    return this.authorizationUrlValue;
  }

  get redirectUrl(): string {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const manualSecret = this.options.manualClient?.clientSecret != null;
    return {
      client_name: 'Cloud Harness MCP Gateway',
      redirect_uris: [this.options.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: manualSecret ? 'client_secret_basic' : 'none',
      ...(this.options.scopes ? { scope: this.options.scopes } : {})
    };
  }

  private async call(operation: 'mcp_oauth_grant_load' | 'mcp_oauth_grant_save' | 'mcp_oauth_grant_mark' | 'mcp_oauth_flow_begin', input: Record<string, unknown>) {
    const response = await this.options.runner.callInternal(operation, input, this.options.principal);
    if (!response.ok) {
      const code = response.error?.code ?? 'UNAVAILABLE';
      throw new HarnessError(code, response.error?.message ?? response.message, code === 'CONFLICT' ? 409 : 502, response.error?.retryable ?? false);
    }
    return response;
  }

  /** Loads the persisted grant once per provider instance. */
  async load(): Promise<void> {
    if (this.loaded) return;
    const response = await this.call('mcp_oauth_grant_load', { serverId: this.options.serverId });
    const grant = (response.data as { grant?: { blob: string; generation: number } | null } | undefined)?.grant;
    if (grant) {
      // A callback keeps the discovery and client state of its own flow; it only needs
      // the current generation so the new grant replaces the old one.
      if (!this.options.flow) this.grant = parse<GrantBlob>(grant.blob);
      this.generation = grant.generation;
    }
    this.loaded = true;
  }

  /** True when a stored refresh token lets a background call renew an expired access token. */
  get canRefresh(): boolean {
    return Boolean(this.grant.tokens?.refresh_token);
  }

  get hasGrant(): boolean {
    return this.generation > 0;
  }

  get grantGeneration(): number {
    return this.generation;
  }

  state(): string {
    this.stateValue = randomBytes(32).toString('base64url');
    return this.stateValue;
  }

  async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    await this.load();
    const manual = this.options.manualClient;
    if (manual) {
      return { client_id: manual.clientId, ...(manual.clientSecret ? { client_secret: manual.clientSecret } : {}) } as StoredOAuthClientInformation;
    }
    return this.grant.clientInformation;
  }

  async saveClientInformation(info: StoredOAuthClientInformation): Promise<void> {
    await this.load();
    // A manually registered client lives in the server configuration, never in the grant.
    if (this.options.manualClient) return;
    this.grant.clientInformation = info;
    this.pendingRegistrationMode = this.options.clientMetadataUrl && info.client_id === this.options.clientMetadataUrl ? 'cimd' : 'dcr';
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    await this.load();
    const tokens = this.grant.tokens;
    if (!tokens) return undefined;
    const obtainedAt = this.grant.tokensObtainedAt;
    if (typeof tokens.expires_in === 'number' && obtainedAt !== undefined) {
      const remaining = Math.floor(tokens.expires_in - (this.now() - obtainedAt) / 1000);
      // An expired access token stays visible with a zero lifetime so the SDK refreshes it
      // instead of replaying it.
      return { ...tokens, expires_in: Math.max(remaining, 0) } as StoredOAuthTokens;
    }
    return tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await this.load();
    const previous = this.grant.tokens;
    const refreshed = this.options.mode === 'background' && previous !== undefined;
    // Refresh responses may omit a rotated refresh token; the previous one stays valid.
    const next = { ...tokens } as StoredOAuthTokens;
    if (!next.refresh_token && previous?.refresh_token) next.refresh_token = previous.refresh_token;
    this.grant.tokens = next;
    this.grant.tokensObtainedAt = this.now();
    this.refreshedSinceLoad = refreshed;
    await this.persist(refreshed);
  }

  private async persist(refreshed: boolean): Promise<void> {
    const issuer = issuerOf(this.grant.discoveryState) ?? this.options.flow?.expectedIssuer;
    if (!issuer) throw new HarnessError('INTERNAL_ERROR', 'OAuth issuer is unknown; refusing to store a grant', 500, false);
    const tokens = this.grant.tokens;
    const expiresIn = typeof tokens?.expires_in === 'number' ? tokens.expires_in : null;
    const mode: McpGatewayOAuthRegistrationMode = this.options.manualClient
      ? 'manual'
      : this.pendingRegistrationMode ?? this.registrationModeFromGrant();
    const save = (): Promise<RunnerResponse | undefined> => this.call('mcp_oauth_grant_save', {
      serverId: this.options.serverId,
      expectedGeneration: this.generation,
      issuer,
      registrationMode: mode,
      grantedScopes: typeof tokens?.scope === 'string' ? tokens.scope : this.options.scopes,
      requestedScopes: this.options.scopes,
      expiresAt: expiresIn === null ? null : Math.floor(this.now() + expiresIn * 1000),
      refreshed,
      blob: JSON.stringify(this.grant)
    }).catch((error: unknown) => {
      if (error instanceof HarnessError && error.code === 'CONFLICT') return undefined;
      throw error;
    });
    let response = await save();
    if (!response) {
      this.loaded = false;
      await this.load();
      // A callback holds the only copy of the freshly authorized tokens, so it saves them
      // over the newer generation. A background refresh adopts the newer grant instead of
      // overwriting a token another process rotated.
      if (this.options.flow) response = await save();
      if (!response) return;
    }
    this.generation = Number((response.data as { generation?: number } | undefined)?.generation ?? this.generation + 1);
    this.dirty = false;
  }

  private registrationModeFromGrant(): McpGatewayOAuthRegistrationMode {
    const id = (this.grant.clientInformation as { client_id?: string } | undefined)?.client_id;
    return this.options.clientMetadataUrl && id === this.options.clientMetadataUrl ? 'cimd' : 'dcr';
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new HarnessError('INVALID_INPUT', 'no PKCE verifier is available for this authorization', 400, false);
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.grant.discoveryState = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.grant.discoveryState;
  }

  saveResourceUrl(resourceUrl: string): void {
    this.grant.resourceUrl = resourceUrl;
  }

  resourceUrl(): string | undefined {
    return this.grant.resourceUrl;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    await this.load();
    if (scope === 'all' || scope === 'tokens') {
      delete this.grant.tokens;
      delete this.grant.tokensObtainedAt;
    }
    if (scope === 'all' || scope === 'client') delete this.grant.clientInformation;
    if (scope === 'all' || scope === 'discovery') delete this.grant.discoveryState;
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
    this.dirty = true;
  }

  get wasRefreshed(): boolean {
    return this.refreshedSinceLoad;
  }

  get needsReauthorization(): boolean {
    return this.dirty && this.grant.tokens === undefined;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.options.mode !== 'interactive') {
      // A grant whose tokens the SDK discarded (rejected refresh) or that has no refresh
      // token cannot recover without the user. A transient refresh failure keeps the
      // grant untouched, so it is never reported as re-authorization.
      if (this.hasGrant && (this.dirty || !this.canRefresh)) {
        await this.markReauthorizationRequired('the authorization server rejected the stored grant');
      } else if (this.hasGrant) {
        throw new HarnessError('UNAVAILABLE', 'The OAuth token refresh failed temporarily; retry shortly', 503, true);
      }
      throw new McpOAuthAuthorizationRequiredError();
    }
    const state = authorizationUrl.searchParams.get('state');
    if (!state || state !== this.stateValue) {
      throw new HarnessError('INTERNAL_ERROR', 'authorization URL did not carry the generated state', 500, false);
    }
    const issuer = issuerOf(this.grant.discoveryState);
    if (!issuer) throw new HarnessError('INTERNAL_ERROR', 'authorization server was not discovered', 500, false);
    const flow: FlowBlob = { ...this.grant, ...(this.verifier ? { codeVerifier: this.verifier } : {}) };
    delete flow.tokens;
    delete flow.tokensObtainedAt;
    await this.call('mcp_oauth_flow_begin', {
      serverId: this.options.serverId,
      stateHash: hashState(state),
      expectedIssuer: issuer,
      scopes: this.options.scopes,
      blob: JSON.stringify(flow)
    });
    this.authorizationUrlValue = authorizationUrl;
  }

  /** Records a refresh that failed so the dashboard shows Re-authorization required. */
  async markReauthorizationRequired(reason: string): Promise<void> {
    if (!this.hasGrant) return;
    await this.call('mcp_oauth_grant_mark', {
      serverId: this.options.serverId,
      state: 'reauthorization_required',
      error: reason
    }).catch(() => undefined);
  }
}

/**
 * Wraps the OAuth fetch for a background provider. A background call must never create
 * state at an authorization server: discovery (GET) is side-effect free and allowed, but a
 * POST (dynamic registration, token exchange, revocation) is permitted only to refresh an
 * existing grant that holds a refresh token.
 */
export function guardBackgroundFetch(
  provider: DownstreamOAuthProvider,
  fetcher: (input: string | URL, init?: RequestInit) => Promise<Response>
): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      await provider.load();
      if (!provider.canRefresh) {
        if (provider.hasGrant) await provider.markReauthorizationRequired('the authorization server rejected the stored client');
        throw new McpOAuthAuthorizationRequiredError();
      }
    }
    return fetcher(input, init);
  };
}
