import { describe, expect, it } from 'vitest';
import {
  renderRuntimePanel, renderSessionsPanel, renderTaskGraph, renderTaskList, taskDuration,
  taskGraphLayout, taskStatusLabel
} from '../dashboard/dashboard-render.js';

const now = Date.parse('2026-08-17T01:00:00.000Z');
const taskId = (letter: string) => `task_${letter.repeat(24)}`;
const task = (overrides: Record<string, unknown> = {}) => ({
  id: taskId('a'), name: 'install', status: 'running', startedAt: now - 5_000, finishedAt: null,
  exitCode: null, dependsOn: [], output: '', ...overrides
});
const session = (overrides: Record<string, unknown> = {}) => ({ id: `sess_${'b'.repeat(24)}`, name: 'shell', status: 'open', cwd: '.', ...overrides });

describe('runtime renderers', () => {
  it('names task state as text for every state the runner reports', () => {
    for (const status of ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timedOut']) {
      expect(taskStatusLabel(status), status).not.toBe('Unknown');
    }
    expect(taskStatusLabel('nope')).toBe('Unknown');
  });

  it('measures duration from the task timestamps', () => {
    expect(taskDuration({ startedAt: now - 5_000, finishedAt: now }, now)).toBe('5.0 s');
    expect(taskDuration({ startedAt: now - 120_000, finishedAt: now }, now)).toBe('2.0 min');
    // A running task measures against now; one that never started says so.
    expect(taskDuration({ startedAt: now - 3_000 }, now)).toBe('3.0 s');
    expect(taskDuration({}, now)).toBe('Not started');
  });

  it('shows outcome, exit code, dependencies and output, and only cancels live tasks', () => {
    const running = renderTaskList([task({ dependsOn: [taskId('c')] })], now);
    expect(running).toContain('Running');
    expect(running).toContain('5.0 s');
    expect(running).toContain(taskId('c'));
    expect(running).toContain('No output reported');
    expect(running).toContain('class="danger cancel-task"');

    const done = renderTaskList([task({ status: 'succeeded', exitCode: 0, finishedAt: now, output: 'ok' })], now);
    expect(done).toContain('Succeeded');
    expect(done).not.toContain('cancel-task');
    expect(done).toContain('ok');

    expect(renderTaskList([], now)).toContain('No tasks have run in this workspace yet.');
  });

  it('lays the graph out by dependency depth and survives a cycle', () => {
    const first = task({ id: taskId('a'), name: 'install' });
    const second = task({ id: taskId('b'), name: 'unit tests', dependsOn: [first.id] });
    const third = task({ id: taskId('c'), name: 'package', dependsOn: [second.id] });
    const layout = taskGraphLayout({ nodes: [third, first, second], edges: [{ from: first.id, to: second.id }, { from: second.id, to: third.id }] });
    expect(layout.layers.map((layer) => layer.length)).toEqual([1, 1, 1]);
    // x grows with depth, so a deeper task is drawn to the right of its dependency.
    expect(layout.positions.get(third.id).x).toBeGreaterThan(layout.positions.get(first.id).x);

    const cyclic = taskGraphLayout({ nodes: [task({ id: taskId('d') }), task({ id: taskId('e') })], edges: [{ from: taskId('d'), to: taskId('e') }, { from: taskId('e'), to: taskId('d') }] });
    expect(cyclic.nodes).toHaveLength(2);

    // An edge to a node that is not in this page is simply not drawn.
    const dangling = taskGraphLayout({ nodes: [task()], edges: [{ from: taskId('z'), to: taskId('a') }] });
    expect(dangling.layers).toHaveLength(1);
  });

  it('renders the DAG as SVG with focusable nodes and text state, and never colour alone', () => {
    const first = task({ id: taskId('a'), name: 'install', status: 'succeeded', exitCode: 0, finishedAt: now });
    const second = task({ id: taskId('b'), name: 'unit tests', dependsOn: [first.id], status: 'failed', exitCode: 1, finishedAt: now });
    const svg = renderTaskGraph({ nodes: [first, second], edges: [{ from: first.id, to: second.id }] }, now);
    expect(svg).toContain('<figure class="task-graph-figure">');
    expect(svg).toContain('viewBox=');
    expect(svg).toContain('role="list"');
    expect(svg).toContain('tabindex="0"');
    expect(svg).toContain('aria-label="install: Succeeded');
    expect(svg).toContain('class="task-node task-failed"');
    expect(svg).toContain('>Failed · ');
    expect(svg).toContain('class="task-edge"');
    expect(svg).toContain('the task table below carries the same facts');
    expect(renderTaskGraph({}, now)).toContain('No tasks have run in this workspace yet.');
  });

  it('keeps the session view read-only, bounded and explicit about truncation', () => {
    const open = renderSessionsPanel({ sessions: [session()], io: { output: 'partial output', truncated: true } });
    expect(open).toContain('id="session-io-output"');
    expect(open).toContain('Read-only and bounded');
    expect(open).toContain('never sends input');
    expect(open).toContain('Output is truncated');
    expect(open).toContain('id="open-session-dialog"');
    expect(open).toContain('class="read-session"');

    const closed = renderSessionsPanel({ sessions: [session({ status: 'closed' })] });
    expect(closed).toContain('Close session</button>');
    expect(closed).toContain('disabled');
    expect(closed).not.toContain('session-io-output');
    expect(renderSessionsPanel({})).toContain('No sessions are open in this workspace.');
  });

  it('composes the cockpit runtime panel from tasks, graph and sessions', () => {
    const panel = renderRuntimePanel({ tasks: [task()], graph: { nodes: [task()], edges: [] }, sessions: [session()] }, now);
    expect(panel).toContain('id="tasks-heading"');
    expect(panel).toContain('id="graph-heading"');
    expect(panel).toContain('id="sessions-heading"');
    expect(panel).toContain('Live workspace runtime');
  });
});
