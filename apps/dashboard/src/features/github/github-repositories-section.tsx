import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AsyncStatus } from '@/components/feedback/async-status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api-client';
import { bffQuery } from '@/lib/bff-query';
import { formatTime } from '../shared/format';
import { reportActionError } from '../shared/report-error';
import { Section } from '../shared/section';
import { StatusBadge } from '../shared/status-badge';
import { filterRepositories, refetchGitHubReads, type GitHubRepositoryListing, type GitHubUnreachableAccount } from './github-model';

const PATH = '/github/repositories';
/** Rows added per "Show more"; every repository of the listing stays reachable. */
const PAGE_ROWS = 300;

function installLink(account: GitHubUnreachableAccount): string | undefined {
  if (!account.installUrl) return undefined;
  try {
    const url = new URL(account.installUrl);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every repository this identity can open, read live from GitHub through the bound installations
 * and the connected GitHub user (`GET /github/repositories`). Refresh bypasses the runner's
 * short cache; names and access levels are the only things rendered.
 */
export function GitHubRepositoriesSection() {
  const queryClient = useQueryClient();
  // An answer missing a list (an older BFF during a rolling deploy) renders as empty, never as a crashed page.
  const read = useQuery({
    ...bffQuery<Partial<GitHubRepositoryListing>>(PATH),
    select: (body): GitHubRepositoryListing => ({
      ...body.data,
      repositories: body.data?.repositories ?? [],
      accounts: body.data?.accounts ?? [],
      unreachableAccounts: body.data?.unreachableAccounts ?? [],
      warnings: body.data?.warnings ?? []
    })
  });
  const [filter, setFilter] = useState('');
  const [shown, setShown] = useState(PAGE_ROWS);
  const [refreshing, setRefreshing] = useState(false);

  // Refreshing reconciles the bound installations, which rewrites their stored grants, so it is a CSRF-protected
  // POST. `force` bypasses the runner's cache; the automatic sync on load reuses a fresh synced listing. The POST
  // answer is never shown: a response that arrives after a Disconnect could carry the previous connection's names,
  // so the page refetches the read, which the runner answers for the connection as it is now (and cancels any
  // read still in flight).
  const sync = useCallback(async (force: boolean) => {
    setRefreshing(true);
    try {
      await apiClient.request<unknown>(`${PATH}/refresh`, { method: 'POST', body: { refresh: force } });
      // Cancels a read still in flight before refetching; the bound installations were re-verified too.
      await refetchGitHubReads(queryClient, [PATH, '/github']);
    } catch (error) {
      reportActionError('GitHub repositories could not be refreshed', error);
    } finally {
      setRefreshing(false);
    }
  }, [queryClient]);

  // The read lists stored installation grants; bring them up to date from GitHub once per visit.
  const autoSynced = useRef(false);
  const needsSync = read.data !== undefined && read.data.synced !== true;
  useEffect(() => {
    if (!needsSync || autoSynced.current) return;
    autoSynced.current = true;
    void sync(false);
  }, [needsSync, sync]);

  return (
    <Section
      title="All accessible repositories"
      description="Read live from GitHub across your personal account and every organization this App can reach for you."
      testId="github-all-repositories"
      actions={<Button size="sm" variant="outline" disabled={refreshing} aria-busy={refreshing || undefined} onClick={() => { void sync(true); }}>{refreshing ? 'Refreshing…' : 'Refresh from GitHub'}</Button>}
    >
      <AsyncStatus query={read} label="GitHub repositories">
        {(listing) => {
          const matching = filterRepositories(listing.repositories, filter);
          return (
            <div className="grid gap-3">
              {listing.warnings.length ? (
                <ul className="grid gap-1 rounded-md border border-warning/60 bg-warning/10 p-3 text-sm" data-testid="github-repositories-warnings">
                  {listing.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              ) : null}
              {listing.unreachableAccounts.length ? (
                <div className="grid gap-1 text-sm" data-testid="github-unreachable-accounts">
                  <p className="text-muted-foreground">No App installation you can reach covers these accounts (your personal account and public organization memberships; private memberships are not visible to the App). Their private repositories cannot be opened through the App for you; public repositories still clone.</p>
                  <ul className="flex flex-wrap gap-2">
                    {listing.unreachableAccounts.map((account) => {
                      const href = installLink(account);
                      return (
                        <li key={account.login} className="rounded-md border px-2 py-1">
                          <span className="font-medium">{account.login}</span> <span className="text-muted-foreground">({account.type})</span>
                          {account.installation === 'installed'
                            ? <span className="text-muted-foreground"> · App installed, but you have no repository access there: ask an owner</span>
                            : href ? <> · <a className="underline" href={href} rel="noreferrer noopener" target="_blank">Install App</a></> : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <Input className="max-w-xs" aria-label="Filter repositories" placeholder="Filter owner/name" value={filter} onChange={(event) => { setFilter(event.target.value); setShown(PAGE_ROWS); }} />
                <span className="text-muted-foreground" data-testid="github-repositories-count">
                  {matching.length} of {listing.repositories.length} repositories{listing.incomplete ? ' (incomplete)' : ''}
                  {listing.listedAt ? ` · read ${formatTime(listing.listedAt)}` : ''}
                </span>
              </div>
              {matching.length ? (
                <ul className="grid gap-2">
                  {matching.slice(0, shown).map((repository) => (
                    <li key={repository.fullName} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm">
                      <strong className="break-all">{repository.fullName}</strong>
                      <StatusBadge tone={repository.access === 'write' ? 'success' : 'neutral'}>{repository.access === 'write' ? 'write permission' : 'read'}</StatusBadge>
                      <span className="text-muted-foreground">
                        via {repository.via === 'installation' ? 'App installation' : 'your GitHub user'}
                        {repository.private === undefined ? '' : repository.private ? ' · private' : ' · public'}
                        {repository.archived ? ' · archived' : ''}
                        {repository.defaultBranch ? ` · ${repository.defaultBranch}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted-foreground">No repositories match.</p>}
              {matching.length > shown ? (
                <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                  <span>Showing {shown} of {matching.length}.</span>
                  <Button size="sm" variant="outline" onClick={() => setShown((count) => count + PAGE_ROWS)}>Show {Math.min(PAGE_ROWS, matching.length - shown)} more</Button>
                </div>
              ) : null}
            </div>
          );
        }}
      </AsyncStatus>
    </Section>
  );
}
