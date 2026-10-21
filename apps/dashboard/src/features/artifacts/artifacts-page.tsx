import { useQuery } from '@tanstack/react-query';
import { ArchiveIcon } from 'lucide-react';
import { useCallback, useState } from 'react';
import { CursorPager } from '@/components/data/cursor-pager';
import { Section } from '@/components/data/section';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { apiClient } from '@/lib/api-client';
import { bffPath } from '@/lib/bff-query';
import { useBffMutation } from '@/lib/bff-mutation';
import { formatBytes, formatDateTime } from '@/lib/format';
import { usePagePrimaryAction } from '@/lib/page-primary-action';
import { type Artifact, artifactDeletable, artifactDownloadHref, artifactsPage, snapshotBody, type SnapshotValues } from './artifacts-model';
import { artifactsPageQuery } from './artifacts-query';
import { SnapshotDialog } from './snapshot-dialog';

export type ArtifactsSearch = { cursor?: string | undefined };

const linkButton = 'inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none';

/**
 * Retained artifact snapshots (`GET /artifacts?limit=50`), paged forward by the opaque
 * cursor in the URL. "Create snapshot" is the page's primary action (generation 0, a new
 * record); a delete confirms and is fenced by the record's generation, so a snapshot that
 * changed since the page loaded is refused with a 409 and the list refetches.
 */
export function ArtifactsPage({ search, onCursor }: { search: ArtifactsSearch; onCursor: (cursor: string | undefined) => void }) {
  const read = useQuery(artifactsPageQuery(search.cursor));
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Artifact & { generation: number }>();
  usePagePrimaryAction('artifacts', { onSelect: useCallback(() => setCreating(true), []) });

  const create = useBffMutation<SnapshotValues, unknown>({
    mutationFn: (values) => apiClient.request('/artifacts', { method: 'POST', body: snapshotBody(values) }),
    invalidate: ['/artifacts'],
    successToast: 'Retained artifact snapshot created.',
    errorTitle: 'The snapshot was not created'
  });
  const remove = useBffMutation<Artifact & { generation: number }, unknown>({
    mutationFn: (artifact) => apiClient.request(bffPath('artifacts', artifact.artifactId), { method: 'DELETE', body: { expectedGeneration: artifact.generation } }),
    invalidate: ['/artifacts'],
    successToast: 'Artifact deleted.',
    errorTitle: 'The artifact was not deleted'
  });

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
    { id: 'sha', header: 'SHA-256', cell: (artifact) => <span className="font-mono text-xs break-all">{artifact.sha256}</span>, className: 'hidden lg:table-cell' },
    { id: 'expires', header: 'Expires', cell: (artifact) => formatDateTime(artifact.expiresAt), className: 'whitespace-nowrap' },
    {
      id: 'actions', header: <span className="sr-only">Actions</span>, cell: (artifact) => (
        <div className="flex justify-end gap-2">
          <a className={linkButton} href={artifactDownloadHref(artifact.artifactId)} download={artifact.logicalName}>Download<span className="sr-only"> {artifact.logicalName}</span></a>
          <Button size="sm" variant="destructive" disabled={!artifactDeletable(artifact)} onClick={() => { if (artifactDeletable(artifact)) setDeleting(artifact); }}>
            Delete<span className="sr-only"> {artifact.logicalName}</span>
          </Button>
        </div>
      )
    }
  ];

  return (
    <div className="grid gap-(--stack-gap)">
      <p className="rounded-lg border bg-surface p-3 text-sm text-muted-foreground">
        <strong className="font-medium text-foreground">Retained artifact snapshots.</strong>{' '}
        These bounded copies persist until their displayed expiry or deletion. Tasks and sessions are volatile runtime state.
      </p>
      <AsyncStatus query={read} label="artifacts">
        {(body) => {
          const { artifacts, nextCursor } = artifactsPage(body);
          return (
            <Section title="Retained artifacts">
              <DataTable
                caption={`${artifacts.length} snapshots`}
                columns={columns}
                rows={artifacts}
                rowKey={(artifact) => artifact.artifactId}
                empty={<EmptyState icon={ArchiveIcon} title="No retained snapshots yet" description="Create one to keep a bounded copy of a workspace file." action={<Button size="sm" onClick={() => setCreating(true)}>Create snapshot</Button>} />}
              />
              <CursorPager cursor={search.cursor} nextCursor={nextCursor} onCursor={onCursor} label="Artifacts" />
            </Section>
          );
        }}
      </AsyncStatus>
      <SnapshotDialog open={creating} onOpenChange={setCreating} onSubmit={(values) => create.mutateAsync(values)} />
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => { if (!open) setDeleting(undefined); }}
        title="Delete retained artifact?"
        description="Delete this bounded snapshot before its retention expiry?"
        {...(deleting ? { target: deleting.artifactId } : {})}
        confirmLabel="Delete artifact"
        pendingLabel="Deleting…"
        destructive
        onConfirm={() => (deleting ? remove.mutateAsync(deleting) : Promise.resolve())}
      />
    </div>
  );
}
