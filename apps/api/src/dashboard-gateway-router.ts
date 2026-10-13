import type { NextFunction, Response, Router } from 'express';
import { z } from 'zod';
import { HarnessError, type ApiConfig, type RunnerPrincipalSelector, type ToolResult } from '@cloud-harness/contracts';
import { principalFromAuthInfo } from './auth.js';
import type { DashboardRequest } from './dashboard-types.js';
import type { McpGatewayService } from './mcp-gateway/service.js';

const mcpServerId = z.string().regex(/^mcps_[A-Za-z0-9_-]{20,80}$/);

type PrincipalResolver = (request: DashboardRequest, response: Response) => RunnerPrincipalSelector | undefined;

/** Lower-cased hostname of a Host header, dropping any port and IPv6 brackets. */
function hostnameFromHost(raw: string): string {
  if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']')).toLowerCase();
  return raw.split(':', 1)[0]!.toLowerCase();
}

/**
 * `https://<allowlisted host>/mcp-gateway`. Only the host is read from the request,
 * so no path, query string, or fragment can ever be echoed back to the browser.
 */
function gatewayPublicUrl(request: DashboardRequest, config: ApiConfig): string | null {
  const raw = request.header('host');
  const candidate = raw ? hostnameFromHost(raw) : undefined;
  const allowlisted = config.publicHosts.map((host) => host.toLowerCase());
  const host = candidate && allowlisted.includes(candidate) ? candidate : allowlisted[0];
  return host ? `https://${host}/mcp-gateway` : null;
}

/**
 * The gateway endpoint on the managed API-key lane: the configured static-key Worker
 * origin with the `/mcp-gateway` path. Null unless that lane is enabled and published.
 */
function gatewayApiKeyPublicUrl(config: ApiConfig): string | null {
  if (config.authMode !== 'cloudflare-access' || !config.apiKeyAuthEnabled || !config.apiKeyGatewayPublicUrl) return null;
  return new URL('/mcp-gateway', config.apiKeyGatewayPublicUrl).toString();
}

function probeFailureStatus(code: string): number {
  if (code === 'NOT_FOUND' || code === 'FORBIDDEN') return 404;
  if (code === 'INVALID_INPUT') return 400;
  // Not 401: the dashboard treats 401 as an ended session.
  if (code === 'AUTHORIZATION_REQUIRED') return 409;
  if (code === 'TIMEOUT') return 504;
  return 503;
}

function connectionData(result: ToolResult): Record<string, unknown> {
  const data = result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : {};
  return {
    status: typeof data.status === 'string' ? data.status : 'error',
    toolCount: typeof data.toolCount === 'number' ? data.toolCount : 0,
    error: typeof data.error === 'string' ? data.error : null
  };
}

/**
 * The routes that need the API-side connection manager rather than a runner call:
 * connection test, tool discovery refresh, and the endpoint projection the UI shows
 * a client. They share the dashboard's auth, host allowlist, and CSRF middleware.
 */
