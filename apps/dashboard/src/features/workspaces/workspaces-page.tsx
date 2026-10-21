import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { BoxIcon, SearchXIcon } from 'lucide-react';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { FilterBar, SearchFilter, SelectFilter } from '@/components/data/filter-bar';
import { StatusBadge } from '@/components/data/status-badge';
import { TruncationNotice } from '@/components/data/truncation-notice';
import { type BffEnvelope } from '@/lib/bff-query';
import { formatRelative } from '@/lib/format';
import { pageReadQuery } from '@/lib/page-read';
import { OpenWorkspaceWizard } from './open-workspace-wizard';
import { filterWorkspaces, networkLabel, repositoryName, type Workspace, WORKSPACE_STATUSES, workspaceStatusLabel } from './workspace-model';

export type WorkspacesSearch = { q?: string | undefined; status?: (typeof WORKSPACE_STATUSES)[number] | undefined; expiring?: number | undefined };

const COLUMNS: DataTableColumn<Workspace>[] = [
  {
    id: 'repository',
    header: 'Repository',
    cell: (workspace) => (
      <div className="grid min-w-0">
        <Link to="/workspaces/$workspaceId" params={{ workspaceId: workspace.workspaceId }} className="truncate font-medium hover:underline">{repositoryName(workspace.repositoryUrl)}</Link>
        <span className="truncate font-mono text-xs text-muted-foreground">{workspace.workspaceId}</span>
      </div>
    )
  },
  { id: 'status', header: 'State', cell: (workspace) => <StatusBadge status={workspace.status} /> },
  { id: 'activity', header: 'Last activity', cell: (workspace) => formatRelative(workspace.lastActivityAt), className: 'whitespace-nowrap' },
  { id: 'expires', header: 'Expires', cell: (workspace) => formatRelative(workspace.expiresAt), className: 'whitespace-nowrap' },
  { id: 'network', header: 'Network', cell: (workspace) => networkLabel(workspace.networkProfile), className: 'hidden md:table-cell whitespace-nowrap' }
];

/**
 * The workspace list. Filters are URL search params (`q`, `status`, `expiring`), applied to
 * the one `/workspaces` read the page registry warms, so typing never refetches. The page
 * has no poller: the list refreshes on focus and on return, like the classic page. Its primary
 * action is the open-workspace wizard.
 */
export function WorkspacesPage({ search, onSearch }: { search: WorkspacesSearch; onSearch: (next: WorkspacesSearch) => void }) {
  const read = useQuery(pageReadQuery('workspaces', {}));
  const active = Boolean(search.q || search.status || search.expiring);
  return (
    <div className="grid gap-(--stack-gap)">
      <FilterBar active={active} onClear={() => onSearch({})} label="Workspace filters">
        <SearchFilter label="Search workspaces" placeholder="Repository or workspace id" value={search.q} onChange={(q) => onSearch({ ...search, q })} />
        <SelectFilter label="State" value={search.status} options={WORKSPACE_STATUSES.map((value) => ({ value, label: workspaceStatusLabel(value) }))} onChange={(status) => onSearch({ ...search, status })} />
        {search.expiring ? <span className="rounded-full border px-2.5 py-0.5 text-xs">Expiring within {search.expiring} min</span> : null}
      </FilterBar>
      <AsyncStatus query={read} label="workspaces">
        {(body) => {
          const envelope = body as BffEnvelope<{ workspaces?: Workspace[] }>;
          const all = envelope.data?.workspaces ?? [];
          const rows = filterWorkspaces(all, search);
          return (
            <div className="grid gap-2">
              <TruncationNotice truncated={envelope.truncated} what="workspaces" />
              <DataTable
                caption={`${rows.length} workspaces`}
                columns={COLUMNS}
                rows={rows}
                rowKey={(workspace) => workspace.workspaceId}
                empty={all.length === 0
                  ? <EmptyState icon={BoxIcon} title="No workspaces yet" description="Open one with New workspace, or from an MCP client, and it will appear here." />
                  : <EmptyState icon={SearchXIcon} title="No workspaces match these filters" action={<Button variant="outline" size="sm" onClick={() => onSearch({})}>Clear filters</Button>} />}
              />
            </div>
          );
        }}
      </AsyncStatus>
      <OpenWorkspaceWizard />
    </div>
  );
}
