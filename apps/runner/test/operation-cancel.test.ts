import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationManager } from '../src/operation-manager.js';

describe('generic operation cancel', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the cleanup when it finishes promptly', async () => {
    const manager = new OperationManager();
    const op = manager.registerGenericOperation({ id: 'op_cancel_prompt', kind: 'bash', ownerId: 'owner', abortController: new AbortController() });
    let cleaned = false;
    op.completion = new Promise<void>((resolve) => setTimeout(() => { cleaned = true; resolve(); }, 20));
    const cancelled = await manager.cancelGenericOperation(op.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cleaned).toBe(true);
  });

  it('answers within a bound while a slow cleanup keeps running', async () => {
    vi.useFakeTimers();
    const manager = new OperationManager();
    const abortController = new AbortController();
    const op = manager.registerGenericOperation({ id: 'op_cancel_slow', kind: 'bash', ownerId: 'owner', abortController });
    op.completion = new Promise<void>(() => undefined);
    let answered = false;
    const cancelled = manager.cancelGenericOperation(op.id).then((result) => { answered = true; return result; });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(answered).toBe(true);
    expect((await cancelled).status).toBe('cancelled');
    expect(abortController.signal.aborted).toBe(true);
  });
});
