import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiConfig } from '@cloud-harness/contracts';
import { createApiApp, type ApiRuntime } from '../src/app.js';

const token = 'test-bearer-token-that-is-longer-than-32-characters';
let server: Server;
let runtime: ApiRuntime;
let url: string;

beforeEach(async () => {
  const config: ApiConfig = { host: '127.0.0.1', port: 0, ownerId: 'owner', bearerToken: token, runnerUrl: 'http://127.0.0.1:9', runnerToken: 'runner-token-that-is-longer-than-32-characters', publicHosts: ['127.0.0.1'], allowedOrigins: ['https://allowed.example'], requestTimeoutMs: 2_000, maxBodyBytes: 65_536 };
  runtime = createApiApp(config);
  server = createServer(runtime.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server failed');
  url = `http://127.0.0.1:${address.port}/mcp`;
});

afterEach(async () => {
  await runtime.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('MCP HTTP security', () => {
  it('rejects missing bearer before MCP dispatch', async () => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('rejects an incorrect non-empty bearer', async () => {
    const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer incorrect-token-that-is-longer-than-32-characters', 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(401);
  });

  it('does not let unauthenticated traffic exhaust the owner rate limit', async () => {
    for (let attempt = 0; attempt < 125; attempt += 1) {
      const rejected = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(rejected.status).toBe(401);
    }
    const owner = await fetch(url, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}'
    });
    expect(owner.status).not.toBe(429);
  });

  it('rejects a foreign Origin', async () => {
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(403);
  });

  it('rejects a foreign Host before authentication or MCP dispatch', async () => {
    const target = new URL(url);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { host: 'evil.example', authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
      request.end('{}');
    });
    expect(status).toBe(403);
  });
});
