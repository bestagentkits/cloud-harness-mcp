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

export type GitHubUserAuthorizationReason = 'bad_refresh_token' | 'refresh_token_expired';
/** The person's own GitHub user authorization. `refreshExpiresAt` is epoch ms and set only when connected; `reasonCode` only when revoked. */
export type GitHubUserAuthorization = {
  status: 'connected' | 'revoked' | 'disconnected';
  login: string;
  githubUserId: string;
  refreshExpiresAt: number | null;
  reasonCode: GitHubUserAuthorizationReason | null;
};

export type GitHubStatus = {
  configured: boolean;
  /** False when the runner lacks the GitHub App client credentials, so no installation can be verified and bound and no user authorization can be made. */
  userAuthorizationConfigured?: boolean;
  installation: GitHubInstallation | null;
  installations?: GitHubInstallation[];
  repositories?: GitHubRepository[];
  /** `null` (never connected) and `disconnected` both offer Connect. */
  userAuthorization?: GitHubUserAuthorization | null;
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

/** GitHub's pages are followed only over HTTPS on github.com itself, with no embedded credentials or port. */
export function safeGitHubUrl(value: unknown, message = 'GitHub setup URL was invalid.'): string {
  try {
    const url = new URL(String(value));
    if (url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port) return url.toString();
  } catch { /* fall through */ }
  throw new ClientValidationError(message);
}

/** The revoked card's reason, by the runner's reason code. */
export function userAuthorizationReasonText(reasonCode: GitHubUserAuthorizationReason | null): string {
  if (reasonCode === 'refresh_token_expired') return 'GitHub user authorization expired because it was not renewed in time.';
  if (reasonCode === 'bad_refresh_token') return 'GitHub rejected the stored authorization, so it was revoked.';
  return 'GitHub user authorization is no longer valid.';
}

/** The state the card shows: connected with a login, revoked, or the Connect prompt for `null` and `disconnected`. */
export function userAuthorizationState(status: GitHubStatus): 'connected' | 'revoked' | 'none' {
  const state = status.userAuthorization?.status;
  return state === 'connected' || state === 'revoked' ? state : 'none';
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
    return safeGitHubUrl(data.url);
  },
  /** The setup `state` is sent only when GitHub returned one; the BFF binds the flow to this browser. */
  authorize: async (installationId: string, state?: string) => {
    const data = unwrap<{ url?: string }>(await apiClient.request('/github/authorize', { method: 'POST', body: state ? { installationId, state } : { installationId } }));
    return safeGitHubUrl(data.url, 'GitHub authorization URL was invalid.');
  },
  /** Starts the person's own user authorization. The body is exactly `{ purpose: 'user' }`; the runner decides the purpose of the return from the stored state. */
  authorizeUser: async () => {
    const data = unwrap<{ url?: string }>(await apiClient.request('/github/authorize', { method: 'POST', body: { purpose: 'user' } }));
    return safeGitHubUrl(data.url, 'GitHub authorization URL was invalid.');
  },
  complete: (state: string, code: string) => apiClient.request('/github/complete', { method: 'POST', body: { state, code } }),
  reconcile: (installationId?: string) => apiClient.request('/github/reconcile', { method: 'POST', body: installationId ? { installationId } : {} }),
  disconnect: (installationId: string) => apiClient.request('/github/disconnect', { method: 'POST', body: { installationId } }),
  disconnectUser: () => apiClient.request('/github/user/disconnect', { method: 'POST', body: {} })
};

export const GITHUB_READS = ['/github'] as const;
