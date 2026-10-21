import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { SquareTerminalIcon } from 'lucide-react';
import { useState } from 'react';
import { Section } from '@/components/data/section';
import { StatusBadge } from '@/components/data/status-badge';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { repositoryName, type Workspace } from '@/features/workspaces/workspace-model';
import { apiClient } from '@/lib/api-client';
import { bffPath } from '@/lib/bff-query';
import { useBffMutation } from '@/lib/bff-mutation';
import { arr } from '@/lib/format';
import { pageReadQuery } from '@/lib/page-read';
import { terminalAge, terminalIdleExpiry, terminalSize, terminalsOf } from './terminal-model';
import { terminalStatusLabel, type TerminalView } from './terminal-protocol';

/**
 * Every live terminal across the operator's workspaces (`GET /terminals`), with Close behind
 * the shared confirmation. Only a running terminal can be closed. No poller: Refresh re-reads,
 * as the classic page does.
 */
export function TerminalsPage() {
  const read = useQuery(pageReadQuery('terminals', {}));
  const workspaces = useQuery(pageReadQuery('workspaces', {}));
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<TerminalView>();
  const names = new Map(arr<Workspace>((workspaces.data as { data?: { workspaces?: unknown } } | undefined)?.data?.workspaces).map((workspace) => [workspace.workspaceId, repositoryName(workspace.repositoryUrl)]));
  const close = useBffMutation<TerminalView, unknown>({
    mutationFn: (terminal) => apiClient.request(`${bffPath('workspaces', terminal.workspaceId ?? '', 'terminals', terminal.terminalId)}/close`, { method: 'POST', body: {} }),
    invalidate: (terminal) => ['/terminals', `${bffPath('workspaces', terminal.workspaceId ?? '')}/terminals`],
    successToast: 'Terminal closed.',
    errorTitle: 'The terminal was not closed'
  });

  const columns: DataTableColumn<TerminalView>[] = [
    {
      id: 'workspace', header: 'Workspace', cell: (terminal) => (
        <div className="grid min-w-0">
          {terminal.workspaceId
            ? <Link to="/workspaces/$workspaceId/$tab" params={{ workspaceId: terminal.workspaceId, tab: 'terminal' }} className="truncate font-medium underline-offset-2 hover:underline">{names.get(terminal.workspaceId) ?? terminal.workspaceId}</Link>
            : <span className="font-medium">Unknown workspace</span>}
          <span className="truncate font-mono text-xs text-muted-foreground">{terminal.terminalId}</span>
        </div>
      )
    },
    { id: 'status', header: 'Status', cell: (terminal) => <StatusBadge status={terminal.status} label={terminalStatusLabel({ phase: terminal.status, exitCode: terminal.exitCode })} /> },
    { id: 'size', header: 'Size', cell: terminalSize, className: 'tabular-nums' },
    { id: 'age', header: 'Age', cell: (terminal) => terminalAge(terminal.createdAt), className: 'whitespace-nowrap' },
    { id: 'idle', header: 'Idle expiry', cell: terminalIdleExpiry, className: 'hidden md:table-cell whitespace-nowrap' },
    {
      id: 'actions', header: <span className="sr-only">Actions</span>, cell: (terminal) => (
        <div className="flex justify-end">
          <Button size="sm" variant="destructive" disabled={terminal.status !== 'running' || !terminal.workspaceId} onClick={() => setTarget(terminal)}>
            Close<span className="sr-only"> {terminal.terminalId}</span>
          </Button>
        </div>
      )
    }
  ];

  return (
    <div className="grid gap-(--stack-gap)">
      <AsyncStatus query={read} label="terminals">
        {(body) => {
          const terminals = terminalsOf((body as { data?: unknown }).data);
          return (
            <Section
              title="Terminals"
              description="Terminals live in runner memory: they end on idle expiry, at their lifetime limit, or when the runner restarts, and are never resumed. Ended terminals stay listed briefly so their final status can be read."
              actions={<Button size="sm" variant="outline" disabled={read.isFetching} onClick={() => void queryClient.invalidateQueries({ queryKey: pageReadQuery('terminals', {}).queryKey })}>{read.isFetching ? 'Refreshing…' : 'Refresh'}</Button>}
            >
              <DataTable
                caption={`${terminals.length} terminal(s)`}
                columns={columns}
                rows={terminals}
                rowKey={(terminal) => terminal.terminalId}
                empty={<EmptyState icon={SquareTerminalIcon} title="No terminals are running." description="Open one from a workspace's Terminal tab." />}
              />
            </Section>
          );
        }}
      </AsyncStatus>
      <ConfirmDialog
        open={target !== undefined}
        onOpenChange={(open) => { if (!open) setTarget(undefined); }}
        title="Close this terminal?"
        description="The shell and every process it started end now. Unsaved work in that shell is lost; the workspace itself is unchanged."
        target={target ? `${target.workspaceId ?? ''} ${target.terminalId}` : ''}
        confirmLabel="Close terminal"
        pendingLabel="Closing…"
        onConfirm={() => (target ? close.mutateAsync(target) : Promise.resolve())}
      />
    </div>
  );
}
