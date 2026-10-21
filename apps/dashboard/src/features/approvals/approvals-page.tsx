import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PackageIcon, ShieldCheckIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toast-store';
import { apiClient } from '@/lib/api-client';
import { bffPrefix } from '@/lib/bff-mutation';
import { Callout } from '../shared/callout';
import { usePageData } from '../shared/feature-read';
import { formatTime } from '../shared/format';
import { reportActionError } from '../shared/report-error';
import { Section } from '../shared/section';
import { type BadgeTone, StatusBadge } from '../shared/status-badge';
import {
  APPROVAL_READS, approvalsApi, ECOSYSTEM_LABELS, formatPackageBytes, grantIsActionable, grantStatusLabel, type PackagePlan,
  type PackagePlans, planCanWithdraw, planIsActionable, planRisks, planStatusLabel, type PrivilegeGrant, runtimeText, shortDigest
} from './approvals-model';

const GRANT_TONES: Record<string, BadgeTone> = { Pending: 'warning', Approved: 'success', Rejected: 'danger', Used: 'neutral', Expired: 'neutral' };
const PLAN_TONES: Record<string, BadgeTone> = { Pending: 'warning', 'Approved, awaiting apply': 'info', Rejected: 'danger', Expired: 'neutral', Applied: 'success' };
const NOT_REPORTED = 'Not reported';

type Decision =
  | { kind: 'grant'; decision: 'approve' | 'reject'; grant: PrivilegeGrant }
  | { kind: 'plan'; decision: 'approve' | 'reject'; plan: PackagePlan };

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

function Card({ children, testId, ...data }: { children: ReactNode; testId: string } & Record<`data-${string}`, string>) {
  return <li className="grid gap-3 rounded-lg border bg-card p-4" data-testid={testId} {...data}>{children}</li>;
}

function GrantCard({ grant, onDecide }: { grant: PrivilegeGrant; onDecide: (decision: Decision) => void }) {
  const label = grantStatusLabel(grant);
  return (
    <Card testId="grant-card" data-grant-id={grant.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-1 min-w-0">
          <h3 className="font-mono text-sm font-semibold break-all">{grant.command}</h3>
          <p className="text-xs text-muted-foreground">Workspace <code className="font-mono">{grant.workspaceId}</code></p>
        </div>
        <StatusBadge tone={GRANT_TONES[label] ?? 'neutral'}>{label}</StatusBadge>
      </div>
      <dl className="grid gap-3 sm:grid-cols-2">
        <Fact label="Requested">{formatTime(grant.createdAt, NOT_REPORTED)}</Fact>
        <Fact label="Expires">{formatTime(grant.expiresAt, NOT_REPORTED)}</Fact>
        <Fact label="Working directory">{grant.cwd ? <code className="font-mono text-xs">{grant.cwd}</code> : NOT_REPORTED}</Fact>
        <Fact label="Command digest"><Digest value={grant.commandSha256} label="Command digest" /></Fact>
      </dl>
      {grantIsActionable(grant) ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" aria-haspopup="dialog" onClick={() => onDecide({ kind: 'grant', decision: 'approve', grant })}>Approve</Button>
          <Button size="sm" variant="outline" className="text-destructive" aria-haspopup="dialog" onClick={() => onDecide({ kind: 'grant', decision: 'reject', grant })}>Reject</Button>
        </div>
      ) : null}
    </Card>
  );
}

function Digest({ value, label }: { value: string | null | undefined; label: string }) {
  if (!value) return <>{NOT_REPORTED}</>;
  return (
    <code className="font-mono text-xs break-all" tabIndex={0} title={`${label}: ${value}`} aria-label={`${label}: ${value}`} data-testid="digest">
      {shortDigest(value)}
    </code>
  );
}

