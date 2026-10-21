import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useId, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ManagedDialog } from '@/components/ui/managed-dialog';
import { apiClient } from '@/lib/api-client';
import { bffPath } from '@/lib/bff-query';
import { useBffMutation } from '@/lib/bff-mutation';
import { useIdempotencyKey } from '@/lib/idempotency';

const schema = z.object({
  name: z.string().trim().min(1, 'Name the session.').max(80, 'Use at most 80 characters.'),
  cwd: z.string().trim().min(1, 'Give a working directory, or "." for the workspace root.').max(1_024, 'Use at most 1024 characters.')
});
type Values = z.infer<typeof schema>;

/**
 * Opens a named coding session. One idempotency key per intent: a retry of the same name and
 * directory after a failure reuses it (the runner answers the first attempt's session); a
 * changed name or directory, a reopened dialog, or a success starts a new intent.
 */
export function OpenSessionDialog({ open, onOpenChange, workspaceId, onOpened }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  onOpened: () => void;
}) {
  const formId = useId();
  const { current: idempotencyKey, renew: renewKey } = useIdempotencyKey();
  const keyedFor = useRef<string | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { name: '', cwd: '.' } });
  const { isDirty, errors } = form.formState;
  const openSession = useBffMutation<Values, unknown>({
    mutationFn: (values) => apiClient.request(bffPath('workspaces', workspaceId, 'sessions'), { method: 'POST', body: { ...values, idempotencyKey: idempotencyKey() } }),
    successToast: 'Session opened.',
    errorTitle: 'The session was not opened',
    onSuccess: () => { renewKey(); keyedFor.current = null; onOpened(); }
  });

  const isSubmitting = openSession.isPending;

  useEffect(() => {
    if (!open) return;
    form.reset({ name: '', cwd: '.' });
    // A reopened dialog is a new intent, even after a failed attempt.
    if (keyedFor.current !== null) renewKey();
    keyedFor.current = null;
  }, [form, open, renewKey]);

  /** Validates, then opens; a changed name or directory since the last attempt is a new intent. */
  async function submit() {
    if (!(await form.trigger())) { form.setFocus(form.getFieldState('name').invalid ? 'name' : 'cwd'); return; }
    const values = form.getValues();
    const intent = JSON.stringify([values.name, values.cwd]);
    if (keyedFor.current !== null && keyedFor.current !== intent) renewKey();
    keyedFor.current = intent;
    try {
      await openSession.mutateAsync(values);
      onOpenChange(false);
    } catch {
      // The mutation's toast explains; the typed values stay for a retry with the same key.
    }
  }

  return (
    <ManagedDialog open={open} onOpenChange={onOpenChange} guard={{ dirty: isDirty && !isSubmitting, locked: isSubmitting }}>
      <DialogHeader>
        <DialogTitle>Open coding session</DialogTitle>
        <DialogDescription>Sessions are named and bounded; close one when you are done with it.</DialogDescription>
      </DialogHeader>
      <form id={formId} className="grid gap-4" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Field label="Session name" error={errors.name?.message}>
          <Input autoFocus autoComplete="off" maxLength={80} {...form.register('name')} />
        </Field>
        <Field label="Working directory" description="Relative to the workspace root." error={errors.cwd?.message}>
          <Input autoComplete="off" maxLength={1_024} className="font-mono" {...form.register('cwd')} />
        </Field>
      </form>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={isSubmitting} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="submit" form={formId} disabled={isSubmitting} aria-busy={isSubmitting || undefined}>{isSubmitting ? 'Opening…' : 'Open session'}</Button>
      </DialogFooter>
    </ManagedDialog>
  );
}
