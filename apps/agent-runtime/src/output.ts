import type { JsonlWriter } from './jsonl.js';
import type { OutputRecord, SessionMessageRecord, TerminalState, Usage } from './protocol-schemas.js';

export class OutputLimitError extends Error {}

export class BoundedOutput {
  readonly #writer: JsonlWriter;
  #maxEvents = 1;
  #maxOutputBytes = 4_096;
  #maxEventBytes = 256;
  #events = 0;
  #outputBytes = 0;
  #terminal = false;

  constructor(writer: JsonlWriter) {
    this.#writer = writer;
  }

  configure(limits: { maxEvents: number; maxOutputBytes: number; maxEventBytes: number }): void {
    if (this.#events !== 0 || this.#outputBytes !== 0) throw new Error('output limits cannot change after emission');
    this.#maxEvents = limits.maxEvents;
    this.#maxOutputBytes = limits.maxOutputBytes;
    this.#maxEventBytes = limits.maxEventBytes;
  }

  emit(record: Exclude<OutputRecord, { type: 'terminal' | 'session_message' }>): Promise<void> {
    if (this.#terminal) throw new Error('cannot emit after terminal record');
    const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8') + 1;
    if (record.type === 'event' && this.#events + 1 > this.#maxEvents) {
      throw new OutputLimitError('event count limit exceeded');
    }
    if (record.type === 'event' && bytes > this.#maxEventBytes) {
      throw new OutputLimitError('event byte limit exceeded');
    }
    if (this.#outputBytes + bytes > this.#maxOutputBytes) {
      throw new OutputLimitError('output byte limit exceeded');
    }
    if (record.type === 'event') this.#events += 1;
    this.#outputBytes += bytes;
    return this.#writer.write(record);
  }

  /**
   * Writes a persisted-session record. It is runner state, not caller output, so it never counts
   * against the caller's event or byte budget. A record that cannot be written (over the protocol
   * record limit, or not a valid message) is skipped and `undefined` is returned; the resulting
   * sequence gap makes the runner stop the log rather than fail the run.
   */
  emitSession(record: SessionMessageRecord): Promise<void> | undefined {
    if (this.#terminal) return undefined;
    try {
      return this.#writer.write(record);
    } catch {
      return undefined;
    }
  }

  terminal(state: TerminalState, usage: Usage, error?: string): Promise<void> {
    if (this.#terminal) throw new Error('duplicate terminal record');
    this.#terminal = true;
    return this.#writer.write({ type: 'terminal', state, usage, error });
  }

  get terminalWritten(): boolean {
    return this.#terminal;
  }
}
