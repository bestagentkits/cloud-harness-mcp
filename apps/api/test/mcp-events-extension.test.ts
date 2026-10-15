import { Client, ProtocolError } from '@modelcontextprotocol/client';
import { InMemoryTransport, type AuthInfo, type McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { McpEventsRunnerRequest, RunnerPrincipalSelector } from '@cloud-harness/contracts';
import { createCloudHarnessServer, createCloudHarnessServerFactory } from '../src/mcp-server.js';
import type { RunnerClient } from '../src/runner-client.js';
import type { WebhookSender } from '../src/events/webhook-sender.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const sender: WebhookSender = {
  checkUrl: async (url) => ({ ok: true, url }),
  verify: async () => ({ ok: true }),
  post: async () => ({ ok: true, status: 200, body: new Uint8Array() })
};

function fakeRunner() {
  const requests: McpEventsRunnerRequest[] = [];
  const client = {
    async call() { return { ok: true, message: 'ok', data: {}, truncated: false }; },
    async callEvents(request: McpEventsRunnerRequest) {
      requests.push(request);
      if (request.operation === 'events_prepare') return { ok: true, data: { id: `sub_${'0'.repeat(32)}`, verified: true } };
      if (request.operation === 'events_subscribe') return { ok: true, data: { id: `sub_${'0'.repeat(32)}`, refreshBefore: new Date().toISOString() } };
      return { ok: true, data: { removed: true } };
    }
  } as unknown as RunnerClient;
  return { client, requests };
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'events-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

const params = {
  name: 'cloudharness.agent.failed',
  arguments: {},
  delivery: { mode: 'webhook', url: 'https://hooks.example.com/a', secret: `whsec_${Buffer.alloc(32, 1).toString('base64')}` }
};

const authInfo = (extra: Record<string, unknown>): AuthInfo => ({ token: 'opaque', clientId: 'client', scopes: [], extra });
const owner: RunnerPrincipalSelector = { kind: 'owner', ownerId: 'owner' };

async function code(promise: Promise<unknown>): Promise<number | undefined> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ProtocolError);
  return (error as ProtocolError).code;
}

describe('MCP Events extension wiring', () => {
  it('is absent from backends without an events port, such as the local stdio backend', async () => {
    const client = await connect(createCloudHarnessServer({ call: async () => ({ ok: true, message: 'ok', data: {}, truncated: false }) }));
    expect(await code(client.request({ method: 'events/list', params: {} } as never, z.unknown()))).toBe(-32601);
  });

  it('refuses subscribe and unsubscribe without an authenticated principal and never reaches the runner', async () => {
    const { client: runner, requests } = fakeRunner();
    const client = await connect(createCloudHarnessServerFactory(runner, { sender })({ era: 'modern' }));
    expect(await code(client.request({ method: 'events/subscribe', params } as never, z.unknown()))).toBe(-32012);
    expect(await code(client.request({ method: 'events/unsubscribe', params: { name: params.name, delivery: { url: params.delivery.url } } } as never, z.unknown()))).toBe(-32012);
    expect(requests).toEqual([]);
  });

  it('scopes runner calls to the request principal and records the managed API key behind it', async () => {
    const { client: runner, requests } = fakeRunner();
    const apiKeyId = `apk_${'a'.repeat(24)}`;
    const client = await connect(createCloudHarnessServerFactory(runner, { sender })({ era: 'modern', authInfo: authInfo({ principal: owner, apiKeyId }) }));
    await client.request({ method: 'events/subscribe', params } as never, z.unknown());
    expect(requests.map((request) => request.operation)).toEqual(['events_prepare', 'events_subscribe']);
    expect(requests.every((request) => 'principal' in request && request.principal.kind === 'owner')).toBe(true);
    expect(requests[1]!.input).toMatchObject({ apiKeyId, verified: false, url: params.delivery.url, name: params.name, arguments: {} });
  });
});
