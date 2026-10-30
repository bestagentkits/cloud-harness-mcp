import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { FetchLike } from '@modelcontextprotocol/client';
import { WorkspaceIdSchema, type ApiConfig } from '@cloud-harness/contracts';
import {
  accessAssertionAuth, agentkitBearerAuth, agentkitProtectedResourceMetadata, apiKeyGatewayAuth, bearerAuth, isAgentkitRequest,
  type AgentkitVerifierOverrides, type AuthenticatedRequest, type VerifierOverrides
} from './auth.js';
import { createDashboardAssetsRouter } from './dashboard-assets.js';
import { createDashboardReactRouter, loadDashboardReactBundle } from './dashboard-react-assets.js';
import { createDashboardRouter } from './dashboard-router.js';
import { bindWorkspace, createCloudHarnessServerFactory, createWorkspaceBoundServerFactory } from './mcp-server.js';
import { createMcpGateway } from './mcp-gateway/index.js';
import type { McpGatewayService } from './mcp-gateway/service.js';
import { preAuthRequestLimits, principalRequestLimits, requestSecurity } from './request-security.js';
import { RunnerClient } from './runner-client.js';
import { EventDeliveryWorker } from './events/event-delivery-worker.js';
import { createWebhookSender, type WebhookSender } from './events/webhook-sender.js';
import { apiLogger } from './logging.js';
import { createAutomationWebhookIngress } from './automations/webhook-ingress.js';

export type ApiRuntime = {
  app: Express;
  close: () => Promise<void>;
  runnerClient: RunnerClient;
  gateway: McpGatewayService;
  /** Starts the MCP Events delivery worker; the remote entrypoint calls it once it is listening. */
  startEventDelivery: () => void;
};

/**
 * `overrides` is a test-only seam: it injects a fake runner, a fake downstream fetch,
 * and an offline Access JWKS source so the gateway suites run offline. It defaults to
 * today's behaviour exactly.
 */
export type ApiAppOverrides = {
  runnerClient?: RunnerClient;
  gatewayFetchImpl?: FetchLike;
  accessVerifier?: VerifierOverrides;
  agentkitVerifier?: AgentkitVerifierOverrides;
  webhookSender?: WebhookSender;
  /** Built React Dashboard directory; defaults to `apps/dashboard/dist`. */
  dashboardReactDirectory?: string;
};

