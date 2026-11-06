import { exact, matching } from '@/lib/search-params';

// Kept apart from the page model: the route file imports this validator eagerly, and the
// page itself must stay in its lazily loaded route chunk.

/** The setup `state` is 32 random bytes in base64url; the runner accepts 32-128 characters. */
export const GITHUB_STATE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
export const GITHUB_INSTALLATION_PATTERN = /^[0-9]{1,20}$/;

/**
 * The callback params GitHub appends (`setup_action` is ignored, as in the classic
 * Dashboard). The router parses a numeric `installation_id` as a number, so it is read as
 * text. Components re-apply this to `useSearch()`, which also carries parents' raw keys.
 */
export function githubCallbackSearch(raw: Record<string, unknown>) {
  const value = raw.installation_id;
  // A number past 2^53 has already lost digits, so only a safe integer is taken as an ID;
  // anything longer than the pattern is refused, never truncated.
  const installationId = typeof value === 'number' ? (Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined) : typeof value === 'string' ? value.trim() : undefined;
  return exact({
    state: matching(raw, 'state', GITHUB_STATE_PATTERN),
    installation_id: installationId && GITHUB_INSTALLATION_PATTERN.test(installationId) ? installationId : undefined
  });
}

/** Whether a raw query string carries any GitHub callback param, valid or not. */
export function hasGitHubCallbackParams(search: string): boolean {
  const params = new URLSearchParams(search);
  return ['state', 'installation_id', 'setup_action'].some((key) => params.has(key));
}
