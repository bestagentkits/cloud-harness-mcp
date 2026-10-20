import { useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from '@/components/feedback/empty-state';
import { ActionButton, Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable } from '@/components/ui/data-table';
import { toast } from '@/components/ui/toast-store';
import { apiClient } from '@/lib/api-client';
import { bffKey } from '@/lib/bff-mutation';
import { useOpenedOnce } from '@/lib/use-opened-once';
import { Callout } from '../shared/callout';
import { downloadText } from '../shared/download-text';
import { formatTime, plural } from '../shared/format';
import { reportActionError } from '../shared/report-error';
import { Section } from '../shared/section';
import { StatusBadge } from '../shared/status-badge';
import { BulkImportDialog } from './bulk-import-dialog';
import { SecretCreateDialog } from './secret-create-dialog';
import { SecretEditDialog, type SecretEditMode } from './secret-edit-dialog';
import { buildEnvExample, envExampleFilename, type SecretList, type SecretReference } from './secret-model';
import { type SecretScope, secretsApi, secretsPath } from './secrets-api';

/**
 * The write-only secret list of one scope with create, rotate, describe, delete, bulk
 * import and `.env.example` export. Used by the Secrets page for global secrets and built
 * to serve a project environment as well (pass an environment scope).
 */
export function SecretsPanel({ scope, list, createOpen, onCreateOpenChange }: { scope: SecretScope; list: SecretList; createOpen: boolean; onCreateOpenChange: (open: boolean) => void }) {
  const global = scope.kind === 'global';
  const queryClient = useQueryClient();
  const [bulkOpen, setBulkOpen] = useState(false);
  const [editing, setEditing] = useState<{ secret: SecretReference; mode: SecretEditMode } | undefined>();
  const [deleting, setDeleting] = useState<SecretReference | undefined>();
  const bulkMounted = useOpenedOnce(bulkOpen);
  const secrets = list.secrets;
  // The current list, not the possibly stale page copy.
  const readFresh = () => queryClient.fetchQuery({ queryKey: [...bffKey(secretsPath(scope)), {}], queryFn: ({ signal }) => apiClient.get<{ data: SecretList }>(secretsPath(scope), { signal }), staleTime: 0 });

  // The dialog stays fenced on the row it opened with, so a background refetch never moves
  // the fence past a change the operator has not seen. Only a 409 replaces the snapshot,
  // with the row from a fresh read, so the retry carries the generation now on the server.
  async function adoptLatest(secretId: string) {
    const latest = (await readFresh()).data.secrets.find((secret) => secret.id === secretId);
    if (latest) setEditing((current) => (current?.secret.id === secretId ? { ...current, secret: latest } : current));
  }

  async function exportExample() {
    try {
      const fresh = await readFresh();
      const filename = envExampleFilename(scope.kind === 'environment' ? scope.name : undefined);
      downloadText(filename, buildEnvExample(fresh.data.secrets));
      toast({ title: `${filename} exported.`, variant: 'success' });
    } catch (error) {
      reportActionError('The .env.example file could not be exported', error);
    }
  }

  return (
    <div className="grid gap-(--stack-gap)">
      {list.readiness && !list.readiness.ready ? (
        <Callout tone="warning" title="Secret storage unavailable" testId="secrets-unavailable">{list.readiness.error ?? 'Review runner readiness.'}</Callout>
      ) : null}
      <Section
        title={global ? 'Secret references' : 'Write-only secret references'}
        description={plural(secrets.length, 'secret')}
        actions={(
          <>
            <Button variant="outline" size="sm" aria-haspopup="dialog" onClick={() => setBulkOpen(true)}>Bulk import .env</Button>
            <ActionButton variant="outline" size="sm" pendingLabel="Exporting…" onAction={exportExample} disabled={!secrets.length}>Export .env.example</ActionButton>
          </>
        )}
      >
        <DataTable
          caption={`${plural(secrets.length, 'secret')}${global ? ' inherited by new workspaces' : ''}`}
          rows={secrets}
          rowKey={(secret) => secret.id ?? secret.name}
          empty={(
            <EmptyState
              icon={KeyRoundIcon}
              title={global ? 'No global secrets yet.' : 'No secret references.'}
              description="Add a secret when a workspace needs a credential that every project can inherit."
              action={<Button size="sm" aria-haspopup="dialog" onClick={() => onCreateOpenChange(true)}>{global ? 'Add global secret' : 'Add secret'}</Button>}
            />
          )}
          columns={[
            { id: 'name', header: 'Name', cell: (secret) => <span className="font-mono font-medium break-all">{secret.name}</span> },
            { id: 'description', header: 'Description', className: 'max-w-72', cell: (secret) => secret.description ? <span className="line-clamp-2">{secret.description}</span> : <span className="text-muted-foreground">None</span> },
            { id: 'state', header: 'State', cell: (secret) => <StatusBadge tone={secret.state === 'ACTIVE' || secret.state === 'active' ? 'success' : 'neutral'}>{secret.state ?? 'unknown'}</StatusBadge> },
            { id: 'version', header: 'Version', cell: (secret) => <span className="whitespace-nowrap tabular-nums">v{secret.version ?? secret.generation} · gen {secret.generation}</span> },
            { id: 'updated', header: 'Updated', cell: (secret) => <span className="whitespace-nowrap">{formatTime(secret.updatedAt ?? secret.createdAt, 'Unknown')}</span> },
            {
              id: 'actions',
              header: <span className="sr-only">Actions</span>,
              cell: (secret) => (
                <div className="flex justify-end gap-1">
                  <Button size="sm" variant="outline" aria-haspopup="dialog" aria-label={`Rotate ${secret.name}`} onClick={() => setEditing({ secret, mode: 'rotate' })}>Rotate</Button>
                  <Button size="sm" variant="ghost" aria-haspopup="dialog" aria-label={`Edit description of ${secret.name}`} onClick={() => setEditing({ secret, mode: 'describe' })}>Edit</Button>
                  <Button size="sm" variant="ghost" className="text-destructive" aria-haspopup="dialog" aria-label={`Delete ${secret.name}`} onClick={() => setDeleting(secret)}>Delete</Button>
                </div>
              )
            }
          ]}
        />
      </Section>
      <SecretCreateDialog scope={scope} open={createOpen} onOpenChange={onCreateOpenChange} />
      <SecretEditDialog scope={scope} secret={editing?.secret} mode={editing?.mode ?? 'rotate'} onConflict={adoptLatest} onClose={() => setEditing(undefined)} />
      {bulkMounted ? <BulkImportDialog scope={scope} existing={secrets} open={bulkOpen} onOpenChange={setBulkOpen} /> : null}
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => { if (!open) setDeleting(undefined); }}
        title={global ? 'Delete global secret?' : 'Delete secret reference?'}
        description={global ? 'Delete this global write-only reference and its encrypted value? Running workspaces keep the value they started with.' : 'Delete this write-only reference and its encrypted value?'}
        target={deleting?.name ?? ''}
        confirmLabel="Delete secret"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          if (!deleting) return;
          await secretsApi.remove(scope, deleting);
          toast({ title: global ? 'Global secret deleted.' : 'Secret reference deleted.', variant: 'success' });
          await queryClient.invalidateQueries({ queryKey: bffKey(secretsPath(scope)) });
        }}
        onError={(error) => {
          reportActionError('The secret could not be deleted', error);
          void queryClient.invalidateQueries({ queryKey: bffKey(secretsPath(scope)) });
        }}
      />
    </div>
  );
}