export function createApiApp(config: ApiConfig, overrides: ApiAppOverrides = {}): ApiRuntime {
  const app = express();
  const runnerClient = overrides.runnerClient ?? new RunnerClient(config);
  const events = { sender: overrides.webhookSender ?? createWebhookSender() };
  const deliveryWorker = new EventDeliveryWorker({
    callRunner: (request, signal) => runnerClient.callEvents(request, signal),
    sender: events.sender,
    onError: (stage, reason) => apiLogger.warn({ stage, reason }, 'MCP event delivery pass failed')
  });
  // Owner automation management stays on the authenticated MCP endpoints; the public webhook
  // ingress below only ever forwards `webhook_ingest`.
  const automations = { enabled: config.automationsEnabled === true };
  const handler = createMcpHandler(createCloudHarnessServerFactory(runnerClient, events, automations), { legacy: 'stateless', responseMode: 'auto' });
  const nodeHandler = toNodeHandler(handler);
  const boundHandler = createMcpHandler(createWorkspaceBoundServerFactory(runnerClient, events, automations), { legacy: 'stateless', responseMode: 'auto' });
  const boundNodeHandler = toNodeHandler(boundHandler);
  const gateway = createMcpGateway(config, runnerClient, {
    ...(overrides.gatewayFetchImpl ? { fetchImpl: overrides.gatewayFetchImpl } : {})
  });
  const gatewayHandler = createMcpHandler(gateway.factory, { legacy: 'stateless', responseMode: 'auto' });
  const gatewayNodeHandler = toNodeHandler(gatewayHandler);
  app.disable('x-powered-by');
  app.get('/healthz', (_request, response) => response.json({ status: 'ok' }));
  app.get('/readyz', async (_request, response) => {
    const ready = await runnerClient.ready();
    response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable' });
  });
  const verifierOverrides = overrides.accessVerifier ?? {};
  const instanceAuth = bearerAuth(config, verifierOverrides);
  const agentkitAuth = agentkitBearerAuth(config, overrides.agentkitVerifier ?? {});
  // Requests addressed to the agentkit.best resource host use only the agentkit.best lane; every
  // other host keeps the instance's own lane, so enabling it never changes existing sign-in.
  const mcpAuth = (request: AuthenticatedRequest, response: Response, next: NextFunction): void => {
    if (isAgentkitRequest(config, request)) void agentkitAuth(request, response, next);
    else void instanceAuth(request, response, next);
  };
  if (config.agentkitAuthEnabled) {
    const metadata = [requestSecurity(config), preAuthRequestLimits(), agentkitProtectedResourceMetadata(config)];
    app.get('/.well-known/oauth-protected-resource', ...metadata);
    app.get('/.well-known/oauth-protected-resource/mcp', ...metadata);
  }
  app.use('/mcp', requestSecurity(config), preAuthRequestLimits(), mcpAuth, principalRequestLimits());
  app.use('/mcp', express.json({ limit: config.maxBodyBytes, strict: true }));
  app.all('/mcp', async (request: Request, response: Response) => {
    if (request.method === 'POST' && !request.is('application/json')) {
      response.status(415).json({ error: 'unsupported_media_type' });
      return;
    }
    await nodeHandler(request, response, request.body);
  });
  // The `app.use('/mcp', ...)` chain above is a prefix mount, so this route is already behind
  // the same host/origin checks, authentication, rate limits, and body parser. The exact
  // `app.all('/mcp')` route does not match it. The binding comes only from this path segment.
  app.all('/mcp/workspaces/:workspaceId', async (request: AuthenticatedRequest, response: Response) => {
    const workspaceId = WorkspaceIdSchema.safeParse(request.params.workspaceId);
    if (!workspaceId.success) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    if (request.method === 'POST' && !request.is('application/json')) {
      response.status(415).json({ error: 'unsupported_media_type' });
      return;
    }
    if (!request.auth) {
      response.status(401).json({ error: 'authentication_required' });
      return;
    }
    request.auth = bindWorkspace(request.auth, workspaceId.data);
    await boundNodeHandler(request, response, request.body);
  });
  // Express `app.use('/mcp', ...)` does not match `/mcp-gateway` (the next character
  // must be `/` or end), so the two chains cannot interfere.
  // The agentkit.best resource is `/mcp` only; its host never reaches the gateway.
  const gatewayAuth = (request: AuthenticatedRequest, response: Response, next: NextFunction): void => {
    if (isAgentkitRequest(config, request)) response.status(404).json({ error: 'not_found' });
    else void instanceAuth(request, response, next);
  };
  app.use('/mcp-gateway', requestSecurity(config), preAuthRequestLimits(), gatewayAuth, principalRequestLimits());
  app.use('/mcp-gateway', express.json({ limit: config.maxBodyBytes, strict: true }));
  app.all('/mcp-gateway', async (request: Request, response: Response) => {
    if (request.method === 'POST' && !request.is('application/json')) {
      response.status(415).json({ error: 'unsupported_media_type' });
      return;
    }
    await gatewayNodeHandler(request, response, request.body);
  });
  if (config.authMode === 'cloudflare-access' && config.apiKeyAuthEnabled) {
    app.use(
      '/mcp-api-key',
      requestSecurity(config),
      preAuthRequestLimits(),
      apiKeyGatewayAuth(config, runnerClient, verifierOverrides),
      principalRequestLimits()
    );
    app.use('/mcp-api-key', express.json({ limit: config.maxBodyBytes, strict: true }));
    app.all('/mcp-api-key', async (request: Request, response: Response) => {
      if (request.method === 'POST' && !request.is('application/json')) {
        response.status(415).json({ error: 'unsupported_media_type' });
        return;
      }
      await nodeHandler(request, response, request.body);
    });
    // The prefix mount above already applies the host/origin checks, the dual-credential
    // verification (Worker service assertion and principal-bound managed key), rate limits,
    // and the body parser. Keeping the gateway under `/mcp-api-key/` keeps it inside the
    // path-scoped Access application that protects the API-key lane.
    app.all('/mcp-api-key/gateway', async (request: Request, response: Response) => {
      if (request.method === 'POST' && !request.is('application/json')) {
        response.status(415).json({ error: 'unsupported_media_type' });
        return;
      }
      await gatewayNodeHandler(request, response, request.body);
    });
  }
  // Public, unauthenticated webhook ingress: the runner verifies each delivery's HMAC signature.
  // It is mounted only when automations are enabled, so the path does not exist otherwise.
  if (config.automationsEnabled) app.use(createAutomationWebhookIngress(config, runnerClient));
  if (config.authMode === 'cloudflare-access') {
    // Authentication and broad pre-auth DoS protection cover the whole Dashboard,
    // while the tighter per-principal budget is reserved for BFF/API operations.
    // Static shell/assets are browser transport overhead and must not consume the
    // same 120-request/minute budget as user-initiated control-plane requests.
    app.use('/dashboard', requestSecurity(config), preAuthRequestLimits(), accessAssertionAuth(config, verifierOverrides));
    app.use('/dashboard/api/v1', principalRequestLimits());
    app.use('/dashboard', createDashboardRouter(config, runnerClient, gateway.service));
    app.use('/dashboard', createDashboardReactRouter(config, loadDashboardReactBundle(overrides.dashboardReactDirectory)));
    app.use('/dashboard', createDashboardAssetsRouter());
  }
  return {
    app,
    close: async () => {
      await Promise.all([deliveryWorker.stop(), handler.close(), boundHandler.close(), gatewayHandler.close(), gateway.service.close()]);
    },
    startEventDelivery: () => deliveryWorker.start(),
    runnerClient,
    gateway: gateway.service
  };
}
