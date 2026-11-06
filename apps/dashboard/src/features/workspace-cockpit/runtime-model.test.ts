import { describe, expect, it } from 'vitest';
import { runtimeOf, taskDuration, taskIsCancellable, taskStatusLabel } from './runtime-model';

describe('runtime model', () => {
  it('labels task states like the classic page and falls back to Unknown', () => {
    expect(taskStatusLabel('timedOut')).toBe('Timed out');
    expect(taskStatusLabel('weird')).toBe('Unknown');
  });

  it('only offers cancel for tasks that are not finished', () => {
    expect(taskIsCancellable({ id: 'a', status: 'running' })).toBe(true);
    expect(taskIsCancellable({ id: 'a', status: 'queued' })).toBe(true);
    expect(taskIsCancellable({ id: 'a', status: 'succeeded' })).toBe(false);
    expect(taskIsCancellable({ id: 'a', status: 'timedOut' })).toBe(false);
  });

  it('never reads a missing timestamp as the epoch', () => {
    expect(taskDuration({ id: 'a', startedAt: null })).toBe('Not started');
    expect(taskDuration({ id: 'a', startedAt: 1_000, finishedAt: 3_500 })).toBe('2.5 s');
    expect(taskDuration({ id: 'a', startedAt: 0, finishedAt: null }, 180_000)).toBe('3.0 min');
    expect(taskDuration({ id: 'a', startedAt: '2026-10-20T00:00:00Z', finishedAt: '2026-10-20T00:00:01Z' })).toBe('1.0 s');
  });

  it('drops malformed rows from an untrusted projection', () => {
    expect(runtimeOf({ tasks: [{ id: 't1' }, null, { name: 'no id' }], sessions: 'nope' })).toEqual({ tasks: [{ id: 't1' }], sessions: [] });
    expect(runtimeOf(undefined)).toEqual({ tasks: [], sessions: [] });
  });
});
