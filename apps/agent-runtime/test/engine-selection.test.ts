import { describe, expect, it, vi } from 'vitest';
import { durableLoadFailure, EngineRouter, type EngineWorker } from '../src/engine-selection.js';
import { ProtocolError } from '../src/jsonl.js';
import type { InputRecord } from '../src/protocol-schemas.js';
import { createStartRecord } from './helpers.js';

function fakeWorker(): EngineWorker & { received: InputRecord[]; interrupted: unknown[]; finish(): void } {
  const completion = Promise.withResolvers<void>();
  const worker = {
    received: [] as InputRecord[],
    interrupted: [] as unknown[],
    completion: completion.promise,
    receive(record: InputRecord) {
      worker.received.push(record);
    },
    interrupt(error: unknown) {
      worker.interrupted.push(error);
    },
    finish() {
      completion.resolve();
    }
  };
  return worker;
}

const message: InputRecord = { type: 'message', requestId: 'm-1', behavior: 'followUp', text: 'more' };

describe('engine selection', () => {
  it.each([
    ['without a runtime', createStartRecord()],
    ['for the coding runtime', createStartRecord({ runtime: 'pi-coding' })]
  ])('keeps the default worker and never loads the durable engine %s', async (_name, start) => {
    const defaultWorker = fakeWorker();
    const loader = vi.fn();
    const router = new EngineRouter(defaultWorker, loader, vi.fn());
    router.receive(start);
    router.receive(message);
    expect(defaultWorker.received).toEqual([start, message]);
    expect(loader).not.toHaveBeenCalled();
    defaultWorker.finish();
    await expect(router.completion).resolves.toBeUndefined();
  });

  it('sends interrupts before any start to the default worker', () => {
    const defaultWorker = fakeWorker();
    const loader = vi.fn();
    const router = new EngineRouter(defaultWorker, loader, vi.fn());
    router.interrupt(new Error('stdin closed'));
    expect(defaultWorker.interrupted).toHaveLength(1);
    expect(loader).not.toHaveBeenCalled();
  });

  it('refuses storage responses on the default engine', () => {
    const router = new EngineRouter(fakeWorker(), vi.fn(), vi.fn());
    router.receive(createStartRecord());
    expect(() => router.receive({ type: 'storage_response', id: 's-1', ok: true })).toThrow(ProtocolError);
  });

  it('loads the durable engine for a durable start and replays records that arrived while loading', async () => {
    const defaultWorker = fakeWorker();
    const durable = fakeWorker();
    const loaded = Promise.withResolvers<EngineWorker>();
    const start = createStartRecord({ runtime: 'pi-durable' });
    const loader = vi.fn(() => loaded.promise);
    const router = new EngineRouter(defaultWorker, loader, vi.fn());
    router.receive(start);
    router.receive(message);
    router.interrupt(new Error('stop'));
    expect(loader).toHaveBeenCalledWith(start);
    loaded.resolve(durable);
    await loaded.promise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(durable.received).toEqual([message]);
    expect(durable.interrupted).toHaveLength(1);
    expect(defaultWorker.received).toEqual([]);
    durable.finish();
    await expect(router.completion).resolves.toBeUndefined();
  });

  it('reports a failed terminal when the durable engine cannot load', async () => {
    const onFailure = vi.fn(async () => undefined);
    const router = new EngineRouter(fakeWorker(), async () => {
      throw new Error('module not found');
    }, onFailure);
    router.receive(createStartRecord({ runtime: 'pi-durable' }));
    await router.completion;
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(() => router.receive(message)).toThrow(ProtocolError);
  });
});

describe('durable engine load failure', () => {
  it('tells the operator to rebuild the image when the engine is not installed, without the module path', () => {
    const missing = Object.assign(new Error("Cannot find package '/app/node_modules/@cloud-harness/agent-runtime-durable'"), { code: 'ERR_MODULE_NOT_FOUND' });
    const message = durableLoadFailure(missing);
    expect(message).toContain('INCLUDE_DURABLE_RUNTIME=true');
    expect(message).not.toContain('/app');
    expect(durableLoadFailure(new Error('boom'))).toBe('durable agent runtime is unavailable');
    expect(durableLoadFailure(undefined)).toBe('durable agent runtime is unavailable');
  });
});
