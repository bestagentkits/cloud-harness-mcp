import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:https';
import { request as httpRequest, type RequestListener, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertProductionHostname, isUnsafeAddress, loadGatewayConfig, readExactSecret } from '../src/config.js';
import { createLeaseGrant, LeaseRegistry } from '../src/lease-registry.js';
import { createGatewayRuntime, type GatewayRuntime } from '../src/gateway.js';
import { reserveBudget } from '../src/budget.js';
import { startUpstreamRequest } from '../src/upstream.js';
import type { BudgetReservation, GatewayConfig, GatewayLogger, GatewayProfile, LeaseIssueInput, Usage } from '../src/types.js';

let fixtureDirectory = '';
let credentialFile = '';
let certificateFile = '';
let privateKeyFile = '';
const runtimes: GatewayRuntime[] = [];
const tlsServers: TlsServer[] = [];

function profile(upstream: URL, limits: Partial<GatewayProfile['limits']> = {}): GatewayProfile {
  return {
    id: 'fake-test-only',
    provider: 'fake',
    model: 'fixed-model',
    downstreamPath: '/v1/chat/completions',
    upstream,
    credentialFile,
    credentialHeader: 'authorization',
    credentialScheme: 'Bearer',
    inputMicrosPerMillionTokens: 1_000,
    outputMicrosPerMillionTokens: 2_000,
    limits: {
      maxRequestBytes: 65_536,
      maxResponseBytes: 1_048_576,
      maxHeaderBytes: 8_192,
      maxHeaders: 24,
      deadlineMs: 5_000,
      maxInputTokens: 4_096,
      maxOutputTokens: 1_024,
      maxCostMicros: 1_000_000,
      maxStreamLineBytes: 65_536,
      ...limits
    },
    testOnly: true,
    allowPrivateUpstream: true,
    tlsCaFile: certificateFile
  };
}

function grant(profileId: string, inputTokens: number, outputTokens: number, costMicros: number) {
  return createLeaseGrant({ agentId: issue().agentId, profileId, expiresAt: Date.now() + 1_000, inputTokens, outputTokens, costMicros });
}

type ActivatedLease = LeaseIssueInput & { lease: string };

function issue(profileId = 'fake-test-only'): LeaseIssueInput {
  return {
    leaseId: `lease-${randomBytes(16).toString('hex')}`,
    agentId: 'agent_0123456789abcdefghij',
    profileId,
    ttlMs: 30_000,
    maxInputTokens: 4_096,
    maxOutputTokens: 1_024,
    maxCostMicros: 1_000_000
  };
}

function activate(runtime: GatewayRuntime, input: LeaseIssueInput): ActivatedLease {
  return { ...input, lease: runtime.issueLease(input) };
}

