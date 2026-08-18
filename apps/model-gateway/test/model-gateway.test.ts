import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:https';
import { request as httpRequest, type RequestListener } from 'node:http';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertProductionHostname, readExactSecret } from '../src/config.js';
import { LeaseRegistry } from '../src/lease-registry.js';
import { createGatewayRuntime, type GatewayRuntime } from '../src/gateway.js';
import { reserveBudget } from '../src/budget.js';
import type { GatewayConfig, GatewayLogger, GatewayProfile, LeaseIssueInput } from '../src/types.js';

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
  logger: GatewayLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
): Promise<{ runtime: GatewayRuntime; baseUrl: string }> {
  const config: GatewayConfig = {
    mode: 'test', host: '127.0.0.1', port: 0, controlSocket: `/tmp/model-gateway-${randomBytes(8).toString('hex')}.sock`,
    profiles: new Map([[gatewayProfile.id, gatewayProfile]])
  };
  const runtime = createGatewayRuntime(config, hooks, logger);
  await runtime.listen();
  runtimes.push(runtime);
  const address = runtime.httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('gateway address unavailable');
  return { runtime, baseUrl: `http://127.0.0.1:${address.port}` };
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

  it('clamps model and output tokens before reserving cost', () => {
    const configured = profile(new URL('https://localhost:443/v1/chat/completions'));
    const body: Record<string, unknown> = { model: 'caller-model', max_tokens: 999_999, messages: [] };
    const reservation = reserveBudget(body, 100, {
      agentId: issue().agentId, profileId: configured.id, expiresAt: Date.now() + 1_000,
      remainingInputTokens: 100, remainingOutputTokens: 17, remainingCostMicros: 1_000
    }, configured);
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
    expect(reconcile).toHaveBeenCalledWith(expect.anything(), { inputTokens: 3, outputTokens: 2, costMicros: 2 });
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
