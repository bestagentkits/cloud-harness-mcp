import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createGatewayRuntime } from '../src/gateway.js';
import { loadGatewayConfig } from '../src/config.js';
import { connect } from 'node:net';

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
});
