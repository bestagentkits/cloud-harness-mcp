/**
 * Shared pieces of the agent runtime benchmark: the runtime-under-test contract, the in-memory
 * workspace every runtime executes proxy tools against, and the scripted faux model.
 *
 * Every runtime sees the same workspace semantics, the same tool result text (a serialized runner
 * response, as the runner sends it) and the same scripted model, so their numbers are comparable.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { RunnerResponse } from '@cloud-harness/contracts';
import { InMemoryCredentialStore, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai';
import { ModelRuntime, SessionManager, SettingsManager, createAgentSession } from '@earendil-works/pi-coding-agent';
import { ControlledResourceLoader } from '../../../apps/agent-runtime/src/controlled-resources.js';
import { assertExactTools, createReplaySessionManager, type AgentSessionFactory, type AgentSessionLike } from '../../../apps/agent-runtime/src/pi-session.js';
import type { AgentProxyOperation, OutputRecord, TerminalState } from '../../../apps/agent-runtime/src/protocol-schemas.js';

export type ModelStep = { text: string } | { toolCalls: Array<{ name: string; args: Record<string, unknown> }> };
export type ScenarioSpec = {
  title: string;
  prompt: string;
  followUpPrompt?: string;
  tools: AgentProxyOperation[];
  model: ModelStep[];
  followUpModel?: ModelStep[];
  killAtToolRequest?: number;
  cancelAtToolRequest?: number;
  children?: number;
};
export type ScenarioFixture = { workspace: Record<string, string>; scenarios: Record<string, ScenarioSpec> };

export const fixture = JSON.parse(readFileSync(new URL('../../fixtures/agent-runtime/scenarios.json', import.meta.url), 'utf8')) as ScenarioFixture;

const MUTATING = new Set<string>(['files_write', 'files_apply_patch', 'files_delete', 'files_move', 'files_mkdir']);

/** The limits every offline runtime runs under; the persisted runtime gets them through its runner config and spawn. */
export const BENCH_LIMITS = {
  deadlineMs: 60_000,
  maxEvents: 10_000,
  maxOutputBytes: 8 * 1024 * 1024,
  maxEventBytes: 16_384,
  maxToolResultBytes: 1024 * 1024
} as const;

/* ------------------------------------------------------------------------------------------------
 * Runtime-under-test contract
 * --------------------------------------------------------------------------------------------- */

/** How a task ends: left to finish, killed like a crashed process, or cancelled by the owner. */
export type Interrupt = { atToolRequest: number; mode: 'kill' | 'cancel' };

export interface TaskRun {
  prompt: string;
  tools: AgentProxyOperation[];
  model: ModelStep[];
  workspace: FakeWorkspace;
  interrupt?: Interrupt;
  /** Handle returned by an earlier lifetime of the same runtime. Runtimes that cannot continue ignore it. */
  continueFrom?: unknown;
}

export interface TaskOutcome {
  state: TerminalState;
  error?: string | undefined;
  wallMs: number;
  /** Time from the start of the task (spawn request or start record) to the first record the worker wrote. */
  firstRecordMs: number;
  modelRequests: number;
  toolRoundTrips: number;
  /**
   * Tool calls in flight when the run ended that were cancelled with it: the worker's own
   * `tool_cancel` records, plus calls a runner aborted before their result reached the worker.
   */
  toolCancels: number;
  recordBytes: number;
  /** Messages the model saw on its first request, and on the last one. */
  firstRequestMessages: number;
  lastRequestMessages: number;
  lastRequestBytes: number;
  /** Messages and serialized size of the session transcript when the worker finished. */
  transcriptMessages: number;
  transcriptBytes: number;
  /** Tokens this lifetime reported (net of any replayed history), from the worker's usage records. */
  inputTokens: number;
  outputTokens: number;
  /** Runner-side state rows and payload bytes written for this lifetime; zero for a container-local runtime. */
  storageRows: number;
  storageBytes: number;
  rssDeltaBytes: number;
  /** True when this lifetime started from a transcript supplied by an earlier lifetime. */
  continued: boolean;
  /** Whether the worker refused input after reaching a terminal state. */
  postTerminalInputRefused: boolean;
  /** The container and gateway lease this lifetime ran with, when the runtime has them. */
  launch?: { container: string; leaseId: string } | undefined;
  /** Proxy effects the runtime's ledger holds with an unknown outcome after this lifetime, when it keeps one. */
  effectsUnknown?: number | undefined;
  /** Opaque value a later lifetime of the same runtime can continue from. */
  handle?: unknown;
}

