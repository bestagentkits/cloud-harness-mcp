import express, { type Express, type Request, type Response } from 'express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { FetchLike } from '@modelcontextprotocol/client';
import type { ApiConfig } from '@cloud-harness/contracts';
import { accessAssertionAuth, apiKeyGatewayAuth, bearerAuth } from './auth.js';
import { createDashboardAssetsRouter } from './dashboard-assets.js';
import { createDashboardRouter } from './dashboard-router.js';
import { createCloudHarnessServerFactory } from './mcp-server.js';
import { createMcpGateway } from './mcp-gateway/index.js';
import type { McpGatewayService } from './mcp-gateway/service.js';
import { preAuthRequestLimits, principalRequestLimits, requestSecurity } from './request-security.js';
import { RunnerClient } from './runner-client.js';

export type ApiRuntime = {
  app: Express;
  close: () => Promise<void>;
  runnerClient: RunnerClient;
  gateway: McpGatewayService;
};

/**
 * `overrides` is a test-only seam: it injects a fake runner and a fake downstream
 * fetch so the gateway suites run offline. It defaults to today's behaviour exactly.
 */
export type ApiAppOverrides = { runnerClient?: RunnerClient; gatewayFetchImpl?: FetchLike };

export function createApiApp(config: ApiConfig, overrides: ApiAppOverrides = {}): ApiRuntime {
  const app = express();
  const runnerClient = overrides.runnerClient ?? new RunnerClient(config);
  const handler = createMcpHandler(createCloudHarnessServerFactory(runnerClient), { legacy: 'stateless', responseMode: 'auto' });
  const nodeHandler = toNodeHandler(handler);
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
  app.use('/mcp', requestSecurity(config), preAuthRequestLimits(), bearerAuth(config), principalRequestLimits());
  app.use('/mcp', express.json({ limit: config.maxBodyBytes, strict: true }));
  app.all('/mcp', async (request: Request, response: Response) => {
    if (request.method === 'POST' && !request.is('application/json')) {
      response.status(415).json({ error: 'unsupported_media_type' });
      return;
    }
    await nodeHandler(request, response, request.body);
  });
  // Express `app.use('/mcp', ...)` does not match `/mcp-gateway` (the next character
  // must be `/` or end), so the two chains cannot interfere.
  app.use('/mcp-gateway', requestSecurity(config), preAuthRequestLimits(), bearerAuth(config), principalRequestLimits());
  app.use('/mcp-gateway', express.json({ limit: config.maxBodyBytes, strict: true }));
  app.all('/mcp-gateway', async (request: Request, response: Response) => {
    if (request.method === 'POST' && !request.is('application/json')) {
      response.status(415).json({ error: 'unsupported_media_type' });
      return;
    }
    await gatewayNodeHandler(request, response, request.body);
  });
  if (config.authMode === 'cloudflare-access' && config.apiKeyAuthEnabled) {
    app.use('/mcp-api-key', requestSecurity(config), preAuthRequestLimits(), apiKeyGatewayAuth(config, runnerClient), principalRequestLimits());
    app.use('/mcp-api-key', express.json({ limit: config.maxBodyBytes, strict: true }));
    app.all('/mcp-api-key', async (request: Request, response: Response) => {
      if (request.method === 'POST' && !request.is('application/json')) {
        response.status(415).json({ error: 'unsupported_media_type' });
        return;
      }
      await nodeHandler(request, response, request.body);
    });
  }
  if (config.authMode === 'cloudflare-access') {
    app.use('/dashboard', requestSecurity(config), preAuthRequestLimits(), accessAssertionAuth(config), principalRequestLimits());
    app.use('/dashboard', createDashboardRouter(config, runnerClient, gateway.service));
    app.use('/dashboard', createDashboardAssetsRouter());
  }
  return {
    app,
    close: async () => {
      await Promise.all([handler.close(), gatewayHandler.close(), gateway.service.close()]);
    },
    runnerClient,
    gateway: gateway.service
  };
}
