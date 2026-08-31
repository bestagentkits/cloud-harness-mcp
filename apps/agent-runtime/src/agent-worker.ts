import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { projectAgentEvent } from './events.js';
import { ProtocolError } from './jsonl.js';
import { OutputLimitError } from './output.js';
import type { BoundedOutput } from './output.js';
import { type AgentSessionFactory, type AgentSessionLike, usageFromSession } from './pi-session.js';
import { ProxyToolBroker, ToolResultLimitError } from './proxy-tools.js';
import {
  type InputRecord,
  type MessageRecord,
  type StartRecord,
  type TerminalState,
  type Usage
} from './protocol-schemas.js';
import { createRedactor, type Redactor } from './redaction.js';

const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
function safeTokenCount(value: number): number {
  return Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value))) : 0;
}
function isLimitExceeded(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const record = current as Record<string, unknown>;
    const status = record.status ?? record.statusCode;
    if (status === 429 || status === 413) return true;
    const code = typeof record.code === 'string' ? record.code : '';
    const message = typeof record.message === 'string' ? record.message : '';
    if (/\b(?:413|429)\b|model_(?:budget_exhausted|bound_exceeded)|(?:budget|quota|token|cost|output|rate)[\s_-]*(?:limit|exhaust|exceed)/i.test(`${code} ${message}`)) return true;
    current = record.cause;
  }
  return false;
}
function completionFailure(session: AgentSessionLike): { state: TerminalState; error: string } | undefined {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message?.role !== 'assistant') continue;
    if (message.stopReason === 'length') {
      return { state: 'LIMIT_EXCEEDED', error: 'model output token limit exceeded' };
    }
    if (message.stopReason === 'error') {
      const error = message.errorMessage || 'model provider request failed';
      return { state: isLimitExceeded(new Error(error)) ? 'LIMIT_EXCEEDED' : 'FAILED', error };
    }
    if (message.stopReason === 'aborted') {
      return { state: 'FAILED', error: 'model request aborted without a cancellation request' };
    }
    return undefined;
  }
  return { state: 'FAILED', error: 'model session ended without an assistant response' };
}





export class AgentWorker {
  readonly #output: BoundedOutput;
  readonly #sessionFactory: AgentSessionFactory;
  readonly #redactor: Redactor;
  readonly #completion = Promise.withResolvers<void>();
  #start: StartRecord | undefined;
  #session: AgentSessionLike | undefined;
  #broker: ProxyToolBroker | undefined;
  #unsubscribe: (() => void) | undefined;
  #deadline: NodeJS.Timeout | undefined;
  #sequence = 0;
  #finalizing = false;
  #terminating = false;
  #terminationState: TerminalState | undefined;
  #pendingMessages: MessageRecord[] = [];
  #pendingMessageBytes = 0;

  constructor(output: BoundedOutput, sessionFactory: AgentSessionFactory, redactor = createRedactor()) {
    this.#output = output;
    this.#sessionFactory = sessionFactory;
    this.#redactor = redactor;
  }

  get completion(): Promise<void> {
    return this.#completion.promise;
  }

  receive(record: InputRecord): void {
    if (this.#finalizing || this.#terminating || this.#output.terminalWritten) throw new ProtocolError('protocol input received after terminal state');
    if (!this.#start) {
      if (record.type !== 'start') throw new ProtocolError('first protocol record must be start');
      this.#start = record;
      this.#begin(record);
      return;
    }
    if (record.type === 'start') throw new ProtocolError('duplicate start record');
    switch (record.type) {
      case 'tool_result':
        if (!this.#broker) throw new ProtocolError('tool result received before session initialization');
        try {
          this.#broker.acceptResult(record);
        } catch (error) {
          if (!(error instanceof ToolResultLimitError)) throw error;
          void this.#terminate('LIMIT_EXCEEDED', this.#redactor.error(error));
        }
        break;
      case 'tool_cancel':
        if (!this.#broker) throw new ProtocolError('tool cancellation received before session initialization');
        this.#broker.acceptCancel(record.requestId, record.reason);
        break;
      case 'message':
        this.#acceptMessage(record);
        break;
      case 'cancel':
        void this.#terminate('CANCELLED', record.reason ?? 'agent cancelled');
        break;
    }
  }

  interrupt(error: unknown): void {
    void this.#terminate('INTERRUPTED', this.#redactor.error(error));
  }

  #begin(start: StartRecord): void {
    this.#redactor.addSecret(start.gateway.lease);
    this.#output.configure(start.limits);
    this.#broker = new ProxyToolBroker((record) => this.#emit(record), this.#redactor, start.limits.maxToolResultBytes);
    this.#deadline = setTimeout(() => {
      void this.#terminate('TIMED_OUT', 'agent deadline exceeded');
    }, start.limits.deadlineMs);
    this.#deadline.unref();
    void this.#run(start);
  }