/** What a runtime leaves behind once the workspace is closed. */
export interface WorkspaceCloseReport {
  leftoverSessionRows: number;
  leftoverEffectRows: number;
}

export interface RuntimeUnderTest {
  readonly id: string;
  readonly description: string;
  run(task: TaskRun): Promise<TaskOutcome>;
  /** Closes the workspace the way the product does and reports stored state that outlived it. */
  closeWorkspace?(workspace: FakeWorkspace): Promise<WorkspaceCloseReport>;
}

/* ------------------------------------------------------------------------------------------------
 * In-memory workspace behind every runtime's proxy tool executor
 * --------------------------------------------------------------------------------------------- */

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** One mutating call that reached the executor. */
export interface EffectInvocation { operation: string; key: string; applied: boolean }

function logicalEffectKey(operation: string, input: Record<string, unknown>): string {
  // The workspace id differs between runtimes; the logical effect is the operation and its arguments.
  const ordered = Object.fromEntries(Object.entries(input).filter(([name]) => name !== 'workspaceId').sort(([a], [b]) => a.localeCompare(b)));
  return sha256(JSON.stringify({ operation, input: ordered }));
}

export class FakeWorkspace {
  readonly files: Map<string, string>;
  /** Every mutating call that reached the executor, applied or refused. */
  readonly invocations: EffectInvocation[] = [];

  constructor(files: Record<string, string>) {
    this.files = new Map(Object.entries(files));
  }

  /** Executes a proxy operation the way the executor does and answers with a runner response. */
  execute(operation: string, input: Record<string, unknown>): RunnerResponse {
    const response = this.#apply(operation, input);
    if (MUTATING.has(operation)) this.invocations.push({ operation, key: logicalEffectKey(operation, input), applied: response.ok });
    return response;
  }

  /** Mutations that changed the workspace. */
  get effects(): EffectInvocation[] {
    return this.invocations.filter((invocation) => invocation.applied);
  }

  /** Applications of a logical effect (same operation and input) beyond its first. Zero tolerance. */
  get duplicateEffects(): number {
    return this.#extra(this.effects);
  }

  /** Executor invocations of a logical mutation beyond its first, applied or not. */
  get repeatedInvocations(): number {
    return this.#extra(this.invocations);
  }

