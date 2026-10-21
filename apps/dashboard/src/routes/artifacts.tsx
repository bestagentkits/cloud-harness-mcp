import { createFileRoute } from '@tanstack/react-router';
import { ArtifactsPage } from '@/features/artifacts/artifacts-page';
import { artifactsPageQuery } from '@/features/artifacts/artifacts-query';
import { compact, cursor, exact } from '@/lib/search-params';

export const Route = createFileRoute('/artifacts')({
  staticData: { pageId: 'artifacts' },
  validateSearch: (raw: Record<string, unknown>) => exact({ cursor: cursor(raw) }),
  // Preload warms the linked cursor's page, the key the page reads (as on the Audit page).
  loader: ({ context, location, preload }) => {
    if (preload) void context.queryClient.prefetchQuery(artifactsPageQuery(cursor(location.search)));
  },
  component: ArtifactsRoute
});

/** Paging pushes a history entry, so Back returns to the previous page. */
function ArtifactsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <ArtifactsPage search={search} onCursor={(next) => { void navigate({ search: compact({ cursor: next }) }); }} />;
}
