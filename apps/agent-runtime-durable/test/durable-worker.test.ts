import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { InputRecordSchema, OutputRecordSchema } from '../../agent-runtime/src/protocol-schemas.js';
import { createRedactor } from '../../agent-runtime/src/redaction.js';
import { AgentStorageRequestRecordSchema } from '../../runner/src/agent-protocol.js';
import { DurableSessionStore } from '../../runner/src/durable-session-store.js';
import { runDurableWorker } from '../src/durable-worker.js';
import type { DurableInputRecord, DurableStartRecord, DurableWorker, TerminalState, Usage } from '../src/protocol.js';
import { LINEAGE, OWNER } from './channel.js';

const LEASE = 'lease-secret-value';

function startRecord(overrides: Partial<DurableStartRecord> = {}): DurableStartRecord {
  return {
    type: 'start',
    requestId: 'start-1',
    agentId: OWNER,
    prompt: 'Read the README.',
    tools: ['files_read', 'files_write'],
    gateway: { profile: 'test-profile', lease: LEASE },
    model: {
      id: 'faux-model',
      name: 'Faux model',
      api: 'openai-completions',
      reasoning: false,
      contextWindow: 32_000,
      maxTokens: 4_096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    },
    limits: { deadlineMs: 60_000, maxEvents: 500, maxOutputBytes: 1024 * 1024, maxEventBytes: 8_192, maxToolResultBytes: 64 * 1024 },
    runtime: 'pi-durable',
    ...overrides
  };
}

function line(record: unknown): unknown {
  return JSON.parse(JSON.stringify(record));
}

