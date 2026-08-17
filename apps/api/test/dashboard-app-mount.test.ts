import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiConfig } from '@cloud-harness/contracts';
import { createApiApp, type ApiRuntime } from '../src/app.js';
import { createDashboardAssetsRouter } from '../src/dashboard-assets.js';

const runnerToken = 'runner-token-that-is-longer-than-32-characters';
const bearerToken = 'owner-token-that-is-longer-than-32-characters';
let server: Server | undefined;
let runtime: ApiRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  runtime = undefined;
});

async function serve(config: ApiConfig): Promise<string> {
  runtime = createApiApp(config);
  server = createServer(runtime.app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server failed');
  return `http://127.0.0.1:${address.port}`;
}

describe('dashboard application mount', () => {
  it('serves the dashboard shell for every direct navigation route', async () => {
    const app = express();
    app.use('/dashboard', createDashboardAssetsRouter());
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server failed');
    for (const path of ['/projects', '/projects/prj_abcdefghijklmnopqrst', '/artifacts', '/audit', '/github']) {
      const response = await fetch(`http://127.0.0.1:${address.port}/dashboard${path}`);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain('<title>Workspaces | Cloud Harness</title>');
    }
  });

  it('does not expose dashboard routes in owner-bearer mode', async () => {
    const url = await serve({
      authMode: 'owner-bearer', host: '127.0.0.1', port: 0, ownerId: 'owner', bearerToken,
      runnerUrl: 'http://127.0.0.1:9', runnerToken, publicHosts: ['127.0.0.1'],
      allowedOrigins: [], requestTimeoutMs: 2_000, maxBodyBytes: 65_536
    });
    expect((await fetch(`${url}/dashboard`)).status).toBe(404);
  });

  it('requires a verified Access assertion before serving dashboard assets', async () => {
    const url = await serve({
      authMode: 'cloudflare-access', host: '127.0.0.1', port: 0, ownerId: 'owner',
      accessIssuer: 'https://team.cloudflareaccess.com', accessAudience: 'dashboard-audience',
      accessJwksUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs',
      runnerUrl: 'http://127.0.0.1:9', runnerToken, publicHosts: ['127.0.0.1'],
      allowedOrigins: [], requestTimeoutMs: 2_000, maxBodyBytes: 65_536
    });
    const response = await fetch(`${url}/dashboard`);
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});
