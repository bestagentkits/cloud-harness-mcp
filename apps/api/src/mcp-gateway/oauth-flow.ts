import { auth } from '@modelcontextprotocol/client';
import {
  HarnessError,
  type McpGatewayResolvedCredentials,
  type RunnerPrincipalSelector
} from '@cloud-harness/contracts';
import type { RunnerClient } from '../runner-client.js';
import type { GatewayConnectionManager } from './connection-manager.js';
import { createOAuthFetch, type OAuthFetchOptions } from './oauth-fetch.js';
import { DownstreamOAuthProvider, hashState } from './oauth-provider.js';
import { sanitizeGatewayText } from './redaction.js';

/**
 * Orchestrates the explicit, user-driven parts of downstream MCP OAuth: starting an
 * authorization, completing the browser callback, and disconnecting. Background Test,
 * Refresh and Execute never come through here; they use a background provider that cannot
 * navigate a browser or create state at an authorization server.
 *
 * The callback trusts nothing from the browser except the one-time `state`: the flow
 * row names the server and the expected issuer, the SDK validates `iss` and the resource
 * binding, and the runner enforces principal scope.
 */

export type McpOAuthCoordinatorOptions = {
  redirectUrl: string | undefined;
  clientMetadataUrl: string | undefined;
  fetch: OAuthFetchOptions;
};

export type McpOAuthCallbackOutcome =
  | { serverId: string; outcome: 'connected' }
  | { serverId: string | null; outcome: 'error'; reason: 'invalid_state' | 'expired' | 'denied' | 'issuer_mismatch' | 'exchange_failed' | 'unavailable' };

type OAuthCredentials = NonNullable<McpGatewayResolvedCredentials['oauth']>;

export class McpOAuthCoordinator {
  constructor(
    private readonly runner: RunnerClient,
    private readonly connections: GatewayConnectionManager,
    private readonly options: McpOAuthCoordinatorOptions
  ) {}

  get configured(): boolean {
    return this.options.redirectUrl !== undefined;
  }

  get redirectUrl(): string | null {
    return this.options.redirectUrl ?? null;
  }

  private requireRedirect(): string {
    if (!this.options.redirectUrl) {
      throw new HarnessError(
        'UNAVAILABLE',
        'MCP OAuth is not available: set MCP_DOWNSTREAM_OAUTH_REDIRECT_URL to the dashboard callback URL',
        503,
        false
      );
    }
    return this.options.redirectUrl;
  }

  /**
   * Safe status projection. The redirect URL comes from deployment config, never from storage.
   * Without a redirect URL no interactive step can run, so every state that would offer
   * Connect reads `not_configured`; a connected grant keeps working in the background.
   */
  async status(principal: RunnerPrincipalSelector, serverId: string, signal?: AbortSignal) {
    const response = await this.runner.callInternal('mcp_oauth_status', { serverId }, principal, signal);
    if (!response.ok) throw new HarnessError(response.error?.code ?? 'UNAVAILABLE', response.error?.message ?? response.message, 502, false);
    const status = (response.data as { status: Record<string, unknown> }).status;
    const state = !this.configured && status.enabled === true && status.state !== 'connected' ? 'not_configured' : status.state;
    return { ...status, state, redirectUrl: this.options.redirectUrl ?? null };
  }

  /** Background provider for Test, Refresh and Execute. Never navigates a browser. */
  background(principal: RunnerPrincipalSelector, serverId: string, oauth: OAuthCredentials): DownstreamOAuthProvider {
    return new DownstreamOAuthProvider({
      runner: this.runner,
      principal,
      serverId,
      scopes: oauth.scopes,
      manualClient: oauth.clientId ? { clientId: oauth.clientId, clientSecret: oauth.clientSecret } : null,
      // The redirect URL is never used by a background call; the SDK only needs a value.
      redirectUrl: this.options.redirectUrl ?? 'https://invalid.example/dashboard/mcp-oauth/callback',
      clientMetadataUrl: this.options.clientMetadataUrl ?? null,
      mode: 'background'
    });
  }

