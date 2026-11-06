import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AsyncStatus } from '@/components/feedback/async-status';
import { Section } from '@/components/data/section';
import { StatusBadge } from '@/components/data/status-badge';
import { Button } from '@/components/ui/button';
import { type BffEnvelope, bffPath, bffQuery } from '@/lib/bff-query';
import { str } from '@/lib/format';
import { taskStatusLabel } from '../runtime-model';

type OutputSlice = { output?: string; cursor?: string; truncated?: boolean; status?: string; exitCode?: number | null };

/** The task status read nests the task (`{ task: {..., output} }`); a session read is flat. */
function sliceOf(body: BffEnvelope<unknown> | undefined): OutputSlice {
  const data = (body?.data ?? {}) as Record<string, unknown>;
  const task = data.task && typeof data.task === 'object' ? data.task as Record<string, unknown> : data;
  const cursor = typeof body?.cursor === 'string' ? body.cursor : typeof data.cursor === 'string' ? data.cursor : undefined;
  return {
    output: str(task.output),
    ...(cursor ? { cursor } : {}),
    truncated: body?.truncated === true || data.truncated === true,
    status: str(task.status),
    exitCode: typeof task.exitCode === 'number' ? task.exitCode : null
  };
}

/**
 * A bounded, read-only output slice with "Next slice" when the runner truncated it. Output is
 * process output: it lives only in this component's in-memory query (dropped on unmount,
 * `gcTime: 0`) and is rendered as text, never markup.
 */
function OutputPanel({ title, path, description, onClose, showStatus }: { title: string; path: string; description: string; onClose: () => void; showStatus?: boolean }) {
  const [cursor, setCursor] = useState<string>();
  const read = useQuery({ ...bffQuery<unknown>(path, { cursor }), gcTime: 0, retry: false });
  return (
    <Section
      title={title}
      description={description}
      className="animate-in fade-in-0 motion-reduce:animate-none"
      actions={<>
        <Button size="sm" variant="outline" disabled={read.isFetching} onClick={() => void read.refetch()}>{read.isFetching ? 'Refreshing…' : 'Refresh'}</Button>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </>}
    >
      <AsyncStatus query={read} label="output">
        {(body) => {
          const slice = sliceOf(body);
          return (
            <div className="grid gap-2">
              {showStatus && slice.status ? (
                <p className="flex items-center gap-2 text-sm">
                  <StatusBadge status={slice.status} label={taskStatusLabel(slice.status)} />
                  <span className="text-muted-foreground">Exit {slice.exitCode ?? 'none'}</span>
                </p>
              ) : null}
              <pre data-testid="runtime-output" className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-words">{slice.output || 'No output reported.'}</pre>
              {slice.truncated ? (
                <div className="flex flex-wrap items-center gap-2 text-sm" role="status">
                  <span className="text-muted-foreground">Output is truncated.</span>
                  {slice.cursor ? <Button size="sm" variant="outline" onClick={() => setCursor(slice.cursor)}>Next slice</Button> : null}
                </div>
              ) : null}
            </div>
          );
        }}
      </AsyncStatus>
    </Section>
  );
}

export function TaskOutput({ workspaceId, taskId, onClose }: { workspaceId: string; taskId: string; onClose: () => void }) {
  return (
    <OutputPanel
      key={taskId}
      title="Task output"
      description={`Bounded output of ${taskId}.`}
      path={bffPath('workspaces', workspaceId, 'tasks', taskId)}
      onClose={onClose}
      showStatus
    />
  );
}

export function SessionOutput({ workspaceId, sessionId, onClose }: { workspaceId: string; sessionId: string; onClose: () => void }) {
  return (
    <OutputPanel
      key={sessionId}
      title="Session output"
      description="Read-only and bounded. The Dashboard never sends input to a session."
      path={`${bffPath('workspaces', workspaceId, 'sessions', sessionId)}/io`}
      onClose={onClose}
    />
  );
}
