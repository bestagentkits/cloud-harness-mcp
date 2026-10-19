import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig, AutomationsRunnerRequest, AutomationsRunnerResponse } from '@cloud-harness/contracts';
import { createApiApp, type ApiRuntime } from '../src/app.js';
import { apiLogger } from '../src/logging.js';
import type { RunnerClient } from '../src/runner-client.js';

const connectionId = `whc_${'a'.repeat(32)}`;
const signature = `sha256=${'f'.repeat(64)}`;
const baseConfig: ApiConfig = {
  host: '127.0.0.1', port: 0, ownerId: 'owner', authMode: 'owner-bearer',
  bearerToken: 'test-bearer-token-that-is-longer-than-32-characters', runnerUrl: 'http://127.0.0.1:9',
  runnerToken: 'runner-token-that-is-longer-than-32-characters', publicHosts: ['127.0.0.1'],
  allowedOrigins: [], requestTimeoutMs: 2_000, maxBodyBytes: 65_536,
  mcpGatewayTimeoutMs: 30_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
  mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
  mcpGatewayMaxConnections: 32, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false,
  apiKeyAuthEnabled: false, automationsEnabled: true
} as ApiConfig;

type Harness = { origin: string; runtime: ApiRuntime; server: Server; requests: AutomationsRunnerRequest[] };
const open: Harness[] = [];

async function start(
  reply: (request: AutomationsRunnerRequest) => Promise<AutomationsRunnerResponse> | AutomationsRunnerResponse = () => ({ ok: true, data: { outcome: 'accepted' } }),
  overrides: Partial<ApiConfig> = {}
): Promise<Harness> {
  const requests: AutomationsRunnerRequest[] = [];
  const runner = {
    callAutomations: vi.fn(async (request: AutomationsRunnerRequest) => { requests.push(request); return await reply(request); }),
    ready: async () => true
  } as unknown as RunnerClient;
  const runtime = createApiApp({ ...baseConfig, ...overrides } as ApiConfig, { runnerClient: runner });
  const server = createServer(runtime.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server failed');
  const harness = { origin: `http://127.0.0.1:${address.port}`, runtime, server, requests };
  open.push(harness);
  return harness;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const harness of open.splice(0)) {
    await harness.runtime.close();
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  }
});

const githubHeaders = (overrides: Record<string, string | undefined> = {}): Record<string, string> => Object.fromEntries(Object.entries({
  'content-type': 'application/json',
  'x-github-event': 'issues',
  'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958',
  'x-hub-signature-256': signature,
  ...overrides
}).filter((entry): entry is [string, string] => entry[1] !== undefined));

async function deliver(harness: Harness, body: Buffer | string = '{"action":"labeled"}', headers = githubHeaders(), id = connectionId): Promise<Response> {
  return await fetch(`${harness.origin}/integrations/webhooks/github/${id}`, { method: 'POST', headers, body });
}

