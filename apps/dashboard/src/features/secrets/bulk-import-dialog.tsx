import { useMemo, useState } from 'react';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { mutationErrorText, useBffMutation } from '@/lib/bff-mutation';
import { FormDialog } from '../shared/form-dialog';
import { type BulkItem, type BulkPlanLine, planBulkImport, type SecretReference } from './secret-model';
import { type SecretScope, secretsApi, secretsPath } from './secrets-api';

function PlanLine({ line }: { line: BulkPlanLine }) {
  const description = 'description' in line && line.description ? ` (${line.description})` : '';
  switch (line.kind) {
    case 'create': return <li data-kind="create">+ CREATE: {line.name}{description}</li>;
    case 'rotate': return <li data-kind="rotate">↻ ROTATE: {line.name}{description} (v{line.fromVersion} → v{line.toVersion})</li>;
    case 'rejected': return <li data-kind="rejected" className="font-semibold">× REJECTED: {line.name} ({line.reason})</li>;
    case 'duplicate': return <li data-kind="duplicate" className="font-semibold">× DUPLICATE: {line.name} (duplicate in pasted batch)</li>;
  }
}

/**
 * Parity matrix D4: paste `.env` text to create or rotate many secrets at once. The text
 * holds values, so it lives in component state only and is cleared on every close
 * (Cancel, Escape, outside click, success). The preview shows names, never values.
 */
export function BulkImportDialog({ scope, existing, open, onOpenChange }: { scope: SecretScope; existing: readonly SecretReference[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [text, setText] = useState('');
  const [blockedMessage, setBlockedMessage] = useState<string | undefined>();
  const plan = useMemo(() => planBulkImport(text, existing), [existing, text]);
  const mutation = useBffMutation<BulkItem[]>({
    mutationFn: (items) => secretsApi.bulk(scope, items),
    invalidate: [secretsPath(scope)],
    successToast: 'Bulk secrets applied successfully.'
  });

  function setOpen(next: boolean) {
    if (!next) { setText(''); setBlockedMessage(undefined); mutation.reset(); }
    onOpenChange(next);
  }

  async function apply() {
    if (!plan.items.length && !plan.blocked) { setBlockedMessage('Paste at least one KEY=value line.'); return; }
    if (plan.blocked) { setBlockedMessage(`Fix ${plan.blocked} rejected item(s) before applying.`); return; }
    setBlockedMessage(undefined);
    try {
      await mutation.mutateAsync(plan.items);
      setOpen(false);
    } catch { /* shown in the dialog */ }
  }

  const error = blockedMessage ?? (mutation.isError ? mutationErrorText(mutation.error) : undefined);
  return (
    <FormDialog
      testId="bulk-import-dialog"
      wide
      open={open}
      onOpenChange={setOpen}
      title="Bulk import .env"
      description="Paste .env content to create or rotate secrets. Contiguous comments directly above keys become descriptions. Values are write-only and not retained in the page."
      submitLabel="Apply import"
      pendingLabel="Applying…"
      pending={mutation.isPending}
      error={error}
      dirty={text.length > 0}
      onSubmit={(event) => { event.preventDefault(); void apply(); }}
    >
      <Field label=".env content">
        <Textarea
          rows={8}
          className="font-mono"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          placeholder={'# Description\nKEY=value'}
          value={text}
          onChange={(event) => { setText(event.target.value); setBlockedMessage(undefined); }}
        />
      </Field>
      <section aria-label="Import preview" aria-live="polite" className="rounded-md border bg-muted/40 p-3">
        {text.trim() === '' ? <p className="text-sm text-muted-foreground">The preview lists each key and whether it is created or rotated.</p>
          : plan.lines.length === 0 ? <p className="text-sm text-muted-foreground">No variable assignments found.</p>
            : <ul className="grid gap-1 font-mono text-xs break-all" data-testid="bulk-import-preview">{plan.lines.map((line, index) => <PlanLine key={`${line.name}-${index}`} line={line} />)}</ul>}
      </section>
    </FormDialog>
  );
}
