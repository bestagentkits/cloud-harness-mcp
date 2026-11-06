import { apiClient } from '@/lib/api-client';
import { ApiError, UnauthorizedError } from '@/lib/api-client';
import { ClientValidationError, mutationErrorText } from '@/lib/bff-mutation';

export type GitHubInstallation = {
  appId?: string | number | null;
  installationId: string | number;
  accountId?: string | number | null;
  accountLogin?: string | null;
  status?: string | null;
  checkedAt?: string | number | null;
};
export type GitHubRepository = { installationId?: string | number | null; owner: string; repository: string; contents?: string | null; status?: string | null };
export type GitHubStatus = {
  configured: boolean;
  /** False when the runner lacks the GitHub App client credentials, so no installation can be verified and bound. */
  userAuthorizationConfigured?: boolean;
  installation: GitHubInstallation | null;
  installations?: GitHubInstallation[];
  repositories?: GitHubRepository[];
};

export { classifyGitHubCallback, GITHUB_CODE_PATTERN, GITHUB_INSTALLATION_PATTERN, GITHUB_STATE_PATTERN, type GitHubCallback } from './github-callback-search';

/** The status says so explicitly; an absent field (an older BFF) is treated as configured. */
export const userAuthorizationUnavailable = (status: GitHubStatus): boolean => status.userAuthorizationConfigured === false;

export function installationsOf(status: GitHubStatus): GitHubInstallation[] {
  if (Array.isArray(status.installations) && status.installations.length) return status.installations;
  return status.installation ? [status.installation] : [];
}

export function accountOf(installation: GitHubInstallation): string {
  return String(installation.accountLogin ?? installation.accountId ?? 'Installation');
}

/** GitHub's install page is followed only over HTTPS. */
export function safeSetupUrl(value: unknown, message = 'GitHub setup URL was invalid.'): string {
  try {
    const url = new URL(String(value));
    if (url.protocol === 'https:') return url.toString();
  } catch { /* fall through */ }
  throw new ClientValidationError(message);
}

/**
 * The text for a failed callback step. The BFF composes these messages for the operator
 * (a 403 for a flow started in another browser, a 409 for an installation bound to another
 * identity) and `mutationErrorText` would replace both with generic copy, so every API
 * answer except a session end shows its own message.
 */
export function githubCallbackErrorText(error: unknown): string {
  return error instanceof ApiError && !(error instanceof UnauthorizedError) && error.message ? error.message : mutationErrorText(error);
}

const unwrap = <T>(body: unknown) => (body as { data: T }).data;

/** Bodies match the classic Dashboard exactly. */
export const githubApi = {
  setup: async (expectedAccountId: string) => {
    const trimmed = expectedAccountId.trim();
    const data = unwrap<{ url?: string }>(await apiClient.request('/github/setup', { method: 'POST', body: trimmed ? { expectedAccountId: trimmed } : {} }));
    return safeSetupUrl(data.url);
  },
  /** The setup `state` is sent only when GitHub returned one; the BFF binds the flow to this browser. */
  authorize: async (installationId: string, state?: string) => {
    const data = unwrap<{ url?: string }>(await apiClient.request('/github/authorize', { method: 'POST', body: state ? { installationId, state } : { installationId } }));
    return safeSetupUrl(data.url, 'GitHub authorization URL was invalid.');
  },
  complete: (state: string, code: string) => apiClient.request('/github/complete', { method: 'POST', body: { state, code } }),
  reconcile: (installationId?: string) => apiClient.request('/github/reconcile', { method: 'POST', body: installationId ? { installationId } : {} }),
  disconnect: (installationId: string) => apiClient.request('/github/disconnect', { method: 'POST', body: { installationId } })
};

export const GITHUB_READS = ['/github'] as const;