  #extra(invocations: EffectInvocation[]): number {
    const seen = new Set<string>();
    let extra = 0;
    for (const invocation of invocations) {
      if (seen.has(invocation.key)) extra += 1;
      seen.add(invocation.key);
    }
    return extra;
  }

  #apply(operation: string, input: Record<string, unknown>): RunnerResponse {
    const ok = (message: string, data: unknown): RunnerResponse => ({ ok: true, message, data, truncated: false });
    const fail = (code: 'INVALID_INPUT' | 'CONFLICT', message: string): RunnerResponse =>
      ({ ok: false, message, error: { code, message, retryable: false }, truncated: false });
    const path = String(input.path ?? '');
    switch (operation) {
      case 'files_list': {
        const prefix = path === '' || path === '.' ? '' : `${path.replace(/\/$/u, '')}/`;
        return ok('listed', { entries: [...this.files.keys()].filter((name) => name.startsWith(prefix)).sort().map((name) => ({ name, type: 'file' })) });
      }
      case 'files_read': {
        const content = this.files.get(path);
        if (content === undefined) return fail('INVALID_INPUT', `ENOENT: no such file or directory, realpath '/workspace/${path}'`);
        const offset = typeof input.offset === 'number' ? input.offset : 0;
        const limit = input.readAll === true ? 1_048_576 : typeof input.limit === 'number' ? input.limit : 65_536;
        const slice = content.slice(offset, offset + limit);
        return ok(`Read ${slice.length} bytes`, {
          path, content: slice, sha256: sha256(content), bytesReturned: slice.length, totalBytes: content.length, eof: offset + limit >= content.length
        });
      }
      case 'files_write': {
        const content = String(input.content ?? '');
        this.files.set(path, content);
        return ok('File written', { path, sha256: sha256(content) });
      }
      case 'files_apply_patch': {
        const current = this.files.get(path);
        const oldText = String(input.oldText ?? '');
        if (current === undefined) return fail('INVALID_INPUT', `ENOENT: no such file or directory, realpath '/workspace/${path}'`);
        const first = current.indexOf(oldText);
        if (first < 0) return fail('CONFLICT', 'oldText was not found');
        const next = current.slice(0, first) + String(input.newText ?? '') + current.slice(first + oldText.length);
        this.files.set(path, next);
        return ok('Patch applied', { path, sha256: sha256(next) });
      }
      case 'grep_search': {
        const pattern = String(input.pattern ?? '');
        const matches = [...this.files].flatMap(([name, content]) => content.split('\n').flatMap((line, index) => (line.includes(pattern) ? [{ path: name, line: index + 1, text: line }] : [])));
        return ok(`${matches.length} matches`, { matches });
      }
      default:
        return ok(`${operation} ok`, {});
    }
  }
}

/* ------------------------------------------------------------------------------------------------
 * Scripted faux model
 * --------------------------------------------------------------------------------------------- */

const GATEWAY_PROVIDER_ID_FOR_BENCH = 'faux';
const RUNTIME_CWD = '/runtime';
let toolCallSequence = 0;

type ContextMessage = { role?: unknown; content?: unknown; toolCallId?: unknown; isError?: unknown };

/** True when the conversation already holds every tool call of the step with a successful result. */
function stepCompleted(step: ModelStep, messages: readonly ContextMessage[]): boolean {
  if ('text' in step) return false;
  const succeeded = new Set(messages.flatMap((message) => (message.role === 'toolResult' && message.isError === false && typeof message.toolCallId === 'string' ? [message.toolCallId] : [])));
  const calls = messages.flatMap((message) => (message.role === 'assistant' && Array.isArray(message.content)
    ? (message.content as Array<{ type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }>).filter((block) => block.type === 'toolCall')
    : []));
  return step.toolCalls.every((wanted) => calls.some((call) => call.name === wanted.name
    && JSON.stringify(call.arguments) === JSON.stringify(wanted.args)
    && typeof call.id === 'string' && succeeded.has(call.id)));
}

/**
 * One scripted model for every runtime. It plays its steps in order, but skips a step whose tool
 * calls the conversation already shows as completed, as a model that sees its earlier work would.
 * A runtime without history therefore replays the whole script, and one with history picks up
 * where the earlier lifetime stopped. Tool call IDs are unique across lifetimes and fixed-width.
 */
export function scriptedResponses(steps: ModelStep[], onRequest: (messageCount: number, bytes: number) => void): FauxResponseStep[] {
  let cursor = 0;
  const respond: FauxResponseStep = (context) => {
    onRequest(context.messages.length, Buffer.byteLength(JSON.stringify(context.messages), 'utf8'));
    while (cursor < steps.length - 1 && stepCompleted(steps[cursor]!, context.messages as readonly ContextMessage[])) cursor += 1;
    const step = steps[Math.min(cursor, steps.length - 1)]!;
    cursor += 1;
    if ('text' in step) return fauxAssistantMessage([fauxText(step.text)]);
    return fauxAssistantMessage(
      step.toolCalls.map((call) => fauxToolCall(call.name, call.args as never, { id: `call_${String((toolCallSequence += 1)).padStart(10, '0')}` })),
      { stopReason: 'toolUse' }
    );
  };
  return steps.map(() => respond);
}

