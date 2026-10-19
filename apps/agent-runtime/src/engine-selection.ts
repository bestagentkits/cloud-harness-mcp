import { ProtocolError } from './jsonl.js';
import { MAX_QUEUED_RECORDS, type InputRecord, type StartRecord } from './protocol-schemas.js';

/** The surface the entry point drives, shared by the default and the durable worker. */
export interface EngineWorker {
  receive(record: InputRecord): void;
  interrupt(error: unknown): void;
  readonly completion: Promise<void>;
}

/** Starts the durable engine for a start record; only called when that engine is requested. */
export type DurableEngineLoader = (start: StartRecord) => Promise<EngineWorker>;

type Selection =
  | { kind: 'pending' }
  | { kind: 'default' }
  | { kind: 'loading'; buffered: InputRecord[]; interrupted?: unknown }
  | { kind: 'durable'; worker: EngineWorker }
  | { kind: 'failed' };

/**
 * Routes protocol records to the engine chosen by the first start record. The default worker is
 * built eagerly and receives every record unless the start asks for the durable engine, whose
 * module is loaded only then; records that arrive while it loads are replayed in order.
 */
export class EngineRouter implements EngineWorker {
  readonly #defaultWorker: EngineWorker;
  readonly #loadDurable: DurableEngineLoader;
  readonly #onLoadFailure: (error: unknown) => Promise<void>;
  readonly #completion = Promise.withResolvers<void>();
  #selection: Selection = { kind: 'pending' };

  constructor(defaultWorker: EngineWorker, loadDurable: DurableEngineLoader, onLoadFailure: (error: unknown) => Promise<void>) {
    this.#defaultWorker = defaultWorker;
    this.#loadDurable = loadDurable;
    this.#onLoadFailure = onLoadFailure;
  }

  get completion(): Promise<void> {
    return this.#completion.promise;
  }

  receive(record: InputRecord): void {
    const selection = this.#selection;
    switch (selection.kind) {
      case 'pending':
        if (record.type === 'start' && record.runtime === 'pi-durable') {
          this.#selection = { kind: 'loading', buffered: [] };
          void this.#load(record);
          return;
        }
        this.#useDefault();
        this.#forwardDefault(record);
        return;
      case 'default':
        this.#forwardDefault(record);
        return;
      case 'loading':
        if (selection.buffered.length >= MAX_QUEUED_RECORDS) throw new ProtocolError('protocol record queue overflow');
        selection.buffered.push(record);
        return;
      case 'durable':
        selection.worker.receive(record);
        return;
      case 'failed':
        throw new ProtocolError('protocol input received after terminal state');
    }
  }

  interrupt(error: unknown): void {
    const selection = this.#selection;
    switch (selection.kind) {
      case 'pending':
        this.#useDefault();
        this.#defaultWorker.interrupt(error);
        return;
      case 'default':
        this.#defaultWorker.interrupt(error);
        return;
      case 'loading':
        selection.interrupted ??= error;
        return;
      case 'durable':
        selection.worker.interrupt(error);
        return;
      case 'failed':
        return;
    }
  }

  #useDefault(): void {
    this.#selection = { kind: 'default' };
    this.#defaultWorker.completion.then(() => this.#completion.resolve(), (error: unknown) => this.#completion.reject(error));
  }

  #forwardDefault(record: InputRecord): void {
    // Storage traffic belongs to the durable engine only; the default engine never asks for it.
    if (record.type === 'storage_response') throw new ProtocolError('storage response received by an engine without remote storage');
    this.#defaultWorker.receive(record);
  }

  async #load(start: StartRecord): Promise<void> {
    let worker: EngineWorker;
    try {
      worker = await this.#loadDurable(start);
    } catch (error) {
      this.#selection = { kind: 'failed' };
      try {
        await this.#onLoadFailure(error);
        this.#completion.resolve();
      } catch (failure) {
        this.#completion.reject(failure);
      }
      return;
    }
    const loading = this.#selection;
    this.#selection = { kind: 'durable', worker };
    worker.completion.then(() => this.#completion.resolve(), (error: unknown) => this.#completion.reject(error));
    if (loading.kind !== 'loading') return;
    try {
      for (const record of loading.buffered) worker.receive(record);
    } catch (error) {
      worker.interrupt(error);
      return;
    }
    if (loading.interrupted !== undefined) worker.interrupt(loading.interrupted);
  }
}
