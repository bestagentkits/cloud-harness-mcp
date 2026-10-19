/**
 * Baseline runtime: the shipped pi-coding worker with a scripted model in place of the gateway and
 * the benchmark answering proxy tool requests in place of the runner. One-shot Pi session,
 * in-memory transcript, container-local state; it never continues an earlier lifetime.
 */
import { PassThrough } from 'node:stream';
import { AgentWorker } from '../../../apps/agent-runtime/src/agent-worker.js';
import { JsonlWriter, ProtocolError } from '../../../apps/agent-runtime/src/jsonl.js';
import { BoundedOutput } from '../../../apps/agent-runtime/src/output.js';
import type { AgentSessionLike } from '../../../apps/agent-runtime/src/pi-session.js';
import { createStartRecord } from '../../../apps/agent-runtime/test/helpers.js';
import { BENCH_LIMITS, ModelRequestCounter, WorkerRecordObserver, fauxSessionFactory, type RuntimeUnderTest } from './harness.js';

let agentCounter = 0;

/** Whether a finished worker refuses a follow-up message, as a terminal worker must. */
export function refusesInputAfterTerminal(worker: AgentWorker): boolean {
  try {
    worker.receive({ type: 'message', requestId: 'late-1', behavior: 'followUp', text: 'continue' });
    return false;
  } catch (error) {
    return error instanceof ProtocolError;
  }
}

export const piCodingBaseline: RuntimeUnderTest = {
  id: 'pi-coding',
  description: 'Shipped runtime: one-shot Pi session, in-memory transcript, container-local state',
  async run(task) {
    const startRecord = createStartRecord({
      agentId: `agent_${String((agentCounter += 1)).padStart(20, '0')}`,
      prompt: task.prompt,
      tools: task.tools,
      limits: { ...BENCH_LIMITS }
    });
    const stream = new PassThrough();
    const output = new BoundedOutput(new JsonlWriter(stream));
    let session: AgentSessionLike | undefined;
    const model = new ModelRequestCounter();
    const worker = new AgentWorker(output, fauxSessionFactory(task.model, model.onRequest, (created) => { session = created; }));

    const stop = (mode: 'kill' | 'cancel') => {
      // Defer so the request that triggered the stop has been fully recorded first.
      setImmediate(() => {
        if (mode === 'kill') worker.interrupt(new Error('runtime received termination signal'));
        else worker.receive({ type: 'cancel', requestId: 'cancel-1', reason: 'owner cancelled' });
      });
    };
    const answered = new Set<string>();
    const rssBefore = process.memoryUsage().rss;
    const observer = new WorkerRecordObserver((record) => {
      if (record.type !== 'tool_request') return;
      const interrupt = task.interrupt;
      if (interrupt && observer.toolRoundTrips >= interrupt.atToolRequest) {
        if (observer.toolRoundTrips === interrupt.atToolRequest) stop(interrupt.mode);
        return; // the request stays in flight: no result is ever delivered
      }
      if (answered.has(record.requestId)) return;
      answered.add(record.requestId);
      const result = task.workspace.execute(record.operation, record.input as Record<string, unknown>);
      setImmediate(() => {
        try {
          worker.receive({ type: 'tool_result', requestId: record.requestId, final: true, isError: !result.ok, content: [{ type: 'text', text: JSON.stringify(result) }] });
        } catch {
          // The worker already reached a terminal state; the late result is dropped like the runner does.
        }
      });
    });
    stream.on('data', (chunk: Buffer) => observer.feed(chunk));

    worker.receive(startRecord);
    await worker.completion;
    const wallMs = performance.now() - observer.startedAt;
    await new Promise((resolve) => setImmediate(resolve));
    const postTerminalInputRefused = refusesInputAfterTerminal(worker);

    const transcript = session ? JSON.stringify(session.messages) : '[]';
    return {
      state: observer.terminal?.state ?? 'FAILED',
      error: observer.terminal?.error,
      wallMs,
      firstRecordMs: (observer.firstRecordAt ?? performance.now()) - observer.startedAt,
      modelRequests: model.requests,
      toolRoundTrips: observer.toolRoundTrips,
      toolCancels: observer.toolCancels,
      recordBytes: observer.recordBytes,
      firstRequestMessages: model.firstMessages,
      lastRequestMessages: model.lastMessages,
      lastRequestBytes: model.lastBytes,
      transcriptMessages: session?.messages.length ?? 0,
      transcriptBytes: Buffer.byteLength(transcript, 'utf8'),
      inputTokens: observer.inputTokens,
      outputTokens: observer.outputTokens,
      storageRows: 0,
      storageBytes: 0,
      rssDeltaBytes: process.memoryUsage().rss - rssBefore,
      continued: false,
      postTerminalInputRefused,
      handle: undefined
    };
  }
};
