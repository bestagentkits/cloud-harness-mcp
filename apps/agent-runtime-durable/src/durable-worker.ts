import { BACKGROUND_CONTEXT, withCancel, type Context } from '@earendil-works/chord/context';
import { createModels, type AssistantMessage, type Models } from '@earendil-works/pi-ai';
import {
  createRegistry,
  defineExtension,
  Harness,
  section,
  watchEvents,
  type AgentEvent,
  type AgentEventStream,
  type Conversation,
  type ModelRef,
  type SettledSubmissionRecord
} from '@earendil-works/pi-durable';
import { DurableEventProjector, usageFromState, usageSince } from './events.js';
import { createGatewayProvider, GATEWAY_PROVIDER_ID } from './gateway-provider.js';
import {
  ZERO_USAGE,
  type DurableInputRecord,
  type DurableOutputRecord,
  type DurableStartRecord,
  type DurableWorker,
  type DurableWorkerIo,
  type TerminalState,
  type Usage
} from './protocol.js';
import { DurableToolBroker, ToolResultLimitError } from './proxy-tools.js';
import { RemoteStorage, type RemoteStorageOptions } from './remote-storage.js';

export const CONTROLLED_SYSTEM_PROMPT = [
  'You are a bounded coding agent.',
  'Use only the explicitly listed proxy tools. Never attempt remote Git, deployment, shell, task/session, skill/hook, worktree, or nested-agent operations.',
  'Repository operations execute in a separate validated workspace boundary. Keep responses concise and do not expose credentials.'
].join('\n');

const EXTENSION_NAME = 'cloud-harness-proxy';
const SHUTDOWN_STEP_MS = 5_000;
const MAX_PENDING_MESSAGES = 64;
const MAX_PENDING_MESSAGE_BYTES = 512 * 1024;

export interface DurableWorkerOptions {
  /** Model access; defaults to a catalog holding only the gateway provider. Tests pass a faux provider. */
  readonly models?: Models;
  /** Model to run; defaults to the start record's model on the gateway provider. */
  readonly model?: ModelRef;
  readonly storage?: RemoteStorageOptions;
}

function isLimitExceeded(text: string): boolean {
  return /\b(?:413|429)\b|model_(?:budget_exhausted|bound_exceeded)|(?:budget|quota|token|cost|output|rate)[\s_-]*(?:limit|exhaust|exceed)/i.test(text);
}

function detailText(detail: unknown): string | undefined {
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object' && 'message' in detail && typeof detail.message === 'string') return detail.message;
  return undefined;
}

/** Resolves within `ms`, whatever `promise` does; cleanup steps must not hold the terminal record hostage. */
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
        timer.unref();
      })
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs one agent turn on a pi-durable Harness behind the same stdio contract as the default
 * worker: caller-safe events, proxied tool calls, usage and exactly one terminal record. Session
 * state lives in the runner, reached through storage RPC; this process holds no durable state.
 */
class DurableAgentWorker implements DurableWorker {
  readonly #io: DurableWorkerIo;
  readonly #start: DurableStartRecord;
  readonly #options: DurableWorkerOptions;
  readonly #completion = Promise.withResolvers<void>();
  readonly #storage: RemoteStorage;
  readonly #broker: DurableToolBroker;
  readonly #run: { readonly context: Context; readonly cancel: (reason?: unknown) => void };
  readonly #projector: DurableEventProjector;
  #deadline: NodeJS.Timeout | undefined;
  #harness: Harness | undefined;
  #root: Conversation | undefined;
  #events: AgentEventStream | undefined;
  #sequence = 0;
  #baseline: Usage | undefined;
  #lastUsage: Usage = ZERO_USAGE;
  #pendingMessages: Array<Extract<DurableInputRecord, { type: 'message' }>> = [];
  #pendingMessageBytes = 0;
  #latestSubmission: Promise<unknown> | undefined;
  // Messages wait until the prompt is admitted, so they steer or follow it rather than precede it.
  #promptAdmitted = false;
  #stopping = false;
  #finished = false;

  constructor(io: DurableWorkerIo, start: DurableStartRecord, options: DurableWorkerOptions) {
    this.#io = io;
    this.#start = start;
    this.#options = options;
    this.#run = withCancel(BACKGROUND_CONTEXT);
    this.#projector = new DurableEventProjector(io.redactor, Math.max(1, Math.floor((start.limits.maxEventBytes - 192) / 6)));
    this.#storage = new RemoteStorage((record) => io.sendStorage(record), options.storage);
    this.#broker = new DurableToolBroker((record) => this.#emit(record), io.redactor, start.limits.maxToolResultBytes);
  }

  get completion(): Promise<void> {
    return this.#completion.promise;
  }

