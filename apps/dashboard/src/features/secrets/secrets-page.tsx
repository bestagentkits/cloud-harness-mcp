import { useCallback, useState } from 'react';
import { AsyncStatus } from '@/components/feedback/async-status';
import { usePagePrimaryAction } from '@/lib/page-primary-action';
import { Callout } from '../shared/callout';
import { usePageData } from '../shared/feature-read';
import type { SecretList } from './secret-model';
import { SecretsPanel } from './secrets-panel';

const GLOBAL = { kind: 'global' } as const;

export function SecretsPage() {
  const read = usePageData<SecretList>('secrets');
  const [createOpen, setCreateOpen] = useState(false);
  usePagePrimaryAction('secrets', { onSelect: useCallback(() => setCreateOpen(true), []) });
  return (
    <div className="grid gap-(--stack-gap)" data-testid="secrets-page">
      <Callout title="Values are write-only and never displayed.">
        Global secrets are inherited by every workspace you open from now on. An environment secret with the same name overrides a global one. Rotating or deleting a secret applies to future workspace opens, not to workspaces already running.
      </Callout>
      <AsyncStatus query={read} label="secrets">
        {(list) => <SecretsPanel scope={GLOBAL} list={list} createOpen={createOpen} onCreateOpenChange={setCreateOpen} />}
      </AsyncStatus>
    </div>
  );
}