  private async credentials(principal: RunnerPrincipalSelector, serverId: string, signal?: AbortSignal) {
    const response = await this.runner.callInternal('mcp_server_get_credentials', { serverId, purpose: 'connect' }, principal, signal);
    const data = response.data as McpGatewayResolvedCredentials | undefined;
    if (!response.ok || !data || data.allowed !== true || !data.endpoint) {
      throw new HarnessError('INVALID_INPUT', 'the MCP server is unknown, disabled, or not configured for OAuth', 400, false);
    }
    if (!data.oauth) throw new HarnessError('INVALID_INPUT', 'OAuth is not enabled for this MCP server', 400, false);
    return { endpoint: data.endpoint, oauth: data.oauth };
  }

  private fetcher() {
    return createOAuthFetch(this.options.fetch);
  }

  /** Begins an explicit authorization. Returns the URL the user's browser must open. */
  async start(
    principal: RunnerPrincipalSelector,
    serverId: string,
    signal?: AbortSignal
  ): Promise<{ authorizationUrl: string; expiresAt: number | null }> {
    const redirectUrl = this.requireRedirect();
    const { endpoint, oauth } = await this.credentials(principal, serverId, signal);
    const provider = new DownstreamOAuthProvider({
      runner: this.runner,
      principal,
      serverId,
      scopes: oauth.scopes,
      manualClient: oauth.clientId ? { clientId: oauth.clientId, clientSecret: oauth.clientSecret } : null,
      redirectUrl,
      clientMetadataUrl: this.options.clientMetadataUrl ?? null,
      mode: 'interactive'
    });
    let result: Awaited<ReturnType<typeof auth>>;
    try {
      result = await auth(provider, {
        serverUrl: endpoint,
        ...(oauth.scopes ? { scope: oauth.scopes } : {}),
        forceReauthorization: true,
        fetchFn: this.fetcher() as never
      });
    } catch (error) {
      await this.recordFailure(principal, serverId, error);
      throw this.startFailure(error);
    }
    if (result !== 'REDIRECT' || !provider.authorizationUrl) {
      throw new HarnessError('INTERNAL_ERROR', 'the authorization server did not require an interactive step', 500, false);
    }
    // A fresh Connect replaces whatever transport was built on the previous grant.
    this.connections.invalidate(serverId);
    return { authorizationUrl: provider.authorizationUrl.toString(), expiresAt: null };
  }

