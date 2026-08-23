import express, { type Express, type Request, type Response } from 'express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { ApiConfig } from '@cloud-harness/contracts';
import { accessAssertionAuth, apiKeyGatewayAuth, bearerAuth } from './auth.js';
import { createDashboardAssetsRouter } from './dashboard-assets.js';
import { createDashboardRouter } from './dashboard-router.js';
import { createCloudHarnessServerFactory } from './mcp-server.js';
import { preAuthRequestLimits, principalRequestLimits, requestSecurity } from './request-security.js';
import { RunnerClient } from './runner-client.js';

export type ApiRuntime = { app: Express; close: () => Promise<void>; runnerClient: RunnerClient };

export function createApiApp(config: ApiConfig): ApiRuntime {
  const app = express();
  const runnerClient = new RunnerClient(config);
  const handler = createMcpHandler(createCloudHarnessServerFactory(runnerClient), { legacy: 'stateless', responseMode: 'auto' });
  const nodeHandler = toNodeHandler(handler);
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
    app.use('/dashboard', createDashboardRouter(config, runnerClient));
    app.use('/dashboard', createDashboardAssetsRouter());
  }
  return { app, close: () => handler.close(), runnerClient };
}
