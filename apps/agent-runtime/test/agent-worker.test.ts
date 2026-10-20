import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { AgentWorker } from '../src/agent-worker.js';
import { JsonlWriter } from '../src/jsonl.js';
import { BoundedOutput } from '../src/output.js';
import type { AgentSessionLike } from '../src/pi-session.js';
import { ProxyToolBroker, transcriptToolCalls } from '../src/proxy-tools.js';
import type { OutputRecord } from '../src/protocol-schemas.js';
import { createRedactor } from '../src/redaction.js';
import { captureOutput, createStartRecord } from './helpers.js';

class FakeSession implements AgentSessionLike {
  readonly promptGate = Promise.withResolvers<void>();
  readonly prompts: string[] = [];
  readonly steering: string[] = [];
  readonly followUps: string[] = [];
  readonly messages: Array<{ role: string; stopReason?: string; errorMessage?: string }> = [
    { role: 'assistant', stopReason: 'stop' }
  ];
  readonly abort = vi.fn(async () => this.promptGate.resolve());
  readonly dispose = vi.fn();
  #listener: ((event: AgentSessionEvent) => void) | undefined;

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listener = listener;
    return () => {
      this.#listener = undefined;
    };
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    await this.promptGate.promise;
  }

  async steer(text: string): Promise<void> {
    this.steering.push(text);
  }

  async followUp(text: string): Promise<void> {
    this.followUps.push(text);
  }

  waitForIdle(): Promise<void> {
    return Promise.resolve();
  }

  getActiveToolNames(): string[] {
    return ['files_read'];
  }

  getAllTools(): Array<{ name: string }> {
    return [{ name: 'files_read' }];
  }

  getSessionStats() {
    return { tokens: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, total: 23 }, cost: 0.25 };
  }

  emit(event: AgentSessionEvent): void {
    this.#listener?.(event);
  }
}

function createWorker(session: FakeSession) {
  const captured = captureOutput();
  const writer = new JsonlWriter(captured.stream);
  const worker = new AgentWorker(new BoundedOutput(writer), async () => session);
  return { worker, writer, records: captured.records };
}