  private startFailure(error: unknown): HarnessError {
    if (error instanceof HarnessError) return error;
    return new HarnessError(
      'UNAVAILABLE',
      `could not start OAuth authorization: ${sanitizeGatewayText(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
      502,
      false
    );
  }

  private async recordFailure(principal: RunnerPrincipalSelector, serverId: string, error: unknown): Promise<void> {
    const reason = sanitizeGatewayText(error instanceof Error ? error.message : String(error)).slice(0, 300);
    await this.runner.callInternal('mcp_oauth_grant_mark', { serverId, state: 'error', error: reason }, principal).catch(() => undefined);
  }

  /** Completes the browser callback. Never throws for a user-visible failure. */
  async complete(
    principal: RunnerPrincipalSelector,
    query: { code?: string; state?: string; iss?: string; error?: string },
    signal?: AbortSignal
  ): Promise<McpOAuthCallbackOutcome> {
    if (!query.state || query.state.length > 256) return { serverId: null, outcome: 'error', reason: 'invalid_state' };
    const consumed = await this.runner.callInternal('mcp_oauth_flow_consume', { stateHash: hashState(query.state) }, principal, signal);
    if (!consumed.ok) {
      const code = consumed.error?.code;
      return { serverId: null, outcome: 'error', reason: code === 'EXPIRED' ? 'expired' : code === 'NOT_FOUND' ? 'invalid_state' : 'unavailable' };
    }
    const flow = consumed.data as { serverId: string; blob: string; expectedIssuer: string; scopes: string | null };
    if (query.error) {
      await this.runner.callInternal('mcp_oauth_grant_mark', { serverId: flow.serverId, state: 'error', error: 'the authorization server denied the request' }, principal).catch(() => undefined);
      return { serverId: flow.serverId, outcome: 'error', reason: 'denied' };
    }
    if (!query.code || query.code.length > 4_096) return { serverId: flow.serverId, outcome: 'error', reason: 'exchange_failed' };
    if (query.iss !== undefined && query.iss !== flow.expectedIssuer) {
      await this.runner.callInternal('mcp_oauth_grant_mark', { serverId: flow.serverId, state: 'error', error: 'authorization response issuer did not match the expected issuer' }, principal).catch(() => undefined);
      return { serverId: flow.serverId, outcome: 'error', reason: 'issuer_mismatch' };
    }
    try {
      const { endpoint, oauth } = await this.credentials(principal, flow.serverId, signal);
      const provider = new DownstreamOAuthProvider({
        runner: this.runner,
        principal,
        serverId: flow.serverId,
        scopes: flow.scopes,
        manualClient: oauth.clientId ? { clientId: oauth.clientId, clientSecret: oauth.clientSecret } : null,
        redirectUrl: this.requireRedirect(),
        clientMetadataUrl: this.options.clientMetadataUrl ?? null,
        mode: 'interactive',
        flow: { blob: flow.blob, expectedIssuer: flow.expectedIssuer }
      });
      const result = await auth(provider, {
        serverUrl: endpoint,
        authorizationCode: query.code,
        ...(query.iss !== undefined ? { iss: query.iss } : {}),
        ...(flow.scopes ? { scope: flow.scopes } : {}),
        fetchFn: this.fetcher() as never
      });
      if (result !== 'AUTHORIZED') throw new HarnessError('UNAVAILABLE', 'authorization was not completed', 502, false);
      this.connections.invalidate(flow.serverId);
      return { serverId: flow.serverId, outcome: 'connected' };
    } catch (error) {
      await this.recordFailure(principal, flow.serverId, error);
      const message = error instanceof Error ? error.message : '';
      const mismatch = /issuer/i.test(message) || (error as { name?: string })?.name === 'IssuerMismatchError';
      return { serverId: flow.serverId, outcome: 'error', reason: mismatch ? 'issuer_mismatch' : 'exchange_failed' };
    }
  }

  /** Best-effort revocation, then local deletion and connection invalidation. */
  async disconnect(principal: RunnerPrincipalSelector, serverId: string, signal?: AbortSignal): Promise<{ disconnected: boolean; revocation: 'attempted' | 'unsupported' | 'failed' | null }> {
    let revocation: 'attempted' | 'unsupported' | 'failed' | null = null;
    const response = await this.runner.callInternal('mcp_server_get_credentials', { serverId, purpose: 'connect' }, principal, signal).catch(() => undefined);
    const creds = response?.data as McpGatewayResolvedCredentials | undefined;
    if (creds?.allowed === true && creds.oauth) {
      const provider = this.background(principal, serverId, creds.oauth);
      try {
        await provider.load();
        revocation = await this.revoke(provider, creds.oauth, signal);
      } catch {
        revocation = 'failed';
      }
    }
    const result = await this.runner.callInternal('mcp_oauth_disconnect', { serverId, revocation }, principal, signal);
    this.connections.invalidate(serverId);
    if (!result.ok) throw new HarnessError(result.error?.code ?? 'UNAVAILABLE', result.error?.message ?? result.message, 502, false);
    return { disconnected: (result.data as { disconnected?: boolean } | undefined)?.disconnected === true, revocation };
  }

  private async revoke(
    provider: DownstreamOAuthProvider,
    oauth: OAuthCredentials,
    signal?: AbortSignal
  ): Promise<'attempted' | 'unsupported' | 'failed'> {
    const tokens = await provider.tokens();
    const metadata = provider.discoveryState()?.authorizationServerMetadata as { revocation_endpoint?: string } | undefined;
    const endpoint = metadata?.revocation_endpoint;
    const token = tokens?.refresh_token ?? tokens?.access_token;
    if (!tokens || !token) return 'unsupported';
    if (!endpoint) return 'unsupported';
    const client = await provider.clientInformation();
    const body = new URLSearchParams({ token, token_type_hint: tokens.refresh_token ? 'refresh_token' : 'access_token' });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (oauth.clientId && oauth.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(oauth.clientId)}:${encodeURIComponent(oauth.clientSecret)}`).toString('base64')}`;
    } else if (client?.client_id) {
      body.set('client_id', client.client_id);
    }
    try {
      const response = await this.fetcher()(endpoint, { method: 'POST', headers, body, ...(signal ? { signal } : {}) });
      return response.ok ? 'attempted' : 'failed';
    } catch {
      return 'failed';
    }
  }
}
