import { useQuery } from '@tanstack/react-query';
import { ListTodoIcon, TerminalSquareIcon } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Section } from '@/components/data/section';
import { StatusBadge } from '@/components/data/status-badge';
import { TruncationNotice } from '@/components/data/truncation-notice';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { apiClient } from '@/lib/api-client';
import { bffKey, bffPath, bffQuery } from '@/lib/bff-query';
import { useBffMutation } from '@/lib/bff-mutation';
import { EMPTY } from '@/lib/format';
import type { CockpitTabProps } from '../cockpit-tab-registry';
import { type RuntimeSession, type RuntimeTask, runtimeOf, taskDuration, taskIsCancellable, taskStatusLabel } from '../runtime-model';
import { OpenSessionDialog } from './open-session-dialog';
import { SessionOutput, TaskOutput } from './runtime-output';

// The graph is its own chunk: the table carries the same facts and paints first.
const TaskGraph = lazy(() => import('../task-graph'));

type Pending = { kind: 'cancel-task'; id: string } | { kind: 'close-session'; id: string } | undefined;

/**
 * Tasks and sessions of a live workspace: one bounded `/runtime` read, cancel and close behind
 * a confirmation, a named session opener, and two read-only output views. The selected task
 * is the `task` search param, so a task's output is a shareable link; a session's output is
 * session-scoped state only (never in the URL). Nothing here polls: Refresh re-reads, as the
 * classic tab does. The dependency graph sits above the task table, as on the classic tab,
 * and loads lazily; the table carries the same dependency facts.
 */
