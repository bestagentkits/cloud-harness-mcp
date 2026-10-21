import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ManagedDialog } from '@/components/ui/managed-dialog';
import { mutationErrorText } from '@/lib/bff-mutation';
import { useIdempotencyKey } from '@/lib/idempotency';

export type FinalizeValues = { commitMessage: string; push: boolean; idempotencyKey: string };

/**
 * "Finalize workspace": stage everything, run the preflights, commit with the workspace
 * identity, and push when asked. One idempotency key per intent: a retry of the same message
 * and push choice after a lost answer reuses it, so the commit is never made twice; a changed
 * message or push choice, a reopened dialog, or a success is a new intent.
 */
export function FinalizeDialog({ open, onOpenChange, onSubmit }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: FinalizeValues) => Promise<unknown>;
}) {
  const formId = useId();
  const pushId = useId();
  const { current: idempotencyKey, renew } = useIdempotencyKey();
  const keyedFor = useRef<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [push, setPush] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  // Reset on close, so the next open is a fresh intent with a fresh key.
  function changeOpen(next: boolean) {
    if (!next) {
      setCommitMessage(''); setPush(true); setError('');
      if (keyedFor.current !== null) renew();
      keyedFor.current = null;
    }
    onOpenChange(next);
  }

  async function submit() {
    const message = commitMessage.trim();
    if (!message) { setError('Write a commit message.'); return; }
    const intent = JSON.stringify([message, push]);
    if (keyedFor.current !== null && keyedFor.current !== intent) renew();
    keyedFor.current = intent;
    setError(''); setPending(true);
    try {
      await onSubmit({ commitMessage: message, push, idempotencyKey: idempotencyKey() });
      renew(); keyedFor.current = null;
      changeOpen(false);
    } catch (failure) {
      setError(mutationErrorText(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <ManagedDialog open={open} onOpenChange={changeOpen} guard={{ dirty: commitMessage !== '' && !pending, locked: pending }}>
      <DialogHeader>
        <DialogTitle>Finalize workspace</DialogTitle>
        <DialogDescription>Stages the changes, runs the preflights, commits with the workspace identity, and pushes when you ask it to.</DialogDescription>
      </DialogHeader>
      <form id={formId} className="grid gap-4" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Field label="Commit message" error={error || undefined}>
          <Input autoFocus autoComplete="off" maxLength={10_000} value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} />
        </Field>
        <div className="flex items-center gap-2">
          <Checkbox id={pushId} checked={push} onCheckedChange={(checked) => setPush(checked === true)} />
          <Label htmlFor={pushId} className="font-normal">Push to the remote after committing</Label>
        </div>
      </form>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={() => changeOpen(false)}>Cancel</Button>
        <Button type="submit" form={formId} disabled={pending} aria-busy={pending || undefined}>{pending ? 'Finalizing…' : 'Finalize workspace'}</Button>
      </DialogFooter>
    </ManagedDialog>
  );
}
