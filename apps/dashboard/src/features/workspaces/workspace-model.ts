/**
 * The workspace projection the BFF returns (`cleanWorkspace` in
 * `apps/api/src/dashboard-response.ts`) and its display helpers, shared by the list, the
 * cockpit and the Overview.
 */
export type Workspace = {
  workspaceId: string;
  repositoryUrl?: string;
  ref?: string;
  status?: string;
  networkProfile?: string;
  createdAt?: string;
  lastActivityAt?: string;
  expiresAt?: string;
  version?: number;
  canRenewLease?: boolean;
  leaseCapped?: boolean;
  leaseState?: string;
  availableActions?: string[];
  error?: string;
};

export const WORKSPACE_STATUSES = ['CREATING', 'ACTIVE', 'EXPIRED_RECOVERABLE', 'NETWORK_QUARANTINED', 'REAPING', 'CLOSED', 'FAILED'] as const;

const STATUS_LABELS: Record<string, string> = {
  CREATING: 'Creating', ACTIVE: 'Active', REAPING: 'Closing', CLOSED: 'Closed', FAILED: 'Failed',
  NETWORK_QUARANTINED: 'Quarantined', EXPIRED_RECOVERABLE: 'Expired (recoverable)'
};

export function workspaceStatusLabel(status: unknown): string {
  return STATUS_LABELS[String(status)] ?? 'Unknown';
}

export function networkLabel(profile: unknown): string {
  return profile === 'dependency-access' ? 'Dependency access' : profile === 'local-host' ? 'Local host' : 'No network';
}

/** `owner/repo` from a credential-free HTTPS repository URL. */
export function repositoryName(url: unknown): string {
  try {
    return new URL(String(url)).pathname.replace(/^\//, '').replace(/\.git$/, '') || 'Repository';
  } catch {
    return 'Repository';
  }
}

/**
 * Whether the runner offers `action` for this workspace. The runner's `availableActions` is
 * authoritative; the status fallback covers an API/runner rolling upgrade, as the legacy
 * `workspaceHasAction` does. A visible control never grants the action: the BFF re-checks.
 */
export function workspaceHasAction(workspace: Workspace | undefined, action: string): boolean {
  if (!workspace) return false;
  if (Array.isArray(workspace.availableActions)) return workspace.availableActions.includes(action);
  const status = workspace.status;
  if (action === 'workspace_context') return status === 'ACTIVE' || status === 'NETWORK_QUARANTINED';
  if (action === 'workspace_lease_renew') return status === 'ACTIVE' || status === 'EXPIRED_RECOVERABLE';
  return false;
}

/** Workspaces matching the list filters: free text over repository and id, status, and an expiry budget in minutes. */
export function filterWorkspaces(workspaces: readonly Workspace[], filters: { q?: string | undefined; status?: string | undefined; expiring?: number | undefined }, now = Date.now()): Workspace[] {
  const term = filters.q?.toLowerCase() ?? '';
  return workspaces.filter((workspace) => {
    if (filters.status && workspace.status !== filters.status) return false;
    if (term && !`${workspace.repositoryUrl ?? ''} ${workspace.workspaceId}`.toLowerCase().includes(term)) return false;
    if (filters.expiring && filters.expiring > 0) {
      const expiresAt = Date.parse(workspace.expiresAt ?? '');
      if (!Number.isFinite(expiresAt) || expiresAt - now > filters.expiring * 60_000) return false;
    }
    return true;
  });
}
