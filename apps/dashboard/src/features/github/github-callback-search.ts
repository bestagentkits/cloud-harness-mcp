// Kept apart from the page model: the route file imports this module eagerly, and the
// page itself must stay in its lazily loaded route chunk. `classifyGitHubCallback` is the only
// validator of the callback query; the route declares no search params and the page reads the raw
// query string, so a malformed callback can still be reported instead of silently dropped.

/** The setup `state` is 32 random bytes in base64url; the runner accepts 32-128 characters. */
export const GITHUB_STATE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
export const GITHUB_INSTALLATION_PATTERN = /^[1-9][0-9]{0,19}$/;
/** The one-time OAuth `code` GitHub returns. */
export const GITHUB_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,256}$/;

const CALLBACK_KEYS = ['state', 'installation_id', 'setup_action', 'code', 'error', 'error_description', 'error_uri'] as const;

/** Whether a raw query string carries any GitHub callback param, valid or not. */
export function hasGitHubCallbackParams(search: string): boolean {
  const params = new URLSearchParams(search);
  return CALLBACK_KEYS.some((key) => params.has(key));
}

export type GitHubCallback =
  | { kind: 'none' }
  /** OAuth return with a well-formed `state` and `code`. */
  | { kind: 'complete'; state: string; code: string }
  | { kind: 'malformed' }
  /** OAuth refusal; the raw error value is never kept beyond this classification. */
  | { kind: 'refused'; reason: 'access_denied' | 'redirect_uri_mismatch' | 'other' }
  /** Fresh install: the setup callback carries both the installation and its setup state. */
  | { kind: 'authorize'; installationId: string; state: string }
  /** Already-installed App: GitHub's Configure flow drops `state`. */
  | { kind: 'verify'; installationId: string };

/**
 * Classifies the raw callback query by precedence: `code` (OAuth return), then `error`
 * (OAuth refusal), then `installation_id` with a valid `state` (fresh install), then
 * `installation_id` alone. Read from the raw string, since the validated search drops
 * invalid values (and a malformed callback must still be reported).
 */
export function classifyGitHubCallback(search: string): GitHubCallback {
  const params = new URLSearchParams(search);
  // The router re-serializes a digits-only string with JSON quotes (`"4242"`) to keep it a
  // string; no valid value contains a quote, so one wrapping pair is simply removed.
  const read = (key: string) => (params.get(key) ?? '').replace(/^"(.*)"$/, '$1');
  const state = read('state');
  const validState = GITHUB_STATE_PATTERN.test(state);
  if (params.has('code')) {
    const code = read('code');
    return validState && GITHUB_CODE_PATTERN.test(code) ? { kind: 'complete', state, code } : { kind: 'malformed' };
  }
  if (params.has('error')) {
    const error = params.get('error');
    return { kind: 'refused', reason: error === 'access_denied' || error === 'redirect_uri_mismatch' ? error : 'other' };
  }
  const installationId = read('installation_id');
  if (GITHUB_INSTALLATION_PATTERN.test(installationId)) return validState ? { kind: 'authorize', installationId, state } : { kind: 'verify', installationId };
  return { kind: 'none' };
}
