import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { Skeleton } from '@/components/ui/skeleton';
import { UnauthorizedError } from '@/lib/api-client';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';
import { displayName, profileQuery } from '@/lib/profile';

export const Route = createFileRoute('/')({
  staticData: { pageId: 'overview' },
  validateSearch: noSearch,
  loader: (match) => warmPageRead('overview', match),
  component: OverviewPage
});

function OverviewPage() {
  const profile = useQuery(profileQuery);
  return (
    <PagePlaceholder pageId="overview">
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
            <div className="flex gap-2"><dt className="text-muted-foreground">Name</dt><dd>{displayName(profile.data) ?? '—'}</dd></div>
            <div className="flex gap-2"><dt className="text-muted-foreground">Email</dt><dd className="font-mono">{profile.data.identity.email || '—'}</dd></div>
          </dl>
        )}
      </section>
    </PagePlaceholder>
  );
}
