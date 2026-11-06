/**
 * `pi-durable`: the opt-in durable engine behind the real runner (see `runner-backed.ts`), with
 * `AGENT_DURABLE_RUNTIME_ENABLED` on and root agents spawned with `runtime: 'pi-durable'`.
 *
 * The worker is the image entry point's composition: the `EngineRouter` loads the durable engine
 * for the durable start record and wires it to the same bounded output and JSONL writer, so
 * events, proxy tool calls and the session storage RPC all cross the runner's stdio protocol.
 * Session state lives in the runner's `DurableSessionStore` (one SQLite file per lineage). A
 * continuation resumes the predecessor's store in a new worker; it never receives a replayed
 * transcript. Only the model provider differs from production: the shared scripted faux model,
 * built with the durable engine's own pi-ai version.
 */
// The durable engine pins its own pi-ai release; its faux provider must come from that release,
// which only the durable package resolves.
import {
  createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type AssistantMessage
} from '../../../apps/agent-runtime-durable/node_modules/@earendil-works/pi-ai/dist/index.js';
import { runDurableWorker } from '../../../apps/agent-runtime-durable/src/durable-worker.js';
import { OutputLimitError } from '../../../apps/agent-runtime/src/output.js';
import { createRedactor } from '../../../apps/agent-runtime/src/redaction.js';
import { scriptedResponder } from './harness.js';
import { createRunnerBackedRuntime, type DurableEngineIo } from './runner-backed.js';

const FAUX_PROVIDER = 'faux';
// A resumed run asks the model again for its interrupted work before the new prompt, so the
// script gets room for more requests than it has steps; past its end it repeats the final answer.
const SPARE_RESPONSES = 8;
// Partial-message commits are throttled by wall-clock time, so a stream slowed by a loaded host
// adds storage rows. The longest timer Node accepts outlasts every scripted stream, and the stream's
// end cancels it, so only the commits every run makes are counted.
const NO_PARTIAL_COMMITS_MS = 2_147_483_647;

function loadDurableEngine({ start, steps, model, output, writer }: DurableEngineIo) {
  const faux = fauxProvider({
    provider: FAUX_PROVIDER,
    models: [{ id: start.model.id, contextWindow: start.model.contextWindow, maxTokens: start.model.maxTokens, cost: start.model.cost }]
  });
  const respond = scriptedResponder<AssistantMessage>(steps, model.onRequest, {
    text: (text) => fauxAssistantMessage([fauxText(text)]),
    toolCalls: (calls) => fauxAssistantMessage(calls.map((call) => fauxToolCall(call.name, call.args as never, { id: call.id })), { stopReason: 'toolUse' })
  });
  faux.setResponses(Array.from({ length: steps.length + SPARE_RESPONSES }, () => respond));
  const models = createModels();
  models.setProvider(faux.provider);
  return Promise.resolve(runDurableWorker({
    gatewayBaseUrl: 'http://model-gateway.invalid/v1',
    redactor: createRedactor(),
    configureOutput: (limits) => output.configure(limits),
    emit: (record) => output.emit(record),
    isOutputLimitError: (error) => error instanceof OutputLimitError,
    sendStorage: (record) => writer.write(record),
    terminal: (state, usage, error) => output.terminal(state, usage, error)
  }, start, {
    models,
    model: { provider: FAUX_PROVIDER, modelId: start.model.id },
    // A killed container's storage requests are never answered; its engine winds down promptly.
    storage: { requestTimeoutMs: 2_000 },
    partialIntervalMs: NO_PARTIAL_COMMITS_MS
  }));
}

export const piDurable = createRunnerBackedRuntime({
  id: 'pi-durable',
  description: 'pi-durable engine behind the real runner: runner-hosted durable session store over storage RPC, resume on continueFrom, effect receipts',
  durableEngine: loadDurableEngine
});
