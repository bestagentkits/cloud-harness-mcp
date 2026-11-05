import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { GitBranchIcon as GithubIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast-store';
import { bffPrefix, mutationErrorText } from '@/lib/bff-mutation';
import { Callout } from '../shared/callout';
import { usePageData } from '../shared/feature-read';
import { formatTime } from '../shared/format';
import { reportActionError } from '../shared/report-error';
import { Section } from '../shared/section';
import { StatusBadge } from '../shared/status-badge';
import { hasGitHubCallbackParams } from './github-callback-search';
import { accountOf, classifyGitHubCallback, type GitHubCallback, type GitHubInstallation, type GitHubStatus, githubApi, githubCallbackErrorText, GITHUB_READS, installationsOf, userAuthorizationUnavailable } from './github-model';
import { ForbiddenError } from '@/lib/api-client';

/** One-time callbacks already acted on in this document, so a re-render or StrictMode never replays one. */
const consumed = new Set<string>();

const REFUSAL_MESSAGES = {
  access_denied: 'GitHub authorization was cancelled. The installation was not connected.',
  other: 'GitHub did not authorize the connection. Start the connection again.'
} as const;

const callbackKey = (callback: GitHubCallback) =>
  callback.kind === 'complete' ? `complete:${callback.state}:${callback.code}` : callback.kind === 'authorize' ? `authorize:${callback.state}:${callback.installationId}` : undefined;

function AlertMessage({ title, children, testId }: { title?: string; children: string; testId: string }) {
  return (
    <div role="alert" className="grid gap-1 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid={testId}>
      {title ? <p className="font-medium">{title}</p> : null}
      <p>{children}</p>
    </div>
  );
}

/**
 * Acts on the GitHub callback once per document and replaces the URL with the canonical
 * page so the one-time `state`/`code` leave the address bar and history. The classified
 * callback (including a pending installation ID) lives only in component state, never in
 * browser storage.
 *
 * - OAuth return: `POST /github/complete` with exactly `{ state, code }`.
 * - Fresh install: `POST /github/authorize` with `{ installationId, state }`, then navigate to GitHub.
 *   An expired or invalid setup state (a 403) falls back to the Verify prompt for the same installation.
 * - Already-installed App (no `state`): a prompt, and `POST /github/authorize` with `{ installationId }` on request.
 *   When this identity already has the installation, the page reconciles it instead (see `GitHubPage`).
 */
function useGitHubCallback(search: string) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const classified = useMemo(() => classifyGitHubCallback(search), [search]);
  const hasParams = hasGitHubCallbackParams(search);
  // Latched: the URL is cleared right away, but the outcome must stay on the page.
  const [callback, setCallback] = useState<GitHubCallback>(classified);
  const pendingFor = (next: GitHubCallback) => {
    const key = callbackKey(next);
    return key !== undefined && !consumed.has(key);
  };
  const [busy, setBusy] = useState(() => pendingFor(callback));
  const [failure, setFailure] = useState<{ title: string; message: string } | undefined>();
  const [verifying, setVerifying] = useState(false);
  const [stateExpired, setStateExpired] = useState(false);
  // Only a changed query starts a new callback: the page itself may have moved the latched
  // callback on (an expired setup state becomes a Verify prompt) while the query is still present.
  const [seenSearch, setSeenSearch] = useState(search);
  if (search !== seenSearch) {
    setSeenSearch(search);
    if (classified.kind !== 'none') {
      setCallback(classified);
      setBusy(pendingFor(classified));
      setFailure(undefined);
      setVerifying(false);
      setStateExpired(false);
    }
  }

  useEffect(() => {
    if (hasParams) void navigate({ to: '/integrations/github', search: {}, replace: true });
  }, [hasParams, navigate]);

  useEffect(() => {
    const key = callbackKey(callback);
    if (!key || consumed.has(key)) return;
    consumed.add(key);
    void (async () => {
      try {
        if (callback.kind === 'complete') {
          await githubApi.complete(callback.state, callback.code);
          toast({ title: 'GitHub App connection completed.', variant: 'success' });
        } else if (callback.kind === 'authorize') {
          window.location.assign(await githubApi.authorize(callback.installationId, callback.state));
          return;
        }
      } catch (error) {
        if (callback.kind === 'authorize' && error instanceof ForbiddenError) {
          setStateExpired(true);
          setCallback({ kind: 'verify', installationId: callback.installationId });
        } else {
          setFailure({ title: callback.kind === 'complete' ? 'The GitHub App connection could not be completed.' : 'GitHub authorization could not be started.', message: githubCallbackErrorText(error) });
        }
      }
      await queryClient.invalidateQueries({ queryKey: bffPrefix('/github') });
      setBusy(false);
    })();
  }, [callback, queryClient]);

  const verify = useCallback(async () => {
    if (callback.kind !== 'verify') return;
    setVerifying(true);
    setFailure(undefined);
    try {
      window.location.assign(await githubApi.authorize(callback.installationId));
    } catch (error) {
      setFailure({ title: 'GitHub authorization could not be started.', message: githubCallbackErrorText(error) });
      setVerifying(false);
    }
  }, [callback]);

  return { callback, busy, failure, verify, verifying, stateExpired };
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

function UserAuthorizationNotice() {
  return (
    <AlertMessage testId="github-user-authorization-unconfigured" title="GitHub user authorization is not configured.">
      {`An operator must set GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET on the runner and set the GitHub App Callback URL to ${window.location.origin}/dashboard/integrations/github before an installation can be connected.`}
    </AlertMessage>
  );
}

function SetupForm({ unavailable }: { unavailable: boolean }) {
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
      {unavailable ? <UserAuthorizationNotice /> : null}
      <form className="grid max-w-md gap-3" noValidate onSubmit={(event) => { void submit(event); }} aria-busy={pending || undefined}>
        <Field label="Expected account ID" optional description="Refuse the installation unless it belongs to this GitHub account or organization ID.">
          <Input autoComplete="off" spellCheck={false} maxLength={100} className="font-mono" {...form.register('expectedAccountId')} />
        </Field>
        {error ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm" data-testid="form-error">{error}</p> : null}
        <div><Button type="submit" disabled={pending || unavailable} aria-busy={pending || undefined}>{pending ? 'Preparing connection…' : 'Connect GitHub App'}</Button></div>
      </form>
    </Section>
  );
}

export function GitHubPage({ search = '' }: { search?: string }) {
  const queryClient = useQueryClient();
  const { callback, busy, failure, verify, verifying, stateExpired } = useGitHubCallback(search);
  const read = usePageData<GitHubStatus>('github');
  const [reconciling, setReconciling] = useState<string | undefined>();
  const [disconnecting, setDisconnecting] = useState<GitHubInstallation | undefined>();
  const refresh = useCallback(() => Promise.all(GITHUB_READS.map((path) => queryClient.invalidateQueries({ queryKey: bffPrefix(path) }))), [queryClient]);

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

  // An installation this identity already has needs no user proof: refresh it instead of asking to verify.
  const known = read.data ? installationsOf(read.data) : undefined;
  const callbackInstallationId = callback.kind === 'verify' ? callback.installationId : undefined;
  const alreadyBound = callbackInstallationId !== undefined && known?.some((item) => String(item.installationId) === callbackInstallationId) === true;
  useEffect(() => {
    const key = alreadyBound ? `reconcile:${callbackInstallationId}` : undefined;
    if (!key || !callbackInstallationId || consumed.has(key)) return;
    consumed.add(key);
    void (async () => {
      try {
        await githubApi.reconcile(callbackInstallationId);
        toast({ title: 'GitHub installation reconciled.', variant: 'success' });
      } catch (error) {
        reportActionError('GitHub installations could not be reconciled', error);
      } finally {
        void refresh();
      }
    })();
  }, [alreadyBound, callbackInstallationId, refresh]);
  const verifyUnavailable = read.data !== undefined && userAuthorizationUnavailable(read.data);

  return (
    <div className="grid gap-(--stack-gap)" data-testid="github-page">
      <Callout title="GitHub App authorization metadata.">Provider private keys and minted tokens remain runner-only and are never rendered.</Callout>
      {busy ? <p role="status" className="rounded-lg border bg-surface p-3 text-sm" data-testid="github-completing">{callback.kind === 'authorize' ? 'Redirecting to GitHub to verify your authorization…' : 'Completing GitHub App connection…'}</p> : null}
      {callback.kind === 'refused' ? <AlertMessage testId="github-callback-refused">{callback.reason === 'redirect_uri_mismatch' ? `GitHub refused this dashboard's callback URL. Set the GitHub App Callback URL to ${window.location.origin}/dashboard/integrations/github, then connect again.` : REFUSAL_MESSAGES[callback.reason]}</AlertMessage> : null}
      {callback.kind === 'malformed' ? <AlertMessage testId="github-callback-malformed">The GitHub authorization callback was malformed. Start the connection again.</AlertMessage> : null}
      {callback.kind === 'verify' && !alreadyBound && !read.isPending ? (
        <Callout tone="warning" testId="github-verify">
          <p>{stateExpired
            ? `The connection started here has expired. Verify with GitHub to connect installation ${callback.installationId}.`
            : `GitHub returned installation ${callback.installationId} without a connection state. This happens when the App was already installed on the account. Verify with GitHub to connect it.`}</p>
          {verifyUnavailable ? <p className="pt-2 text-sm">GitHub user authorization is not configured: an operator must set GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET and the GitHub App Callback URL.</p> : null}
          <div className="pt-2"><Button size="sm" disabled={verifying || verifyUnavailable} aria-busy={verifying || undefined} onClick={() => { void verify(); }}>{verifying ? 'Opening GitHub…' : 'Verify with GitHub'}</Button></div>
        </Callout>
      ) : null}
      {failure ? <AlertMessage title={failure.title} testId="github-callback-error">{failure.message}</AlertMessage> : null}
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
              <SetupForm unavailable={userAuthorizationUnavailable(status)} />
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