describe('automation webhook ingress', () => {
  it('is not mounted when automations are disabled', async () => {
    const harness = await start(undefined, { automationsEnabled: false });
    const response = await deliver(harness);
    expect(response.status).toBe(404);
    expect(harness.requests).toHaveLength(0);
  });

  it('forwards the exact raw bytes and only the allowlisted GitHub headers to the runner', async () => {
    const harness = await start();
    // Whitespace, key order and non-ASCII text must survive untouched: the signature covers these bytes.
    const raw = Buffer.from('{ "action":"labeled",  "label":{"name":"triage ✓"}, "z":1 }\n', 'utf8');
    const response = await deliver(harness, raw, githubHeaders({ cookie: 'session=secret', 'linear-signature': 'x', 'x-forwarded-for': '10.0.0.1' }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'accepted' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(harness.requests).toEqual([{
      version: 1,
      operation: 'webhook_ingest',
      input: {
        provider: 'github', connectionId,
        headers: { 'x-github-event': 'issues', 'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958', 'x-hub-signature-256': signature },
        bodyBase64: raw.toString('base64')
      }
    }]);
  });

  it.each([
    ['linear', { 'linear-event': 'Issue', 'linear-delivery': 'd-1', 'linear-signature': 'a'.repeat(64) }],
    ['jira', { 'x-atlassian-webhook-identifier': '42', 'x-hub-signature': `sha256=${'b'.repeat(64)}` }],
    ['jira', { 'x-hub-signature': `sha256=${'b'.repeat(64)}` }],
    ['custom', { 'x-cloudharness-delivery': 'd-2', 'x-cloudharness-timestamp': '1792400000', 'x-cloudharness-signature': `v1=${'c'.repeat(64)}` }]
  ] as const)('forwards the %s allowlist and nothing else', async (provider, providerHeaders) => {
    const harness = await start();
    const response = await fetch(`${harness.origin}/integrations/webhooks/${provider}/${connectionId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...providerHeaders, 'x-github-event': 'issues', authorization: 'Bearer leaked' },
      body: '{}'
    });
    expect(response.status).toBe(202);
    expect(harness.requests).toEqual([{
      version: 1, operation: 'webhook_ingest', input: { provider, connectionId, headers: providerHeaders, bodyBase64: Buffer.from('{}').toString('base64') }
    }]);
  });

  it('forwards only webhook_ingest, even when the request names a management operation', async () => {
    const harness = await start();
    const management = JSON.stringify({ version: 1, principal: { kind: 'owner', ownerId: 'owner' }, operation: 'rules_list', input: {} });
    const response = await fetch(`${harness.origin}/integrations/webhooks/github/${connectionId}?operation=rule_create`, {
      method: 'POST', headers: githubHeaders({ 'x-cloudharness-operation': 'rule_update', authorization: 'Bearer test-bearer-token-that-is-longer-than-32-characters' }), body: management
    });
    expect(response.status).toBe(202);
    for (const path of ['rules_list', `rule_create/${connectionId}`, `github/${connectionId}/rules_list`]) {
      expect((await fetch(`${harness.origin}/integrations/webhooks/${path}`, { method: 'POST', headers: githubHeaders(), body: management })).status, path).toBe(404);
    }
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toEqual({
      version: 1, operation: 'webhook_ingest',
      input: { provider: 'github', connectionId, headers: expect.any(Object), bodyBase64: Buffer.from(management).toString('base64') }
    });
    expect(harness.requests[0]).not.toHaveProperty('principal');
  });

  it.each([
    ['linear', { 'linear-event': 'Issue', 'linear-delivery': 'd-1' }, 401],
    ['linear', { 'linear-delivery': 'd-1', 'linear-signature': 's' }, 400],
    ['jira', { 'x-atlassian-webhook-identifier': '42' }, 401],
    ['jira', { 'x-atlassian-webhook-identifier': 'i'.repeat(101), 'x-hub-signature': 's' }, 400],
    ['custom', { 'x-cloudharness-delivery': 'd', 'x-cloudharness-signature': 's' }, 400],
    ['custom', { 'x-cloudharness-delivery': 'd', 'x-cloudharness-timestamp': '1', 'x-cloudharness-signature': 's'.repeat(201) }, 401]
  ] as const)('rejects incomplete %s headers before the runner', async (provider, providerHeaders, status) => {
    const harness = await start();
    const response = await fetch(`${harness.origin}/integrations/webhooks/${provider}/${connectionId}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...providerHeaders }, body: '{}'
    });
    expect(response.status).toBe(status);
    expect(harness.requests).toHaveLength(0);
  });

  it('does not route an unknown provider', async () => {
    const harness = await start();
    const response = await fetch(`${harness.origin}/integrations/webhooks/gitlab/${connectionId}`, { method: 'POST', headers: githubHeaders(), body: '{}' });
    expect(response.status).toBe(404);
    expect(harness.requests).toHaveLength(0);
  });

  it.each(['duplicate', 'ignored'] as const)('acknowledges a %s delivery with 202', async (outcome) => {
    const harness = await start(() => ({ ok: true, data: { outcome } }));
    const response = await deliver(harness);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: outcome });
  });

  it('returns one identical 401 body for an unknown connection, a bad signature and a missing signature', async () => {
    const harness = await start(() => ({ ok: false, error: { code: 'UNAUTHORIZED', message: 'connection whc_x unknown' } }));
    const unknown = await deliver(harness, '{}', githubHeaders(), `whc_${'b'.repeat(32)}`);
    const badSignature = await deliver(harness, '{}', githubHeaders({ 'x-hub-signature-256': 'sha256=00' }));
    const missing = await deliver(harness, '{}', githubHeaders({ 'x-hub-signature-256': undefined }));
    const overlongId = await deliver(harness, '{}', githubHeaders(), 'x'.repeat(101));
    const bodies = await Promise.all([unknown, badSignature, missing, overlongId].map(async (response) => ({ status: response.status, text: await response.text() })));
    for (const body of bodies) expect(body).toEqual({ status: 401, text: JSON.stringify({ error: 'unauthorized' }) });
    // The missing signature and the overlong id never reach the runner.
    expect(harness.requests).toHaveLength(2);
  });

  it.each([
    ['event', { 'x-github-event': undefined }],
    ['delivery', { 'x-github-delivery': undefined }],
    ['overlong event', { 'x-github-event': 'e'.repeat(65) }]
  ])('rejects a missing or malformed %s header with 400', async (_name, overrides) => {
    const harness = await start();
    const response = await deliver(harness, '{}', githubHeaders(overrides));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(harness.requests).toHaveLength(0);
  });

  it('requires a JSON content type', async () => {
    const harness = await start();
    const response = await deliver(harness, 'payload=%7B%7D', githubHeaders({ 'content-type': 'application/x-www-form-urlencoded' }));
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: 'unsupported_media_type' });
    expect(harness.requests).toHaveLength(0);
  });

  it('refuses a body above the raw byte cap with a JSON 413', async () => {
    const harness = await start();
    const response = await deliver(harness, Buffer.alloc(1_048_577, 0x20));
    expect(response.status).toBe(413);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ error: 'payload_too_large' });
    expect(harness.requests).toHaveLength(0);
  });

  it('maps runner validation, exhaustion and failure codes', async () => {
    const replies: AutomationsRunnerResponse[] = [
      { ok: false, error: { code: 'INVALID_INPUT', message: 'bad payload' } },
      { ok: false, error: { code: 'RESOURCE_EXHAUSTED', message: 'queue full' } },
      { ok: false, error: { code: 'UNAVAILABLE', message: 'Runner is unavailable' } },
      { ok: false, error: { code: 'INTERNAL', message: 'boom /var/lib/state' } },
      { ok: true, data: { outcome: 'something-else' } }
    ];
    const harness = await start(() => replies.shift()!);
    const invalid = await deliver(harness);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'invalid_request' });
    const exhausted = await deliver(harness);
    expect(exhausted.status).toBe(429);
    expect(exhausted.headers.get('retry-after')).toBe('60');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await deliver(harness);
      expect(failed.status).toBe(503);
      expect(await failed.text()).toBe(JSON.stringify({ error: 'unavailable' }));
    }
  });

  it('answers 503 when the runner call throws', async () => {
    const harness = await start(() => { throw new Error('socket hang up'); });
    const response = await deliver(harness);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'unavailable' });
  });

  it('applies its own concurrency window before reaching the runner', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const harness = await start(async () => { await gate; return { ok: true, data: { outcome: 'accepted' } }; });
    const pending = Array.from({ length: 16 }, async () => await deliver(harness));
    await vi.waitFor(() => expect(harness.requests).toHaveLength(16));
    const limited = await deliver(harness);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');
    release();
    for (const response of await Promise.all(pending)) expect(response.status).toBe(202);
  });

  it('rejects a malformed connection id with the shared 401 before the runner', async () => {
    const harness = await start();
    const valid = await deliver(harness, undefined, githubHeaders(), `whc_${'0'.repeat(32)}`);
    const malformed = await deliver(harness, undefined, githubHeaders(), 'not-a-connection');
    expect(malformed.status).toBe(401);
    expect(await malformed.text()).toBe(JSON.stringify({ error: 'unauthorized' }));
    expect(valid.status).toBe(202);
    expect(harness.requests).toHaveLength(1);
  });

  it('keeps each connection in its own rate window so other traffic cannot starve it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const other = `whc_${'b'.repeat(32)}`;
    const harness = await start(async (request) => {
      if ((request.input as { connectionId: string }).connectionId === other) await gate;
      return { ok: true, data: { outcome: 'accepted' } };
    });
    const flood = Array.from({ length: 16 }, async () => await deliver(harness, undefined, githubHeaders(), other));
    await vi.waitFor(() => expect(harness.requests).toHaveLength(16));
    expect((await deliver(harness, undefined, githubHeaders(), other)).status).toBe(429);
    expect((await deliver(harness)).status).toBe(202);
    release();
    for (const response of await Promise.all(flood)) expect(response.status).toBe(202);
  });

  it('rejects a foreign Host before forwarding', async () => {
    const harness = await start();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const target = new URL(harness.origin);
      const request = httpRequest({
        hostname: target.hostname, port: target.port, path: `/integrations/webhooks/github/${connectionId}`, method: 'POST',
        headers: { ...githubHeaders(), host: 'evil.example' }
      }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
      request.end('{}');
    });
    expect(status).toBe(403);
    expect(harness.requests).toHaveLength(0);
  });

  it('never logs the body or the signature', async () => {
    const logged: unknown[] = [];
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      vi.spyOn(apiLogger, level).mockImplementation(((...args: unknown[]) => { logged.push(args); }) as never);
    }
    const replies: Array<() => AutomationsRunnerResponse> = [
      () => ({ ok: false, error: { code: 'INTERNAL', message: 'boom' } }),
      () => { throw new Error('socket hang up'); },
      () => ({ ok: true, data: { outcome: 'accepted' } })
    ];
    const harness = await start(() => replies.shift()!());
    const secretBody = '{"marker":"body-canary-7f3a"}';
    const secretSignature = 'sha256=signature-canary-9c1e';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await deliver(harness, secretBody, githubHeaders({ 'x-hub-signature-256': secretSignature }));
    }
    expect(logged.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain('body-canary-7f3a');
    expect(serialized).not.toContain(Buffer.from(secretBody).toString('base64'));
    expect(serialized).not.toContain('signature-canary-9c1e');
  });
});