  async #run(start: StartRecord): Promise<void> {
    try {
      const broker = this.#broker;
      if (!broker) throw new Error('proxy tool broker is unavailable');
      const session = await this.#sessionFactory(start, broker);
      if (this.#finalizing || this.#terminating) {
        await session.abort();
        session.dispose();
        return;
      }
      this.#session = session;
      this.#unsubscribe = session.subscribe((event) => this.#onSessionEvent(event));
      const prompt = session.prompt(start.prompt, { expandPromptTemplates: false });
      this.#flushPendingMessages();
      await prompt;
      await session.waitForIdle();
      if (!this.#finalizing && !this.#terminating) {
        const failure = completionFailure(session);
        await this.#finish(failure?.state ?? 'SUCCEEDED', failure?.error);
      }
    } catch (error) {
      if (!this.#finalizing && !this.#terminating) {
        await this.#finish(isLimitExceeded(error) ? 'LIMIT_EXCEEDED' : (this.#terminationState ?? 'FAILED'), this.#redactor.error(error));
      }
    }
  }

  #acceptMessage(record: MessageRecord): void {
    if (this.#session) {
      void this.#deliverMessage(record);
      return;
    }
    const bytes = Buffer.byteLength(record.text, 'utf8');
    if (this.#pendingMessages.length >= 64 || this.#pendingMessageBytes + bytes > 512 * 1024) {
      throw new ProtocolError('pending message queue overflow');
    }
    this.#pendingMessages.push(record);
    this.#pendingMessageBytes += bytes;
  }

  #flushPendingMessages(): void {
    const messages = this.#pendingMessages;
    this.#pendingMessages = [];
    this.#pendingMessageBytes = 0;
    for (const record of messages) void this.#deliverMessage(record);
  }

  async #deliverMessage(record: MessageRecord): Promise<void> {
    try {
      const session = this.#session;
      if (!session) throw new Error('agent session is unavailable');
      if (record.behavior === 'steer') await session.steer(record.text);
      else await session.followUp(record.text);
    } catch (error) {
      await this.#terminate('FAILED', this.#redactor.error(error));
    }
  }

  #onSessionEvent(event: AgentSessionEvent): void {
    const start = this.#start;
    const session = this.#session;
    if (!start || !session || this.#finalizing || this.#terminating) return;
    const projected = projectAgentEvent(event, this.#redactor, Math.max(1, Math.floor((start.limits.maxEventBytes - 192) / 6)));
    if (projected) this.#emit({ type: 'event', sequence: ++this.#sequence, event: projected });
    if (event.type === 'turn_end' || event.type === 'agent_end') {
      this.#emit({ type: 'usage', sequence: ++this.#sequence, usage: this.#safeUsage() });
    }
  }

  #emit(record: Parameters<BoundedOutput['emit']>[0]): void {
    try {
      void this.#output.emit(record).catch((error: unknown) => {
        void this.#terminate('INTERRUPTED', this.#redactor.error(error));
      });
    } catch (error) {
      const state = error instanceof OutputLimitError ? 'LIMIT_EXCEEDED' : 'FAILED';
      void this.#terminate(state, this.#redactor.error(error));
    }
  }

  async #terminate(state: TerminalState, reason: string): Promise<void> {
    if (this.#finalizing || this.#terminating) return;
    this.#terminating = true;
    this.#terminationState = state;
    this.#broker?.cancelAll(reason);
    try {
      await this.#session?.abort();
    } catch {
      // Terminal state and redacted reason remain authoritative when cooperative abort fails.
    }
    this.#terminating = false;
    await this.#finish(state, reason);
  }

  async #finish(state: TerminalState, error?: string): Promise<void> {
    if (this.#finalizing) return;
    this.#finalizing = true;
    clearTimeout(this.#deadline);
    this.#unsubscribe?.();
    this.#broker?.cancelAll(error ?? 'agent session ended');
    const usage = this.#safeUsage();
    this.#session?.dispose();
    try {
      await this.#output.terminal(state, usage, error ? this.#redactor.text(error, 4_096) : undefined);
      this.#completion.resolve();
    } catch (terminalError) {
      this.#completion.reject(terminalError);
    }
  }

  #safeUsage(): Usage {
    if (!this.#session) return ZERO_USAGE;
    try {
      const usage = usageFromSession(this.#session);
      return {
        input: safeTokenCount(usage.input),
        output: safeTokenCount(usage.output),
        cacheRead: safeTokenCount(usage.cacheRead),
        cacheWrite: safeTokenCount(usage.cacheWrite),
        total: safeTokenCount(usage.total),
        cost: Number.isFinite(usage.cost) ? Math.min(1_000_000_000, Math.max(0, usage.cost)) : 0
      };
    } catch {
      return ZERO_USAGE;
    }
  }
}
