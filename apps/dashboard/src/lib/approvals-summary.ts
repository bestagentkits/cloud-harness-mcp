import { type QueryClient, useQuery } from '@tanstack/react-query';
import { bffQuery } from './bff-query';
import { pageReadQuery } from './page-read';

/**
 * Pending approvals, as the legacy badge counts them (`pendingApprovals` in
 * `apps/api/dashboard/dashboard.js`): only an unexpired PENDING grant or PENDING_APPROVAL
 * package plan can still be decided.
 */
export type PrivilegeGrant = { id?: string; status?: string; expiresAt?: string };
export type PackagePlan = { planId?: string; status?: string; expiresAt?: string };

function unexpired(expiresAt: unknown, now: number): boolean {
  const at = Date.parse(String(expiresAt ?? ''));
  return Number.isNaN(at) || at > now;
}

export function grantIsActionable(grant: PrivilegeGrant | undefined, now = Date.now()): boolean {
  return String(grant?.status ?? '').toUpperCase() === 'PENDING' && unexpired(grant?.expiresAt, now);
}

export function planIsActionable(plan: PackagePlan | undefined, now = Date.now()): boolean {
  return String(plan?.status ?? '') === 'PENDING_APPROVAL' && unexpired(plan?.expiresAt, now);
}

function listOf<T>(body: unknown, key: string): T[] {
  const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
  const list = data && typeof data === 'object' ? (data as Record<string, unknown>)[key] : undefined;
  return Array.isArray(list) ? list.filter((item): item is T => Boolean(item) && typeof item === 'object') : [];
}

export function pendingGrantCount(body: unknown, now = Date.now()): number {
  return listOf<PrivilegeGrant>(body, 'grants').filter((grant) => grantIsActionable(grant, now)).length;
}

export function pendingPlanCount(body: unknown, now = Date.now()): number {
  return listOf<PackagePlan>(body, 'plans').filter((plan) => planIsActionable(plan, now)).length;
}

/** The two reads behind every approvals count: the same keys the Approvals page reads, so its decisions refresh them. */
export function approvalsQueries() {
  return { grants: pageReadQuery('approvals', {}), plans: bffQuery<unknown>('/package-plans') } as const;
}

/**
 * Call after any approval decision (P4a's Approvals page, or anything else that changes a
 * grant or plan): refetches the summary on Activity and the sidebar badge, and the Approvals
 * registry read, all of which share these keys.
 */
export function invalidateApprovals(queryClient: QueryClient): Promise<void> {
  const { grants, plans } = approvalsQueries();
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: grants.queryKey }),
    queryClient.invalidateQueries({ queryKey: plans.queryKey })
  ]).then(() => undefined);
}

export type ApprovalsSummary = {
  loading: boolean;
  fetching: boolean;
  grantCount: number | undefined;
  planCount: number | undefined;
  /** Pending grants plus plans that could be read; a lower bound when `partial`. */
  total: number;
  /** At least one of the two reads failed, so "nothing is waiting" cannot be claimed. */
  partial: boolean;
  /** Either read has answered (data or an error); false while nothing has been asked yet. */
  settled: boolean;
};

/**
 * The pending-approvals count, the React form of the legacy `refreshApprovalsBadge`. With
 * `enabled` false it only observes the cache (no request), which is how the sidebar keeps
 * the last count on pages that the legacy badge did not refresh on.
 */
export function useApprovalsSummary({ enabled = true }: { enabled?: boolean } = {}): ApprovalsSummary {
  const { grants: grantsQuery, plans: plansQuery } = approvalsQueries();
  const grants = useQuery({ ...grantsQuery, enabled: enabled && grantsQuery.enabled !== false, refetchOnWindowFocus: true });
  const plans = useQuery({ ...plansQuery, enabled, refetchOnWindowFocus: true });
  const grantCount = grants.data === undefined ? undefined : pendingGrantCount(grants.data);
  const planCount = plans.data === undefined ? undefined : pendingPlanCount(plans.data);
  return {
    loading: enabled && (grants.isPending || plans.isPending),
    fetching: grants.isFetching || plans.isFetching,
    grantCount,
    planCount,
    total: (grantCount ?? 0) + (planCount ?? 0),
    partial: grants.isError || plans.isError || grantCount === undefined || planCount === undefined,
    settled: grants.data !== undefined || plans.data !== undefined || grants.isError || plans.isError
  };
}
