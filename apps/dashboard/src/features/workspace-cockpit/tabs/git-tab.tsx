import { type QueryKey, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { GitBranchIcon, GitCommitHorizontalIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { DetailList } from '@/components/data/detail-list';
import { Section } from '@/components/data/section';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { toast } from '@/components/ui/toast-store';
import { apiClient } from '@/lib/api-client';
import { type BffEnvelope, bffPath, bffQuery } from '@/lib/bff-query';
import { mutationErrorText, useBffMutation } from '@/lib/bff-mutation';
import { formatDateTime } from '@/lib/format';
import type { CockpitTabProps } from '../cockpit-tab-registry';
import { GIT_ACTIONS, GIT_CONFIRM_COPY, type GitAction, gitActionBody, gitCommitsOf, gitDiffOf, gitStatusOf, type Worktree, worktreesOf } from '../git-model';

const dataOf = (body: unknown) => (body as BffEnvelope<unknown>).data;
const preClass = 'max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none';

/**
 * The Git tab: working-tree status, a bounded diff (staged or unstaged, the `staged` search
 * param), the last 20 commits, managed worktrees and the advanced operations. Finalize stays
 * the happy path in the cockpit header. Checkout, merge and rebase confirm first (R12), as
 * does removing a worktree; nothing here resolves a conflict automatically.
 */
export default function GitTab({ workspaceId, search, onSearch }: CockpitTabProps) {
  const base = bffPath('workspaces', workspaceId);
  const staged = search.staged === true;
  const status = useQuery(bffQuery<unknown>(`${base}/git/status`, {}));
  const diff = useQuery(bffQuery<unknown>(`${base}/git/diff`, { staged: staged ? 'true' : 'false' }));
  const log = useQuery(bffQuery<unknown>(`${base}/git/log`, { limit: 20 }));
  const worktrees = useQuery(bffQuery<unknown>(`${base}/worktrees`, {}));
  // Every Git write can move the branch, the index and the log, so each refetches all four reads.
  const reads: QueryKey[] = [`${base}/git/status`, `${base}/git/diff`, `${base}/git/log`, `${base}/worktrees`].map((path) => ['bff', path]);

  return (
    <div className="grid gap-(--stack-gap)">
      <p className="text-sm text-muted-foreground"><strong className="font-medium text-foreground">Workspace Git.</strong> Finalize stages, commits and pushes in one confirmed step. Advanced operations stay collapsed until you need them.</p>
      <AsyncStatus query={status} label="Git status">
        {(body) => {
          const value = gitStatusOf(dataOf(body));
          return (
            <Section title="Working tree">
              <DetailList items={[
                { label: 'Branch', value: value.branch ?? 'Not reported', mono: true },
                { label: 'Upstream', value: value.upstream ?? 'Not reported', mono: true },
                { label: 'Ahead / behind', value: `${value.ahead} ahead · ${value.behind} behind` },
                { label: 'Staged', value: value.staged },
                { label: 'Modified', value: value.modified },
                { label: 'Untracked', value: value.untracked }
              ]} />
              <h3 className="text-sm font-medium">File changes</h3>
              {value.entries.length ? (
                <ul className="grid divide-y rounded-md border text-sm" aria-label="Changed files">
                  {value.entries.map((entry) => (
                    <li key={`${entry.code}:${entry.path}`} className="flex gap-3 px-3 py-1.5 font-mono text-xs">
                      <span className="w-6 shrink-0 text-muted-foreground">{entry.code}</span>
                      <span className="break-all">{entry.path}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted-foreground">No changed files.</p>}
            </Section>
          );
        }}
      </AsyncStatus>
      <Section
        title={staged ? 'Staged diff' : 'Unstaged diff'}
        id="git-diff"
        actions={<Button size="sm" variant="outline" onClick={() => onSearch({ ...search, staged: staged ? undefined : true })}>Show {staged ? 'unstaged' : 'staged'} diff</Button>}
      >
        <AsyncStatus query={diff} label="diff">
          {(body) => {
            const value = gitDiffOf(dataOf(body));
            return (
              <>
                <pre className={preClass} tabIndex={0} aria-label={staged ? 'Staged diff' : 'Unstaged diff'} data-testid="git-diff">{value.diff || 'No diff to show.'}</pre>
                {value.truncated ? <p className="text-sm text-warning" role="status">Diff is truncated. Narrow it with a path filter before trusting the whole change set.</p> : null}
              </>
            );
          }}
        </AsyncStatus>
      </Section>
      <Section title="Recent commits">
        <AsyncStatus query={log} label="commits">
          {(body) => {
            const commits = gitCommitsOf(dataOf(body));
            return commits.length ? (
              <ul className="grid divide-y rounded-md border" aria-label="Recent commits">
                {commits.map((commit, index) => (
                  <li key={`${commit.oid}:${index}`} className="grid gap-0.5 px-3 py-2 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <span className="font-medium break-words">{commit.subject}</span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">{commit.oid.slice(0, 12)}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{commit.author}{commit.at ? ` · ${formatDateTime(commit.at)}` : ''}</span>
                  </li>
                ))}
              </ul>
            ) : <EmptyState icon={GitCommitHorizontalIcon} title="No commits reported." />;
          }}
        </AsyncStatus>
      </Section>
      <Worktrees workspaceId={workspaceId} query={worktrees} reads={reads} />
      <AdvancedGit workspaceId={workspaceId} reads={reads} />
    </div>
  );
}

function Worktrees({ workspaceId, query, reads }: { workspaceId: string; query: UseQueryResult<BffEnvelope<unknown>>; reads: QueryKey[] }) {
  const base = bffPath('workspaces', workspaceId);
  const [name, setName] = useState('');
  const [ref, setRef] = useState('');
  const [removing, setRemoving] = useState<Worktree>();
  const create = useBffMutation<{ name: string; ref: string }, unknown>({
    mutationFn: (body) => apiClient.request(`${base}/worktrees`, { method: 'POST', body }),
    invalidate: reads,
    successToast: 'Worktree created.',
    errorTitle: 'The worktree was not created',
    onSuccess: () => { setName(''); setRef(''); }
  });
  const remove = useBffMutation<string, unknown>({
    mutationFn: (tree) => apiClient.request(`${base}/worktrees/${encodeURIComponent(tree)}`, { method: 'DELETE', body: {} }),
    invalidate: reads,
    successToast: 'Worktree removed.'
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() && ref.trim()) void create.mutateAsync({ name: name.trim(), ref: ref.trim() }).catch(() => undefined);
  }
  return (
    <details className="group rounded-lg border bg-surface p-4">
      <summary className="cursor-pointer text-base font-semibold">Worktrees</summary>
      <div className="mt-3 grid gap-4">
        <AsyncStatus query={query} label="worktrees">
          {(body) => {
            const trees = worktreesOf(dataOf(body));
            return trees.length ? (
              <ul className="grid divide-y rounded-md border" aria-label="Managed worktrees">
                {trees.map((tree) => (
                  <li key={tree.path || tree.name} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm">
                    <div className="grid min-w-0 gap-0.5">
                      <span className="font-mono text-xs break-all">{tree.path}</span>
                      <span className="text-xs text-muted-foreground"><span className="font-mono">{tree.head.slice(0, 12)}</span> · {tree.branch}</span>
                    </div>
                    <Button size="sm" variant="destructive" disabled={!tree.name} onClick={() => setRemoving(tree)}>Remove<span className="sr-only"> worktree {tree.name}</span></Button>
                  </li>
                ))}
              </ul>
            ) : <EmptyState icon={GitBranchIcon} title="No managed worktrees." />;
          }}
        </AsyncStatus>
        <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={submit}>
          <Field label="Name"><Input required autoComplete="off" pattern="[A-Za-z0-9._\-]{1,80}" maxLength={80} className="font-mono" value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label="Ref"><Input required autoComplete="off" maxLength={255} className="font-mono" value={ref} onChange={(event) => setRef(event.target.value)} /></Field>
          <Button type="submit" size="sm" disabled={create.isPending} aria-busy={create.isPending || undefined}>{create.isPending ? 'Creating…' : 'Create worktree'}</Button>
        </form>
      </div>
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => { if (!open) setRemoving(undefined); }}
        title="Remove this worktree?"
        description="The managed worktree is removed; its branch stays in the repository."
        target={removing?.name ?? ''}
        confirmLabel="Remove worktree"
        pendingLabel="Removing…"
        onConfirm={() => (removing ? remove.mutateAsync(removing.name) : Promise.resolve())}
        onError={(error) => toast({ title: 'The worktree was not removed', description: mutationErrorText(error), variant: 'destructive' })}
      />
    </details>
  );
}

function AdvancedGit({ workspaceId, reads }: { workspaceId: string; reads: QueryKey[] }) {
  const base = bffPath('workspaces', workspaceId);
  const [action, setAction] = useState<GitAction>('fetch');
  const [argument, setArgument] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [output, setOutput] = useState<{ action: GitAction; text: string }>();
  const selected = GIT_ACTIONS.find((entry) => entry.id === action) ?? GIT_ACTIONS[0];
  const run = useBffMutation<{ action: GitAction; argument: string }, BffEnvelope<{ output?: string }>>({
    mutationFn: (input) => apiClient.request(`${base}/git/${input.action}`, { method: 'POST', body: gitActionBody(input.action, input.argument) }),
    invalidate: reads,
    successToast: (_result, input) => `Git ${input.action} completed.`,
    onSuccess: (result, input) => setOutput({ action: input.action, text: result.data?.output ?? '' })
  });
  const failed = (error: unknown) => toast({ title: `Git ${action} failed`, description: mutationErrorText(error), variant: 'destructive' });
  const execute = () => run.mutateAsync({ action, argument: argument.trim() });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (selected.needsRef && !argument.trim()) return;
    if (selected.confirm) setConfirming(true);
    else execute().catch(failed);
  }
  const copy = GIT_CONFIRM_COPY[action];
  return (
    <details className="rounded-lg border bg-surface p-4">
      <summary className="cursor-pointer text-base font-semibold">Advanced Git operations</summary>
      <form className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={submit}>
        <Field label="Action">
          <NativeSelect value={action} onChange={(event) => setAction(event.target.value as GitAction)}>
            {GIT_ACTIONS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Ref (checkout, branch, merge, rebase)">
          <Input autoComplete="off" maxLength={255} className="font-mono" required={selected.needsRef} disabled={!selected.needsRef} value={argument} onChange={(event) => setArgument(event.target.value)} />
        </Field>
        <Button type="submit" size="sm" disabled={run.isPending} aria-busy={run.isPending || undefined}>{run.isPending ? 'Running…' : 'Run Git operation'}</Button>
      </form>
      <p className="mt-3 text-xs text-muted-foreground">Conflicts are reported here and never resolved automatically. Finalize remains the recommended path.</p>
      {output ? (
        <div className="mt-3 grid gap-1">
          <h3 className="text-sm font-medium">Output of git {output.action}</h3>
          <pre className={preClass} tabIndex={0} aria-label={`Output of git ${output.action}`}>{output.text || 'No output.'}</pre>
        </div>
      ) : null}
      {copy ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={copy.title}
          description={copy.description}
          target={argument.trim()}
          confirmLabel={copy.confirmLabel}
          pendingLabel="Running…"
          onConfirm={execute}
          onError={failed}
        />
      ) : null}
    </details>
  );
}
