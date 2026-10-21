/**
 * The runtime projection (`/workspaces/:id/runtime`): volatile tasks and sessions that
 * disappear when the workspace is reaped. Labels and durations follow the classic page.
 */
export type RuntimeTask = {
  id: string;
  name?: string;
  status?: string;
  exitCode?: number | null;
  dependsOn?: string[];
  startedAt?: number | string | null;
  finishedAt?: number | string | null;
  output?: string;
};

export type RuntimeSession = { id: string; name?: string; status?: string };

const TASK_STATUS_LABELS: Record<string, string> = {
  queued: 'Queued', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled', timedOut: 'Timed out'
};

const TERMINAL_TASK_STATES = new Set(['succeeded', 'failed', 'cancelled', 'timedOut']);

export function taskStatusLabel(status: unknown): string {
  return TASK_STATUS_LABELS[String(status)] ?? 'Unknown';
}

/** A task the runner can still cancel: anything not in a terminal state. */
export function taskIsCancellable(task: RuntimeTask): boolean {
  return !TERMINAL_TASK_STATES.has(String(task.status));
}

export function taskIsTerminal(status: unknown): boolean {
  return TERMINAL_TASK_STATES.has(String(status));
}

function instant(value: unknown): number {
  // `Number(null)` is 0, which would read as "finished at the epoch".
  if (value === null || value === undefined || value === '') return Number.NaN;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Date.parse(String(value));
}

/** Duration from the task's own timestamps; a running task measures against now. */
export function taskDuration(task: RuntimeTask, now = Date.now()): string {
  const start = instant(task.startedAt);
  if (!Number.isFinite(start)) return 'Not started';
  const finished = instant(task.finishedAt);
  const ms = Math.max(0, (Number.isFinite(finished) ? finished : now) - start);
  return ms < 60_000 ? `${(ms / 1_000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];
}

export function runtimeOf(data: unknown): { tasks: RuntimeTask[]; sessions: RuntimeSession[] } {
  const body = data && typeof data === 'object' ? data as { tasks?: unknown; sessions?: unknown } : {};
  return {
    tasks: records(body.tasks).filter((task) => typeof task.id === 'string') as RuntimeTask[],
    sessions: records(body.sessions).filter((session) => typeof session.id === 'string') as RuntimeSession[]
  };
}

/** Task and session ids as the runner issues them; the `task` search param must match. */
export const RUNTIME_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
