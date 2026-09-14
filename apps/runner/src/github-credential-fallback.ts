import {
 GITHUB_CREDENTIAL_SECRET_NAMES,
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
 * Refused in `cloudflare-access` mode: a credential that authorizes every
 * repository the operator can reach must never stand in for a principal-scoped
 * GitHub App grant. That mode uses a principal's own global secret instead.
 */
export function envFallbackGitHubToken(
 config: RunnerConfig,
): string | undefined {
 if ((config.authMode ?? "owner-bearer") === "cloudflare-access")
  return undefined;
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
 * Resolve the fallback credential for one principal: environment first, then
 * the principal's own global secret.
 */
export function resolveGitHubFallbackToken(input: {
 config: RunnerConfig;
 principalId: string;
 metadata?: MetadataStore | undefined;
}): string | undefined {
 return resolveGitHubFallbackCredential(input)?.token;
}

/**
 * The fallback credential and the boundary it came from. The two sources are not
 * interchangeable: the runner environment credential is operator-wide and is
 * refused in `cloudflare-access` mode, while a principal's global runtime secret
 * belongs to — and is injected into the workspaces of — that principal alone.
 * Callers that record or report which credential performed an action need the
 * source, not just the value.
 */
export function resolveGitHubFallbackCredential(input: {
 config: RunnerConfig;
 principalId: string;
 metadata?: MetadataStore | undefined;
}): { token: string; source: 'runner-environment' | 'principal-global-secret' } | undefined {
 const environmentToken = envFallbackGitHubToken(input.config);
 if (environmentToken) return { token: environmentToken, source: 'runner-environment' };
 const principalToken = globalFallbackGitHubToken(input.principalId, input.metadata);
 return principalToken ? { token: principalToken, source: 'principal-global-secret' } : undefined;
}

/**
 * Whether a fallback credential is *present*, without decrypting it, so
 * capability reporting never needs plaintext.
 */
export function hasGitHubFallbackCredential(
 config: RunnerConfig,
 principalId: string,
 metadata: MetadataStore | undefined,
): boolean {
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