export function registerDashboardGatewayRoutes(
  router: Router,
  gateway: McpGatewayService,
  principal: PrincipalResolver,
  config: ApiConfig
): void {
  router.post('/api/v1/mcp-servers/:serverId/test', probe('test'));
  router.post('/api/v1/mcp-servers/:serverId/refresh', probe('refresh'));

  router.get('/api/v1/mcp-gateway', (request: DashboardRequest, response: Response): void => {
    const selected = principal(request, response);
    if (!selected) return;
    response.json({
      data: {
        endpoint: '/mcp-gateway',
        publicUrl: gatewayPublicUrl(request, config),
        apiKeyPublicUrl: gatewayApiKeyPublicUrl(config),
        authMode: config.authMode ?? 'owner-bearer'
      }
    });
  });

  const oauth = gateway.oauth;
  const oauthFailure = (error: unknown, response: Response): boolean => {
    if (!(error instanceof HarnessError)) return false;
    response.status(error.code === 'UNAVAILABLE' ? 503 : probeFailureStatus(error.code)).json({ error: error.code.toLowerCase(), message: error.message });
    return true;
  };
  const unavailable = (response: Response): void => {
    response.status(503).json({ error: 'unavailable', message: 'MCP OAuth is not available on this deployment.' });
  };

  router.get('/api/v1/mcp-servers/:serverId/oauth', async (request: DashboardRequest, response: Response, next: NextFunction): Promise<void> => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      if (!oauth) return unavailable(response);
      response.json({ data: { status: await oauth.status(selected, mcpServerId.parse(request.params.serverId)) } });
    } catch (error) { if (!oauthFailure(error, response)) next(error); }
  });

  router.post('/api/v1/mcp-servers/:serverId/oauth/start', async (request: DashboardRequest, response: Response, next: NextFunction): Promise<void> => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      if (!oauth) return unavailable(response);
      const started = await oauth.start(selected, mcpServerId.parse(request.params.serverId));
      gateway.invalidateCatalog(selected);
      response.json({ data: { authorizationUrl: started.authorizationUrl } });
    } catch (error) { if (!oauthFailure(error, response)) next(error); }
  });

  router.post('/api/v1/mcp-servers/:serverId/oauth/disconnect', async (request: DashboardRequest, response: Response, next: NextFunction): Promise<void> => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      if (!oauth) return unavailable(response);
      const result = await oauth.disconnect(selected, mcpServerId.parse(request.params.serverId));
      gateway.invalidateCatalog(selected);
      response.json({ data: result });
    } catch (error) { if (!oauthFailure(error, response)) next(error); }
  });

  /**
   * Browser callback. The only trusted input is the one-time `state`; the redirect target is
   * built here from the server id the stored flow named, never from a query parameter.
   */
  router.get('/mcp-oauth/callback', async (request: DashboardRequest, response: Response, next: NextFunction): Promise<void> => {
    try {
      const selected = principalFromAuthInfo(request.auth);
      if (!selected || selected.kind !== 'external') {
        response.redirect(303, '/dashboard/mcp-servers');
        return;
      }
      const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
      const outcome = oauth
        ? await oauth.complete(selected, {
          ...(text(request.query.code) ? { code: text(request.query.code)! } : {}),
          ...(text(request.query.state) ? { state: text(request.query.state)! } : {}),
          ...(text(request.query.iss) ? { iss: text(request.query.iss)! } : {}),
          ...(text(request.query.error) ? { error: text(request.query.error)! } : {})
        })
        : { serverId: null, outcome: 'error' as const, reason: 'unavailable' as const };
      if (outcome.outcome === 'connected') gateway.invalidateCatalog(selected);
      const base = outcome.serverId && mcpServerId.safeParse(outcome.serverId).success
        ? `/dashboard/mcp-servers/${outcome.serverId}`
        : '/dashboard/mcp-servers';
      const status = outcome.outcome === 'connected' ? 'oauth=connected' : `oauth=error&reason=${outcome.reason}`;
      response.redirect(303, `${base}?${status}`);
    } catch (error) { next(error); }
  });

  function probe(kind: 'test' | 'refresh') {
    return async (request: DashboardRequest, response: Response, next: NextFunction): Promise<void> => {
      try {
        const selected = principal(request, response);
        if (!selected) return;
        const serverId = mcpServerId.parse(request.params.serverId);
        const result: ToolResult = kind === 'test'
          ? await gateway.testServer(selected, serverId, { clientId: 'dashboard' })
          : await gateway.refreshServer(selected, serverId, { clientId: 'dashboard' });
        if (!result.ok) {
          const code = result.error?.code ?? 'INTERNAL_ERROR';
          response.status(probeFailureStatus(code)).json({
            error: code.toLowerCase(),
            message: result.error?.message ?? result.message
          });
          return;
        }
        // A reachability answer is data, not a transport error: an unreachable server
        // still answers 200 with `status: 'error'`, and either outcome evicts the cache.
        gateway.invalidateCatalog(selected);
        gateway.invalidateConnection(serverId);
        response.json({ data: connectionData(result) });
      } catch (error) { next(error); }
    };
  }
}