export default function RuntimeTab({ workspaceId, search, onSearch }: CockpitTabProps) {
  const runtimePath = `${bffPath('workspaces', workspaceId)}/runtime`;
  const read = useQuery(bffQuery<unknown>(runtimePath, {}));
  const [pending, setPending] = useState<Pending>();
  const [opening, setOpening] = useState(false);
  const [sessionId, setSessionId] = useState<string>();
  const invalidate = [bffKey(runtimePath, {})];
  const cancelTask = useBffMutation<string, unknown>({
    mutationFn: (taskId) => apiClient.request(`${bffPath('workspaces', workspaceId, 'tasks', taskId)}/cancel`, { method: 'POST', body: {} }),
    invalidate: (taskId) => [...invalidate, bffKey(bffPath('workspaces', workspaceId, 'tasks', taskId), {})],
    successToast: 'Task cancelled.',
    errorTitle: 'The task was not cancelled'
  });
  const closeSession = useBffMutation<string, unknown>({
    mutationFn: (id) => apiClient.request(`${bffPath('workspaces', workspaceId, 'sessions', id)}/close`, { method: 'POST', body: {} }),
    invalidate,
    successToast: 'Session closed.',
    errorTitle: 'The session was not closed'
  });

  const taskColumns: DataTableColumn<RuntimeTask>[] = [
    {
      id: 'task', header: 'Task', cell: (task) => (
        <div className="grid min-w-0">
          <span className="truncate font-medium">{task.name ?? task.id}</span>
          <span className="truncate font-mono text-xs text-muted-foreground">{task.id}</span>
        </div>
      )
    },
    { id: 'status', header: 'Status', cell: (task) => <StatusBadge status={task.status} label={taskStatusLabel(task.status)} /> },
    { id: 'duration', header: 'Duration', cell: (task) => taskDuration(task), className: 'whitespace-nowrap tabular-nums' },
    { id: 'exit', header: 'Exit', cell: (task) => task.exitCode ?? EMPTY, className: 'tabular-nums' },
    { id: 'depends', header: 'Depends on', cell: (task) => task.dependsOn?.length ? <span className="font-mono text-xs break-all">{task.dependsOn.join(', ')}</span> : EMPTY, className: 'hidden md:table-cell' },
    {
      id: 'actions', header: <span className="sr-only">Actions</span>, cell: (task) => (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant={search.task === task.id ? 'secondary' : 'outline'} aria-pressed={search.task === task.id} onClick={() => onSearch({ ...search, task: search.task === task.id ? undefined : task.id })}>
            Output<span className="sr-only"> of {task.name ?? task.id}</span>
          </Button>
          {taskIsCancellable(task) ? <Button size="sm" variant="destructive" onClick={() => setPending({ kind: 'cancel-task', id: task.id })}>Cancel<span className="sr-only"> {task.name ?? task.id}</span></Button> : null}
        </div>
      )
    }
  ];

  const sessionColumns: DataTableColumn<RuntimeSession>[] = [
    {
      id: 'session', header: 'Session', cell: (session) => (
        <div className="grid min-w-0">
          <span className="truncate font-medium">{session.name ?? session.id}</span>
          <span className="flex items-center gap-1 font-mono text-xs text-muted-foreground"><span className="truncate">{session.id}</span><CopyButton value={session.id} label="Copy session ID" /></span>
        </div>
      )
    },
    { id: 'status', header: 'Status', cell: (session) => <StatusBadge status={session.status} /> },
    {
      id: 'actions', header: <span className="sr-only">Actions</span>, cell: (session) => (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant={sessionId === session.id ? 'secondary' : 'outline'} aria-pressed={sessionId === session.id} onClick={() => setSessionId(sessionId === session.id ? undefined : session.id)}>
            Read output<span className="sr-only"> of {session.name ?? session.id}</span>
          </Button>
          <Button size="sm" variant="destructive" disabled={session.status === 'closed'} onClick={() => setPending({ kind: 'close-session', id: session.id })}>
            Close<span className="sr-only"> {session.name ?? session.id}</span>
          </Button>
        </div>
      )
    }
  ];

  return (
    <>
    <AsyncStatus query={read} label="runtime">
      {(body) => {
        const { tasks, sessions } = runtimeOf(body.data);
        return (
          <div className="grid gap-(--stack-gap)">
            <p className="text-sm text-muted-foreground"><strong className="font-medium text-foreground">Live workspace runtime.</strong> Tasks and sessions are volatile: they disappear when the workspace is reaped, unlike retained artifacts.</p>
            <TruncationNotice truncated={body.truncated} what="tasks and sessions" />
            {tasks.length ? <Suspense fallback={<p className="text-sm text-muted-foreground">Loading the task graph…</p>}><TaskGraph workspaceId={workspaceId} /></Suspense> : null}
            <Section title="Tasks" actions={<Button size="sm" variant="outline" disabled={read.isFetching} onClick={() => void read.refetch()}>{read.isFetching ? 'Refreshing…' : 'Refresh'}</Button>}>
              <DataTable
                caption={`${tasks.length} task(s)`}
                columns={taskColumns}
                rows={tasks}
                rowKey={(task) => task.id}
                empty={<EmptyState icon={ListTodoIcon} title="No tasks have run in this workspace yet" />}
              />
            </Section>
            {search.task ? <TaskOutput workspaceId={workspaceId} taskId={search.task} onClose={() => onSearch({ ...search, task: undefined })} /> : null}
            <Section title="Sessions" description="Named, bounded coding sessions. The Dashboard reads their output but never sends input." actions={<Button size="sm" onClick={() => setOpening(true)}>Open session</Button>}>
              <DataTable
                caption={`${sessions.length} session(s)`}
                columns={sessionColumns}
                rows={sessions}
                rowKey={(session) => session.id}
                empty={<EmptyState icon={TerminalSquareIcon} title="No sessions are open in this workspace" />}
              />
            </Section>
            {sessionId ? <SessionOutput workspaceId={workspaceId} sessionId={sessionId} onClose={() => setSessionId(undefined)} /> : null}
          </div>
        );
      }}
    </AsyncStatus>
    <RuntimeConfirm pending={pending} onDone={() => setPending(undefined)} cancelTask={(id) => cancelTask.mutateAsync(id)} closeSession={(id) => closeSession.mutateAsync(id)} />
    <OpenSessionDialog open={opening} onOpenChange={setOpening} workspaceId={workspaceId} onOpened={() => void read.refetch()} />
    </>
  );
}

function RuntimeConfirm({ pending, onDone, cancelTask, closeSession }: {
  pending: Pending;
  onDone: () => void;
  cancelTask: (id: string) => Promise<unknown>;
  closeSession: (id: string) => Promise<unknown>;
}) {
  const isTask = pending?.kind === 'cancel-task';
  return (
    <ConfirmDialog
      open={pending !== undefined}
      onOpenChange={(open) => { if (!open) onDone(); }}
      title={isTask ? 'Cancel this task?' : 'Close this session?'}
      description={isTask ? 'The command stops and anything depending on it stays blocked.' : 'The session ends and its retained output stays readable.'}
      {...(pending ? { target: pending.id } : {})}
      confirmLabel={isTask ? 'Cancel task' : 'Close session'}
      pendingLabel={isTask ? 'Cancelling…' : 'Closing…'}
      onConfirm={() => (pending ? (isTask ? cancelTask(pending.id) : closeSession(pending.id)) : Promise.resolve())}
    />
  );
}
