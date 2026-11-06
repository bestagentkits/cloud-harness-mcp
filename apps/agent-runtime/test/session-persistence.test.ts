import { createHash } from 'node:crypto';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { AgentWorker } from '../src/agent-worker.js';
import { JsonlWriter } from '../src/jsonl.js';
import { BoundedOutput } from '../src/output.js';
import { createPiSessionFactory, createReplaySessionManager, type AgentSessionLike } from '../src/pi-session.js';
import { StartRecordSchema } from '../src/protocol-schemas.js';
import { ProxyToolBroker } from '../src/proxy-tools.js';
import { createRedactor } from '../src/redaction.js';
import {
  INTERRUPTED_TOOL_RESULT_TEXT,
  SESSION_GENESIS_SHA256,
  planSessionReplay,
  redactSecretDeep,
  sessionHead,
  type SessionMessage
} from '../src/session-replay.js';
import { captureOutput, createStartRecord } from './helpers.js';

const LEASE = 'lease-secret-value';
const user = (text: string, timestamp = 1): SessionMessage => ({ role: 'user', content: [{ type: 'text', text }], timestamp });
const assistantText = (text: string): SessionMessage => ({
  role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'cloud-harness-gateway', model: 'test-model',
  usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 } },
  stopReason: 'stop', timestamp: 2
});
const assistantCall = (id: string): SessionMessage => ({
  ...assistantText(''), content: [{ type: 'toolCall', id, name: 'files_read', arguments: { path: 'README.md' } }], stopReason: 'toolUse'
});
const result = (id: string): SessionMessage => ({
  role: 'toolResult', toolCallId: id, toolName: 'files_read', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 3
});

/** The runner's chain formula, written out independently of the runtime module. */
function runnerHead(messages: readonly unknown[]): string {
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  return messages.reduce<string>((head, message) => sha(head + sha(JSON.stringify(message))), '0'.repeat(64));
}