function PlanCard({ plan, onDecide }: { plan: PackagePlan; onDecide: (decision: Decision) => void }) {
  const label = planStatusLabel(plan);
  const risks = planRisks(plan);
  const ref = `${plan.name}@${plan.version}`;
  const affected = Array.isArray(plan.affectedWorkspaces) ? plan.affectedWorkspaces.length : 0;
  return (
    <Card testId="plan-card" data-plan-id={plan.planId} data-plan-digest={plan.planDigest}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-1 min-w-0">
          <h3 className="text-sm font-semibold break-all">{plan.name}<span className="font-normal text-muted-foreground">@{plan.version}</span></h3>
          <p className="text-xs text-muted-foreground">
            {ECOSYSTEM_LABELS[plan.ecosystem ?? ''] ?? plan.ecosystem ?? ''}{' · '}
            {plan.scope === 'workspace' ? <>Workspace <code className="font-mono">{plan.workspaceId ?? 'not reported'}</code></> : 'Owner (every workspace)'}
          </p>
        </div>
        <StatusBadge tone={PLAN_TONES[label] ?? 'neutral'}>{label}</StatusBadge>
      </div>
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span>{plan.currentRelease ? <>Current <strong>{plan.currentRelease.version ?? 'unknown'}</strong></> : 'New install'}</span>
        <span aria-hidden="true">→</span>
        <span>Planned <strong>{plan.version}</strong></span>
      </p>
      {risks.length > 0 ? (
        <ul className="grid gap-1 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm list-disc ps-8" aria-label={`Risks for ${plan.name}`} data-testid="package-risks">
          {risks.map((risk) => <li key={risk}>{risk}</li>)}
        </ul>
      ) : null}
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Plan digest"><Digest value={plan.planDigest} label="Plan digest" /></Fact>
        <Fact label="Requested"><code className="font-mono text-xs break-all">{plan.requestedSpec ?? plan.version}</code></Fact>
        <Fact label="Source"><code className="font-mono text-xs break-all">{plan.source?.resolved ?? plan.source?.registry ?? NOT_REPORTED}</code></Fact>
        <Fact label="Integrity">{plan.integrity ? <Digest value={plan.integrity} label="Integrity" /> : 'Not reported by the registry'}</Fact>
        <Fact label="Dependencies">{plan.dependencyCount ?? NOT_REPORTED}</Fact>
        <Fact label="Estimated size">{formatPackageBytes(plan.sizeEstimateBytes)}</Fact>
        <Fact label="Binaries"><span className="font-mono text-xs">{plan.binaries?.length ? plan.binaries.join(', ') : 'None'}</span></Fact>
        <Fact label="Lifecycle scripts">{plan.lifecycleScripts ? 'Allowed' : 'Not run'}</Fact>
        <Fact label="Affected">{`${affected} ${affected === 1 ? 'workspace' : 'workspaces'}`}</Fact>
        <Fact label="Runtime">{runtimeText(plan.runtime)}</Fact>
        <Fact label="Created">{formatTime(plan.createdAt, NOT_REPORTED)}</Fact>
        <Fact label="Expires">{formatTime(plan.expiresAt, NOT_REPORTED)}</Fact>
        {plan.decidedBy ? <Fact label="Decided by">{plan.decidedBy === 'policy' ? 'Policy (approval not required)' : 'Dashboard'}</Fact> : null}
      </dl>
      {planIsActionable(plan) ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" aria-haspopup="dialog" aria-label={`Approve ${ref}`} onClick={() => onDecide({ kind: 'plan', decision: 'approve', plan })}>Approve</Button>
          <Button size="sm" variant="outline" className="text-destructive" aria-haspopup="dialog" aria-label={`Reject ${ref}`} onClick={() => onDecide({ kind: 'plan', decision: 'reject', plan })}>Reject</Button>
        </div>
      ) : planCanWithdraw(plan) ? (
        <div><Button size="sm" variant="outline" className="text-destructive" aria-haspopup="dialog" onClick={() => onDecide({ kind: 'plan', decision: 'reject', plan })}>Withdraw approval</Button></div>
      ) : null}
    </Card>
  );
}

function PackagePlansSection({ plans, onDecide }: { plans: PackagePlans | undefined; onDecide: (decision: Decision) => void }) {
  if (!plans) return null;
  if (!plans.enabled) {
    return <Section title="Package plans" testId="package-plans"><Callout title="Managed packages are off.">Operators enable them with PACKAGES_ENABLED=true.</Callout></Section>;
  }
  const note = plans.approvalMode === 'not_required'
    ? <Callout title="Approval not required.">PACKAGES_APPROVAL_MODE=none, so plans are approved by policy and listed here for the record.</Callout>
    : plans.approvalMode === 'unavailable'
      ? <Callout tone="warning" title="Approval unavailable.">This runner cannot record Dashboard approvals, so applies are refused until PACKAGES_APPROVAL_MODE=none.</Callout>
      : <Callout title="Package plans.">Approving lets an agent apply exactly the plan whose digest is shown. A changed plan is refused. Both decisions are audited.</Callout>;
  return (
    <Section title="Package plans" testId="package-plans">
      {note}
      {plans.plans.length === 0
        ? <EmptyState icon={PackageIcon} title="No package plans are waiting." description="An agent creates a plan with packages_plan. It appears here until it is decided, applied, or expires." />
        : <ul className="grid gap-3">{plans.plans.map((plan) => <PlanCard key={plan.planId} plan={plan} onDecide={onDecide} />)}</ul>}
    </Section>
  );
}