describe('AgentSession worker lifecycle', () => {
  it('prompts once, routes steer/follow-up, emits redacted events and usage, then one terminal', async () => {
    const session = new FakeSession();
    const { worker, writer, records } = createWorker(session);
    const start = createStartRecord();
    worker.receive(start);
    worker.receive({ type: 'message', requestId: 'message-1', behavior: 'steer', text: 'change direction' });
    worker.receive({ type: 'message', requestId: 'message-2', behavior: 'followUp', text: 'then summarize' });
    await Promise.resolve();

    session.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'hidden lease-secret-value' }
    } as unknown as AgentSessionEvent);
    session.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'safe Bearer lease-secret-value' }
    } as unknown as AgentSessionEvent);
    session.emit({ type: 'turn_end' } as unknown as AgentSessionEvent);
    session.promptGate.resolve();

    await worker.completion;
    await writer.close();
    expect(session.prompts).toEqual([start.prompt]);
    expect(session.steering).toEqual(['change direction']);
    expect(session.followUps).toEqual(['then summarize']);
    const output = records() as Array<Record<string, unknown>>;
    expect(JSON.stringify(output)).not.toContain('lease-secret-value');
    expect(JSON.stringify(output)).not.toContain('hidden');
    expect(output).toContainEqual(expect.objectContaining({ type: 'usage', usage: expect.objectContaining({ total: 23 }) }));
    expect(output.filter((record) => record.type === 'terminal')).toEqual([
      expect.objectContaining({ type: 'terminal', state: 'SUCCEEDED', usage: expect.objectContaining({ cost: 0.25 }) })
    ]);
  });

  it('maps gateway budget/bound errors and output-token exhaustion to LIMIT_EXCEEDED', async () => {
    const failures = [
      { stopReason: 'error', errorMessage: '429 model_budget_exhausted: model budget exhausted' },
      { stopReason: 'error', errorMessage: '413 model_bound_exceeded' },
      { stopReason: 'length' }
    ];
    for (const failure of failures) {
      const session = new FakeSession();
      session.messages[0] = { role: 'assistant', ...failure };
      const { worker, writer, records } = createWorker(session);
      worker.receive(createStartRecord());
      session.promptGate.resolve();
      await worker.completion;
      await writer.close();
      expect(records()).toContainEqual(expect.objectContaining({ type: 'terminal', state: 'LIMIT_EXCEEDED' }));
    }
  });

  it('cooperatively aborts the session and emits CANCELLED exactly once', async () => {
    const session = new FakeSession();
    const { worker, writer, records } = createWorker(session);
    worker.receive(createStartRecord());
    await Promise.resolve();
    worker.receive({ type: 'cancel', requestId: 'cancel-1', reason: 'stop now' });
    await worker.completion;
    await writer.close();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(records()).toContainEqual(expect.objectContaining({ type: 'terminal', state: 'CANCELLED' }));
    expect(records().filter((record) => record !== null && typeof record === 'object' && 'type' in record && record.type === 'terminal')).toHaveLength(1);
  });

  it('hands a hard deadline to cooperative abort and reports TIMED_OUT', async () => {
    vi.useFakeTimers();
    try {
      const session = new FakeSession();
      const { worker, writer, records } = createWorker(session);
      const defaults = createStartRecord();
      worker.receive(createStartRecord({ limits: { ...defaults.limits, deadlineMs: 1_000 } }));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      await worker.completion;
      await writer.close();
      expect(session.abort).toHaveBeenCalledOnce();
      expect(records()).toContainEqual(expect.objectContaining({ type: 'terminal', state: 'TIMED_OUT' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards bounded tool updates and resolves the matching final result', async () => {
    const emitted: OutputRecord[] = [];
    const onUpdate = vi.fn();
    const broker = new ProxyToolBroker((record) => emitted.push(record), createRedactor(), 64 * 1024);
    const [definition] = broker.createDefinitions(['files_read']);
    if (!definition) throw new Error('expected proxy tool definition');
    const execution = definition.execute('call-1', { path: 'src/index.ts' }, undefined, onUpdate, undefined as never);
    const request = emitted.find((record) => record.type === 'tool_request');
    if (!request || request.type !== 'tool_request') throw new Error('expected proxy tool request');
    broker.acceptResult({
      type: 'tool_result',
      requestId: request.requestId,
      final: false,
      isError: false,
      content: [{ type: 'text', text: 'partial' }],
      details: {}
    });
    expect(onUpdate).toHaveBeenCalledOnce();
    broker.acceptResult({
      type: 'tool_result',
      requestId: request.requestId,
      final: true,
      isError: false,
      content: [{ type: 'text', text: 'complete' }],
      details: {}
    });
    await expect(execution).resolves.toMatchObject({ content: [{ type: 'text', text: 'complete' }] });
  });

  it('forwards validated tool arguments without redaction or truncation', async () => {
    const emitted: OutputRecord[] = [];
    const broker = new ProxyToolBroker((record) => emitted.push(record), createRedactor(), 64 * 1024);
    const [definition] = broker.createDefinitions(['files_write']);
    if (!definition) throw new Error('expected proxy tool definition');
    const content = `export const key = 'sk-abcdefgh';\n${'a'.repeat(150_000)}`;
    const execution = definition.execute('call-write', { path: 'proof.txt', content }, undefined, undefined, undefined as never);
    const request = emitted.find((record) => record.type === 'tool_request');
    if (!request || request.type !== 'tool_request') throw new Error('expected proxy tool request');
    expect(request.input).toEqual({ path: 'proof.txt', content });
    broker.acceptResult({
      type: 'tool_result',
      requestId: request.requestId,
      final: true,
      isError: false,
      content: [{ type: 'text', text: 'written' }]
    });
    await expect(execution).resolves.toMatchObject({ content: [{ type: 'text', text: 'written' }] });
  });

  it('maps a custom tool AbortSignal to request-scoped tool cancellation', async () => {
    const emitted: OutputRecord[] = [];
    const broker = new ProxyToolBroker((record) => emitted.push(record), createRedactor(), 64 * 1024);
    const [definition] = broker.createDefinitions(['files_read']);
    if (!definition) throw new Error('expected proxy tool definition');
    const controller = new AbortController();
    const execution = definition.execute('call-1', { path: 'src/index.ts' }, controller.signal, undefined, undefined as never);
    const request = emitted.find((record) => record.type === 'tool_request');
    expect(request).toMatchObject({ type: 'tool_request', operation: 'files_read', toolCallId: 'call-1' });
    controller.abort();
    await expect(execution).rejects.toThrow('aborted');
    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'tool_cancel',
      requestId: request?.type === 'tool_request' ? request.requestId : 'missing'
    }));
  });

  it('names each proxy request by its tool call ID so a redelivery is recognizable', async () => {
    const emitted: OutputRecord[] = [];
    const broker = new ProxyToolBroker((record) => emitted.push(record), createRedactor(), 64 * 1024);
    const [definition] = broker.createDefinitions(['files_read']);
    if (!definition) throw new Error('expected proxy tool definition');
    const execution = definition.execute('toolu_01ABC', { path: 'a.txt' }, undefined, undefined, undefined as never);
    expect(emitted[0]).toMatchObject({ type: 'tool_request', requestId: 'toolu_01ABC', toolCallId: 'toolu_01ABC' });
    broker.acceptResult({ type: 'tool_result', requestId: 'toolu_01ABC', final: true, isError: false, content: [{ type: 'text', text: 'ok' }] });
    await expect(execution).resolves.toMatchObject({ content: [{ type: 'text', text: 'ok' }] });
  });

  describe('request IDs of repeated or empty tool call IDs', () => {
    const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: 'toolCall', id, name, arguments: args });
    const result = (id: string, isError = false) => ({ role: 'toolResult', toolCallId: id, toolName: 'files_read', content: [], isError });
    // The same vector pins the runner's derivation in apps/runner/test/agent-effect-reconciler.test.ts.
    const transcript = [
      { role: 'user', content: [{ type: 'text', text: 'task' }] },
      { role: 'assistant', content: [
        call('call_0', 'files_write', { path: 'a.txt', content: '1' }),
        call('call_0', 'files_read', { path: 'b.txt' }),
        call('', 'files_read', { path: 'c.txt' })
      ] },
      // Pi rejected the first call's arguments without executing it; it is still a recorded call.
      result('call_0', true), result('call_0'), result(''),
      { role: 'assistant', content: [
        call('call_0', 'files_write', { path: 'a.txt', content: '2' }),
        call('', 'files_read', { path: 'd.txt' }),
        call('bad id', 'files_read', { path: 'e.txt' })
      ] }
    ];
    const expected = [
      'call_0', 'call_801178adf4f55d2756ae10d7449b803c', 'call_e3b0c44298fc1c149afbf4c8996fb924',
      'call_d8d9e880ebc0b0b5b0665a12b803d76f', 'call_b8e3852dae73d75c43557bb87f0afba9', 'call_4b2d2ff66c98b2a1e6f08bdcdf4a04a7'
    ];
    const entries = (messages: unknown[]) => ({ sessionManager: { getEntries: () => messages.map((message) => ({ type: 'message', message })) } });
    const execute = (ctx: unknown, calls: Array<[string, string, Record<string, unknown>]>) => {
      const emitted: OutputRecord[] = [];
      const broker = new ProxyToolBroker((record) => emitted.push(record), createRedactor(), 64 * 1024);
      const definitions = new Map(broker.createDefinitions(['files_read', 'files_write']).map((definition) => [definition.name, definition]));
      for (const [id, name, args] of calls) {
        void definitions.get(name)!.execute(id, args, undefined, undefined, ctx as never).catch(() => undefined);
      }
      return emitted.flatMap((record) => record.type === 'tool_request' ? [record.requestId] : []);
    };

    it('derives one request ID per recorded tool call block, executed or not, matching the runner', () => {
      expect(transcriptToolCalls(transcript).map((item) => item.requestId)).toEqual(expected);
      for (const id of expected) expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
    });

    it('proxies each call of the latest assistant message under its transcript-derived request ID', () => {
      expect(execute(entries(transcript), [
        ['call_0', 'files_write', { path: 'a.txt', content: '2' }],
        ['', 'files_read', { path: 'd.txt' }],
        ['bad id', 'files_read', { path: 'e.txt' }]
      ])).toEqual(expected.slice(3));
    });

    it('picks the block a repeated ID was executed for when Pi skipped an earlier block with that ID', () => {
      // Only the second `call_0` block of the message passed validation and reached the broker.
      expect(execute(entries(transcript.slice(0, 2)), [['call_0', 'files_read', { path: 'b.txt' }]])).toEqual([expected[1]]);
    });

    it('falls back to issue order when the session transcript cannot be read', () => {
      const unreadable = { sessionManager: { getEntries: () => { throw new Error('closed'); } } };
      const ids = execute(unreadable, [['call_0', 'files_read', { path: 'a.txt' }], ['call_0', 'files_read', { path: 'a.txt' }]]);
      expect(ids).toEqual(['call_0', 'call_801178adf4f55d2756ae10d7449b803c']);
      expect(execute(undefined, [['', 'files_read', { path: 'a.txt' }]])).toEqual(['call_e3b0c44298fc1c149afbf4c8996fb924']);
    });
  });
});
