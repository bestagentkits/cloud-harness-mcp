import { queryOptions } from '@tanstack/react-query';
import { apiClient } from './api-client';

/** Shape of `GET /dashboard/api/v1/profile` (apps/api/src/dashboard-router.ts). */
export type ProfileResponse = {
  data: {
    identity: { issuer: string; subject: string; email?: string; name?: string };
    preferences: { displayName?: string | null };
    sessionExpiresAt: string | null;
  };
};

export const profileQuery = queryOptions({
  queryKey: ['profile'],
  queryFn: ({ signal }) => apiClient.get<ProfileResponse>('/profile', { signal }).then((body) => body.data),
  staleTime: 5 * 60_000
});

/** The name the shell shows: the chosen display name, then the identity's name, then its email. */
export function displayName(profile: ProfileResponse['data'] | undefined): string | undefined {
  return profile?.preferences.displayName || profile?.identity.name || profile?.identity.email || undefined;
}
