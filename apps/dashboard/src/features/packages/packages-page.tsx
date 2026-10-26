import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PackageIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Section } from '@/components/data/section';
import { StatusBadge } from '@/components/data/status-badge';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { apiClient } from '@/lib/api-client';
import { type BffEnvelope } from '@/lib/bff-query';
import { useBffMutation } from '@/lib/bff-mutation';
import { formatDateTime } from '@/lib/format';
import { pageReadQuery } from '@/lib/page-read';
import { ECOSYSTEM_LABELS, formatPackageBytes, runtimeText, shortDigest } from '@/features/approvals/approvals-model';
import {
  APPLY_STEP_LABELS, APPLY_STEPS, approvalModeText, bindingFenced, bindingRisks, type PackageApply, type PackageBinding,
  type PackageChange, packageChangeCopy, packageChangeRequest, packagesOverviewOf, type PackagesOverview, releaseHealth, workspaceCount
} from './packages-model';

const NOT_REPORTED = 'Not reported';
const when = (value: string | undefined) => (value ? formatDateTime(value) : NOT_REPORTED);

function Fact({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`text-sm break-words ${mono ? 'font-mono text-xs break-all' : ''}`}>{children}</dd>
    </div>
  );
}

function Digest({ value, label }: { value: string | undefined; label: string }) {
  if (!value) return <>{NOT_REPORTED}</>;
  return <code className="font-mono text-xs break-all" tabIndex={0} title={`${label}: ${value}`} aria-label={`${label}: ${value}`}>{shortDigest(value)}</code>;
}

