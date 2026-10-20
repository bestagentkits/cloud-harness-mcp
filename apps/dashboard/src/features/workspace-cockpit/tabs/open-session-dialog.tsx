import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useId } from 'react';
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
 * Opens a named coding session. One idempotency key per intent: a retry after a failure
 * reuses it (the runner answers the first attempt's session), and it renews only after a
 * success, so the next session is a new intent.
 */
export function OpenSessionDialog({ open, onOpenChange, workspaceId, onOpened }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  onOpened: () => void;
}) {
  const formId = useId();
  const idempotency = useIdempotencyKey();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { name: '', cwd: '.' } });
  const { isDirty, isSubmitting, errors } = form.formState;
  const openSession = useBffMutation<Values, unknown>({
    mutationFn: (values) => apiClient.request(bffPath('workspaces', workspaceId, 'sessions'), { method: 'POST', body: { ...values, idempotencyKey: idempotency.current() } }),
    successTitle: 'Session opened.',
    errorTitle: 'The session was not opened',
    onSuccess: () => { idempotency.renew(); onOpened(); }
  });

  useEffect(() => {
    if (open) form.reset({ name: '', cwd: '.' });
  }, [form, open]);

  const submit = form.handleSubmit(async (values) => {
    try {
      await openSession.mutateAsync(values);
      onOpenChange(false);
    } catch {
      // The mutation's toast explains; the typed values stay for a retry with the same key.
    }
  });

  return (
    <ManagedDialog open={open} onOpenChange={onOpenChange} guard={{ dirty: isDirty && !isSubmitting, locked: isSubmitting }}>
      <DialogHeader>
        <DialogTitle>Open coding session</DialogTitle>
        <DialogDescription>Sessions are named and bounded; close one when you are done with it.</DialogDescription>
      </DialogHeader>
      <form id={formId} className="grid gap-4" noValidate onSubmit={(event) => { void submit(event); }}>
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
