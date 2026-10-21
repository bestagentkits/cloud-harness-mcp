import { useQuery } from '@tanstack/react-query';
import { BoxIcon, CircleAlertIcon } from 'lucide-react';
import { Suspense, useState } from 'react';
import type { WorkspaceTab } from '@/app/page-registry';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { PageSkeleton } from '@/components/feedback/page-skeleton';
import { StatusBadge } from '@/components/data/status-badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { ActionButton } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ApiError } from '@/lib/api-client';
import { apiClient } from '@/lib/api-client';
import { type BffEnvelope, bffPath } from '@/lib/bff-query';
import { useBffMutation } from '@/lib/bff-mutation';
import { pageReadQuery } from '@/lib/page-read';
import { networkLabel, repositoryName, type Workspace, workspaceHasAction, workspaceStatusLabel } from '@/features/workspaces/workspace-model';
import { Link, useNavigate } from '@tanstack/react-router';
import { COCKPIT_TABS, type CockpitSearch } from './cockpit-tab-registry';
import { CockpitTabNav } from './cockpit-tab-nav';
import { FinalizeDialog, type FinalizeValues } from './finalize-dialog';
import { unavailableDetail, workspaceAttention, workspaceLeaseState } from './workspace-lease';

/**
 * The workspace cockpit: the workspace record (the page registry's read, warmed on hover),
 * a header with lease posture and its lifecycle actions (renew, finalize, recover, close,
 * each shown only when the runner offers it), the tab nav, and the active tab's lazy
 * chunk. Live tabs (runtime, terminal, files, git, automation, deploy) render an explanation
 * instead of their content while the workspace is not ACTIVE, so they never call an executor
 * that is not there.
 */
export function WorkspaceCockpit({ workspaceId, tab, search, onSearch }: {
  workspaceId: string;
  tab: WorkspaceTab;
  search: CockpitSearch;
  onSearch: (next: CockpitSearch) => void;
}) {
  const read = useQuery(pageReadQuery('workspace', { workspaceId }));
  const entry = COCKPIT_TABS[tab];
  const gone = read.error instanceof ApiError && (read.error.status === 404 || read.error.status === 410);
  if (gone && read.data === undefined) {
    return (
      <EmptyState
        icon={BoxIcon}
        title="Workspace not found or no longer available"
        description="It may have been closed and reaped, or it belongs to another identity."
        action={<Button asChild variant="outline" size="sm"><Link to="/workspaces">Back to workspaces</Link></Button>}
      />
    );
  }
  return (
    <AsyncStatus query={read} label="workspace">
      {(body) => {
        const workspace: Workspace = { ...(body as BffEnvelope<Workspace>).data, workspaceId };
        const Tab = entry.component;
        return (
          <div className="grid gap-(--stack-gap)">
            <CockpitHeader workspace={workspace} />
            <CockpitTabNav workspaceId={workspaceId} tab={tab} />
            <div key={tab} className="animate-in fade-in-0 duration-(--motion-base) motion-reduce:animate-none" data-testid="cockpit-tab" data-tab={tab}>
              {entry.live && workspace.status !== 'ACTIVE' ? (
                <EmptyState
                  icon={CircleAlertIcon}
                  title={`${entry.label} is unavailable while the workspace is ${workspaceStatusLabel(workspace.status)}`}
                  description={unavailableDetail(workspace.status)}
                />
              ) : (
                <Suspense fallback={<PageSkeleton label={`Loading ${entry.label}`} />}>
                  <Tab workspaceId={workspaceId} workspace={workspace} search={search} onSearch={onSearch} />
                </Suspense>
              )}
            </div>
          </div>
        );
      }}
    </AsyncStatus>
  );
}