async function fakeProvider(handler: RequestListener): Promise<{ server: TlsServer; upstream: URL }> {
  const server = createTlsServer({ key: await readFile(privateKeyFile), cert: await readFile(certificateFile) }, handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  tlsServers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('TLS server address unavailable');
  return { server, upstream: new URL(`https://127.0.0.1:${address.port}/v1/chat/completions`) };
}

async function gateway(
  gatewayProfile: GatewayProfile,
  hooks?: Parameters<typeof createGatewayRuntime>[1],
  logger: GatewayLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  extraConfig: Partial<GatewayConfig> = {}
): Promise<{ runtime: GatewayRuntime; baseUrl: string }> {
  const controlSocket = process.platform === 'win32'
    ? `\\\\.\\pipe\\model-gateway-${randomBytes(8).toString('hex')}`
    : join(tmpdir(), `model-gateway-${randomBytes(8).toString('hex')}.sock`);
  const config: GatewayConfig = {
    mode: 'test', host: '127.0.0.1', port: 0, controlSocket,
    profiles: new Map([[gatewayProfile.id, gatewayProfile]]),
    ...extraConfig
  };
  const runtime = createGatewayRuntime(config, hooks, logger);
  await runtime.listen();
  runtimes.push(runtime);
  const address = runtime.httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('gateway address unavailable');
  return { runtime, baseUrl: `http://127.0.0.1:${address.port}` };
}

function controlSocketPath(): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\model-gateway-${randomBytes(8).toString('hex')}`
    : join(tmpdir(), `model-gateway-${randomBytes(8).toString('hex')}.sock`);
}

async function control(socketPath: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let reply = '';
    socket.on('data', (chunk: Buffer) => { reply += chunk.toString('utf8'); });
    socket.on('end', () => { try { resolve(JSON.parse(reply) as Record<string, unknown>); } catch (error) { reject(error); } });
    socket.on('error', reject);
    socket.end(`${JSON.stringify(payload)}\n`);
  });
}

function recordingHooks() {
  const reserved: BudgetReservation[] = [];
  const reconciled: Usage[] = [];
  return {
    reserved,
    reconciled,
    hooks: {
      reserve: (reservation: BudgetReservation) => { reserved.push({ ...reservation }); },
      reconcile: (_reservation: BudgetReservation, actual: Usage) => { reconciled.push(actual); }
    }
  };
}

// 2 micros per input token, 8 per output token, 0.5 per cache read, 4 per cache write.
function pricedProfile(upstream: URL, overrides: Partial<GatewayProfile> = {}): GatewayProfile {
  return {
    ...profile(upstream),
    inputMicrosPerMillionTokens: 2_000_000,
    outputMicrosPerMillionTokens: 8_000_000,
    cacheReadMicrosPerMillionTokens: 500_000,
    cacheWriteMicrosPerMillionTokens: 4_000_000,
    ...overrides
  };
}

function headers(grant: ActivatedLease): Record<string, string> {
  return {
    authorization: `Bearer ${grant.lease}`,
    'content-type': 'application/json',
    'x-agent-id': grant.agentId,
    'x-model-profile': grant.profileId,
    'x-request-id': randomBytes(12).toString('base64url')
  };
}

beforeAll(async () => {
  fixtureDirectory = await realpath(await mkdtemp(join(tmpdir(), 'model-gateway-tls-')));
  credentialFile = join(fixtureDirectory, 'provider-api-key');
  certificateFile = join(fixtureDirectory, 'server-cert.pem');
  privateKeyFile = join(fixtureDirectory, 'server-key.pem');
  await writeFile(credentialFile, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
  const generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-subj', '/CN=fake-provider',
    '-addext', 'subjectAltName=DNS:fake-provider,DNS:localhost,IP:127.0.0.1',
    '-keyout', privateKeyFile,
    '-out', certificateFile
  ], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  if (generated.status !== 0) throw new Error(`openssl test fixture generation failed: ${generated.stderr.trim()}`);
});

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(tlsServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('model gateway security boundary', () => {
  it('uses a lease once to activate one agent/profile binding and rejects revoked replay', () => {
    const registry = new LeaseRegistry({ now: () => 1_000 });
    const configured = profile(new URL('https://localhost:443/v1/chat/completions'));
    const grant = issue();
    const lease = registry.issue(grant, configured);
    expect(() => registry.consume(lease, 'agent_wrongwrongwrongwrongxxxx', grant.profileId)).toThrow('binding mismatch');
    expect(registry.consume(lease, grant.agentId, grant.profileId).agentId).toBe(grant.agentId);
    expect(registry.consume(lease, grant.agentId, grant.profileId).agentId).toBe(grant.agentId);
    expect(registry.revoke(grant.leaseId)).toBe(true);
    expect(() => registry.consume(lease, grant.agentId, grant.profileId)).toThrow('revoked or expired');
  });

  it('rejects secret-file path escapes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'model-gateway-secret-'));
    try {
      const target = join(directory, 'credential');
      const escaped = join(directory, 'credential-link');
      await writeFile(target, 'test-only-secret-value');
      await symlink(target, escaped);
      await expect(readExactSecret(escaped)).rejects.toThrow('symlink');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects private, link-local, loopback, and custom internal production upstreams', () => {
    for (const host of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', 'provider.internal', 'localhost', 'singlelabel']) {
      expect(() => assertProductionHostname(host)).toThrow();
    }
    expect(() => assertProductionHostname('api.openai.com')).not.toThrow();
  });

  it('refuses IPv6 prefixes that embed or tunnel an IPv4 address in every text form', () => {
    for (const address of [
      '64:ff9b::a9fe:a9fe', '64:ff9b:0:0:0:0:a9fe:a9fe', '64:FF9B::169.254.169.254', '0064:ff9b:0000::0a00:0001',
      '64:ff9b:1::1', '64:ff9b:1:abcd::a9fe:a9fe', '64:ff9b::1%eth0', '2002:a9fe:a9fe::1', '2002::', '2002:0808:0808:0:0:0:0:1',
      '::ffff:169.254.169.254', '::ffff:808:808', '0:0:0:0:0:ffff:a9fe:a9fe', '::a9fe:a9fe', '::8.8.8.8',
      '::ffff:0:a9fe:a9fe', '2001:0:4136:e378::1', '2001:0000:4136:e378:8000:63bf:3fff:fdd2', '::', '::1', 'fe80::1%eth0'
    ]) {
      expect(isUnsafeAddress(address), address).toBe(true);
    }
    for (const address of [
      '2606:4700::6810:84e5', '64:ff9c::1', '64:ff9b:0:1::1', '2003::1', '2001:4860:4860::8888', '2001:1::1', '1::ffff:808:808'
    ]) {
      expect(isUnsafeAddress(address), address).toBe(false);
    }
  });

  it('checks a bracketed IPv6 upstream literal before connecting', async () => {
    const configured: GatewayProfile = {
      ...profile(new URL('https://[64:ff9b::a9fe:a9fe]/v1/chat/completions')),
      credentialSecret: 'test-only-secret-value',
      allowPrivateUpstream: false
    };
    // The address check runs before the downstream response is touched.
    const downstream = {} as ServerResponse;
    await expect(startUpstreamRequest({
      profile: configured, body: Buffer.from('{}'), downstream, requestId: 'req-literal', maxOutputTokens: 1
    })).rejects.toThrow('unsafe upstream address');
  });

  it('writes the output cap as max_completion_tokens for OpenAI chat profiles', () => {
    const configured = { ...profile(new URL('https://localhost:443/v1/chat/completions')), provider: 'openai' };
    const body: Record<string, unknown> = { max_tokens: 40, max_completion_tokens: 30, messages: [] };
    const reservation = reserveBudget(body, 100, grant(configured.id, 100, 500, 1_000), configured);
    expect(reservation.outputTokens).toBe(30);
    expect(body).toMatchObject({ max_completion_tokens: 30, stream: true });
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('writes max_completion_tokens for any provider whose upstream is api.openai.com', () => {
    for (const configured of [
      { ...profile(new URL('https://api.openai.com/v1/chat/completions')), provider: 'custom' },
      { ...profile(new URL('https://llm.example.net/v1/chat/completions')), provider: 'OpenAI' }
    ]) {
      const body: Record<string, unknown> = { max_tokens: 25, messages: [] };
      reserveBudget(body, 100, grant(configured.id, 100, 500, 1_000), configured);
      expect(body).toMatchObject({ max_completion_tokens: 25 });
      expect(body).not.toHaveProperty('max_tokens');
    }
  });

  it('drops both chat output aliases on the responses path', () => {
    const configured: GatewayProfile = {
      ...profile(new URL('https://api.openai.com/v1/responses')), provider: 'openai', downstreamPath: '/v1/responses'
    };
    const body: Record<string, unknown> = { max_tokens: 40, max_completion_tokens: 30, max_output_tokens: 50, input: [] };
    const reservation = reserveBudget(body, 100, grant(configured.id, 100, 500, 1_000), configured);
    expect(reservation.outputTokens).toBe(50);
    expect(body).toMatchObject({ max_output_tokens: 50, stream: true });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('stream_options');
  });

  it('writes the output cap as max_tokens for other chat providers', () => {
    const configured = profile(new URL('https://localhost:443/v1/chat/completions'));
    const body: Record<string, unknown> = { max_tokens: 40, max_completion_tokens: 30, messages: [] };
    const reservation = reserveBudget(body, 100, grant(configured.id, 100, 500, 1_000), configured);
    expect(reservation.outputTokens).toBe(30);
    expect(body).toMatchObject({ max_tokens: 30, stream: true });
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('clamps model and output tokens before reserving cost', () => {
    const configured = profile(new URL('https://localhost:443/v1/chat/completions'));
    const body: Record<string, unknown> = { model: 'caller-model', max_tokens: 999_999, messages: [] };
    const reservation = reserveBudget(body, 100, grant(configured.id, 100, 17, 1_000), configured);
    expect(body).toMatchObject({ model: 'fixed-model', max_tokens: 17, stream: true });
    expect(reservation.outputTokens).toBe(17);
    expect(reservation.costMicros).toBeLessThanOrEqual(1_000);
  });

  it('rejects hostile routing headers without consuming the lease', async () => {
    const provider = await fakeProvider((_request, response) => response.end());
    const running = await gateway(profile(provider.upstream));
    const grant = activate(running.runtime, issue());
    const rejected = await fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { ...headers(grant), 'x-forwarded-host': 'metadata.google.internal' }, body: '{"messages":[]}'
    });
    expect(rejected.status).toBe(400);
    expect(running.runtime.leases.consume(grant.lease, grant.agentId, grant.profileId)).toBeDefined();
  });

  it('has no caller-selected path or upstream URL', async () => {
    let providerRequests = 0;
    const provider = await fakeProvider((_request, response) => {
      providerRequests += 1;
      response.end();
    });
    const running = await gateway(profile(provider.upstream));
    const grant = activate(running.runtime, issue());
    const wrongPath = await fetch(`${running.baseUrl}/v1/arbitrary`, {
      method: 'POST', headers: headers(grant), body: '{"messages":[]}'
    });
    expect(wrongPath.status).toBe(404);
    const callerUpstream = await fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: headers(grant), body: '{"messages":[],"url":"https://metadata.google.internal/"}'
    });
    expect(callerUpstream.status).toBe(400);
    expect(providerRequests).toBe(0);
  });

  it('sends max_completion_tokens upstream for an OpenAI dynamic profile', async () => {
    let received: Record<string, unknown> = {};
    const provider = await fakeProvider((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}');
      });
    });
    const controlSocket = process.platform === 'win32'
      ? `\\\\.\\pipe\\model-gateway-${randomBytes(8).toString('hex')}`
      : join(tmpdir(), `model-gateway-${randomBytes(8).toString('hex')}.sock`);
    const running = await gateway(profile(provider.upstream), { reserve: vi.fn(), reconcile: vi.fn() }, undefined, {
      controlSocket, tlsCaFile: certificateFile
    });
    const applied = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = connect(controlSocket);
      let reply = '';
      socket.on('data', (chunk: Buffer) => { reply += chunk.toString('utf8'); });
      socket.on('end', () => { try { resolve(JSON.parse(reply) as Record<string, unknown>); } catch (error) { reject(error); } });
      socket.on('error', reject);
      socket.end(`${JSON.stringify({
        operation: 'apply_snapshot',
        credentials: { cred_openai: { provider: 'openai', authMode: 'bearer', secret: 'sk-dynamic-openai-test-key' } },
        profiles: {
          rev_openai: {
            credentialId: 'cred_openai', model: 'gpt-5.2', downstreamPath: '/v1/chat/completions',
            upstreamUrl: provider.upstream.href, limits: { maxInputTokens: 4_096, maxOutputTokens: 1_024, maxCostMicros: 1_000_000 }
          }
        }
      })}\n`);
    });
    expect(applied.ok).toBe(true);
    const grant = activate(running.runtime, issue('rev_openai'));
    const response = await fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: headers(grant), body: '{"messages":[],"max_tokens":20}'
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(received).toMatchObject({ model: 'gpt-5.2', max_completion_tokens: 20, stream: true });
    expect(received).not.toHaveProperty('max_tokens');
  });

  it('forwards the configured provider session header with the calling agent id', async () => {
    let receivedSession = '';
    let receivedUserAgent = '';
    const provider = await fakeProvider((_request, response) => {
      receivedSession = String(_request.headers['x-opencode-session'] ?? '');
      receivedUserAgent = String(_request.headers['user-agent'] ?? '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}');
    });
    const running = await gateway(profile(provider.upstream), { reserve: vi.fn(), reconcile: vi.fn() }, undefined, {
      sessionHeader: 'x-opencode-session'
    });
    const grant = activate(running.runtime, issue());
    const response = await fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: headers(grant), body: '{"messages":[],"max_tokens":20}'
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(receivedSession).toBe('agent_0123456789abcdefghij');
    expect(receivedUserAgent).toContain('cloud-harness-model-gateway');

    let unconfiguredSession: string | undefined;
    const plainProvider = await fakeProvider((_request, response) => {
      unconfiguredSession = _request.headers['x-opencode-session'] as string | undefined;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}');
    });
    const plain = await gateway(profile(plainProvider.upstream), { reserve: vi.fn(), reconcile: vi.fn() });
    await fetch(`${plain.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: headers(activate(plain.runtime, issue())), body: '{"messages":[],"max_tokens":20}'
    }).then((plainResponse) => plainResponse.text());
    expect(unconfiguredSession).toBeUndefined();
  });

  it('rejects a session header that collides with a header the gateway sets itself', async () => {
    await expect(loadGatewayConfig({ MODEL_GATEWAY_MODE: 'test', MODEL_GATEWAY_SESSION_HEADER: 'authorization' }))
      .rejects.toThrow('MODEL_GATEWAY_SESSION_HEADER must not be authorization');
    await expect(loadGatewayConfig({ MODEL_GATEWAY_MODE: 'test', MODEL_GATEWAY_SESSION_HEADER: 'X-Opencode-Session' }))
      .rejects.toThrow('MODEL_GATEWAY_SESSION_HEADER must be a lowercase header name');
  });

  it('streams bounded output, reconciles usage, and never discloses provider credentials or headers', async () => {
    const credential = (await readFile(credentialFile, 'utf8')).trim();
    let receivedAuthorization = '';
    let providerCalls = 0;
    const provider = await fakeProvider((request, response) => {
      providerCalls += 1;
      receivedAuthorization = request.headers.authorization ?? '';
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-provider-secret': 'hidden' });
      if (providerCalls === 1) {
        response.end('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
      } else {
        const split = Math.floor(credential.length / 2);
        response.write(`data: {"leak":"${credential.slice(0, split)}`);
        response.end(`${credential.slice(split)}"}\n\n`);
      }
    });
    const reconcile = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const running = await gateway(profile(provider.upstream), { reserve: vi.fn(), reconcile }, logger);
    const grant = activate(running.runtime, issue());
    const response = await fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: headers(grant), body: '{"messages":[],"max_tokens":20}'
    });
    const output = await response.text();
    expect(response.status, JSON.stringify(logger.warn.mock.calls)).toBe(200);
    expect(response.headers.get('x-provider-secret')).toBeNull();
    expect(`${output}${JSON.stringify([...response.headers])}`).not.toContain(credential);
    expect(receivedAuthorization).toBe(`Bearer ${credential}`);
    expect(reconcile).toHaveBeenCalledWith(expect.anything(), {
      inputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2, reasoningTokens: 0, costMicros: 2
    });
    await expect(fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: headers(grant), body: '{"messages":[],"max_tokens":20}'
    }).then((leakResponse) => leakResponse.text())).rejects.toThrow();
    const logOutput = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
    expect(logOutput).not.toContain(credential);
    expect(logOutput).not.toContain('x-provider-secret');
    expect(logOutput).not.toContain('messages');
  });

  it('aborts and drains upstream when bounded streaming output is exceeded', async () => {
    let upstreamClosed = false;
    const provider = await fakeProvider((_request, response) => {
      response.on('close', () => { upstreamClosed = true; });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${'x'.repeat(4_096)}`);
    });
    const running = await gateway(profile(provider.upstream, { maxResponseBytes: 256, maxStreamLineBytes: 128 }));
    const grant = activate(running.runtime, issue());
    await expect(fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: headers(grant), body: '{"messages":[]}'
    }).then((response) => response.text())).rejects.toThrow();
    await vi.waitFor(() => expect(upstreamClosed).toBe(true));
  });

  it('aborts and drains upstream on explicit cancel, disconnect, and lease revocation', async () => {
    let closeCount = 0;
    let providerRequests = 0;
    const provider = await fakeProvider((_request, response) => {
      providerRequests += 1;
      response.on('close', () => { closeCount += 1; });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[]}\n\n');
    });
    const running = await gateway(profile(provider.upstream));
    const explicit = activate(running.runtime, issue());
    const explicitRequestId = 'explicit-cancel-123';
    const pending = fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { ...headers(explicit), 'x-request-id': explicitRequestId }, body: '{"messages":[]}'
    }).then((response) => response.text()).catch(() => undefined);
    await vi.waitFor(() => expect(providerRequests).toBe(1));
    await vi.waitFor(() => expect(running.runtime.cancelAndDrain(explicitRequestId)).resolves.toBe(true));
    await pending;

    const disconnected = activate(running.runtime, issue());
    const disconnectedRequest = httpRequest(`${running.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(disconnected)
    });
    const disconnectedDone = new Promise<void>((resolve) => {
      disconnectedRequest.once('close', resolve);
      disconnectedRequest.once('error', () => resolve());
    });
    disconnectedRequest.end('{"messages":[]}');
    await vi.waitFor(() => expect(providerRequests).toBe(2));
    disconnectedRequest.destroy();
    await disconnectedDone;
    await vi.waitFor(() => expect(closeCount).toBe(2));

    const revoked = activate(running.runtime, issue());
    const revokedPending = fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: headers(revoked), body: '{"messages":[]}'
    }).then((response) => response.text()).catch(() => undefined);
    await vi.waitFor(() => expect(providerRequests).toBe(3));
    await expect(running.runtime.revokeAndDrain(revoked.leaseId)).resolves.toBe(true);
    await revokedPending;
    expect(closeCount).toBe(3);
    const replay = await fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: headers(revoked), body: '{"messages":[]}'
    });
    expect(replay.status).toBe(401);
  });
});

