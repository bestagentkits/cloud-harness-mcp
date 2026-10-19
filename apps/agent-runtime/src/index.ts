import { AgentWorker } from './agent-worker.js';
import { EngineRouter, type EngineWorker } from './engine-selection.js';
import { InputRecordQueue, JsonlWriter, ProtocolError } from './jsonl.js';
import { BoundedOutput, OutputLimitError } from './output.js';
import { createPiSessionFactory } from './pi-session.js';
import type { StartRecord } from './protocol-schemas.js';
import { createRedactor } from './redaction.js';

const gatewayBaseUrl = process.env.AGENT_MODEL_GATEWAY_URL ?? 'http://model-gateway:3210/v1';
const decoder = new InputRecordQueue();
const writer = new JsonlWriter(process.stdout);
const output = new BoundedOutput(writer);
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };

// The durable engine and its dependencies load only when a start record asks for it.
async function loadDurableEngine(start: StartRecord): Promise<EngineWorker> {
  const { runDurableWorker } = await import('@cloud-harness/agent-runtime-durable');
  return runDurableWorker({
    gatewayBaseUrl,
    redactor: createRedactor(),
    configureOutput: (limits) => output.configure(limits),
    emit: (record) => output.emit(record),
    isOutputLimitError: (error) => error instanceof OutputLimitError,
    sendStorage: (record) => writer.write(record),
    terminal: (state, usage, error) => output.terminal(state, usage, error)
  }, start);
}

const worker = new EngineRouter(
  new AgentWorker(output, createPiSessionFactory(gatewayBaseUrl)),
  loadDurableEngine,
  async () => {
    if (!output.terminalWritten) await output.terminal('FAILED', ZERO_USAGE, 'durable agent runtime is unavailable');
  }
);
let inputClosed = false;

function failInput(error: unknown): void {
  if (inputClosed) return;
  inputClosed = true;
  process.stdin.pause();
  worker.interrupt(error instanceof Error ? error : new ProtocolError('protocol input failed'));
}

process.stdin.on('data', (chunk: Buffer) => {
  if (inputClosed) return;
  try {
    decoder.feed(chunk);
    for (;;) {
      const record = decoder.shift();
      if (!record) break;
      worker.receive(record);
    }
  } catch (error) {
    failInput(error);
  }
});

process.stdin.on('end', () => {
  try {
    decoder.end();
    failInput(new ProtocolError('protocol input closed before terminal state'));
  } catch (error) {
    failInput(error);
  }
});

process.stdin.on('error', failInput);
process.once('SIGTERM', () => worker.interrupt(new Error('runtime received termination signal')));
process.once('SIGINT', () => worker.interrupt(new Error('runtime received interrupt signal')));
process.once('uncaughtException', failInput);
process.once('unhandledRejection', failInput);

void worker.completion.then(async () => {
  inputClosed = true;
  process.stdin.pause();
  await writer.close();
}).catch(() => {
  process.exitCode = 1;
  process.stdin.pause();
});
