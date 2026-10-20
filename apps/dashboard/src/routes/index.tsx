import { queryOptions, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { apiClient, UnauthorizedError } from '@/lib/api-client';

/** Shape of `GET /dashboard/api/v1/profile` (apps/api/src/dashboard-router.ts). */
type ProfileResponse = {
  data: {
    identity: { issuer: string; subject: string; email?: string; name?: string };
    preferences: { displayName?: string | null };
    sessionExpiresAt: string | null;
  };
};

export const profileQuery = queryOptions({
  queryKey: ['profile'],
  queryFn: ({ signal }) => apiClient.get<ProfileResponse>('/profile', { signal }).then((body) => body.data)
});

export const Route = createFileRoute('/')({
  component: OverviewPage
});

function OverviewPage() {
  const profile = useQuery(profileQuery);
  useEffect(() => { document.title = 'Overview | Cloud Harness'; }, []);
  return (
    <div className="mx-auto grid max-w-5xl gap-(--stack-gap)">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground">The new Dashboard is in preview. Pages move here as they reach parity.</p>
      </header>
      <section aria-labelledby="signed-in-title" className="rounded-lg border bg-surface p-4">
        <h2 id="signed-in-title" className="text-sm font-medium">Signed in</h2>
        {profile.isPending ? (
          <div className="mt-2 grid gap-2" role="status" aria-label="Loading profile">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-56" />
          </div>
        ) : profile.isError ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {profile.error instanceof UnauthorizedError ? 'Your session ended. Reload the page to sign in again.' : 'Profile could not be loaded.'}
          </p>
        ) : (
          <dl className="mt-2 grid gap-1 text-sm">
            <div className="flex gap-2"><dt className="text-muted-foreground">Name</dt><dd>{profile.data.preferences.displayName || profile.data.identity.name || '—'}</dd></div>
            <div className="flex gap-2"><dt className="text-muted-foreground">Email</dt><dd className="font-mono">{profile.data.identity.email || '—'}</dd></div>
          </dl>
        )}
      </section>
    </div>
  );
}
