import {
 GITHUB_CREDENTIAL_SECRET_NAMES,
 isMultiPrincipal,
 type GitHubUserAuthorizationStatus,
 type RunnerConfig,
} from "@cloud-harness/contracts";
import type { MetadataStore } from "./metadata-store.js";

/**
 * Ordered fallback credential names. `gh` prefers `GH_TOKEN` over
 * `GITHUB_TOKEN`, so both the environment and the secret store use that order.
 */
export const GITHUB_FALLBACK_SECRET_NAMES: readonly string[] =
 GITHUB_CREDENTIAL_SECRET_NAMES;

export function isGitHubFallbackSecretName(name: string): boolean {
 return GITHUB_FALLBACK_SECRET_NAMES.includes(name.toUpperCase());
}

/**
 * A credential is used only if it can be one: GitHub credentials are never
 * shorter than 20 characters and never contain whitespace. Anything else is
 * treated as absent so an unrelated environment variable or dashboard secret
 * cannot be sent to GitHub as a token.
 */
function usableToken(value: string | undefined): string | undefined {
 if (value === undefined) return undefined;
 return value.length >= 20 && !/[\s\0]/.test(value) ? value : undefined;
}

/**
 * Operator-wide credential from the runner process environment, assembled from
 * `GH_TOKEN` (preferred) then `GITHUB_TOKEN` at configuration load.
 *
 * Refused in multi-principal modes (`cloudflare-access`, `oidc`): a credential that authorizes every
 * repository the operator can reach must never stand in for a principal-scoped
 * GitHub App grant. That mode uses a principal's own global secret instead.
 */
export function envFallbackGitHubToken(
 config: RunnerConfig,
): string | undefined {
 if (isMultiPrincipal(config.authMode)) return undefined;
 return usableToken(config.githubToken);
}

/**
 * Principal-scoped credential supplied through the operator dashboard. The
 * value is decrypted on demand; an unavailable or undecryptable keyring must
 * never break capability reporting or workspace status, so failures read as
 * "no credential".
 */
export function globalFallbackGitHubToken(
 principalId: string,
 metadata: MetadataStore | undefined,
): string | undefined {
 if (!metadata) return undefined;
 for (const name of GITHUB_FALLBACK_SECRET_NAMES) {
  try {
   const token = usableToken(metadata.globalSecretValue(principalId, name));
   if (token) return token;
  } catch {
   return undefined;
  }
 }
 return undefined;
}

/**
 * Whether the legacy fallback lane may be used for a principal, decided by the stored status of its
 * GitHub user authorization and never by whether token material happens to be present.
 *
 * - No authorization, or `disconnected` (the person chose Disconnect): the lane is open.
 * - `connected`: the user token lane is selected and final, so the fallback is never a recovery path.
 * - `revoked`: GitHub refused the token and the answer is `GITHUB_USER_AUTHORIZATION_REQUIRED`. Only an
 *   explicit Disconnect leaves `revoked`, so the lane changes by the person's action alone and never
 *   as a side effect of GitHub refusing a token.
 */
export function legacyFallbackLaneOpen(
 userAuthorization: GitHubUserAuthorizationStatus | undefined,
): boolean {
 return userAuthorization === undefined || userAuthorization === "disconnected";
}

/**
 * The credential an environment or the principal's global secret would supply, whatever the lane. It
 * exists for output redaction, which must cover every credential-shaped value the runner could hold,
 * never to choose a credential: choosing goes through `resolveGitHubFallbackCredential`.
 */
export function resolveGitHubFallbackToken(input: {
 config: RunnerConfig;
 principalId: string;
 metadata?: MetadataStore | undefined;
}): string | undefined {
 return candidateFallbackCredential(input)?.token;
}

function candidateFallbackCredential(input: {
 config: RunnerConfig;
 principalId: string;
 metadata?: MetadataStore | undefined;
}): { token: string; source: "runner-environment" | "principal-global-secret" } | undefined {
 const environmentToken = envFallbackGitHubToken(input.config);
 if (environmentToken) return { token: environmentToken, source: "runner-environment" };
 const principalToken = globalFallbackGitHubToken(input.principalId, input.metadata);
 return principalToken ? { token: principalToken, source: "principal-global-secret" } : undefined;
}

/**
 * The fallback credential and the boundary it came from, for one principal: environment first, then
 * the principal's own global secret. The two sources are not interchangeable: the runner environment
 * credential is operator-wide and is refused in multi-principal modes, while a principal's global
 * runtime secret belongs to — and is injected into the workspaces of — that principal alone.
 * Callers that record or report which credential performed an action need the source, not just the
 * value.
 *
 * `userAuthorization` is the stored status of the principal's GitHub user authorization and is
 * required, so no caller can choose a credential without answering it: when the legacy lane is
 * closed (`legacyFallbackLaneOpen`) there is no fallback credential, even with a secret configured.
 */
export function resolveGitHubFallbackCredential(input: {
 config: RunnerConfig;
 principalId: string;
 metadata?: MetadataStore | undefined;
 userAuthorization: GitHubUserAuthorizationStatus | undefined;
}): { token: string; source: "runner-environment" | "principal-global-secret" } | undefined {
 if (!legacyFallbackLaneOpen(input.userAuthorization)) return undefined;
 return candidateFallbackCredential(input);
}

/**
 * Whether a fallback credential is *present* and its lane open, without decrypting it, so
 * capability reporting never needs plaintext. A principal with a connected or revoked GitHub user
 * authorization has no fallback, so a secret it still holds never advertises a capability.
 */
export function hasGitHubFallbackCredential(
 config: RunnerConfig,
 principalId: string,
 metadata: MetadataStore | undefined,
 userAuthorization: GitHubUserAuthorizationStatus | undefined,
): boolean {
 if (!legacyFallbackLaneOpen(userAuthorization)) return false;
 if (envFallbackGitHubToken(config)) return true;
 if (!metadata) return false;
 try {
  return metadata
   .listGlobalSecrets(principalId)
   .some((secret) => isGitHubFallbackSecretName(secret.name));
 } catch {
  return false;
 }
}
