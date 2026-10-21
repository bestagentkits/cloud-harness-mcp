import { createFileRoute } from '@tanstack/react-router';
import { AuditPage } from '@/features/audit/audit-page';
import { auditPageQuery } from '@/features/audit/audit-query';
import { compact, cursor, exact } from '@/lib/search-params';

export const Route = createFileRoute('/audit')({
  staticData: { pageId: 'audit' },
  validateSearch: (raw: Record<string, unknown>) => exact({ cursor: cursor(raw) }),
  // Preload warms the page of the linked cursor, the same key the page reads. The cursor comes
  // from the target location, not `loaderDeps`, so paging keeps one route match (no skeleton).
  loader: ({ context, location, preload }) => {
    if (preload) void context.queryClient.prefetchQuery(auditPageQuery(cursor(location.search)));
  },
  component: AuditRoute
});

/** Paging pushes a history entry (Back returns to the previous page), as the classic page did. */
function AuditRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <AuditPage search={search} onCursor={(next) => { void navigate({ search: compact({ cursor: next }) }); }} />;
}
