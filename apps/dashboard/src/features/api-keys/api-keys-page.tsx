import { useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon } from 'lucide-react';
import { useCallback, useState } from 'react';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { DataTable } from '@/components/ui/data-table';
import { toast } from '@/components/ui/toast-store';
import { bffPrefix } from '@/lib/bff-mutation';
import { useOneTimeReveal } from '@/lib/one-time-reveal';
import { usePagePrimaryAction } from '@/lib/page-primary-action';
import { Callout } from '../shared/callout';
import { usePageData } from '../shared/feature-read';
import { formatTime } from '../shared/format';
import { reportActionError } from '../shared/report-error';
import { Section } from '../shared/section';
import { type BadgeTone, StatusBadge } from '../shared/status-badge';
import { ApiKeyCreateDialog } from './api-key-create-dialog';
import { type ApiKeyList, type ApiKeyMetadata, apiKeysApi, MAX_ACTIVE_KEYS, STATE_LABELS, staticEndpoint } from './api-key-model';
import { ApiKeyRevealDialog } from './api-key-reveal-dialog';

const STATE_TONES: Record<string, BadgeTone> = { ACTIVE: 'success', EXPIRED: 'warning', REVOKED: 'neutral' };

function ApiKeysBody({ list, onCreate }: { list: ApiKeyList; onCreate: () => void }) {
  const queryClient = useQueryClient();
  const [revoking, setRevoking] = useState<ApiKeyMetadata | undefined>();
  const keys = list.keys ?? [];
  const active = keys.filter((key) => key.state === 'ACTIVE').length;
  const endpoint = staticEndpoint(list.readiness.publicUrl);
  if (!list.readiness.ready) {
    return <Callout tone="warning" title="API-key connections are not available yet." testId="api-keys-unavailable">An operator must finish the dedicated gateway configuration.</Callout>;
  }
  return (
    <>
      {endpoint ? (
        <Callout title="Static client endpoint">
          <span className="flex flex-wrap items-center gap-2"><code className="font-mono text-xs break-all text-foreground">{endpoint}</code><CopyButton value={endpoint} label="Copy URL" /></span>
        </Callout>
      ) : null}
      {active >= MAX_ACTIVE_KEYS ? <Callout tone="warning" title="The 10-active-key limit is reached.">Revoke an active key before creating another.</Callout> : null}
      <Section title="API keys" description={`${active} active of ${MAX_ACTIVE_KEYS} · ${keys.length} total`}>
        <DataTable
          caption={`${keys.length} API keys`}
          rows={keys}
          rowKey={(key) => key.id}
          empty={<EmptyState icon={KeyRoundIcon} title="No API keys yet." description="Create one when a client cannot complete the browser-based OAuth flow." action={<Button size="sm" aria-haspopup="dialog" onClick={onCreate}>Create API key</Button>} />}
          columns={[
            { id: 'name', header: 'Name', cell: (key) => <span className="font-medium">{key.name}</span> },
            { id: 'prefix', header: 'Prefix', cell: (key) => <code className="font-mono text-xs">{key.displayPrefix}</code> },
            { id: 'state', header: 'State', cell: (key) => <StatusBadge tone={STATE_TONES[key.state] ?? 'neutral'}>{STATE_LABELS[key.state] ?? 'Unknown'}</StatusBadge> },
            { id: 'created', header: 'Created', cell: (key) => <span className="whitespace-nowrap">{formatTime(key.createdAt)}</span> },
            { id: 'expires', header: 'Expires', cell: (key) => <span className="whitespace-nowrap">{formatTime(key.expiresAt)}</span> },
            { id: 'used', header: 'Last used', cell: (key) => <span className="whitespace-nowrap">{formatTime(key.lastUsedAt)}</span> },
            { id: 'revoked', header: 'Revoked', cell: (key) => <span className="whitespace-nowrap">{formatTime(key.revokedAt)}</span> },
            {
              id: 'actions',
              header: <span className="sr-only">Actions</span>,
              cell: (key) => key.state === 'ACTIVE' && Number.isInteger(key.generation) && key.generation > 0
                ? <Button size="sm" variant="ghost" className="text-destructive" aria-haspopup="dialog" aria-label={`Revoke ${key.name}`} onClick={() => setRevoking(key)}>Revoke</Button>
                : null
            }
          ]}
        />
      </Section>
      <ConfirmDialog
        open={revoking !== undefined}
        onOpenChange={(open) => { if (!open) setRevoking(undefined); }}
        title="Revoke API key?"
        description="This key will stop authenticating on the next request. Revocation cannot be undone."
        target={revoking?.name ?? ''}
        confirmLabel="Revoke API key"
        pendingLabel="Revoking…"
        onConfirm={async () => {
          if (!revoking) return;
          await apiKeysApi.revoke(revoking);
          toast({ title: 'API key revoked.', variant: 'success' });
          await queryClient.invalidateQueries({ queryKey: bffPrefix('/api-keys') });
        }}
        onError={(error) => {
          reportActionError('The API key could not be revoked', error);
          void queryClient.invalidateQueries({ queryKey: bffPrefix('/api-keys') });
        }}
      />
    </>
  );
}

export function ApiKeysPage() {
  const read = usePageData<ApiKeyList>('api-keys');
  const [createOpen, setCreateOpen] = useState(false);
  const reveal = useOneTimeReveal();
  const keys = read.data?.keys ?? [];
  const atLimit = keys.filter((key) => key.state === 'ACTIVE').length >= MAX_ACTIVE_KEYS;
  const disabledReason = read.data && !read.data.readiness.ready ? 'API-key connections are not available yet.' : atLimit ? 'Revoke an active key before creating another.' : undefined;
  usePagePrimaryAction('api-keys', { onSelect: useCallback(() => setCreateOpen(true), []), disabledReason });
  return (
    <div className="grid gap-(--stack-gap)" data-testid="api-keys-page">
      <AsyncStatus query={read} label="API keys">{(list) => <ApiKeysBody list={list} onCreate={() => setCreateOpen(true)} />}</AsyncStatus>
      <ApiKeyCreateDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={reveal.reveal} />
      <ApiKeyRevealDialog apiKey={reveal.value} onDismiss={reveal.clear} />
    </div>
  );
}
