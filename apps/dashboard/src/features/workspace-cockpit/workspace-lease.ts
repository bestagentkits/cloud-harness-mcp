import type { Workspace } from '@/features/workspaces/workspace-model';

export type LeaseState = { state: 'unknown' | 'expired' | 'soon' | 'ok'; label: string };

/** Lease posture from the workspace record. Thresholds drive emphasis, never colour alone. */
export function workspaceLeaseState(workspace: Workspace | undefined, now = Date.now()): LeaseState {
  const expiresAt = Date.parse(workspace?.expiresAt ?? '');
  if (!Number.isFinite(expiresAt)) return { state: 'unknown', label: 'Lease unknown' };
  const remainingMs = expiresAt - now;
  if (remainingMs <= 0) return { state: 'expired', label: 'Lease expired' };
  const minutes = Math.round(remainingMs / 60_000);
  if (remainingMs <= 10 * 60_000) return { state: 'soon', label: `${minutes} min left` };
  return { state: 'ok', label: `${Math.round(minutes / 60)} h left` };
}

export type AttentionItem = { id: string; label: string; detail: string };

/**
 * Only reasons the Dashboard can observe. An invented reason is worse than a missing one,
 * so agent, task and Git reasons join when the tabs that expose them land.
 */
export function workspaceAttention(workspace: Workspace | undefined, now = Date.now()): AttentionItem[] {
  const reasons: AttentionItem[] = [];
  const lease = workspaceLeaseState(workspace, now);
  if (lease.state === 'expired') reasons.push({ id: 'lease-expired', label: 'Lease expired', detail: 'Renew the lease to keep working, or recover the workspace if it was reaped.' });
  else if (lease.state === 'soon') reasons.push({ id: 'lease-soon', label: 'Lease expires soon', detail: lease.label });
  if (workspace?.status === 'FAILED') reasons.push({ id: 'failed', label: 'Workspace setup failed', detail: 'The temporary checkout was cleaned up. Review the failure, fix the cause, then open a new workspace.' });
  if (workspace?.status === 'NETWORK_QUARANTINED') reasons.push({ id: 'quarantine', label: 'Network quarantined', detail: 'Egress was revoked for this workspace, so dependency access is denied.' });
  return reasons;
}

/** Why a live tab cannot run while the workspace is not ACTIVE, in the classic page's words. */
export function unavailableDetail(status: unknown): string {
  if (status === 'FAILED') return 'Setup failed before the workspace became active, and its temporary checkout has already been cleaned up. Review runner logs, fix the setup failure, then open a new workspace.';
  if (status === 'CLOSED') return 'This workspace is closed and its checkout is no longer available. Open a new workspace to continue.';
  if (status === 'EXPIRED_RECOVERABLE') return 'This workspace is in recoverable grace state. Recover it before using live runtime, filesystem, Git, automation, or deployment operations.';
  if (status === 'NETWORK_QUARANTINED') return 'This workspace is quarantined. Reconcile the network policy and recover it before using this live operation.';
  return 'This workspace is not active yet. Wait for its lifecycle state to settle before using this live operation.';
}
