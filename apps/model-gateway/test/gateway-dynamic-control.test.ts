import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createGatewayRuntime } from '../src/gateway.js';
import { loadGatewayConfig } from '../src/config.js';
import { startControlServer, type DynamicGatewayRegistry } from '../src/control.js';
import { LeaseRegistry } from '../src/lease-registry.js';
import type { GatewayConfig, GatewayProfile } from '../src/types.js';

const tempSocketPath = () =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\gw-control-${randomBytes(6).toString('hex')}`
    : join(tmpdir(), `gw-control-${randomBytes(6).toString('hex')}.sock`);

async function sendControl(socketPath: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const socket = connect(socketPath);
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  let chunks = Buffer.alloc(0);
  socket.on('data', (chunk) => { chunks = Buffer.concat([chunks, chunk]); });
  socket.on('end', () => {
    try {
      resolve(JSON.parse(chunks.toString('utf8')));
    } catch (e) {
      reject(e);
    }
  });
  socket.on('error', reject);
  socket.end(`${JSON.stringify(payload)}\n`);
  return promise;
}

describe('Model Gateway Dynamic Control & Hot Reload', () => {
  const runtimes: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const rt of runtimes.splice(0)) {
      await rt.close().catch(() => undefined);
    }
  });

  it('applies snapshot, updates dynamic profiles/credentials in RAM, and responds with ack & digest', async () => {
    const socketPath = tempSocketPath();
    const config = await loadGatewayConfig({
      MODEL_GATEWAY_MODE: 'test',
      MODEL_GATEWAY_CONTROL_SOCKET: socketPath,
      MODEL_GATEWAY_HOST: '127.0.0.1',
      MODEL_GATEWAY_PORT: '3210',
      MODEL_GATEWAY_PROFILES_JSON: '[]'
    });

    const gateway = createGatewayRuntime(config);
    runtimes.push(gateway);
    await gateway.listen();

    // 1. Initial digest query
    const initialDigest = await sendControl(socketPath, { operation: 'digest' });
    expect(initialDigest.ok).toBe(true);
    const initialData = initialDigest.digest as { activeProfileCount: number };
    expect(initialData.activeProfileCount).toBe(0);

    // 2. Apply snapshot with dynamic credential and profile
    const applyRes = await sendControl(socketPath, {
      operation: 'apply_snapshot',
      sequence: 1,
      generation: 1,
      credentials: {
        cred_test_1: {
          provider: 'openai',
          authMode: 'bearer',
          secret: 'sk-dynamic-test-key-999'
        }
      },
      profiles: {
        rev_dynamic_1: {
          id: 'rev_dynamic_1',
          profileId: 'coding-fast',
          credentialId: 'cred_test_1',
          model: 'gpt-5.2-codex',
          apiMode: 'chat-completions',
          downstreamPath: '/v1/chat/completions',
          upstreamUrl: 'https://127.0.0.1:3443/v1/chat/completions',
          pricing: { inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000 },
          limits: { maxInputTokens: 50000, maxOutputTokens: 2000, maxCostMicros: 100000 }
        }
      }
    });

    expect(applyRes.ok).toBe(true);
    const ackData = applyRes.ack as { snapshotDigest: string; activeProfileCount: number };
    expect(ackData.snapshotDigest).toMatch(/^sha256:/);
    expect(ackData.activeProfileCount).toBeGreaterThan(0);

    // 3. Issue lease for dynamic profile
    const issueRes = await sendControl(socketPath, {
      operation: 'issue',
      leaseId: 'lease_dynamic_test_1',
      agentId: 'agent_12345678901234567890',
      profileId: 'rev_dynamic_1',
      ttlMs: 30_000,
      maxInputTokens: 10_000,
      maxOutputTokens: 1_000,
      maxCostMicros: 50_000
    });
    expect(issueRes.ok).toBe(true);
    const issueData = issueRes as { lease: string };
    expect(issueData.lease).toBeDefined();

    // 4. Query updated digest
    const updatedDigest = await sendControl(socketPath, { operation: 'digest' });
    expect(updatedDigest.ok).toBe(true);
    const digestData = updatedDigest.digest as { activeLeaseCount: number };
    expect(digestData.activeLeaseCount).toBe(1);
  });

  const productionSnapshot = (upstreamUrl: string, revisionId: string): Record<string, unknown> => ({
    operation: 'apply_snapshot',
    sequence: 1,
    generation: 1,
    credentials: {
      cred_production_1: { provider: 'openai', authMode: 'bearer', secret: 'sk-production-test-key' }
    },
    profiles: {
      [revisionId]: {
        id: revisionId,
        profileId: 'coding-fast',
        credentialId: 'cred_production_1',
        model: 'gpt-5.2-codex',
        apiMode: 'chat-completions',
        downstreamPath: '/v1/chat/completions',
        upstreamUrl,
        pricing: { inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000 },
        limits: { maxInputTokens: 50_000, maxOutputTokens: 2_000, maxCostMicros: 100_000 }
      }
    }
  });

  it('accepts a hostname upstream for a dynamic profile in production mode', async () => {
    const socketPath = tempSocketPath();
    const config: GatewayConfig = {
      mode: 'production', host: '127.0.0.1', port: 0, controlSocket: socketPath, profiles: new Map()
    };
    const gateway = createGatewayRuntime(config);
    runtimes.push(gateway);
    await gateway.listen();

    const applied = await sendControl(socketPath, productionSnapshot(
      'https://api.openai.com/v1/chat/completions', 'rev_production_hostname'
    ));

    expect(applied.ok).toBe(true);
    const ack = applied.ack as { activeProfileCount: number };
    expect(ack.activeProfileCount).toBe(1);
  });

  it('carries the credential provider into the dynamic profile', async () => {
    const socketPath = tempSocketPath();
    const config: GatewayConfig = {
      mode: 'production', host: '127.0.0.1', port: 0, controlSocket: socketPath, profiles: new Map()
    };
    const registry: DynamicGatewayRegistry = {
      profiles: new Map(), credentials: new Map(), snapshotDigest: '', gatewayBootId: 'boot_test'
    };
    const server = await startControlServer({
      config, leases: new LeaseRegistry(), cancelRequest: async () => false, revokeLease: async () => false, registry
    });
    runtimes.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });

    const applied = await sendControl(socketPath, productionSnapshot(
      'https://api.openai.com/v1/chat/completions', 'rev_production_provider'
    ));

    expect(applied.ok).toBe(true);
    expect(registry.profiles.get('rev_production_provider')).toMatchObject({ provider: 'openai', model: 'gpt-5.2-codex' });
  });

  it('rejects a snapshot with an invalid credential provider without changing the registry', async () => {
    const socketPath = tempSocketPath();
    const config: GatewayConfig = {
      mode: 'production', host: '127.0.0.1', port: 0, controlSocket: socketPath, profiles: new Map()
    };
    const registry: DynamicGatewayRegistry = {
      profiles: new Map(), credentials: new Map(), snapshotDigest: '', gatewayBootId: 'boot_test'
    };
    const server = await startControlServer({
      config, leases: new LeaseRegistry(), cancelRequest: async () => false, revokeLease: async () => false, registry
    });
    runtimes.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
    const accepted = await sendControl(socketPath, productionSnapshot(
      'https://api.openai.com/v1/chat/completions', 'rev_production_kept'
    ));
    expect(accepted.ok).toBe(true);
    const credentialsBefore = new Map(registry.credentials);
    const profilesBefore = new Map(registry.profiles);
    const digestBefore = registry.snapshotDigest;

    const refused = await sendControl(socketPath, {
      operation: 'apply_snapshot',
      sequence: 2,
      generation: 2,
      credentials: {
        cred_production_1: { provider: 'anthropic', authMode: 'x-api-key', secret: 'sk-replacement-key' },
        cred_bad: { provider: 42, authMode: 'bearer', secret: 'sk-bad-key' }
      },
      profiles: {
        rev_production_new: {
          id: 'rev_production_new', profileId: 'coding-fast', credentialId: 'cred_production_1',
          model: 'replacement-model', downstreamPath: '/v1/chat/completions',
          upstreamUrl: 'https://api.openai.com/v1/chat/completions'
        }
      }
    });

    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toContain('invalid provider for credential cred_bad');
    expect(registry.credentials).toEqual(credentialsBefore);
    expect(registry.profiles).toEqual(profilesBefore);
    expect(registry.profiles.has('rev_production_new')).toBe(false);
    expect(registry.snapshotDigest).toBe(digestBefore);
  });

  it('refuses an address-literal upstream for a dynamic profile in production mode', async () => {
    const socketPath = tempSocketPath();
    const config: GatewayConfig = {
      mode: 'production', host: '127.0.0.1', port: 0, controlSocket: socketPath, profiles: new Map()
    };
    const gateway = createGatewayRuntime(config);
    runtimes.push(gateway);
    await gateway.listen();

    const refused = await sendControl(socketPath, productionSnapshot(
      'https://127.0.0.1:3443/v1/chat/completions', 'rev_production_literal'
    ));

    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toContain('private or reserved');
    const digest = await sendControl(socketPath, { operation: 'digest' });
    expect((digest.digest as { activeProfileCount: number }).activeProfileCount).toBe(0);
  });

  it('applies cache and tier prices from a snapshot and rejects an invalid tier snapshot whole', async () => {
    const socketPath = tempSocketPath();
    const config: GatewayConfig = {
      mode: 'production', host: '127.0.0.1', port: 0, controlSocket: socketPath, profiles: new Map()
    };
    const registry: DynamicGatewayRegistry = {
      profiles: new Map(), credentials: new Map(), snapshotDigest: '', gatewayBootId: 'boot_test'
    };
    const server = await startControlServer({
      config, leases: new LeaseRegistry(), cancelRequest: async () => false, revokeLease: async () => false, registry
    });
    runtimes.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });

    const tieredSnapshot = (revisionId: string, tiers: unknown[]): Record<string, unknown> => {
      const snapshot = productionSnapshot('https://api.openai.com/v1/chat/completions', revisionId);
      const profile = (snapshot.profiles as Record<string, Record<string, unknown>>)[revisionId] as Record<string, unknown>;
      profile.pricing = {
        inputMicrosPerMillionTokens: 1_000,
        outputMicrosPerMillionTokens: 2_000,
        cacheReadMicrosPerMillionTokens: 100,
        cacheWriteMicrosPerMillionTokens: 1_250,
        tiers
      };
      return snapshot;
    };
    const tier = {
      minPromptTokens: 200_000,
      inputMicrosPerMillionTokens: 2_000,
      outputMicrosPerMillionTokens: 3_000,
      cacheReadMicrosPerMillionTokens: 200,
      cacheWriteMicrosPerMillionTokens: 2_500
    };
    const applied = await sendControl(socketPath, tieredSnapshot('rev_tiered', [tier]));
    expect(applied.ok).toBe(true);
    expect(registry.profiles.get('rev_tiered')).toMatchObject({
      inputMicrosPerMillionTokens: 1_000,
      outputMicrosPerMillionTokens: 2_000,
      cacheReadMicrosPerMillionTokens: 100,
      cacheWriteMicrosPerMillionTokens: 1_250,
      tiers: [tier]
    });

    const profilesBefore = new Map(registry.profiles);
    const digestBefore = registry.snapshotDigest;
    const refused = await sendControl(socketPath, tieredSnapshot('rev_bad_tier', [
      tier,
      { ...tier, minPromptTokens: 100_000 }
    ]));
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toContain('strictly ascending');
    const cheaper = await sendControl(socketPath, tieredSnapshot('rev_cheaper_tier', [{ ...tier, outputMicrosPerMillionTokens: 1_000 }]));
    expect(cheaper.ok).toBe(false);
    expect(String(cheaper.error)).toContain('must not be lower');
    expect(registry.profiles).toEqual(profilesBefore);
    expect(registry.snapshotDigest).toBe(digestBefore);
  });

  it('keeps flat input pricing for a snapshot without cache prices', async () => {
    const socketPath = tempSocketPath();
    const config: GatewayConfig = {
      mode: 'production', host: '127.0.0.1', port: 0, controlSocket: socketPath, profiles: new Map()
    };
    const registry: DynamicGatewayRegistry = {
      profiles: new Map(), credentials: new Map(), snapshotDigest: '', gatewayBootId: 'boot_test'
    };
    const server = await startControlServer({
      config, leases: new LeaseRegistry(), cancelRequest: async () => false, revokeLease: async () => false, registry
    });
    runtimes.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
    const applied = await sendControl(socketPath, productionSnapshot('https://api.openai.com/v1/chat/completions', 'rev_flat'));
    expect(applied.ok).toBe(true);
    const profile = registry.profiles.get('rev_flat');
    expect(profile).toMatchObject({ inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000 });
    expect(profile?.cacheReadMicrosPerMillionTokens).toBeUndefined();
    expect(profile?.cacheWriteMicrosPerMillionTokens).toBeUndefined();
    expect(profile?.tiers).toBeUndefined();
  });


  const snapshotOf = (
    sequence: number,
    entries: Array<{ credentialId: string; revisionId: string; upstreamUrl?: string }>
  ): Record<string, unknown> => ({
    operation: 'apply_snapshot',
    sequence,
    generation: sequence,
    credentials: Object.fromEntries(entries.map(({ credentialId }) => [
      credentialId, { provider: 'openai', authMode: 'bearer', secret: `sk-${credentialId}-secret` }
    ])),
    profiles: Object.fromEntries(entries.map(({ credentialId, revisionId, upstreamUrl }) => [revisionId, {
      id: revisionId,
      profileId: 'coding-fast',
      credentialId,
      model: 'gpt-5.2-codex',
      downstreamPath: '/v1/chat/completions',
      upstreamUrl: upstreamUrl ?? 'https://api.openai.com/v1/chat/completions',
      pricing: { inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000 },
      limits: { maxInputTokens: 50_000, maxOutputTokens: 2_000, maxCostMicros: 100_000 }
    }]))
  });

  async function startRegistryControl(profiles: ReadonlyMap<string, GatewayProfile> = new Map()): Promise<{
    socketPath: string;
    registry: DynamicGatewayRegistry;
  }> {
    const socketPath = tempSocketPath();
    const config: GatewayConfig = {
      mode: 'production', host: '127.0.0.1', port: 0, controlSocket: socketPath, profiles
    };
    const registry: DynamicGatewayRegistry = {
      profiles: new Map(profiles), credentials: new Map(), snapshotDigest: '', gatewayBootId: 'boot_test'
    };
    const server = await startControlServer({
      config, leases: new LeaseRegistry(), cancelRequest: async () => false, revokeLease: async () => false, registry
    });
    runtimes.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
    return { socketPath, registry };
  }

  it('evicts a credential and a revision that the next snapshot no longer exports', async () => {
    const { socketPath, registry } = await startRegistryControl();
    const first = await sendControl(socketPath, snapshotOf(1, [
      { credentialId: 'cred_kept', revisionId: 'rev_kept' },
      { credentialId: 'cred_deleted', revisionId: 'rev_deleted' }
    ]));
    expect(first.ok).toBe(true);
    expect([...registry.credentials.keys()].sort()).toEqual(['cred_deleted', 'cred_kept']);

    const second = await sendControl(socketPath, snapshotOf(2, [{ credentialId: 'cred_kept', revisionId: 'rev_kept' }]));

    expect(second.ok).toBe(true);
    expect([...registry.credentials.keys()]).toEqual(['cred_kept']);
    expect([...registry.profiles.keys()]).toEqual(['rev_kept']);
    expect(second.ack).toMatchObject({ activeProfileCount: 1, activeCredentialCount: 1 });
    const digest = await sendControl(socketPath, { operation: 'digest' });
    expect(digest.digest).toMatchObject({ activeProfileCount: 1, activeCredentialCount: 1 });

    const empty = await sendControl(socketPath, snapshotOf(3, []));
    expect(empty.ok).toBe(true);
    expect(registry.credentials.size).toBe(0);
    expect(registry.profiles.size).toBe(0);
  });

  it('keeps the whole previous set when a replacing snapshot is rejected', async () => {
    const { socketPath, registry } = await startRegistryControl();
    const accepted = await sendControl(socketPath, snapshotOf(1, [
      { credentialId: 'cred_one', revisionId: 'rev_one' },
      { credentialId: 'cred_two', revisionId: 'rev_two' }
    ]));
    expect(accepted.ok).toBe(true);
    const credentialsBefore = new Map(registry.credentials);
    const profilesBefore = new Map(registry.profiles);
    const digestBefore = registry.snapshotDigest;

    const rejected = await sendControl(socketPath, snapshotOf(2, [
      { credentialId: 'cred_one', revisionId: 'rev_one', upstreamUrl: 'https://127.0.0.1:3443/v1/chat/completions' }
    ]));

    expect(rejected.ok).toBe(false);
    expect(String(rejected.error)).toContain('private or reserved');
    expect(registry.credentials).toEqual(credentialsBefore);
    expect(registry.profiles).toEqual(profilesBefore);
    expect(registry.snapshotDigest).toBe(digestBefore);
  });

  it('keeps statically configured profiles while evicting earlier snapshot revisions', async () => {
    const staticProfile: GatewayProfile = {
      id: 'static-profile',
      provider: 'openai',
      model: 'gpt-static',
      downstreamPath: '/v1/chat/completions',
      upstream: new URL('https://api.openai.com/v1/chat/completions'),
      credentialFile: '/run/secrets/static-provider-key',
      credentialHeader: 'authorization',
      credentialScheme: 'Bearer',
      inputMicrosPerMillionTokens: 1000,
      outputMicrosPerMillionTokens: 2000,
      limits: {
        maxRequestBytes: 4_194_304,
        maxResponseBytes: 16_777_216,
        maxHeaderBytes: 16_384,
        maxHeaders: 32,
        deadlineMs: 300_000,
        maxInputTokens: 400_000,
        maxOutputTokens: 128_000,
        maxCostMicros: 100_000_000,
        maxStreamLineBytes: 1_048_576
      },
      testOnly: false,
      allowPrivateUpstream: false
    };
    const { socketPath, registry } = await startRegistryControl(new Map([[staticProfile.id, staticProfile]]));

    const first = await sendControl(socketPath, snapshotOf(1, [{ credentialId: 'cred_old', revisionId: 'rev_old' }]));
    expect(first.ok).toBe(true);
    const second = await sendControl(socketPath, snapshotOf(2, [{ credentialId: 'cred_new', revisionId: 'rev_new' }]));

    expect(second.ok).toBe(true);
    expect(registry.profiles.get('static-profile')).toBe(staticProfile);
    expect([...registry.profiles.keys()].sort()).toEqual(['rev_new', 'static-profile']);
    expect([...registry.credentials.keys()]).toEqual(['cred_new']);
  });

  it('fails closed for a live lease whose revision a later snapshot evicted', async () => {
    const socketPath = tempSocketPath();
    const config: GatewayConfig = {
      mode: 'test', host: '127.0.0.1', port: 0, controlSocket: socketPath, profiles: new Map()
    };
    const gateway = createGatewayRuntime(config);
    runtimes.push(gateway);
    await gateway.listen();
    const address = gateway.httpServer.address();
    if (address === null || typeof address === 'string') throw new Error('gateway did not bind a TCP port');

    const evictedUpstream = 'https://127.0.0.1:3443/v1/chat/completions';
    const applied = await sendControl(socketPath, snapshotOf(1, [
      { credentialId: 'cred_evicted', revisionId: 'rev_evicted', upstreamUrl: evictedUpstream }
    ]));
    expect(applied.ok).toBe(true);
    const agentId = 'agent_12345678901234567890';
    const issued = await sendControl(socketPath, {
      operation: 'issue',
      leaseId: 'lease_on_evicted_revision',
      agentId,
      profileId: 'rev_evicted',
      ttlMs: 30_000,
      maxInputTokens: 10_000,
      maxOutputTokens: 1_000,
      maxCostMicros: 50_000
    });
    expect(issued.ok).toBe(true);

    const replaced = await sendControl(socketPath, snapshotOf(2, [
      { credentialId: 'cred_current', revisionId: 'rev_current', upstreamUrl: evictedUpstream }
    ]));
    expect(replaced.ok).toBe(true);

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${String(issued.lease)}`,
        'content-type': 'application/json',
        'x-agent-id': agentId,
        'x-model-profile': 'rev_evicted'
      },
      body: JSON.stringify({ model: 'gpt-5.2-codex', messages: [{ role: 'user', content: 'hello' }] })
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: 'invalid_gateway_lease', message: 'invalid gateway lease' } });

    const reissued = await sendControl(socketPath, {
      operation: 'issue',
      leaseId: 'lease_after_eviction',
      agentId,
      profileId: 'rev_evicted',
      ttlMs: 30_000,
      maxInputTokens: 10_000,
      maxOutputTokens: 1_000,
      maxCostMicros: 50_000
    });
    expect(reissued).toMatchObject({ ok: false, error: 'unknown profile' });
  });
});
