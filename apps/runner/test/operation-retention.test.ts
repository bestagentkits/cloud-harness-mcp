import { describe, expect, it, vi } from 'vitest';

type FakeChild = {
  stdout: { on: (event: string, listener: (chunk: Buffer) => void) => void };
  stderr: { on: (event: string, listener: (chunk: Buffer) => void) => void };
  stdin: { end: () => void; write: () => void };
  on: (event: string, listener: (code: number) => void) => void;
  kill: () => void;
  close: (code?: number) => void;
};

const docker = vi.hoisted(() => {
  const children: FakeChild[] = [];
  return {
    children,
    spawnDocker: vi.fn(() => {
      const listeners = new Map<string, Array<(value: any) => void>>();
      const stream = { on: (event: string, listener: (chunk: Buffer) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      } };
      const child: FakeChild = {
        stdout: stream, stderr: stream, stdin: { end: vi.fn(), write: vi.fn() }, kill: vi.fn(),
        on: (event, listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); },
        close: (code = 0) => { for (const listener of listeners.get('close') ?? []) listener(code); }
      };
      children.push(child);
      return child;
    }),
    terminateContainerProcessGroup: vi.fn(async () => undefined)
  };
});

vi.mock('../src/docker-engine.js', () => docker);

import { OperationManager } from '../src/operation-manager.js';

describe('operation retention', () => {
  it('bounds completed handles and evicts workspace state on close', () => {
    const operations = new OperationManager();
    const first = operations.runTask('workspace', 'container', '.', 'true', 'key-0', 1_000, 1_024);
    docker.children.at(-1)!.close();
    for (let index = 1; index < 129; index += 1) {
      operations.runTask('workspace', 'container', '.', 'true', `key-${index}`, 1_000, 1_024);
      docker.children.at(-1)!.close();
    }
    expect(operations.listTasks('workspace')).toHaveLength(128);
    expect(() => operations.task('workspace', first.id)).toThrow('task not found');

    operations.stopWorkspace('workspace');
    expect(operations.listTasks('workspace')).toHaveLength(0);
    const replayAfterClose = operations.runTask('workspace', 'container', '.', 'true', 'key-0', 1_000, 1_024);
    expect(replayAfterClose.id).not.toBe(first.id);
  });
});
