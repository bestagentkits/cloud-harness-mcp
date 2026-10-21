import { useQuery } from '@tanstack/react-query';
import { ArchiveIcon } from 'lucide-react';
import { Section } from '@/components/data/section';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { type BffEnvelope, bffPath, bffQuery } from '@/lib/bff-query';
import { formatBytes, formatDateTime } from '@/lib/format';
import type { CockpitTabProps } from '../cockpit-tab-registry';
import { type Artifact, artifactDownloadHref, artifactsOf } from '@/features/artifacts/artifacts-model';

/**
 * The workspace's retained snapshots: the BFF keeps only records whose own `workspaceId`
 * names this workspace. Read-only here; creating and deleting snapshots stays on the
 * Artifacts page, as on the classic tab.
 */
export default function ArtifactsTab({ workspaceId }: CockpitTabProps) {
  const read = useQuery(bffQuery<unknown>(`${bffPath('workspaces', workspaceId)}/artifacts`, {}));
  const columns: DataTableColumn<Artifact>[] = [
    {
      id: 'name', header: 'Name', cell: (artifact) => (
        <div className="grid min-w-0">
          <span className="truncate font-medium">{artifact.logicalName}</span>
          <span className="truncate font-mono text-xs text-muted-foreground">{artifact.artifactId}</span>
        </div>
      )
    },
    { id: 'size', header: 'Size', cell: (artifact) => formatBytes(artifact.sizeBytes), className: 'whitespace-nowrap tabular-nums' },
    { id: 'expires', header: 'Expires', cell: (artifact) => formatDateTime(artifact.expiresAt), className: 'whitespace-nowrap' },
    {
      id: 'actions', header: <span className="sr-only">Actions</span>, cell: (artifact) => (
        <div className="flex justify-end">
          <a className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none" href={artifactDownloadHref(artifact.artifactId)} download={artifact.logicalName}>
            Download<span className="sr-only"> {artifact.logicalName}</span>
          </a>
        </div>
      )
    }
  ];
  return (
    <Section title="Artifacts" description="Bounded snapshots whose own record names this workspace. Creating and deleting snapshots stays on the global Artifacts page.">
      <AsyncStatus query={read} label="artifacts">
        {(body) => {
          const artifacts = artifactsOf((body as BffEnvelope<unknown>).data);
          return (
            <DataTable
              caption={`${artifacts.length} snapshot(s)`}
              columns={columns}
              rows={artifacts}
              rowKey={(artifact) => artifact.artifactId}
              empty={<EmptyState icon={ArchiveIcon} title="No retained snapshots belong to this workspace yet" />}
            />
          );
        }}
      </AsyncStatus>
    </Section>
  );
}
