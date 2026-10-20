import { classicDashboardHref } from '@/components/feedback/classic-dashboard-link';

/** The params GitHub appends when it returns from an App installation. */
const CALLBACK_KEYS = ['state', 'installation_id', 'setup_action'] as const;

/**
 * The GitHub App installation callback is completed by the classic Dashboard, which
 * verifies `state` and records the installation. When the callback lands here, hand the
 * whole query to the classic page (`?ui=legacy`, which the server strips before
 * redirecting back) instead of rendering it. Returns undefined for an ordinary visit.
 */
export function githubCallbackHandoff(searchStr: string): string | undefined {
  const query = new URLSearchParams(searchStr.startsWith('?') ? searchStr.slice(1) : searchStr);
  if (!CALLBACK_KEYS.some((key) => query.has(key))) return undefined;
  return classicDashboardHref('/dashboard/integrations/github', query.toString());
}