/**
 * Builds the same controlled Pi session as the production factory (no extensions, only the proxy
 * tools, in-memory transcript seeded with any replayed history) with the gateway provider swapped
 * for a scripted faux provider.
 */
export function fauxSessionFactory(steps: ModelStep[], onRequest: (messageCount: number, bytes: number) => void, capture: (session: AgentSessionLike) => void): AgentSessionFactory {
  return async (start, broker, history) => {
    const faux = fauxProvider({ provider: GATEWAY_PROVIDER_ID_FOR_BENCH, models: [{ id: start.model.id, contextWindow: start.model.contextWindow, maxTokens: start.model.maxTokens, cost: start.model.cost }] });
    faux.setResponses(scriptedResponses(steps, onRequest));
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const model = modelRuntime.getModel(faux.provider.id, start.model.id);
    if (!model) throw new Error('faux model is unavailable');
    const { session, extensionsResult } = await createAgentSession({
      cwd: RUNTIME_CWD,
      agentDir: RUNTIME_CWD,
      model,
      modelRuntime,
      thinkingLevel: 'off',
      noTools: 'all',
      tools: start.tools,
      customTools: broker.createDefinitions(start.tools),
      resourceLoader: new ControlledResourceLoader(),
      sessionManager: history ? createReplaySessionManager(history) : SessionManager.inMemory(RUNTIME_CWD),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false, maxRetries: 0, provider: { timeoutMs: start.limits.deadlineMs, maxRetries: 0, maxRetryDelayMs: 0 } },
        images: { autoResize: false, blockImages: true },
        enableSkillCommands: false,
        enableInstallTelemetry: false,
        enableAnalytics: false,
        packages: [], extensions: [], skills: [], prompts: [], themes: [],
        defaultTools: start.tools
      })
    });
    if (extensionsResult.extensions.length !== 0 || extensionsResult.errors.length !== 0) throw new Error('controlled Pi session loaded an extension');
    assertExactTools(session, start.tools);
    capture(session);
    return session;
  };
}

/**
 * Reads the worker's JSONL output and keeps the counters every runtime reports. Each complete
 * record is passed on with its line, in order, before the next one is read.
 */
export class WorkerRecordObserver {
  firstRecordAt: number | undefined;
  recordBytes = 0;
  toolRoundTrips = 0;
  toolCancels = 0;
  inputTokens = 0;
  outputTokens = 0;
  terminal: Extract<OutputRecord, { type: 'terminal' }> | undefined;
  #buffered = '';

  constructor(
    private readonly onRecord: (record: OutputRecord, line: string) => void,
    readonly startedAt = performance.now()
  ) {}

  feed(chunk: Buffer): void {
    this.firstRecordAt ??= performance.now();
    this.recordBytes += chunk.length;
    this.#buffered += chunk.toString('utf8');
    const lines = this.#buffered.split('\n');
    this.#buffered = lines.pop() ?? '';
    for (const line of lines) {
      const record = JSON.parse(line) as OutputRecord;
      if (record.type === 'terminal') {
        this.terminal = record;
        this.#usage(record.usage);
      } else if (record.type === 'usage') this.#usage(record.usage);
      else if (record.type === 'tool_cancel') this.toolCancels += 1;
      else if (record.type === 'tool_request') this.toolRoundTrips += 1;
      this.onRecord(record, line);
    }
  }

  #usage(usage: { input: number; output: number }): void {
    // Usage records are cumulative for the lifetime, so the latest one is the total.
    this.inputTokens = usage.input;
    this.outputTokens = usage.output;
  }
}

/** Model-request counters a runtime collects through `fauxSessionFactory`. */
export class ModelRequestCounter {
  requests = 0;
  firstMessages = 0;
  lastMessages = 0;
  lastBytes = 0;
  readonly onRequest = (messages: number, bytes: number): void => {
    this.requests += 1;
    if (this.requests === 1) this.firstMessages = messages;
    this.lastMessages = messages;
    this.lastBytes = bytes;
  };
}