function CockpitHeader({ workspace }: { workspace: Workspace }) {
  const lease = workspaceLeaseState(workspace);
  const attention = workspaceAttention(workspace);
  const navigate = useNavigate();
  const [finalizing, setFinalizing] = useState(false);
  const [closing, setClosing] = useState(false);
  const base = bffPath('workspaces', workspace.workspaceId);
  const invalidate = [pageReadQuery('workspace', { workspaceId: workspace.workspaceId }).queryKey, ['bff', '/workspaces']];
  const renew = useBffMutation<void, BffEnvelope<Workspace>>({
    mutationFn: () => apiClient.request(`${base}/lease-renew`, { method: 'POST', body: {} }),
    invalidate,
    successToast: (result) => result.data?.leaseCapped === true
      ? 'Lease renewed only until the maximum workspace lifetime; the workspace still expires then.'
      : 'Workspace lease renewed.',
    errorTitle: 'The lease was not renewed'
  });
  const recover = useBffMutation<void, unknown>({
    mutationFn: () => apiClient.request(`${base}/recover`, { method: 'POST', body: { mode: 'resume' } }),
    invalidate,
    successToast: 'Workspace recovery requested.',
    errorTitle: 'Recovery was not requested'
  });
  const finalize = useBffMutation<FinalizeValues, unknown>({
    mutationFn: ({ commitMessage, push, idempotencyKey }) => apiClient.request(`${base}/finalize`, { method: 'POST', body: { all: true, push, commitMessage, idempotencyKey } }),
    invalidate: [...invalidate, `${base}/git/status`, `${base}/git/log`, `${base}/git/diff`],
    successToast: 'Workspace finalized.'
  });
  const generation = workspace.version;
  const fenced = typeof generation === 'number' && Number.isSafeInteger(generation) && generation > 0;
  const close = useBffMutation<number, unknown>({
    mutationFn: (expectedGeneration) => apiClient.request(`${base}/close`, { method: 'POST', body: { expectedGeneration } }),
    invalidate,
    successToast: 'Workspace closed.',
    onSuccess: () => { void navigate({ to: '/' }); }
  });
  const canOpen = workspaceHasAction(workspace, 'workspace_open');
  const canFinalize = workspaceHasAction(workspace, 'workspace_finalize');
  const canRecover = workspaceHasAction(workspace, 'workspace_recover');
  const canClose = workspaceHasAction(workspace, 'workspace_close');
  return (
    <section aria-labelledby="workspace-heading" className="grid gap-3 rounded-lg border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h2 id="workspace-heading" className="truncate text-lg font-semibold">{repositoryName(workspace.repositoryUrl)}</h2>
          <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <span className="truncate font-mono">{workspace.workspaceId}</span>
            <CopyButton value={workspace.workspaceId} label="Copy workspace ID" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={workspace.status} label={workspaceStatusLabel(workspace.status)} />
          {canOpen ? (
            <Button asChild variant="outline" size="sm"><Link to="/workspaces">Open new workspace</Link></Button>
          ) : (
            <>
              {workspaceHasAction(workspace, 'workspace_lease_renew') ? (
                <ActionButton variant="outline" size="sm" pendingLabel="Renewing…" successLabel="Renewed" errorLabel="Not renewed" onAction={() => renew.mutateAsync()}>Renew lease</ActionButton>
              ) : null}
              {canFinalize ? <Button size="sm" aria-haspopup="dialog" onClick={() => setFinalizing(true)}>Finalize workspace</Button> : null}
              {canRecover ? (
                <ActionButton variant="outline" size="sm" pendingLabel="Recovering…" successLabel="Requested" errorLabel="Not requested" onAction={() => recover.mutateAsync()}>Recover workspace</ActionButton>
              ) : null}
              {canClose ? (
                <Button variant="destructive" size="sm" aria-haspopup="dialog" disabled={!fenced} onClick={() => setClosing(true)}>Close workspace</Button>
              ) : null}
            </>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div><dt className="text-xs text-muted-foreground">Ref</dt><dd className="truncate">{workspace.ref ?? 'Default branch'}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Network</dt><dd>{networkLabel(workspace.networkProfile)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Lease</dt><dd data-lease={lease.state} className={lease.state === 'expired' ? 'font-medium text-destructive' : lease.state === 'soon' ? 'font-medium text-warning' : undefined}>{lease.label}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Attention</dt><dd>{attention.length ? `${attention.length} item(s) need attention` : 'Nothing needs attention'}</dd></div>
      </dl>
      {canFinalize ? <FinalizeDialog open={finalizing} onOpenChange={setFinalizing} onSubmit={(values) => finalize.mutateAsync(values)} /> : null}
      {canClose ? (
        <ConfirmDialog
          open={closing}
          onOpenChange={setClosing}
          title="Close workspace?"
          description="This stops the executor and removes the workspace checkout. This cannot be undone."
          target={`${repositoryName(workspace.repositoryUrl)} ${workspace.workspaceId}`}
          confirmLabel="Close workspace"
          pendingLabel="Closing…"
          destructive
          onConfirm={() => (fenced ? close.mutateAsync(generation) : Promise.resolve())}
        />
      ) : null}
    </section>
  );
}
