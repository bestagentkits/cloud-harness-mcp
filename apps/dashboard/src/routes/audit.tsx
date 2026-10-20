import { createFileRoute } from '@tanstack/react-router';
import { AuditPage } from '@/features/audit/audit-page';
import { warmPageRead } from '@/lib/page-read';
import { compact, cursor, exact } from '@/lib/search-params';

export const Route = createFileRoute('/audit')({
  staticData: { pageId: 'audit' },
  validateSearch: (raw: Record<string, unknown>) => exact({ cursor: cursor(raw) }),
  loader: (match) => warmPageRead('audit', match),
  component: AuditRoute
});

/** Paging pushes a history entry (Back returns to the previous page), as the classic page did. */
function AuditRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <AuditPage search={search} onCursor={(next) => { void navigate({ search: compact({ cursor: next }) }); }} />;
}