interface Run {
  readonly worker: DurableWorker;
  readonly records: Array<Record<string, unknown>>;
  /** Storage requests sent to the runner so far. */
  readonly storageRequests: () => number;
  readonly terminal: Promise<{ state: TerminalState; usage: Usage; error?: string | undefined }>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * Runs a durable worker against the runner's session store and a fake tool executor, with every
 * record passing through the worker's and the runner's protocol schemas.
 */
async function run(
  start: DurableStartRecord,
  responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0],
  onToolRequest: (record: Record<string, unknown>, deliver: (input: DurableInputRecord) => void) => void,
  tuning: { tokensPerSecond?: number; partialIntervalMs?: number } = {}
): Promise<Run> {
  const stateDir = await mkdtemp(join(tmpdir(), 'durable-worker-'));
  const store = new DurableSessionStore({ stateDir, enabled: true });
  cleanups.push(async () => {
    await store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const claim = await store.claim(LINEAGE, start.agentId, 1, 0);
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-model' }], tokensPerSecond: tuning.tokensPerSecond });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const records: Array<Record<string, unknown>> = [];
  let storageRequests = 0;
  const terminal = Promise.withResolvers<{ state: TerminalState; usage: Usage; error?: string | undefined }>();
  const deliver = (input: DurableInputRecord) => {
    const parsed = InputRecordSchema.parse(line(input));
    queueMicrotask(() => worker.receive(parsed as DurableInputRecord));
  };
  const worker: DurableWorker = runDurableWorker({
    gatewayBaseUrl: 'http://model-gateway.invalid/v1',
    redactor: createRedactor(),
    configureOutput: () => undefined,
    isOutputLimitError: () => false,
    emit: async (record) => {
      const parsed = OutputRecordSchema.parse(line(record)) as Record<string, unknown>;
      records.push(parsed);
      if (parsed.type === 'tool_request') onToolRequest(parsed, deliver);
    },
    sendStorage: async (record) => {
      const request = AgentStorageRequestRecordSchema.parse(OutputRecordSchema.parse(line(record)));
      storageRequests += 1;
      void store.handle(claim, request).then((response) => deliver(response));
    },
    terminal: async (state, usage, error) => {
      OutputRecordSchema.parse(line({ type: 'terminal', state, usage, error }));
      terminal.resolve({ state, usage, error });
    }
  }, start, { models, model: { provider: 'faux', modelId: 'faux-model' }, storage: { requestTimeoutMs: 5_000 }, partialIntervalMs: tuning.partialIntervalMs });
  return { worker, records, storageRequests: () => storageRequests, terminal: terminal.promise };
}

describe('durable worker', () => {
  it('runs a prompt through a proxied tool call to a successful terminal record', async () => {
    const { worker, records, terminal } = await run(startRecord(), [
      fauxAssistantMessage(fauxToolCall('files_read', { path: 'README.md' }, { id: 'call-1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('The README describes the project.')
    ], (request, deliver) => {
      deliver({ type: 'tool_result', requestId: request.requestId as string, final: true, isError: false, content: [{ type: 'text', text: '# Project' }] });
    });
    const result = await terminal;
    await worker.completion;
    expect(result.state).toBe('SUCCEEDED');
    const requests = records.filter((record) => record.type === 'tool_request');
    expect(requests).toEqual([expect.objectContaining({ operation: 'files_read', toolCallId: 'call-1', input: { path: 'README.md' } })]);
    expect(requests[0]?.requestId).toMatch(/^durable-task-\d+$/);
    const events = records.filter((record) => record.type === 'event').map((record) => record.event);
    expect(events).toContainEqual({ kind: 'lifecycle', phase: 'started' });
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool', phase: 'ended', name: 'files_read', isError: false }));
    expect(events.filter((event) => (event as { kind: string }).kind === 'text_delta').map((event) => (event as { text: string }).text).join(''))
      .toBe('The README describes the project.');
    expect(records.some((record) => record.type === 'usage')).toBe(true);
    expect(JSON.stringify(records)).not.toContain(LEASE);
  });

  it('reports a failed tool call to the model and still completes', async () => {
    const { terminal, records } = await run(startRecord(), [
      fauxAssistantMessage(fauxToolCall('files_write', { path: 'a.txt', content: 'x' }, { id: 'call-1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Writing failed.')
    ], (request, deliver) => {
      deliver({ type: 'tool_result', requestId: request.requestId as string, final: true, isError: true, content: [{ type: 'text', text: 'path is read-only' }] });
    });
    expect((await terminal).state).toBe('SUCCEEDED');
    const events = records.filter((record) => record.type === 'event').map((record) => record.event);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool', phase: 'ended', name: 'files_write', isError: true }));
  });

  it('cancels an in-flight tool call when the run is cancelled', async () => {
    let started: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => { started = resolve; });
    const { worker, records, terminal } = await run(startRecord(), [
      fauxAssistantMessage(fauxToolCall('files_read', { path: 'README.md' }, { id: 'call-1' }), { stopReason: 'toolUse' })
    ], () => started?.());
    await toolStarted;
    worker.receive({ type: 'cancel', requestId: 'cancel-1', reason: 'caller cancelled' });
    const result = await terminal;
    expect(result.state).toBe('CANCELLED');
    expect(records).toContainEqual(expect.objectContaining({ type: 'tool_cancel' }));
  });

  it('marks a reply cut off by the token limit as limit exceeded', async () => {
    const { terminal } = await run(startRecord(), [fauxAssistantMessage('partial', { stopReason: 'length' })], () => undefined);
    expect((await terminal).state).toBe('LIMIT_EXCEEDED');
  });

  it('refuses to replay a coding-runtime session', async () => {
    const { terminal } = await run(startRecord({ session: { messages: [], headSha256: '0'.repeat(64) } }), [], () => undefined);
    const result = await terminal;
    expect(result.state).toBe('FAILED');
    expect(result.error).toContain('cannot replay');
  });

  it('commits a slow stream\'s partial message only once the partial interval elapses', async () => {
    // 16 tokens at 20 tokens per second stream for at least 800 ms, past the default 500 ms interval.
    const reply = 'The README describes a remote coding harness and its deployment.';
    const commits = async (tuning: { tokensPerSecond?: number; partialIntervalMs?: number }) => {
      const { worker, storageRequests, terminal } = await run(startRecord(), [fauxAssistantMessage(reply)], () => undefined, tuning);
      expect((await terminal).state).toBe('SUCCEEDED');
      await worker.completion;
      return storageRequests();
    };
    const fast = await commits({});
    expect(await commits({ tokensPerSecond: 20 })).toBeGreaterThan(fast);
    expect(await commits({ tokensPerSecond: 20, partialIntervalMs: 60_000 })).toBe(fast);
  }, 20_000);
});
