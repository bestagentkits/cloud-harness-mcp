import express, { type Express, type Request, type Response } from 'express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { ApiConfig } from '@cloud-harness/contracts';
import { bearerAuth } from './auth.js';
import { createCloudHarnessServer } from './mcp-server.js';
import { requestLimits, requestSecurity } from './request-security.js';
import { RunnerClient } from './runner-client.js';

export type ApiRuntime = { app: Express; close: () => Promise<void>; runnerClient: RunnerClient };

export function createApiApp(config: ApiConfig): ApiRuntime {
  const app = express();
  const runnerClient = new RunnerClient(config);
  const handler = createMcpHandler(() => createCloudHarnessServer(runnerClient), { legacy: 'stateless', responseMode: 'auto' });
  const nodeHandler = toNodeHandler(handler);
  app.disable('x-powered-by');
  app.get('/healthz', (_request, response) => response.json({ status: 'ok' }));
  app.get('/readyz', async (_request, response) => {
    const ready = await runnerClient.ready();
    response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable' });
  });
  app.use('/mcp', requestSecurity(config), bearerAuth(config), requestLimits());
  app.use('/mcp', express.json({ limit: config.maxBodyBytes, strict: true }));
  app.all('/mcp', async (request: Request, response: Response) => {
    if (request.method === 'POST' && !request.is('application/json')) {
      response.status(415).json({ error: 'unsupported_media_type' });
      return;
    }
    await nodeHandler(request, response, request.body);
  });
  return { app, close: () => handler.close(), runnerClient };
}
