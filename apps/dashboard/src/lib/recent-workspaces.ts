import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';

/**
 * The last few workspaces the owner opened, for the command palette. Only workspace ids are
 * kept (non-secret UI restore, ADR 0005); repository URLs and anything else stay out of
 * storage. Unreadable or invalid entries are dropped.
 */
export const RECENT_WORKSPACES_KEY = 'ch-dashboard-recent-workspaces';
export const RECENT_WORKSPACES_MAX = 5;

function storage(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export function readRecentWorkspaces(store: Storage | undefined = storage()): string[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(RECENT_WORKSPACES_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && RESOURCE_ID_PATTERNS.workspaceId.test(id)).slice(0, RECENT_WORKSPACES_MAX);
  } catch {
    return [];
  }
}

/** Moves `workspaceId` to the front of the list. */
export function rememberWorkspace(workspaceId: string, store: Storage | undefined = storage()): void {
  if (!RESOURCE_ID_PATTERNS.workspaceId.test(workspaceId)) return;
  const next = [workspaceId, ...readRecentWorkspaces(store).filter((id) => id !== workspaceId)].slice(0, RECENT_WORKSPACES_MAX);
  try { store?.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
}