describe('persisted session replay planning', () => {
  it('computes the same chained digest as the runner store', () => {
    const messages = [user('task'), assistantCall('call-1'), result('call-1'), assistantText('done')];
    expect(sessionHead([])).toBe(SESSION_GENESIS_SHA256);
    expect(sessionHead(messages)).toBe(runnerHead(messages));
  });

  it('replays a complete log unchanged', () => {
    const messages = [user('task'), assistantCall('call-1'), result('call-1'), assistantText('done')];
    expect(planSessionReplay(messages)).toEqual({ replay: messages, trailingRepairs: [] });
  });

  it('closes a dangling tool call at the end of the log with an interrupted error result', () => {
    const messages = [user('task'), assistantCall('call-1')];
    const plan = planSessionReplay(messages, 42);
    const repair = {
      role: 'toolResult', toolCallId: 'call-1', toolName: 'files_read',
      content: [{ type: 'text', text: INTERRUPTED_TOOL_RESULT_TEXT }], isError: true, timestamp: 42
    };
    expect(plan.trailingRepairs).toEqual([repair]);
    expect(plan.replay).toEqual([...messages, repair]);
  });

  it('repairs an unanswered call inside the log for replay only', () => {
    const messages = [user('task'), assistantCall('call-1'), user('next'), assistantText('done')];
    const plan = planSessionReplay(messages, 7);
    expect(plan.trailingRepairs).toEqual([]);
    expect(plan.replay.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult', 'user', 'assistant']);
    expect(plan.replay[2]).toMatchObject({ toolCallId: 'call-1', isError: true });
  });

  it('never answers a tool call of an errored or aborted reply, which Pi drops from the provider context', () => {
    // Pi's transformMessages skips assistant messages that stopped with `error` or `aborted`, so a
    // result for one of their calls would reach the provider as an orphaned tool result.
    for (const stopReason of ['error', 'aborted']) {
      const broken = { ...assistantCall('call-1'), stopReason };
      const trailing = planSessionReplay([user('task'), broken], 42);
      expect(trailing).toEqual({ replay: [user('task'), broken], trailingRepairs: [] });
      const inner = planSessionReplay([user('task'), broken, user('next'), assistantText('done')], 42);
      expect(inner).toEqual({ replay: [user('task'), broken, user('next'), assistantText('done')], trailingRepairs: [] });
    }
  });

  it('still repairs the dangling tool calls of a reply that stopped on length or toolUse', () => {
    // Only `error` and `aborted` replies are dropped from the provider context; the others keep
    // their calls, so an unanswered one needs the synthetic interrupted result.
    for (const stopReason of ['length', 'toolUse']) {
      const truncated = { ...assistantCall('call-1'), stopReason };
      const repair = {
        role: 'toolResult', toolCallId: 'call-1', toolName: 'files_read',
        content: [{ type: 'text', text: INTERRUPTED_TOOL_RESULT_TEXT }], isError: true, timestamp: 42
      };
      const plan = planSessionReplay([user('task'), truncated], 42);
      expect(plan.trailingRepairs).toEqual([repair]);
      expect(plan.replay).toEqual([user('task'), truncated, repair]);
    }
  });

  it('closes an unanswered call with the outcome the runner settled for it, and the rest with the interruption', () => {
    const applied = JSON.stringify({ ok: true, message: 'File written', data: { path: 'out.txt' }, truncated: false });
    const messages = [user('task'), assistantCall('call-1'), user('next'), {
      ...assistantText(''),
      content: [{ type: 'toolCall', id: 'call-2', name: 'files_write', arguments: {} }, { type: 'toolCall', id: 'call-3', name: 'files_read', arguments: {} }]
    }];
    const outcomes = new Map([
      ['call-1', { text: 'unknown outcome', isError: true }],
      ['call-2', { text: applied, isError: false }]
    ]);
    const plan = planSessionReplay(messages, 9, outcomes);
    expect(plan.replay[2]).toMatchObject({ toolCallId: 'call-1', isError: true, content: [{ type: 'text', text: 'unknown outcome' }] });
    expect(plan.trailingRepairs).toEqual([
      { role: 'toolResult', toolCallId: 'call-2', toolName: 'files_write', content: [{ type: 'text', text: applied }], isError: false, timestamp: 9 },
      { role: 'toolResult', toolCallId: 'call-3', toolName: 'files_read', content: [{ type: 'text', text: INTERRUPTED_TOOL_RESULT_TEXT }], isError: true, timestamp: 9 }
    ]);
  });

  it('accepts bounded tool outcomes on a session and refuses duplicates, unknown outcomes, and oversized ones', () => {
    const plain = createStartRecord();
    const messages = [user('task')];
    const session = { messages, headSha256: sessionHead(messages) };
    const outcome = { toolCallId: 'call-1', outcome: 'APPLIED', isError: false, text: '{"ok":true}' };
    expect(StartRecordSchema.parse({ ...plain, session: { ...session, toolOutcomes: [outcome] } }).session?.toolOutcomes).toEqual([outcome]);
    expect(() => StartRecordSchema.parse({ ...plain, session: { ...session, toolOutcomes: [outcome, outcome] } })).toThrow();
    const unnamed = { ...outcome, toolCallId: '' };
    expect(StartRecordSchema.parse({ ...plain, session: { ...session, toolOutcomes: [unnamed] } }).session?.toolOutcomes).toEqual([unnamed]);
    expect(() => StartRecordSchema.parse({ ...plain, session: { ...session, toolOutcomes: [{ ...outcome, toolCallId: 'x'.repeat(1_025) }] } })).toThrow();
    expect(() => StartRecordSchema.parse({ ...plain, session: { ...session, toolOutcomes: [{ ...outcome, outcome: 'NONE' }] } })).toThrow();
    expect(() => StartRecordSchema.parse({ ...plain, session: { ...session, toolOutcomes: [{ ...outcome, text: 'x'.repeat(64 * 1024 + 1) }] } })).toThrow();
    const many = Array.from({ length: 65 }, (_, index) => ({ ...outcome, toolCallId: `call-${index}` }));
    expect(() => StartRecordSchema.parse({ ...plain, session: { ...session, toolOutcomes: many } })).toThrow();
  });

  it('redacts only the lease and keeps every other byte of the message', () => {
    const message = { role: 'assistant', z: 1, a: [`key ${LEASE} here`, { [LEASE]: 'value', token: 'kept' }] };
    const redacted = redactSecretDeep(message, LEASE);
    expect(JSON.stringify(redacted)).toBe(JSON.stringify({ role: 'assistant', z: 1, a: ['key [REDACTED] here', { '[REDACTED]': 'value', token: 'kept' }] }));
    expect(redactSecretDeep(message, 'absent-secret')).toEqual(message);
  });

  it('accepts a start record without a session exactly as before and validates a session when present', () => {
    const plain = createStartRecord();
    expect(StartRecordSchema.parse(plain)).toEqual(plain);
    const messages = [user('task')];
    expect(StartRecordSchema.parse({ ...plain, session: { messages, headSha256: sessionHead(messages) } }).session?.messages).toEqual(messages);
    expect(() => StartRecordSchema.parse({ ...plain, session: { messages: [{ role: 'bashExecution' }], headSha256: SESSION_GENESIS_SHA256 } })).toThrow();
    expect(() => StartRecordSchema.parse({ ...plain, session: { messages: [], headSha256: 'nope' } })).toThrow();
  });
});

describe('Pi session replay', () => {
  it('replays the history into an in-memory Pi session store in order', () => {
    const history = [user('task'), assistantCall('call-1'), result('call-1'), assistantText('done')];
    const manager = createReplaySessionManager(history);
    expect(manager.buildSessionContext().messages).toEqual(history);
    expect(createReplaySessionManager().buildSessionContext().messages).toEqual([]);
  });

  it('starts a controlled Pi session that holds the replayed history before the first prompt', async () => {
    const history = [user('task'), assistantText('done')];
    const factory = createPiSessionFactory('http://model-gateway:3210');
    const broker = new ProxyToolBroker(() => undefined, createRedactor(), 64 * 1024);
    const session = await factory(createStartRecord(), broker, history);
    try {
      expect(session.messages).toEqual(history);
    } finally {
      session.dispose();
    }
  });
});

class ScriptedSession implements AgentSessionLike {
  readonly promptGate = Promise.withResolvers<void>();
  readonly prompts: string[] = [];
  readonly messages: Array<SessionMessage & { stopReason?: string; errorMessage?: string }>;
  readonly abort = vi.fn(async () => this.promptGate.resolve());
  readonly dispose = vi.fn();
  #listener: ((event: AgentSessionEvent) => void) | undefined;

  constructor(history: readonly SessionMessage[] = []) {
    this.messages = [...history];
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listener = listener;
    return () => { this.#listener = undefined; };
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    await this.promptGate.promise;
  }

  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  waitForIdle(): Promise<void> { return Promise.resolve(); }
  getActiveToolNames(): string[] { return ['files_read']; }
  getAllTools(): Array<{ name: string }> { return [{ name: 'files_read' }]; }

  /** Usage totals over every held message, as Pi computes them. */
  getSessionStats() {
    const assistants = this.messages.filter((message) => message.role === 'assistant').length;
    return { tokens: { input: 5 * assistants, output: 3 * assistants, cacheRead: 0, cacheWrite: 0, total: 8 * assistants }, cost: 0.1 * assistants };
  }

  /** Records a message the way Pi does: hold it, then announce message_end. */
  add(message: SessionMessage): void {
    this.messages.push(message);
    this.#listener?.({ type: 'message_end', message } as unknown as AgentSessionEvent);
  }

  emit(event: AgentSessionEvent): void {
    this.#listener?.(event);
  }
}

function createWorker(session: ScriptedSession) {
  const captured = captureOutput();
  const writer = new JsonlWriter(captured.stream);
  const factory = vi.fn(async (_start: unknown, _broker: unknown, history?: readonly SessionMessage[]) => {
    if (history) session.messages.splice(0, session.messages.length, ...history);
    return session;
  });
  const worker = new AgentWorker(new BoundedOutput(writer), factory);
  return { worker, writer, factory, records: captured.records, text: () => captured.records().map((record) => JSON.stringify(record)).join('\n') };
}

describe('AgentWorker persisted session', () => {
  it('writes the same records as before when the start record has no session', async () => {
    const session = new ScriptedSession();
    const { worker, writer, factory, records } = createWorker(session);
    worker.receive(createStartRecord());
    await vi.waitFor(() => expect(session.prompts).toHaveLength(1));
    session.add(user('Inspect the workspace.'));
    session.add(assistantText('done'));
    session.emit({ type: 'turn_end' } as unknown as AgentSessionEvent);
    session.promptGate.resolve();
    await worker.completion;
    await writer.close();
    expect(factory.mock.calls[0]).toHaveLength(2);
    const usage = { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, total: 8, cost: 0.1 };
    expect(records()).toEqual([
      { type: 'event', sequence: 1, event: { kind: 'lifecycle', phase: 'turn_ended' } },
      { type: 'usage', sequence: 2, usage },
      { type: 'terminal', state: 'SUCCEEDED', usage }
    ]);
  });

  it('reports every completed message of a persisting agent in sequence, redacting only the lease', async () => {
    const session = new ScriptedSession();
    const { worker, writer, records } = createWorker(session);
    worker.receive(createStartRecord({ session: { messages: [], headSha256: SESSION_GENESIS_SHA256 } }));
    await vi.waitFor(() => expect(session.prompts).toHaveLength(1));
    session.add(user(`Inspect the workspace with ${LEASE}`));
    session.add(assistantCall('call-1'));
    session.add({ role: 'bashExecution', command: 'ls' });
    session.add(result('call-1'));
    session.add(assistantText('done'));
    session.promptGate.resolve();
    await worker.completion;
    await writer.close();
    const persisted = (records() as Array<Record<string, unknown>>).filter((record) => record.type === 'session_message');
    expect(persisted).toEqual([
      { type: 'session_message', seq: 0, message: user('Inspect the workspace with [REDACTED]') },
      { type: 'session_message', seq: 1, message: assistantCall('call-1') },
      { type: 'session_message', seq: 2, message: result('call-1') },
      { type: 'session_message', seq: 3, message: assistantText('done') }
    ]);
    // Persisted history is runner state, never charged to the caller's event budget.
    expect(records()).toContainEqual(expect.objectContaining({ type: 'terminal', state: 'SUCCEEDED' }));
  });

  it('replays verified history, persists the repair of a dangling call, and reports only its own usage', async () => {
    const history = [user('task'), assistantText('first answer'), user('follow up'), assistantCall('call-1')];
    const session = new ScriptedSession();
    const { worker, writer, factory, records } = createWorker(session);
    worker.receive(createStartRecord({ prompt: 'continue the task', session: { messages: history, headSha256: runnerHead(history) } }));
    await vi.waitFor(() => expect(session.prompts).toEqual(['continue the task']));
    const replayed = factory.mock.calls[0]![2]!;
    expect(replayed.slice(0, 4)).toEqual(history);
    expect(replayed[4]).toMatchObject({ role: 'toolResult', toolCallId: 'call-1', isError: true, content: [{ type: 'text', text: INTERRUPTED_TOOL_RESULT_TEXT }] });
    session.add(user('continue the task'));
    session.add(assistantText('second answer'));
    session.promptGate.resolve();
    await worker.completion;
    await writer.close();
    const output = records() as Array<Record<string, unknown>>;
    expect(output.filter((record) => record.type === 'session_message').map((record) => [record.seq, (record.message as SessionMessage).role]))
      .toEqual([[4, 'toolResult'], [5, 'user'], [6, 'assistant']]);
    // Two replayed assistant messages are excluded from this run's usage.
    expect(output).toContainEqual({ type: 'terminal', state: 'SUCCEEDED', usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, total: 8, cost: expect.closeTo(0.1, 10) } });
  });

  it('closes and persists a dangling call with the applied result the runner settled, so the model sees it landed', async () => {
    const history = [user('task'), assistantCall('call-1')];
    const receipt = JSON.stringify({ ok: true, message: 'Read 2 bytes', data: { content: 'ok' }, truncated: false });
    const session = new ScriptedSession();
    const { worker, writer, factory, records } = createWorker(session);
    worker.receive(createStartRecord({
      session: { messages: history, headSha256: runnerHead(history), toolOutcomes: [{ toolCallId: 'call-1', outcome: 'APPLIED', isError: false, text: receipt }] }
    }));
    await vi.waitFor(() => expect(session.prompts).toHaveLength(1));
    const repair = { role: 'toolResult', toolCallId: 'call-1', toolName: 'files_read', content: [{ type: 'text', text: receipt }], isError: false };
    expect(factory.mock.calls[0]![2]![2]).toMatchObject(repair);
    session.add(assistantText('done'));
    session.promptGate.resolve();
    await worker.completion;
    await writer.close();
    const persisted = (records() as Array<Record<string, unknown>>).filter((record) => record.type === 'session_message');
    expect(persisted[0]).toMatchObject({ seq: 2, message: repair });
  });

  it('fails a continued run without an assistant reply of its own even if the history ends with one', async () => {
    const history = [user('task'), assistantText('first answer')];
    const session = new ScriptedSession();
    const { worker, writer, records } = createWorker(session);
    worker.receive(createStartRecord({ session: { messages: history, headSha256: runnerHead(history) } }));
    await vi.waitFor(() => expect(session.prompts).toHaveLength(1));
    session.promptGate.resolve();
    await worker.completion;
    await writer.close();
    expect(records()).toContainEqual(expect.objectContaining({ type: 'terminal', state: 'FAILED', error: 'model session ended without an assistant response' }));
  });

  it('refuses history whose digest does not match before creating a session', async () => {
    const history = [user('task'), assistantText('first answer')];
    const session = new ScriptedSession();
    const { worker, writer, factory, records } = createWorker(session);
    worker.receive(createStartRecord({ session: { messages: history, headSha256: runnerHead([user('tampered')]) } }));
    await worker.completion;
    await writer.close();
    expect(factory).not.toHaveBeenCalled();
    expect(records()).toEqual([expect.objectContaining({ type: 'terminal', state: 'FAILED', error: 'agent session history failed integrity verification' })]);
  });

  it('skips a message over the protocol record limit, leaving a sequence gap instead of failing the run', async () => {
    const session = new ScriptedSession();
    const { worker, writer, records } = createWorker(session);
    worker.receive(createStartRecord({ session: { messages: [], headSha256: SESSION_GENESIS_SHA256 } }));
    await vi.waitFor(() => expect(session.prompts).toHaveLength(1));
    session.add(user('x'.repeat(9 * 1024 * 1024)));
    session.add(assistantText('done'));
    session.promptGate.resolve();
    await worker.completion;
    await writer.close();
    const output = records() as Array<Record<string, unknown>>;
    expect(output.filter((record) => record.type === 'session_message').map((record) => record.seq)).toEqual([1]);
    expect(output).toContainEqual(expect.objectContaining({ type: 'terminal', state: 'SUCCEEDED' }));
  });
});