describe('model gateway usage accounting', () => {
  const chatBody = '{"messages":[],"max_tokens":20}';

  it('charges cached usage from a final SSE chunk split across TCP writes', async () => {
    const usageChunk = `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 30, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 4 } }
    })}\n\ndata: [DONE]\n\n`;
    const provider = await fakeProvider((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      const parts = [usageChunk.slice(0, 17), usageChunk.slice(17, 61), usageChunk.slice(61)];
      const writeNext = (): void => {
        const part = parts.shift();
        if (part === undefined) {
          response.end();
          return;
        }
        response.write(part);
        setTimeout(writeNext, 15);
      };
      setTimeout(writeNext, 15);
    });
    const recording = recordingHooks();
    const running = await gateway(pricedProfile(provider.upstream), recording.hooks);
    const response = await fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: headers(activate(running.runtime, issue())), body: chatBody
    });
    expect(response.status).toBe(200);
    await response.text();
    // 16 uncached x 2 + 10 read x 0.5 + 4 written x 4 + 5 output x 8
    await vi.waitFor(() => expect(recording.reconciled).toEqual([{
      inputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 4, outputTokens: 5, reasoningTokens: 0, costMicros: 93
    }]));
  });

  it('charges Responses usage nested under response.usage in response.completed', async () => {
    const provider = await fakeProvider((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_1', usage: null } })}\n\n`);
      response.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' })}\n\n`);
      response.end(`event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_1',
          usage: { input_tokens: 30, input_tokens_details: { cached_tokens: 10 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } }
        }
      })}\n\n`);
    });
    const recording = recordingHooks();
    const running = await gateway(pricedProfile(provider.upstream, { downstreamPath: '/v1/responses' }), recording.hooks);
    const response = await fetch(`${running.baseUrl}/v1/responses`, {
      method: 'POST', headers: headers(activate(running.runtime, issue())), body: '{"input":"hi","max_output_tokens":20}'
    });
    expect(response.status).toBe(200);
    await response.text();
    await vi.waitFor(() => expect(recording.reconciled).toEqual([{
      inputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: 2, costMicros: 20 * 2 + 5 + 5 * 8
    }]));
    expect(recording.reserved[0]?.costMicros).toBeGreaterThan(85);
  });

  it('charges the reservation when the stream ends without usage', async () => {
    const provider = await fakeProvider((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    });
    const recording = recordingHooks();
    const running = await gateway(pricedProfile(provider.upstream), recording.hooks);
    const response = await fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: headers(activate(running.runtime, issue())), body: chatBody
    });
    expect(response.status).toBe(200);
    await response.text();
    const reservation = recording.reserved[0];
    await vi.waitFor(() => expect(recording.reconciled).toEqual([{
      inputTokens: reservation?.inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0,
      outputTokens: reservation?.outputTokens, reasoningTokens: 0, costMicros: reservation?.costMicros
    }]));
  });

  it('never reserves more than the lease cap across concurrent requests', async () => {
    const pending: Array<() => void> = [];
    const provider = await fakeProvider((_request, response) => {
      pending.push(() => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n');
      });
    });
    const recording = recordingHooks();
    const running = await gateway(pricedProfile(provider.upstream), recording.hooks);
    const grant = activate(running.runtime, { ...issue(), maxCostMicros: 1_500 });
    const body = '{"messages":[],"max_tokens":100}';
    const requests = [0, 1].map(() => fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: headers(grant), body
    }));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    const reservedTotal = recording.reserved.reduce((total, reservation) => total + reservation.costMicros, 0);
    expect(reservedTotal).toBeLessThanOrEqual(1_500);
    // The second request only gets the output the first one left affordable.
    expect(recording.reserved.map((reservation) => reservation.outputTokens).sort((a, b) => b - a)).toEqual([100, 55]);
    for (const release of pending) release();
    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(200);
      await response.text();
    }
  });

  it('returns a settlement on revoke that counts a cancelled in-flight request at its reservation', async () => {
    let providerRequests = 0;
    const provider = await fakeProvider((_request, response) => {
      providerRequests += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[]}\n\n');
    });
    const socketPath = controlSocketPath();
    const recording = recordingHooks();
    const running = await gateway(pricedProfile(provider.upstream), recording.hooks, undefined, { controlSocket: socketPath });
    const input = issue();
    const issued = await control(socketPath, { operation: 'issue', ...input });
    expect(issued).toMatchObject({ ok: true, gatewayBootId: expect.stringMatching(/^boot_/) });
    const pendingRequest = fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: headers({ ...input, lease: String(issued.lease) }), body: chatBody
    }).then((response) => response.text()).catch(() => undefined);
    await vi.waitFor(() => expect(providerRequests).toBe(1));

    const revoked = await control(socketPath, { operation: 'revoke', leaseId: input.leaseId });
    await pendingRequest;
    const reservation = recording.reserved[0];
    expect(revoked).toMatchObject({
      ok: true,
      revoked: true,
      gatewayBootId: issued.gatewayBootId,
      settlement: {
        leaseId: input.leaseId,
        reason: 'revoked',
        initialCostMicros: 1_000_000,
        costMicros: reservation?.costMicros,
        overrunCostMicros: 0,
        promptTokens: reservation?.inputTokens,
        outputTokens: reservation?.outputTokens,
        requests: 1,
        requestsWithoutUsage: 1
      }
    });
    expect(recording.reconciled).toEqual([]);
    // Revoking again is idempotent.
    await expect(control(socketPath, { operation: 'revoke', leaseId: input.leaseId }))
      .resolves.toMatchObject({ ok: true, revoked: false, settlement: revoked.settlement });
  });

  it('returns the settlement of an expired lease on revoke', async () => {
    const provider = await fakeProvider((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n');
    });
    const socketPath = controlSocketPath();
    const running = await gateway(pricedProfile(provider.upstream), undefined, undefined, { controlSocket: socketPath });
    const input = { ...issue(), ttlMs: 1_000 };
    const issued = await control(socketPath, { operation: 'issue', ...input });
    const response = await fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: headers({ ...input, lease: String(issued.lease) }), body: chatBody
    });
    expect(response.status).toBe(200);
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(control(socketPath, { operation: 'revoke', leaseId: input.leaseId })).resolves.toMatchObject({
      ok: true,
      revoked: false,
      settlement: { reason: 'expired', costMicros: 5 * 2 + 2 * 8, promptTokens: 5, outputTokens: 2, requests: 1, requestsWithoutUsage: 0 }
    });
  });

  it('refuses stateful Responses fields with a message naming the field', async () => {
    let providerRequests = 0;
    const provider = await fakeProvider((_request, response) => {
      providerRequests += 1;
      response.end();
    });
    const running = await gateway(pricedProfile(provider.upstream, { downstreamPath: '/v1/responses' }));
    const grant = activate(running.runtime, issue());
    for (const [field, value] of [['previous_response_id', 'resp_1'], ['conversation', 'conv_1'], ['prompt', { id: 'pmpt_1' }]] as const) {
      const response = await fetch(`${running.baseUrl}/v1/responses`, {
        method: 'POST', headers: headers(grant), body: JSON.stringify({ input: 'hi', [field]: value })
      });
      expect(response.status).toBe(400);
      const payload = await response.json() as { error: { code: string; message: string } };
      expect(payload.error.code).toBe('invalid_model_request');
      expect(payload.error.message).toContain(field);
    }
    expect(providerRequests).toBe(0);
  });
});
