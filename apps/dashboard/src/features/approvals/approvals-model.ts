import { apiClient } from '@/lib/api-client';

export type GrantStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CONSUMED' | 'EXPIRED';
export type PrivilegeGrant = {
  id: string;
  workspaceId: string;
  command: string;
  cwd?: string | null;
  commandSha256?: string | null;
  status: GrantStatus | string;
  createdAt?: string | number | null;
  expiresAt?: string | number | null;
  consumedAt?: string | number | null;
};

export type PlanStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CONSUMED';
export type PackagePlan = {
  planId: string;
  planDigest: string;
  status: PlanStatus | string;
  scope?: string | null;
  workspaceId?: string | null;
  ecosystem?: string | null;
  name: string;
  version: string;
  requestedSpec?: string | null;
  integrity?: string | null;
  sizeEstimateBytes?: number | null;
  lifecycleScripts?: boolean | null;
  binaries?: string[] | null;
  conflicts?: Array<{ binary?: string; name?: string; scope?: string }> | null;
  stale?: boolean;
  dependencyCount?: number | null;
  affectedWorkspaces?: string[] | null;
  source?: { resolved?: string | null; registry?: string | null } | null;
  runtime?: Partial<Record<'node' | 'npm' | 'python' | 'uv', string | null>> | null;
  currentRelease?: { version?: string | null } | null;
  decidedBy?: string | null;
  createdAt?: string | number | null;
  expiresAt?: string | number | null;
};
export type PackagePlans = { enabled: boolean; approvalMode?: string | null; plans: PackagePlan[] };

export const GRANT_STATUS_LABELS: Record<string, string> = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', CONSUMED: 'Used', EXPIRED: 'Expired' };
export const PLAN_STATUS_LABELS: Record<string, string> = { PENDING_APPROVAL: 'Pending', APPROVED: 'Approved, awaiting apply', REJECTED: 'Rejected', EXPIRED: 'Expired', CONSUMED: 'Applied' };
export const ECOSYSTEM_LABELS: Record<string, string> = { npm: 'npm', uv: 'Python (uv)' };

function expired(expiresAt: string | number | null | undefined, now: number): boolean {
  if (expiresAt === null || expiresAt === undefined || expiresAt === '') return false;
  const time = new Date(expiresAt).getTime();
  return Number.isFinite(time) && time <= now;
}

export function grantIsActionable(grant: PrivilegeGrant, now = Date.now()): boolean {
  return grant.status === 'PENDING' && !expired(grant.expiresAt, now);
}

/** A pending grant past its expiry reads "Expired", like the classic Dashboard. */
export function grantStatusLabel(grant: PrivilegeGrant, now = Date.now()): string {
  if (grant.status === 'PENDING' && expired(grant.expiresAt, now)) return 'Expired';
  return GRANT_STATUS_LABELS[grant.status] ?? grant.status;
}

/** Only an unexpired plan still waiting for a decision offers Approve and counts toward the badge. */
export function planIsActionable(plan: PackagePlan, now = Date.now()): boolean {
  return plan.status === 'PENDING_APPROVAL' && !expired(plan.expiresAt, now);
}

export function planCanWithdraw(plan: PackagePlan, now = Date.now()): boolean {
  return plan.status === 'APPROVED' && !expired(plan.expiresAt, now);
}

/** An open plan past its expiry reads "Expired", like the classic Dashboard. */
export function planStatusLabel(plan: PackagePlan, now = Date.now()): string {
  const open = plan.status === 'PENDING_APPROVAL' || plan.status === 'APPROVED';
  if (open && !planIsActionable(plan, now) && !planCanWithdraw(plan, now)) return 'Expired';
  return PLAN_STATUS_LABELS[plan.status] ?? 'Unknown';
}

/** The leading and trailing characters identify a digest at a glance; the full value stays one focus away. */
export function shortDigest(digest: string): string {
  return digest.length > 20 ? `${digest.slice(0, 12)}…${digest.slice(-6)}` : digest;
}

/** Binary units, because quotas are configured in powers of two. */
export function formatPackageBytes(value: unknown): string {
  const bytes = Number(value);
  if (value === null || value === undefined || !Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${unit === 0 ? amount : amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function runtimeText(runtime: PackagePlan['runtime']): string {
  if (!runtime || typeof runtime !== 'object') return 'Not reported';
  const parts = ([['Node', runtime.node], ['npm', runtime.npm], ['Python', runtime.python], ['uv', runtime.uv]] as const)
    .filter(([, version]) => typeof version === 'string' && version)
    .map(([name, version]) => `${name} ${version}`);
  return parts.length ? parts.join(' · ') : 'Not reported';
}

export function planRisks(plan: PackagePlan): string[] {
  const risks: string[] = [];
  if (plan.lifecycleScripts) risks.push('Runs npm lifecycle scripts while building. Install scripts execute package code in the builder.');
  const conflicts = Array.isArray(plan.conflicts) ? plan.conflicts : [];
  if (conflicts.length) {
    risks.push(`Binary name collisions: ${conflicts.map((conflict) => `${conflict.binary} (already provided by ${conflict.name}${conflict.scope === 'workspace' ? ' in a workspace' : ''})`).join(', ')}. The apply is refused until they are resolved.`);
  }
  if (plan.stale) risks.push('The package changed after this plan was made. Approval will be refused; create a new plan.');
  return risks;
}

/** The approvals count the nav badge shows: actionable grants plus actionable plans. */
export function pendingApprovals(grants: readonly PrivilegeGrant[], plans: readonly PackagePlan[], now = Date.now()): number {
  return grants.filter((grant) => grantIsActionable(grant, now)).length + plans.filter((plan) => planIsActionable(plan, now)).length;
}

/** Bodies match the classic Dashboard: `{}` for grant decisions and plan rejection, `{ planDigest }` to approve a plan. */
export const approvalsApi = {
  decideGrant: (grant: PrivilegeGrant, decision: 'approve' | 'reject') =>
    apiClient.request(`/privilege-grants/${encodeURIComponent(grant.id)}/${decision}`, { method: 'POST', body: {} }),
  approvePlan: (plan: PackagePlan) =>
    apiClient.request(`/package-plans/${encodeURIComponent(plan.planId)}/approve`, { method: 'POST', body: { planDigest: plan.planDigest } }),
  rejectPlan: (plan: PackagePlan) =>
    apiClient.request(`/package-plans/${encodeURIComponent(plan.planId)}/reject`, { method: 'POST', body: {} })
};

export const APPROVAL_READS = ['/privilege-grants', '/package-plans'] as const;
