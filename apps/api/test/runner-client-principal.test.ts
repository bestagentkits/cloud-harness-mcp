import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig, RunnerRequest } from '@cloud-harness/contracts';
import { RunnerClient } from '../src/runner-client.js';

const config: ApiConfig = {
  host: '127.0.0.1', port: 3000, ownerId: 'owner', bearerToken: 'owner-token-that-is-long-enough-123456',
  runnerUrl: 'http://runner:3001', runnerToken: 'runner-token-that-is-longer-than-32-characters',
  publicHosts: ['localhost'], allowedOrigins: [], requestTimeoutMs: 2_000, maxBodyBytes: 65_536
};

afterEach(() => vi.unstubAllGlobals());

describe('RunnerClient principal forwarding', () => {
  it('sends each request-local principal in the v2 runner envelope', async () => {
    const bodies: RunnerRequest[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as RunnerRequest);
      await new Promise((resolve) => setTimeout(resolve, 1));
      return new Response(JSON.stringify({ ok: true, message: 'ok', truncated: false }), { status: 200 });
    }));
    const client = new RunnerClient(config);
    await Promise.all([
      client.call('workspace_list', {}, { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject: 'first' }),
      client.call('workspace_list', {}, { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject: 'second' })
    ]);
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => body.version === 2)).toBe(true);
    expect(new Set(bodies.map((body) => body.version === 2 && body.principal.kind === 'external' ? body.principal.subject : 'legacy'))).toEqual(new Set(['first', 'second']));
  });
});
