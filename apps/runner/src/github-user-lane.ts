import {
  GITHUB_USER_AUTHORIZATION_DASHBOARD_PATH,
  HarnessError,
  type GitHubUserAuthorizationReasonCode
} from '@cloud-harness/contracts';

/**
 * Refusals and classifications of the GitHub user token lane. Once that lane is selected for an
 * operation its outcome is final, so these only describe what happened; none of them selects
 * another credential.
 */

const REASON_PHRASES: Record<GitHubUserAuthorizationReasonCode, string> = {
  bad_refresh_token: 'GitHub no longer accepts the saved authorization (it was revoked on GitHub, or has expired)',
  refresh_token_expired: 'the saved authorization expired'
};

/**
 * The refusal for a revoked authorization. It is never retryable, it is never resolved by another
 * credential, and it names where the person fixes it.
 */
export function githubUserAuthorizationRequired(reasonCode: GitHubUserAuthorizationReasonCode | null): HarnessError {
  const phrase = reasonCode ? REASON_PHRASES[reasonCode] : 'the saved authorization was revoked';
  return new HarnessError(
    'GITHUB_USER_AUTHORIZATION_REQUIRED',
    `GitHub user authorization is required: ${phrase}. Reconnect it in ${GITHUB_USER_AUTHORIZATION_DASHBOARD_PATH}.`,
    403,
    false,
    { resumeAction: 'dashboard:integrations/github' }
  );
}

/**
 * GitHub rejected the credential itself (HTTP 401): the token expired, a refresh rotated it, or the
 * authorization was revoked. Git prints "Authentication failed" and `gh` prints "HTTP 401" or
 * "Bad credentials". A missing token ("could not read Username") and a refusal of an authenticated
 * request (403, 404) are not rejections.
 */
export function isGitHubCredentialRejection(text: string): boolean {
  return /Authentication failed|Invalid username or password|HTTP 401|Bad credentials|token (is )?expired/i.test(text);
}

/**
 * GitHub refused an authenticated request because the organization enforces SAML single sign-on and
 * the user token has no SSO session for it. That is a state of one organization, so it never revokes
 * the authorization.
 */
export function isGitHubSamlRefusal(text: string): boolean {
  return /SAML enforcement|SAML SSO|SAML single sign-on/i.test(text);
}

/** The per-request error for a SAML refusal, with GitHub's documented fix. */
export function githubSamlRefusal(owner: string): HarnessError {
  const login = encodeURIComponent(owner);
  return new HarnessError(
    'GITHUB_PERMISSION_MISSING',
    `GitHub refused this request because ${owner} enforces SAML single sign-on and your connected GitHub user has no SSO session for it. ` +
      `Open https://github.com/orgs/${login}/sso to start an SSO session, then reconnect in ${GITHUB_USER_AUTHORIZATION_DASHBOARD_PATH}; ` +
      'if GitHub still refuses, revoke this GitHub App under https://github.com/settings/applications first and connect again. The authorization itself was not revoked.',
    403,
    false
  );
}

/** A connected user whose owner of the repository has no GitHub App installation the user can reach. */
export function githubUserOwnerNotReachable(
  owner: string,
  details?: { operation?: string | undefined; repository?: string | undefined; requiredCapability?: string | undefined }
): HarnessError {
  return new HarnessError(
    'REPOSITORY_OPERATION_NOT_AUTHORIZED',
    `No GitHub credential applies to ${owner}: your connected GitHub user cannot reach a GitHub App installation on ${owner}. ` +
      `Ask an owner of ${owner} to install the GitHub App, then retry. The repository's access is never widened to another credential.`,
    403,
    false,
    details
  );
}

/**
 * A permission refusal for an action the user token ran. The shared classifier's remedy points at
 * the App's permissions and an operator `GH_TOKEN`, which is the escape hatch this lane closes, so a
 * user token gets its own remedy. The remedy survives truncation of a long helper message.
 */
export function githubUserPermissionRefusal(action: string, helperOutput: string): string {
  const remedy = 'a user token reaches only what both the GitHub App installation and your own GitHub access allow. Ask an owner of the repository to grant the access, or approve the GitHub App\'s pending permission change. No other credential is used.';
  const detail = `GitHub ${action} was refused for your connected GitHub user: ${helperOutput}`.trim();
  return `${detail.slice(0, 2_000 - remedy.length - 3)} — ${remedy}`;
}

/** A connected authorization this runner cannot use: it needs the GitHub App client credentials and the secret keyring. */
export function githubUserAuthorizationUnavailable(): HarnessError {
  return new HarnessError(
    'UNAVAILABLE',
    'Your GitHub user is connected, but this runner cannot use the connection: it needs GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET and SECRET_KEYRING. No other credential is used until they are restored or the connection is disconnected.',
    503,
    false
  );
}

/**
 * Replaces every credential an operation used, a user token before and after a refresh included, in
 * text a helper produced. Helper output is cleaned here, before it can reach an error, a result, a
 * diagnosis, or persisted operation state, so no later step has to remember to do it.
 */
export function redactCredentials(text: string, credentials: readonly (string | undefined)[]): string {
  let redacted = text;
  for (const credential of credentials) {
    // A short value would blank out ordinary words; no real token is this short.
    if (credential === undefined || credential.length < 8) continue;
    redacted = redacted.split(credential).join('[REDACTED]');
    const encoded = encodeURIComponent(credential);
    if (encoded !== credential) redacted = redacted.split(encoded).join('[REDACTED]');
  }
  return redacted;
}