function Tiles({ overview }: { overview: PackagesOverview }) {
  const tiles: Array<{ label: string; value: string; note: string; href?: '/approvals' }> = [
    { label: 'Installed', value: `${overview.usage.bindings ?? overview.bindings.length} / ${overview.quotas.maxBindings ?? '?'}`, note: 'Bindings in use' },
    { label: 'Disk used', value: formatPackageBytes(overview.usage.ownerBytes), note: `of ${formatPackageBytes(overview.quotas.maxOwnerBytes)} quota` },
    { label: 'Applies running', value: String(overview.inFlight.length), note: 'Builds in progress' },
    { label: 'Plans waiting', value: String(overview.pendingPlans), note: overview.pendingPlans ? 'Review on Approvals' : 'Nothing to decide', ...(overview.pendingPlans ? { href: '/approvals' as const } : {}) }
  ];
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Package usage">
      {tiles.map((tile) => {
        const body = (
          <>
            <span className="text-xs text-muted-foreground">{tile.label}</span>
            <span className="text-2xl font-semibold tabular-nums">{tile.value}</span>
            <span className="text-xs text-muted-foreground">{tile.note}</span>
          </>
        );
        return (
          <li key={tile.label} className="rounded-lg border bg-card">
            {tile.href
              ? <Link to={tile.href} className="grid gap-1 rounded-lg p-4 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">{body}</Link>
              : <div className="grid gap-1 p-4">{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}

function ApplySteps({ state }: { state: string }) {
  const failed = state === 'FAILED';
  const reached = state === 'SUCCEEDED' ? APPLY_STEPS.length : APPLY_STEPS.indexOf(state as (typeof APPLY_STEPS)[number]);
  return (
    <ol className="flex flex-wrap gap-2 text-xs" aria-label="Apply progress">
      {APPLY_STEPS.map((step, index) => {
        const done = index < reached;
        const current = index === reached && !failed;
        return (
          <li key={step} aria-current={current ? 'step' : undefined} className={`rounded-full border px-2 py-0.5 ${done ? 'border-success/40 text-success' : current ? 'border-info/40 font-medium text-info' : 'text-muted-foreground'}`}>
            {APPLY_STEP_LABELS[step]}{done ? <span className="sr-only"> (done)</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function ApplyRow({ apply, live }: { apply: PackageApply; live: boolean }) {
  const tone = apply.state === 'SUCCEEDED' ? 'success' : apply.state === 'FAILED' ? 'danger' : 'info';
  return (
    <li className="grid gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0">
          <h3 className="font-medium break-words">{apply.title}</h3>
          <span className="font-mono text-xs break-all text-muted-foreground">{apply.applyId}</span>
        </div>
        <StatusBadge status={apply.state} tone={tone} label={APPLY_STEP_LABELS[apply.state] ?? apply.state} />
      </div>
      {live ? <ApplySteps state={apply.state} /> : null}
      {apply.state === 'FAILED' ? <p className="text-sm text-destructive">{apply.errorCode ?? 'FAILED'}{apply.errorMessage ? `: ${apply.errorMessage}` : ''}</p> : null}
      <dl className="grid gap-3 sm:grid-cols-2">
        <Fact label="Started">{when(apply.createdAt)}</Fact>
        <Fact label={apply.finishedAt ? 'Finished' : 'Updated'}>{when(apply.finishedAt ?? apply.updatedAt ?? apply.createdAt)}</Fact>
      </dl>
    </li>
  );
}

function BindingRow({ binding, overview, onChange }: { binding: PackageBinding; overview: PackagesOverview; onChange: (change: PackageChange) => void }) {
  const release = binding.release;
  const detail = overview.releases.find((candidate) => candidate.releaseId === release?.releaseId) ?? release;
  const health = releaseHealth(release);
  const risks = bindingRisks(release);
  const fenced = bindingFenced(binding) ? binding : undefined;
  return (
    <li className="grid gap-3 rounded-lg border bg-card p-4" data-testid="package-binding">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-0.5">
          <h3 className="font-medium break-words">{binding.name}<span className="ml-0.5 font-mono text-sm text-muted-foreground">@{release?.version ?? 'unknown'}</span></h3>
          <p className="text-xs text-muted-foreground">
            {ECOSYSTEM_LABELS[binding.ecosystem] ?? binding.ecosystem} · {binding.scope === 'workspace' ? <>Workspace <code className="font-mono">{binding.workspaceId ?? 'not reported'}</code></> : 'Owner (every workspace)'}
          </p>
        </div>
        <StatusBadge status={release?.status ?? 'MISSING'} tone={health.tone} label={health.label} />
      </div>
      {risks.length ? <ul className="grid list-disc gap-1 pl-5 text-sm text-warning" aria-label={`Risks for ${binding.name}`}>{risks.map((risk) => <li key={risk}>{risk}</li>)}</ul> : null}
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Active release" mono>{release?.releaseId || 'None'}</Fact>
        <Fact label="Generation">{binding.generation ?? NOT_REPORTED}</Fact>
        <Fact label="Disk usage">{formatPackageBytes(detail?.sizeBytes)}{detail?.fileCount ? ` · ${detail.fileCount} files` : ''}</Fact>
        <Fact label="Dependencies">{detail?.dependencyCount ?? NOT_REPORTED}</Fact>
        <Fact label="Binaries" mono>{release?.binaries.length ? release.binaries.join(', ') : 'None'}</Fact>
        <Fact label="Source" mono>{detail?.source ?? NOT_REPORTED}</Fact>
        <Fact label="Tree digest"><Digest value={release?.treeDigest} label="Tree digest" /></Fact>
        <Fact label="Runtime">{runtimeText(detail?.runtime ?? null)}</Fact>
        <Fact label="Affected">{workspaceCount(binding.affected)}</Fact>
        <Fact label="Installed">{when(release?.createdAt)}</Fact>
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="destructive" disabled={!fenced} aria-haspopup="dialog" onClick={() => { if (fenced) onChange({ kind: 'remove', binding: fenced }); }}>Uninstall {binding.name}</Button>
      </div>
      {binding.history.length ? (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <caption className="px-3 py-2 text-left text-xs text-muted-foreground">History of {binding.name}</caption>
            <thead className="border-y bg-muted/40 text-xs text-muted-foreground">
              <tr><th scope="col" className="px-3 py-2 text-left font-medium">Version</th><th scope="col" className="px-3 py-2 text-left font-medium">Generation</th><th scope="col" className="px-3 py-2 text-left font-medium">Change</th><th scope="col" className="px-3 py-2 text-left font-medium">When</th><th scope="col" className="px-3 py-2 text-right font-medium">Action</th></tr>
            </thead>
            <tbody>
              {binding.history.map((entry) => {
                const current = entry.releaseId === release?.releaseId;
                return (
                  <tr key={`${entry.releaseId}-${entry.generation ?? ''}`} className="border-b last:border-b-0">
                    <th scope="row" className="px-3 py-2 text-left font-medium"><span className="block">{entry.version}</span><span className="block font-mono text-xs font-normal break-all text-muted-foreground">{entry.releaseId}</span></th>
                    <td className="px-3 py-2 tabular-nums">{entry.generation ?? NOT_REPORTED}</td>
                    <td className="px-3 py-2">{entry.reason === 'rollback' ? 'Rollback' : 'Apply'} · {entry.actor === 'dashboard' ? 'Dashboard' : 'Agent'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{when(entry.createdAt)}</td>
                    <td className="px-3 py-2 text-right">
                      {current
                        ? <StatusBadge status="ACTIVE" label="Current" />
                        : entry.available && fenced
                          ? <Button size="sm" variant="outline" className="text-destructive" aria-haspopup="dialog" onClick={() => onChange({ kind: 'rollback', binding: fenced, entry })}>Roll back to {entry.version}</Button>
                          : <StatusBadge status="unavailable" label="Unavailable" />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="text-sm text-muted-foreground">No history yet.</p>}
    </li>
  );
}

/**
 * Managed toolbox packages (`GET /packages`): usage against quota, applies in flight and
 * recent, installed bindings with their health, risks and history, and retained releases.
 * Rollback and uninstall confirm with the classic copy and carry the binding generation
 * the operator saw; a 409 refetches the overview. Plans are decided on the Approvals page.
 */
export function PackagesPage() {
  const read = useQuery(pageReadQuery('packages', {}));
  const [change, setChange] = useState<PackageChange>();
  const write = useBffMutation<PackageChange, unknown>({
    mutationFn: (next) => {
      const { path, body } = packageChangeRequest(next);
      return apiClient.request(path, { method: 'POST', body });
    },
    invalidate: ['/packages'],
    successToast: (_result, next) => packageChangeCopy(next).success,
    errorTitle: 'The package change was not applied'
  });
  const copy = change ? packageChangeCopy(change) : undefined;

  return (
    <>
      <AsyncStatus query={read} label="packages">
        {(body) => {
          const overview = packagesOverviewOf((body as BffEnvelope<unknown>).data);
          if (!overview.enabled) {
            return (
              <div className="grid gap-(--stack-gap)">
                <p className="rounded-lg border bg-surface p-3 text-sm text-muted-foreground"><strong className="font-medium text-foreground">Managed packages are off.</strong> Operators enable them with PACKAGES_ENABLED=true.</p>
                <EmptyState icon={PackageIcon} title="No managed packages" description="When the feature is on, agents plan installs with packages_plan and you approve them on the Approvals page." />
              </div>
            );
          }
          return (
            <div className="grid gap-(--stack-gap)">
              <p className="rounded-lg border bg-surface p-3 text-sm text-muted-foreground">
                <strong className="font-medium text-foreground">Managed packages.</strong>{' '}
                Approval: {approvalModeText(overview.approvalMode)}. Ecosystems: {overview.ecosystems.join(', ') || 'none'}. npm lifecycle scripts: {overview.lifecycleScripts === 'allow' ? 'allowed on request' : 'denied'}. Per-release limit {formatPackageBytes(overview.quotas.maxReleaseBytes)}. A change reaches a running workspace only when it is recreated.
              </p>
              <Tiles overview={overview} />
              <Section title="Applies">
                {overview.inFlight.length || overview.recentApplies.length ? (
                  <ul className="grid gap-3" aria-label="Package applies">
                    {overview.inFlight.map((apply) => <ApplyRow key={`live-${apply.applyId}`} apply={apply} live />)}
                    {overview.recentApplies.map((apply) => <ApplyRow key={`recent-${apply.applyId}`} apply={apply} live={false} />)}
                  </ul>
                ) : <EmptyState icon={PackageIcon} title="No applies yet" description="An approved plan is applied by an agent with packages_apply; its progress appears here." />}
              </Section>
              <Section title="Installed packages">
                {overview.bindings.length ? (
                  <ul className="grid gap-3" aria-label="Installed packages">
                    {overview.bindings.map((binding) => <BindingRow key={binding.bindingId} binding={binding} overview={overview} onChange={setChange} />)}
                  </ul>
                ) : <EmptyState icon={PackageIcon} title="No packages installed" description="Installed releases, their health, and their rollback history appear here." />}
              </Section>
              {overview.releases.length ? (
                <Section title="Retained releases">
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-sm">
                      <caption className="sr-only">Retained package releases</caption>
                      <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                        <tr><th scope="col" className="px-3 py-2 text-left font-medium">Package</th><th scope="col" className="px-3 py-2 text-left font-medium">Version</th><th scope="col" className="px-3 py-2 text-left font-medium">Size</th><th scope="col" className="px-3 py-2 text-left font-medium">Health</th><th scope="col" className="px-3 py-2 text-left font-medium">Built</th></tr>
                      </thead>
                      <tbody>
                        {overview.releases.map((release) => {
                          const health = releaseHealth(release);
                          return (
                            <tr key={release.releaseId} className="border-b last:border-b-0">
                              <th scope="row" className="px-3 py-2 text-left font-medium"><span className="block">{release.name}</span><span className="block font-mono text-xs font-normal break-all text-muted-foreground">{release.releaseId}</span></th>
                              <td className="px-3 py-2">{release.version}</td>
                              <td className="px-3 py-2 whitespace-nowrap tabular-nums">{formatPackageBytes(release.sizeBytes)}</td>
                              <td className="px-3 py-2"><StatusBadge status={release.status} tone={health.tone} label={health.label} /></td>
                              <td className="px-3 py-2 whitespace-nowrap">{when(release.createdAt)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Section>
              ) : null}
            </div>
          );
        }}
      </AsyncStatus>
      <ConfirmDialog
        open={change !== undefined}
        onOpenChange={(open) => { if (!open) setChange(undefined); }}
        title={copy?.title ?? ''}
        description={copy?.description ?? ''}
        {...(copy ? { target: copy.target } : {})}
        confirmLabel={copy?.confirmLabel ?? 'Confirm'}
        pendingLabel={copy?.pendingLabel ?? 'Working…'}
        destructive
        onConfirm={() => (change ? write.mutateAsync(change) : Promise.resolve())}
      />
    </>
  );
}
