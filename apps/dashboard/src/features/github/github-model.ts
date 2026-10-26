import { apiClient } from '@/lib/api-client';
import { ClientValidationError } from '@/lib/bff-mutation';

export type GitHubInstallation = {
  appId?: string | number | null;
  installationId: string | number;
  accountId?: string | number | null;
  accountLogin?: string | null;
  status?: string | null;
  checkedAt?: string | number | null;
};
export type GitHubRepository = { installationId?: string | number | null; owner: string; repository: string; contents?: string | null; status?: string | null };
export type GitHubStatus = { configured: boolean; installation: GitHubInstallation | null; installations?: GitHubInstallation[]; repositories?: GitHubRepository[] };

export { GITHUB_INSTALLATION_PATTERN, GITHUB_STATE_PATTERN, githubCallbackSearch } from './github-callback-search';

export function installationsOf(status: GitHubStatus): GitHubInstallation[] {
  if (Array.isArray(status.installations) && status.installations.length) return status.installations;
  return status.installation ? [status.installation] : [];
}

export function accountOf(installation: GitHubInstallation): string {
  return String(installation.accountLogin ?? installation.accountId ?? 'Installation');
}

/** GitHub's install page is followed only over HTTPS. */
export function safeSetupUrl(value: unknown): string {
  try {
    const url = new URL(String(value));
    if (url.protocol === 'https:') return url.toString();
  } catch { /* fall through */ }
  throw new ClientValidationError('GitHub setup URL was invalid.');
}

const unwrap = <T>(body: unknown) => (body as { data: T }).data;

/** Bodies match the classic Dashboard exactly. */
export const githubApi = {
  setup: async (expectedAccountId: string) => {
    const trimmed = expectedAccountId.trim();
    const data = unwrap<{ url?: string }>(await apiClient.request('/github/setup', { method: 'POST', body: trimmed ? { expectedAccountId: trimmed } : {} }));
    return safeSetupUrl(data.url);
  },
  complete: (state: string, installationId: string) => apiClient.request('/github/complete', { method: 'POST', body: { state, installationId } }),
  reconcile: (installationId?: string) => apiClient.request('/github/reconcile', { method: 'POST', body: installationId ? { installationId } : {} }),
  disconnect: (installationId: string) => apiClient.request('/github/disconnect', { method: 'POST', body: { installationId } })
};

export const GITHUB_READS = ['/github'] as const;
