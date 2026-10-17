import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { startControlServer, type DynamicGatewayRegistry } from '../src/control.js';
import { LeaseRegistry } from '../src/lease-registry.js';
import type { GatewayConfig } from '../src/types.js';

const SENTINEL = 'sk-sentinel-control-record-secret';
// V8 quotes only about ten characters around the bad token, so match on a short prefix.
const SENTINEL_FRAGMENT = SENTINEL.slice(0, 6);

const tempSocketPath = () =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\gw-control-${randomBytes(6).toString('hex')}`
    : join(tmpdir(), `gw-control-${randomBytes(6).toString('hex')}.sock`);

async function sendRaw(socketPath: string, record: string): Promise<string> {
  const socket = connect(socketPath);
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let chunks = Buffer.alloc(0);
  socket.on('data', (chunk) => { chunks = Buffer.concat([chunks, chunk]); });
  socket.on('end', () => resolve(chunks.toString('utf8')));
  socket.on('error', reject);
  socket.end(`${record}\n`);
  return promise;
}

describe('model gateway control record errors', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) await close().catch(() => undefined);
  });

  it.each([
    ['an invalid leading token', `x${SENTINEL}`],
    ['an unquoted value inside an object', `{"operation":"apply_snapshot","credentials":{"cred":{"secret":${SENTINEL}}}}`]
  ])('answers a malformed record with %s without echoing its contents', async (_label, record) => {
    expect(() => JSON.parse(record)).toThrow(SENTINEL_FRAGMENT);
    const socketPath = tempSocketPath();
    const config: GatewayConfig = { mode: 'production', host: '127.0.0.1', port: 0, controlSocket: socketPath, profiles: new Map() };
    const registry: DynamicGatewayRegistry = { profiles: new Map(), credentials: new Map(), snapshotDigest: '', gatewayBootId: 'boot_test' };
    const server = await startControlServer({
      config, leases: new LeaseRegistry(), cancelRequest: async () => false, revokeLease: async () => false, registry
    });
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const reply = await sendRaw(socketPath, record);

    expect(reply).not.toContain(SENTINEL_FRAGMENT);
    expect(JSON.parse(reply)).toEqual({ ok: false, error: 'invalid control record' });
  });
});
