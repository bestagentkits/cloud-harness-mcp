import { describe, expect, it } from 'vitest';
import type { McpEventsRunnerRequest, McpEventsRunnerResponse } from '@cloud-harness/contracts';
import { EventDeliveryWorker, classifyOutcome } from '../src/events/event-delivery-worker.js';
import { categorizeTransportError, createWebhookSender, parseCallbackUrl, type WebhookSender } from '../src/events/webhook-sender.js';
import { signWebhook } from '../src/events/webhook-signature.js';

const PUBLIC = [{ address: '93.184.216.34', family: 4 as const }];
const secret = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;

type Captured = { url: string; init: RequestInit };

function capturingFetch(respond: (captured: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const captured = { url: String(input), init: init ?? {} };
    calls.push(captured);
    return await respond(captured);
  };
  return { calls, fetchImpl };
}

describe('Standard Webhooks signing', () => {
  it('matches the reference test vector', () => {
    // Published Standard Webhooks reference vector.
    expect(signWebhook(['whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'], 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}'))
      .toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('emits one space-separated signature per secret during rotation', () => {
    const second = `whsec_${Buffer.alloc(32, 3).toString('base64')}`;
    const both = signWebhook([secret, second], 'evt_1', 1, '{}').split(' ');
    expect(both).toHaveLength(2);
    expect(both[0]).toBe(signWebhook([secret], 'evt_1', 1, '{}'));
    expect(both[1]).toBe(signWebhook([second], 'evt_1', 1, '{}'));
  });
});

describe('callback URL policy', () => {
  it('requires https without credentials or fragments', () => {
    expect(parseCallbackUrl('https://hooks.example.com/a?b=c')).toEqual({ ok: true, url: 'https://hooks.example.com/a?b=c' });
    expect(parseCallbackUrl('http://hooks.example.com/a').ok).toBe(false);
    expect(parseCallbackUrl('https://user:pass@hooks.example.com/a').ok).toBe(false);
    expect(parseCallbackUrl('https://hooks.example.com/a#frag').ok).toBe(false);
    expect(parseCallbackUrl('not a url').ok).toBe(false);
  });

  it('refuses loopback, private, and metadata destinations, including by resolution', async () => {
    const privateResolver = createWebhookSender({ resolve: async () => [{ address: '10.0.0.5', family: 4 }] });
    expect((await privateResolver.checkUrl('https://hooks.example.com/a')).ok).toBe(false);
    const sender = createWebhookSender({ resolve: async () => PUBLIC });
    for (const url of ['https://127.0.0.1/a', 'https://169.254.169.254/latest', 'https://[::1]/a', 'https://localhost/a']) {
      expect((await sender.checkUrl(url)).ok, url).toBe(false);
    }
    expect(await sender.checkUrl('https://hooks.example.com/a')).toEqual({ ok: true, url: 'https://hooks.example.com/a' });
  });

  it('categorizes transport failures without echoing them', () => {
    expect(categorizeTransportError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(categorizeTransportError(Object.assign(new Error('x'), { cause: { code: 'CERT_HAS_EXPIRED' } }))).toBe('tls_error');
    expect(categorizeTransportError(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }))).toBe('connection_refused');
  });
});

describe('webhook sender', () => {
  it('signs deliveries with Standard Webhooks headers and refuses redirects', async () => {
    const { calls, fetchImpl } = capturingFetch(() => new Response('ok', { status: 200 }));
    const sender = createWebhookSender({ resolve: async () => PUBLIC, fetchImpl });
    const outcome = await sender.post({ url: 'https://hooks.example.com/a', webhookId: 'evt_abc', subscriptionId: 'sub_x', secrets: [secret], body: '{"a":1}' });
    expect(outcome.ok).toBe(true);
    const init = calls[0]!.init;
    const headers = init.headers as Record<string, string>;
    expect(init.redirect).toBe('error');
    expect(init.method).toBe('POST');
    expect(headers['webhook-id']).toBe('evt_abc');
    expect(headers['x-mcp-subscription-id']).toBe('sub_x');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['webhook-signature']).toBe(signWebhook([secret], 'evt_abc', Number(headers['webhook-timestamp']), '{"a":1}'));
    expect(Math.abs(Number(headers['webhook-timestamp']) - Date.now() / 1_000)).toBeLessThan(5);
  });

  it('re-validates on every attempt so a rebound hostname is never dialled', async () => {
    let answer = PUBLIC;
    const { calls, fetchImpl } = capturingFetch(() => new Response('ok'));
    const sender = createWebhookSender({ resolve: async () => answer, fetchImpl });
    expect((await sender.checkUrl('https://hooks.example.com/a')).ok).toBe(true);
    answer = [{ address: '127.0.0.1', family: 4 }];
    expect(await sender.post({ url: 'https://hooks.example.com/a', webhookId: 'evt_1', subscriptionId: 'sub_x', secrets: [secret], body: '{}' }))
      .toEqual({ ok: false, reason: 'connection_refused' });
    expect(calls).toHaveLength(0);
  });

  it('maps statuses to categories and treats a redirect response as a client error', async () => {
    for (const [status, reason] of [[302, 'http_4xx'], [404, 'http_4xx'], [503, 'http_5xx']] as const) {
      const { fetchImpl } = capturingFetch(() => new Response(null, { status }));
      const sender = createWebhookSender({ resolve: async () => PUBLIC, fetchImpl });
      expect(await sender.post({ url: 'https://hooks.example.com/a', webhookId: 'evt_1', subscriptionId: 'sub_x', secrets: [secret], body: '{}' }))
        .toEqual({ ok: false, reason, status });
    }
    const failing = createWebhookSender({ resolve: async () => PUBLIC, fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }); } });
    expect(await failing.post({ url: 'https://hooks.example.com/a', webhookId: 'evt_1', subscriptionId: 'sub_x', secrets: [secret], body: '{}' }))
      .toEqual({ ok: false, reason: 'timeout' });
  });

  it('verifies only an exact challenge echo from a signed verification request', async () => {
    const echo = capturingFetch(({ init }) => {
      const body = JSON.parse(String(init.body)) as { type: string; challenge: string };
      return Response.json({ challenge: body.challenge });
    });
    const sender = createWebhookSender({ resolve: async () => PUBLIC, fetchImpl: echo.fetchImpl });
    expect(await sender.verify({ url: 'https://hooks.example.com/a', subscriptionId: 'sub_x', secrets: [secret] })).toEqual({ ok: true });
    const headers = echo.calls[0]!.init.headers as Record<string, string>;
    expect(headers['webhook-id']).toMatch(/^msg_verification_[A-Za-z0-9_-]+$/u);
    expect(JSON.parse(String(echo.calls[0]!.init.body))).toEqual({ type: 'verification', challenge: expect.any(String) });
    expect(headers['webhook-signature']).toBe(signWebhook([secret], headers['webhook-id']!, Number(headers['webhook-timestamp']), String(echo.calls[0]!.init.body)));

    for (const respond of [() => Response.json({ challenge: 'wrong' }), () => new Response('ok'), () => Response.json({})]) {
      const wrong = createWebhookSender({ resolve: async () => PUBLIC, fetchImpl: capturingFetch(respond).fetchImpl });
      expect(await wrong.verify({ url: 'https://hooks.example.com/a', subscriptionId: 'sub_x', secrets: [secret] })).toEqual({ ok: false, reason: 'challenge_failed' });
    }
  });
});

