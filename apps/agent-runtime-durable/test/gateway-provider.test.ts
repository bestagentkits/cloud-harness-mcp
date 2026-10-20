import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createModels } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { createGatewayProvider, GATEWAY_PROVIDER_ID, parseGatewayBaseUrl } from '../src/gateway-provider.js';
import type { DurableStartRecord } from '../src/protocol.js';

const start: DurableStartRecord = {
  type: 'start',
  requestId: 'start-1',
  agentId: `agent_${'a'.repeat(20)}`,
  prompt: 'hello',
  tools: ['files_read'],
  gateway: { profile: 'test-profile', lease: 'lease-one-0123456789' },
  model: {
    id: 'gateway-model',
    name: 'Gateway model',
    api: 'openai-completions',
    reasoning: false,
    contextWindow: 32_000,
    maxTokens: 1_024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  },
  limits: { deadlineMs: 60_000, maxEvents: 100, maxOutputBytes: 65_536, maxEventBytes: 8_192, maxToolResultBytes: 65_536 }
};

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
  server = undefined;
});

/** A minimal OpenAI-compatible streaming endpoint that records the headers of every request. */
async function fakeGateway(): Promise<{ baseUrl: string; requests: IncomingHttpHeaders[] }> {
  const requests: IncomingHttpHeaders[] = [];
  server = createServer((request, response) => {
    requests.push(request.headers);
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (body: unknown) => response.write(`data: ${JSON.stringify(body)}\n\n`);
      chunk({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'gateway-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] });
      chunk({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'gateway-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests };
}

describe('gateway provider', () => {
  it('resolves the lease and the agent headers for every request', async () => {
    const gateway = await fakeGateway();
    let lease = 'lease-one-0123456789';
    const models = createModels();
    models.setProvider(createGatewayProvider(gateway.baseUrl, start, {
      current: () => ({ lease, agentId: start.agentId, profile: start.gateway.profile })
    }));
    const model = models.getModel(GATEWAY_PROVIDER_ID, 'gateway-model');
    expect(model).toBeDefined();
    if (!model) return;
    const context = { messages: [{ role: 'user' as const, content: 'hi', timestamp: 0 }] };
    const first = await models.completeSimple(model, context);
    lease = 'lease-two-0123456789';
    await models.completeSimple(model, context);
    expect(first.stopReason).toBe('stop');
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests.map((headers) => headers.authorization)).toEqual(['Bearer lease-one-0123456789', 'Bearer lease-two-0123456789']);
    for (const headers of gateway.requests) {
      expect(headers['x-agent-id']).toBe(start.agentId);
      expect(headers['x-model-profile']).toBe('test-profile');
    }
  });

  it('accepts only a plain HTTP or HTTPS gateway URL', () => {
    expect(parseGatewayBaseUrl('http://model-gateway:3210/v1/')).toBe('http://model-gateway:3210/v1');
    expect(() => parseGatewayBaseUrl('file:///etc/passwd')).toThrow('HTTP or HTTPS');
    expect(() => parseGatewayBaseUrl('http://user:pass@gateway/v1')).toThrow('cannot contain credentials');
    expect(() => parseGatewayBaseUrl('http://gateway/v1?token=x')).toThrow('cannot contain credentials');
  });
});
