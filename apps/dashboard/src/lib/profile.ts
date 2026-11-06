import { queryOptions } from '@tanstack/react-query';
import { apiClient } from './api-client';
import { pageReadQuery } from './page-read';

/** Shape of `GET /dashboard/api/v1/profile` (apps/api/src/dashboard-router.ts). */
export type ProfileResponse = {
  data: {
    identity: { issuer: string; subject: string; email?: string; name?: string };
    preferences: { displayName?: string | null };
    sessionExpiresAt: string | null;
  };
};

/**
 * The profile read shares the Profile page's key, so the top-bar chip, the Overview and the
 * Profile page fetch `/profile` once. The cache holds the raw body; `select` unwraps it.
 */
export const profileQuery = queryOptions({
  queryKey: pageReadQuery('profile', {}).queryKey,
  queryFn: ({ signal }) => apiClient.get<ProfileResponse>('/profile', { signal }) as Promise<unknown>,
  select: (body: unknown) => (body as ProfileResponse).data,
  staleTime: 5 * 60_000
});

/** The name the shell shows: the chosen display name, then the identity's name, then its email. */
export function displayName(profile: ProfileResponse['data'] | undefined): string | undefined {
  return profile?.preferences.displayName || profile?.identity.name || profile?.identity.email || undefined;
}