describe('event delivery worker', () => {
  const delivery = (index: number) => ({
    deliveryId: `dlv_${String(index).padStart(22, 'a')}`,
    leaseToken: 'L'.repeat(22),
    subscriptionId: `sub_${'1'.repeat(32)}`,
    eventId: `evt_${index}`,
    url: 'https://hooks.example.com/a',
    secrets: [secret],
    body: `{"eventId":"evt_${index}"}`
  });

  function runner(deliveries: ReturnType<typeof delivery>[]) {
    const requests: McpEventsRunnerRequest[] = [];
    const callRunner = async (request: McpEventsRunnerRequest): Promise<McpEventsRunnerResponse> => {
      requests.push(request);
      if (request.operation === 'events_delivery_claim') return { ok: true, data: { deliveries } };
      return { ok: true, data: { accepted: 1 } };
    };
    return { requests, callRunner };
  }

  it('classifies 410 and 413 as permanent and everything else as retryable', () => {
    expect(classifyOutcome({ ok: true, status: 204, body: new Uint8Array() })).toEqual({ outcome: 'delivered' });
    expect(classifyOutcome({ ok: false, reason: 'http_4xx', status: 410 })).toEqual({ outcome: 'rejected', error: 'http_4xx' });
    expect(classifyOutcome({ ok: false, reason: 'http_4xx', status: 413 })).toEqual({ outcome: 'rejected', error: 'http_4xx' });
    expect(classifyOutcome({ ok: false, reason: 'http_4xx', status: 400 })).toEqual({ outcome: 'failed', error: 'http_4xx' });
    expect(classifyOutcome({ ok: false, reason: 'timeout' })).toEqual({ outcome: 'failed', error: 'timeout' });
  });

  it('posts each claimed delivery with its event id and reports every lease', async () => {
    const posted: string[] = [];
    const sender: WebhookSender = {
      checkUrl: async (url) => ({ ok: true, url }),
      verify: async () => ({ ok: true }),
      post: async (request) => {
        posted.push(request.webhookId);
        return request.webhookId === 'evt_2' ? { ok: false, reason: 'http_5xx', status: 500 } : { ok: true, status: 200, body: new Uint8Array() };
      }
    };
    const { requests, callRunner } = runner([delivery(1), delivery(2), delivery(3)]);
    const worker = new EventDeliveryWorker({ callRunner, sender, concurrency: 2 });
    await worker.tick();
    expect(posted.sort()).toEqual(['evt_1', 'evt_2', 'evt_3']);
    const report = requests.find((request) => request.operation === 'events_delivery_report');
    expect(report?.input).toEqual({
      results: expect.arrayContaining([
        { deliveryId: delivery(1).deliveryId, leaseToken: 'L'.repeat(22), outcome: 'delivered' },
        { deliveryId: delivery(2).deliveryId, leaseToken: 'L'.repeat(22), outcome: 'failed', error: 'http_5xx' }
      ])
    });
    await worker.stop();
  });

  it('runs one pass at a time and reports a failed claim without posting', async () => {
    const errors: string[] = [];
    let posts = 0;
    const sender: WebhookSender = {
      checkUrl: async (url) => ({ ok: true, url }), verify: async () => ({ ok: true }),
      post: async () => { posts += 1; return { ok: true, status: 200, body: new Uint8Array() }; }
    };
    const worker = new EventDeliveryWorker({
      callRunner: async () => ({ ok: false, error: { code: 'UNAVAILABLE', message: 'down' } }),
      sender,
      onError: (stage, reason) => errors.push(`${stage}:${reason}`)
    });
    await Promise.all([worker.tick(), worker.tick()]);
    expect(errors).toEqual(['claim:UNAVAILABLE']);
    expect(posts).toBe(0);
    await worker.stop();
  });
});