function confirmCopy(decision: Decision) {
  if (decision.kind === 'grant') {
    return decision.decision === 'approve'
      ? { title: 'Approve this privilege request?', description: 'The command may then run in that workspace under your identity. The decision is audited.', confirmLabel: 'Approve', pendingLabel: 'Approving…', destructive: false, target: decision.grant.command, success: 'Privilege request approved.', failure: 'The privilege request could not be approved' }
      : { title: 'Reject this privilege request?', description: 'The request is discarded and the command stays blocked. The decision is audited.', confirmLabel: 'Reject', pendingLabel: 'Rejecting…', destructive: true, target: decision.grant.command, success: 'Privilege request rejected.', failure: 'The privilege request could not be rejected' };
  }
  const ref = `${decision.plan.name}@${decision.plan.version}`;
  return decision.decision === 'approve'
    ? { title: `Approve the plan for ${ref}?`, description: 'An agent may then apply exactly this plan. The runner refuses the approval if the plan digest no longer matches. The decision is audited.', confirmLabel: 'Approve plan', pendingLabel: 'Approving…', destructive: false, target: `Plan digest ${decision.plan.planDigest}`, success: `Plan for ${ref} approved.`, failure: `The plan for ${ref} could not be approved` }
    : { title: `Reject the plan for ${ref}?`, description: 'The plan can no longer be applied; an agent must create a new plan. The decision is audited.', confirmLabel: 'Reject plan', pendingLabel: 'Rejecting…', destructive: true, target: `Plan digest ${decision.plan.planDigest}`, success: `Plan for ${ref} rejected.`, failure: `The plan for ${ref} could not be rejected` };
}

export function ApprovalsPage() {
  const queryClient = useQueryClient();
  const grants = usePageData<{ grants: PrivilegeGrant[] }>('approvals');
  // A package-plan read failure must not hide the grants, matching the classic page.
  const plans = useQuery({
    queryKey: ['bff', '/package-plans', {}],
    queryFn: async () => ((await apiClient.request('/package-plans')) as { data: PackagePlans }).data,
    retry: false
  });
  const [pending, setPending] = useState<Decision | undefined>();
  const copy = pending ? confirmCopy(pending) : undefined;
  const refresh = () => Promise.all(APPROVAL_READS.map((path) => queryClient.invalidateQueries({ queryKey: bffPrefix(path) })));
  return (
    <div className="grid gap-(--stack-gap)" data-testid="approvals-page">
      <Callout title="Privilege grants.">Approving lets one command run in a workspace under your identity. Both decisions are audited.</Callout>
      <AsyncStatus query={grants} label="approvals">
        {({ grants: list }) => (
          <Section title="Privilege requests" testId="privilege-requests">
            {list.length === 0
              ? <EmptyState icon={ShieldCheckIcon} title="No approvals are waiting." description="Privilege requests appear here while they are pending. Decided and expired requests stay listed briefly, without actions." />
              : <ul className="grid gap-3">{list.map((grant) => <GrantCard key={grant.id} grant={grant} onDecide={setPending} />)}</ul>}
          </Section>
        )}
      </AsyncStatus>
      <PackagePlansSection plans={plans.data} onDecide={setPending} />
      <ConfirmDialog
        open={pending !== undefined}
        onOpenChange={(open) => { if (!open) setPending(undefined); }}
        title={copy?.title ?? ''}
        description={copy?.description ?? ''}
        target={copy?.target ?? ''}
        confirmLabel={copy?.confirmLabel ?? ''}
        pendingLabel={copy?.pendingLabel ?? 'Working…'}
        destructive={copy?.destructive ?? true}
        onConfirm={async () => {
          if (!pending || !copy) return;
          if (pending.kind === 'grant') await approvalsApi.decideGrant(pending.grant, pending.decision);
          else if (pending.decision === 'approve') await approvalsApi.approvePlan(pending.plan);
          else await approvalsApi.rejectPlan(pending.plan);
          toast({ title: copy.success, variant: 'success' });
          await refresh();
        }}
        onError={(error) => {
          if (copy) reportActionError(copy.failure, error);
          void refresh();
        }}
      />
    </div>
  );
}
