import { createFileRoute } from '@tanstack/react-router';
import { WorkspacesPage } from '@/features/workspaces/workspaces-page';
import { warmPageRead } from '@/lib/page-read';
import { compact, exact, matching, oneOf, text } from '@/lib/search-params';
import { WORKSPACE_STATUSES } from '@/features/workspaces/workspace-model';

/**
 * `expiring` is a lease budget in minutes (the Overview's "Expiring soon" tile links with
 * `?expiring=60`); a legacy boolean `?expiring=true` means the same hour.
 */
function expiringMinutes(raw: Record<string, unknown>): number | undefined {
  if (raw.expiring === true || raw.expiring === 'true') return 60;
  const minutes = matching(raw, 'expiring', /^[1-9]\d{0,4}$/) ?? (typeof raw.expiring === 'number' && Number.isInteger(raw.expiring) && raw.expiring > 0 && raw.expiring < 100_000 ? String(raw.expiring) : undefined);
  return minutes ? Number(minutes) : undefined;
}

export const Route = createFileRoute('/workspaces/')({
  staticData: { pageId: 'workspaces' },
  validateSearch: (raw: Record<string, unknown>) => exact({ q: text(raw, 'q'), status: oneOf(raw, 'status', WORKSPACE_STATUSES), expiring: expiringMinutes(raw) }),
  loader: (match) => warmPageRead('workspaces', match),
  component: WorkspacesRoute
});

function WorkspacesRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <WorkspacesPage search={search} onSearch={(next) => { void navigate({ search: compact(next), replace: true }); }} />;
}