  begin(): void {
    this.#io.redactor.addSecret(this.#start.gateway.lease);
    this.#io.configureOutput(this.#start.limits);
    this.#deadline = setTimeout(() => void this.#stop('TIMED_OUT', 'agent deadline exceeded'), this.#start.limits.deadlineMs);
    this.#deadline.unref();
    void this.#execute();
  }

  receive(record: DurableInputRecord): void {
    // Storage answers keep flowing while the run shuts down: closing the session still uses them.
    if (record.type === 'storage_response') {
      this.#storage.accept(record);
      return;
    }
    if (this.#finished) throw new Error('protocol input received after terminal state');
    switch (record.type) {
      case 'tool_result':
        try {
          this.#broker.acceptResult(record);
        } catch (error) {
          if (!(error instanceof ToolResultLimitError)) throw error;
          void this.#stop('LIMIT_EXCEEDED', this.#io.redactor.error(error));
        }
        return;
      case 'tool_cancel':
        this.#broker.acceptCancel(record.requestId, record.reason);
        return;
      case 'message':
        this.#acceptMessage(record);
        return;
      case 'cancel':
        void this.#stop('CANCELLED', record.reason ?? 'agent cancelled');
        return;
      case 'start':
        throw new Error('duplicate start record');
    }
  }

  interrupt(error: unknown): void {
    void this.#stop('INTERRUPTED', this.#io.redactor.error(error));
  }

  async #execute(): Promise<void> {
    const context = this.#run.context;
    try {
      if (this.#start.session !== undefined) throw new Error('the durable runtime keeps its own session and cannot replay a coding session');
      const harness = await this.#open(context);
      this.#harness = harness;
      void harness.closed.then((end) => {
        if (end.reason === 'failed') void this.#stop('INTERRUPTED', 'agent session storage failed');
      });
      if (this.#stopping) return;
      const root = await harness.root(context, {
        agent: { model: this.#options.model ?? { provider: GATEWAY_PROVIDER_ID, modelId: this.#start.model.id } }
      });
      this.#root = root;
      this.#baseline = usageFromState(await harness.usage(context));
      const events = await watchEvents(harness, root.id, context);
      this.#events = events;
      events.start(async (batch) => this.#onEvents(batch));
      if (this.#stopping) return;
      const submission = await root.submit({ type: 'input', content: this.#start.prompt, requestId: this.#start.requestId, whenBusy: 'reject' }, context);
      this.#promptAdmitted = true;
      this.#flushPendingMessages();
      let settled = await submission.wait(context);
      await root.waitForIdle(context);
      // A follow-up that started its own run decides the outcome once the conversation is idle.
      while (this.#latestSubmission) {
        const latest = this.#latestSubmission;
        this.#latestSubmission = undefined;
        const record = await latest;
        if (record && typeof record === 'object' && 'status' in record) settled = record as SettledSubmissionRecord;
        await root.waitForIdle(context);
      }
      if (this.#stopping) return;
      const outcome = await this.#outcome(harness, settled, context);
      await this.#finish(outcome.state, outcome.error);
    } catch (error) {
      if (!this.#stopping) await this.#finish('FAILED', this.#io.redactor.error(error));
    }
  }

  async #open(context: Context): Promise<Harness> {
    let models = this.#options.models;
    if (!models) {
      const catalog = createModels();
      catalog.setProvider(createGatewayProvider(this.#io.gatewayBaseUrl, this.#start, {
        current: () => ({ lease: this.#start.gateway.lease, agentId: this.#start.agentId, profile: this.#start.gateway.profile })
      }));
      models = catalog;
    }
    const registry = createRegistry();
    registry.install(defineExtension({
      name: EXTENSION_NAME,
      tools: this.#broker.createTools(this.#start.tools),
      sections: [section('cloud-harness-system', () => CONTROLLED_SYSTEM_PROMPT, { tag: false })]
    }));
    return await Harness.open(this.#storage, {
      models,
      registry,
      settings: {
        stream: { timeoutMs: this.#start.limits.deadlineMs, maxRetries: 0, maxRetryDelayMs: 0 },
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
        compaction: { enabled: false },
        // Every progress commit is a storage round trip to the runner.
        progress: { partialIntervalMs: 500, outputIntervalMs: 500 }
      },
      onReport: () => undefined
    }, context);
  }

  async #outcome(harness: Harness, settled: SettledSubmissionRecord, context: Context): Promise<{ state: TerminalState; error?: string }> {
    if (settled.status === 'done' && settled.type === 'input') {
      const answer = await harness.commit((tx) => tx.entry(settled.answer), context);
      const message = answer?.model?.find((item): item is AssistantMessage => item.role === 'assistant');
      if (message?.stopReason === 'length') return { state: 'LIMIT_EXCEEDED', error: 'model output token limit exceeded' };
      return { state: 'SUCCEEDED' };
    }
    if (settled.status === 'unanswered') {
      const error = detailText(settled.detail) ?? `agent input was not answered: ${settled.reason}`;
      return { state: isLimitExceeded(error) ? 'LIMIT_EXCEEDED' : 'FAILED', error };
    }
    return { state: 'FAILED', error: 'agent input settled without an answer' };
  }

  #acceptMessage(record: Extract<DurableInputRecord, { type: 'message' }>): void {
    if (this.#promptAdmitted) {
      this.#deliverMessage(record);
      return;
    }
    const bytes = Buffer.byteLength(record.text, 'utf8');
    if (this.#pendingMessages.length >= MAX_PENDING_MESSAGES || this.#pendingMessageBytes + bytes > MAX_PENDING_MESSAGE_BYTES) {
      throw new Error('pending message queue overflow');
    }
    this.#pendingMessages.push(record);
    this.#pendingMessageBytes += bytes;
  }

  #flushPendingMessages(): void {
    const messages = this.#pendingMessages;
    this.#pendingMessages = [];
    this.#pendingMessageBytes = 0;
    for (const record of messages) this.#deliverMessage(record);
  }

  #deliverMessage(record: Extract<DurableInputRecord, { type: 'message' }>): void {
    const root = this.#root;
    if (!root || this.#stopping) return;
    const context = this.#run.context;
    const delivered = root.submit({ type: 'input', content: record.text, requestId: record.requestId, whenBusy: record.behavior }, context)
      .then((submission) => submission.wait(context));
    this.#latestSubmission = delivered.catch(async (error: unknown) => {
      await this.#stop('FAILED', this.#io.redactor.error(error));
      return undefined;
    });
  }

  async #onEvents(batch: readonly AgentEvent[]): Promise<void> {
    for (const event of batch) {
      if (this.#stopping) return;
      for (const projected of this.#projector.project(event)) {
        this.#emit({ type: 'event', sequence: ++this.#sequence, event: projected });
      }
      if (event.type === 'turn_end' || event.type === 'run_end') {
        await this.#refreshUsage();
        if (!this.#stopping) this.#emit({ type: 'usage', sequence: ++this.#sequence, usage: this.#lastUsage });
      }
    }
  }

  async #refreshUsage(): Promise<void> {
    const harness = this.#harness;
    if (!harness || !this.#baseline) return;
    try {
      this.#lastUsage = usageSince(usageFromState(await harness.usage(this.#run.context)), this.#baseline);
    } catch {
      // The last known usage stays authoritative when the session can no longer be read.
    }
  }

  #emit(record: DurableOutputRecord): void {
    try {
      void this.#io.emit(record).catch((error: unknown) => {
        void this.#stop('INTERRUPTED', this.#io.redactor.error(error));
      });
    } catch (error) {
      void this.#stop(this.#io.isOutputLimitError(error) ? 'LIMIT_EXCEEDED' : 'FAILED', this.#io.redactor.error(error));
    }
  }

  /** Ends the run early: tool calls are cancelled and the conversation aborted before the terminal record. */
  async #stop(state: TerminalState, reason: string): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#broker.cancelAll(reason);
    const root = this.#root;
    if (root) await bounded(root.abort(BACKGROUND_CONTEXT), SHUTDOWN_STEP_MS);
    this.#run.cancel(new Error(reason));
    await this.#finish(state, reason);
  }

  async #finish(state: TerminalState, error?: string): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    this.#stopping = true;
    clearTimeout(this.#deadline);
    this.#broker.cancelAll(error ?? 'agent session ended');
    await bounded(this.#refreshUsage(), SHUTDOWN_STEP_MS);
    if (this.#events) await bounded(this.#events.stop(), SHUTDOWN_STEP_MS);
    if (this.#harness) await bounded(this.#harness.close(BACKGROUND_CONTEXT), SHUTDOWN_STEP_MS);
    this.#run.cancel(new Error('agent session ended'));
    this.#storage.shutdown(new Error('agent session ended'));
    try {
      await this.#io.terminal(state, this.#lastUsage, error ? this.#io.redactor.text(error, 4_096) : undefined);
      this.#completion.resolve();
    } catch (terminalError) {
      this.#completion.reject(terminalError);
    }
  }
}

/** Starts a durable agent run for a validated start record and returns the handle the entry point drives. */
export function runDurableWorker(io: DurableWorkerIo, start: DurableStartRecord, options: DurableWorkerOptions = {}): DurableWorker {
  const worker = new DurableAgentWorker(io, start, options);
  worker.begin();
  return worker;
}
