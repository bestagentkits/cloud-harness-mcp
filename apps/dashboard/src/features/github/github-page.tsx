import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { GitBranchIcon as GithubIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast-store';
import { bffKey, mutationErrorText } from '@/lib/bff-mutation';
import { Callout } from '../shared/callout';
import { usePageData } from '../shared/feature-read';
import { formatTime } from '../shared/format';
import { reportActionError } from '../shared/report-error';
import { Section } from '../shared/section';
import { StatusBadge } from '../shared/status-badge';
import { accountOf, type GitHubInstallation, type GitHubStatus, githubApi, GITHUB_READS, installationsOf } from './github-model';

/** One-time callback states already sent in this document, so a re-render or StrictMode never replays one. */
const consumedStates = new Set<string>();

export type GitHubCallback = { state: string; installationId: string };

/**
 * Completes the GitHub App installation callback once: `POST /github/complete` with exactly
 * `{ state, installationId }`, then replaces the URL with the canonical page so the
 * one-time state leaves the address bar and history.
 */
function useGitHubCallback(callback: GitHubCallback | undefined) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [completing, setCompleting] = useState(() => Boolean(callback && !consumedStates.has(callback.state)));
  const started = useRef(false);
  useEffect(() => {
    if (!callback || started.current || consumedStates.has(callback.state)) return;
    started.current = true;
    consumedStates.add(callback.state);
    void (async () => {
      try {
        await githubApi.complete(callback.state, callback.installationId);
        toast({ title: 'GitHub App connection completed.', variant: 'success' });
      } catch (error) {
        reportActionError('The GitHub App connection could not be completed', error);
      } finally {
        await navigate({ to: '/integrations/github', search: {}, replace: true });
        await queryClient.invalidateQueries({ queryKey: bffKey('/github') });
        setCompleting(false);
      }
    })();
  }, [callback, navigate, queryClient]);
  return completing;
}

