import { createFileRoute } from '@tanstack/react-router';
import { AuditPage } from '@/features/audit/audit-page';
import { auditPageQuery } from '@/features/audit/audit-query';
import { compact, cursor, exact } from '@/lib/search-params';

export const Route = createFileRoute('/audit')({
  staticData: { pageId: 'audit' },
  validateSearch: (raw: Record<string, unknown>) => exact({ cursor: cursor(raw) }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  // Preload warms the page of the linked cursor, the same key the page reads.
  loader: ({ context, deps, preload }) => {
    if (preload) void context.queryClient.prefetchQuery(auditPageQuery(deps.cursor));
  },
  component: AuditRoute
});

/** Paging pushes a history entry (Back returns to the previous page), as the classic page did. */
function AuditRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <AuditPage search={search} onCursor={(next) => { void navigate({ search: compact({ cursor: next }) }); }} />;
}
