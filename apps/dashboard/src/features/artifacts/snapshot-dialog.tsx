import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useId } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ManagedDialog } from '@/components/ui/managed-dialog';
import { snapshotSchema, type SnapshotValues } from './artifacts-model';

const EMPTY_VALUES: SnapshotValues = { workspaceId: '', path: '', logicalName: '', retentionSeconds: '' };

/**
 * "Create snapshot": copies one workspace file into retained, bounded storage. The form
 * resets on open, asks before an edited form is dismissed, and stays open with the typed
 * values when the server refuses (the mutation's toast explains).
 */
export function SnapshotDialog({ open, onOpenChange, onSubmit }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: SnapshotValues) => Promise<unknown>;
}) {
  const formId = useId();
  const form = useForm<SnapshotValues>({ resolver: zodResolver(snapshotSchema), defaultValues: EMPTY_VALUES });
  const { isDirty, isSubmitting, errors } = form.formState;
  useEffect(() => { if (open) form.reset(EMPTY_VALUES); }, [form, open]);
  const submit = form.handleSubmit(async (values) => {
    try {
      await onSubmit(values);
      onOpenChange(false);
    } catch {
      // Reported by the mutation's toast; the typed values stay for a retry.
    }
  });
  return (
    <ManagedDialog open={open} onOpenChange={onOpenChange} guard={{ dirty: isDirty && !isSubmitting, locked: isSubmitting }}>
      <DialogHeader>
        <DialogTitle>Create snapshot</DialogTitle>
        <DialogDescription>Copy one workspace file into retained, bounded storage. The snapshot expires at the retention you set, or at the server default.</DialogDescription>
      </DialogHeader>
      <form id={formId} className="grid gap-4" noValidate onSubmit={(event) => { void submit(event); }}>
        <Field label="Workspace ID" error={errors.workspaceId?.message}>
          <Input autoFocus autoComplete="off" maxLength={83} className="font-mono" {...form.register('workspaceId')} />
        </Field>
        <Field label="Workspace path" description="Relative to the workspace root." error={errors.path?.message}>
          <Input autoComplete="off" maxLength={1_024} className="font-mono" {...form.register('path')} />
        </Field>
        <Field label="Logical name" error={errors.logicalName?.message}>
          <Input autoComplete="off" maxLength={128} {...form.register('logicalName')} />
        </Field>
        <Field label="Retention in seconds" optional description="60 to 2592000 (30 days). Empty uses the server default." error={errors.retentionSeconds?.message}>
          <Input autoComplete="off" inputMode="numeric" placeholder="Use server default" {...form.register('retentionSeconds')} />
        </Field>
      </form>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={isSubmitting} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="submit" form={formId} disabled={isSubmitting} aria-busy={isSubmitting || undefined}>{isSubmitting ? 'Creating snapshot…' : 'Create retained snapshot'}</Button>
      </DialogFooter>
    </ManagedDialog>
  );
}