function InstallationCard({ installation, onReconcile, reconciling, onDisconnect }: { installation: GitHubInstallation; onReconcile: () => void; reconciling: boolean; onDisconnect: () => void }) {
  const account = accountOf(installation);
  return (
    <li className="grid gap-3 rounded-lg border bg-card p-4" data-testid="installation-card" data-installation-id={String(installation.installationId)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-1 min-w-0">
          <h3 className="font-semibold break-all">{account}</h3>
          <p className="flex flex-wrap items-center gap-2 text-xs"><code className="font-mono">{String(installation.installationId)}</code><StatusBadge tone={installation.status === 'active' ? 'success' : 'neutral'}>{installation.status ?? 'unknown'}</StatusBadge></p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={reconciling} aria-busy={reconciling || undefined} aria-label={`Reconcile ${account}`} onClick={onReconcile}>{reconciling ? 'Reconciling…' : 'Reconcile'}</Button>
          <Button size="sm" variant="outline" className="text-destructive" aria-haspopup="dialog" aria-label={`Disconnect ${account}`} onClick={onDisconnect}>Disconnect</Button>
        </div>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-4">
        <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">Account</dt><dd className="break-all">{account}</dd></div>
        <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">Status</dt><dd>{installation.status ?? 'unknown'}</dd></div>
        <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">Installation ID</dt><dd className="font-mono text-xs">{String(installation.installationId)}</dd></div>
        <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">Last checked</dt><dd>{installation.checkedAt ? formatTime(installation.checkedAt) : 'Not yet reconciled'}</dd></div>
      </dl>
    </li>
  );
}

function SetupForm() {
  const form = useForm<{ expectedAccountId: string }>({ defaultValues: { expectedAccountId: '' } });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const submit = form.handleSubmit(async ({ expectedAccountId }) => {
    setPending(true);
    setError(undefined);
    try {
      // A native navigation: `form-action 'self'` forbids posting a form to GitHub, and
      // the returned URL and state are never stored.
      window.location.assign(await githubApi.setup(expectedAccountId));
    } catch (failure) {
      setError(mutationErrorText(failure));
      setPending(false);
    }
  });
  return (
    <Section title="Connect GitHub App" testId="github-setup">
      <form className="grid max-w-md gap-3" noValidate onSubmit={(event) => { void submit(event); }} aria-busy={pending || undefined}>
        <Field label="Expected account ID" optional description="Refuse the installation unless it belongs to this GitHub account or organization ID.">
          <Input autoComplete="off" spellCheck={false} maxLength={100} className="font-mono" {...form.register('expectedAccountId')} />
        </Field>
        {error ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm" data-testid="form-error">{error}</p> : null}
        <div><Button type="submit" disabled={pending} aria-busy={pending || undefined}>{pending ? 'Preparing connection…' : 'Connect GitHub App'}</Button></div>
      </form>
    </Section>
  );
}

export function GitHubPage({ callback }: { callback?: GitHubCallback | undefined }) {
  const queryClient = useQueryClient();
  const completing = useGitHubCallback(callback);
  const read = usePageData<GitHubStatus>('github');
  const [reconciling, setReconciling] = useState<string | undefined>();
  const [disconnecting, setDisconnecting] = useState<GitHubInstallation | undefined>();
  const refresh = useCallback(() => Promise.all(GITHUB_READS.map((path) => queryClient.invalidateQueries({ queryKey: bffKey(path) }))), [queryClient]);

  const reconcile = useCallback(async (installationId?: string) => {
    const key = installationId ?? '*';
    setReconciling(key);
    try {
      await githubApi.reconcile(installationId);
      toast({ title: installationId ? 'GitHub installation reconciled.' : 'GitHub installations reconciled.', variant: 'success' });
    } catch (error) {
      reportActionError('GitHub installations could not be reconciled', error);
    } finally {
      setReconciling(undefined);
      void refresh();
    }
  }, [refresh]);

  return (
    <div className="grid gap-(--stack-gap)" data-testid="github-page">
      <Callout title="GitHub App authorization metadata.">Provider private keys and minted tokens remain runner-only and are never rendered.</Callout>
      {completing ? <p role="status" className="rounded-lg border bg-surface p-3 text-sm" data-testid="github-completing">Completing GitHub App connection…</p> : null}
      <AsyncStatus query={read} label="GitHub">
        {(status) => {
          const list = installationsOf(status);
          return (
            <>
              <Section
                title="Installation status"
                actions={list.length ? (
                  <Button size="sm" variant="outline" disabled={reconciling !== undefined} aria-busy={reconciling === '*' || undefined} onClick={() => { void reconcile(); }}>
                    {reconciling === '*' ? 'Reconciling…' : list.length > 1 ? 'Reconcile all installations' : 'Reconcile installation'}
                  </Button>
                ) : undefined}
              >
                {list.length === 0
                  ? <EmptyState icon={GithubIcon} title="No GitHub App installation is bound to this identity." description="Connect the GitHub App below to authorize private repositories." />
                  : (
                    <ul className="grid gap-3">
                      {list.map((installation) => {
                        const id = String(installation.installationId);
                        return <InstallationCard key={id} installation={installation} reconciling={reconciling === id} onReconcile={() => { void reconcile(id); }} onDisconnect={() => setDisconnecting(installation)} />;
                      })}
                    </ul>
                  )}
              </Section>
              <SetupForm />
              <Section title="Authorized repositories" testId="github-repositories">
                {status.repositories?.length ? (
                  <ul className="grid gap-2">
                    {status.repositories.map((repository) => (
                      <li key={`${repository.installationId ?? ''}/${repository.owner}/${repository.repository}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm">
                        <strong className="break-all">{repository.owner}/{repository.repository}</strong>
                        <span className="text-muted-foreground">{repository.status} · Contents {repository.contents}{repository.installationId ? <> · ID <code className="font-mono">{String(repository.installationId)}</code></> : null}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-muted-foreground">No authorized repositories reported.</p>}
              </Section>
            </>
          );
        }}
      </AsyncStatus>
      <ConfirmDialog
        open={disconnecting !== undefined}
        onOpenChange={(open) => { if (!open) setDisconnecting(undefined); }}
        title="Disconnect GitHub App installation?"
        description="Disconnect this account/organization and remove associated repository authorizations?"
        target={disconnecting ? `${accountOf(disconnecting)} (ID ${String(disconnecting.installationId)})` : ''}
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting…"
        onConfirm={async () => {
          if (!disconnecting) return;
          await githubApi.disconnect(String(disconnecting.installationId));
          toast({ title: 'GitHub installation disconnected.', variant: 'success' });
          await refresh();
        }}
        onError={(error) => { reportActionError('The GitHub installation could not be disconnected', error); void refresh(); }}
      />
    </div>
  );
}
