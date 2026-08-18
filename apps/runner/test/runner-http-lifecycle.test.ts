import { describe, expect, it, vi } from 'vitest';
import { RunnerHttpLifecycle } from '../src/app.js';

describe('RunnerHttpLifecycle', () => {
  it('fences new requests, aborts active work, and waits for every handler to drain', async () => {
    const lifecycle = new RunnerHttpLifecycle();
    const first = lifecycle.begin();
    const second = lifecycle.begin();
    const shutdown = lifecycle.shutdown();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(() => lifecycle.begin()).toThrow('runner is shutting down');
    const settled = vi.fn();
    void shutdown.then(settled);
    lifecycle.end(first);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    lifecycle.end(second);
    await shutdown;
    expect(settled).toHaveBeenCalledOnce();
  });
});
