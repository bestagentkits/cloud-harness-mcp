import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useId } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ManagedDialog } from '@/components/ui/managed-dialog';
import { NAME_MAX, nameSchema, type NameValues } from './project-model';

/**
 * The one-field name form behind "New project", "Rename project", "New environment" and
 * "Rename environment". The form resets every time it opens, an edited form asks before an
 * accidental dismissal discards it, and nothing dismisses it while the request is in flight.
 * A failed submit keeps the dialog and the typed name; the mutation's toast explains why.
 */
export function NameDialog({ open, onOpenChange, title, description, label, submitLabel, pendingLabel, initialName = '', onSubmit }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  label: string;
  submitLabel: string;
  pendingLabel: string;
  initialName?: string;
  /** Resolves when the server accepted the name; the dialog then closes. */
  onSubmit: (name: string) => Promise<unknown>;
}) {
  const formId = useId();
  const form = useForm<NameValues>({ resolver: zodResolver(nameSchema), defaultValues: { name: initialName } });
  const { isDirty, isSubmitting, errors } = form.formState;

  useEffect(() => {
    if (open) form.reset({ name: initialName });
  }, [form, initialName, open]);

  const submit = form.handleSubmit(async ({ name }) => {
    try {
      await onSubmit(name);
      onOpenChange(false);
    } catch {
      // Reported by the mutation's toast; the operator keeps the typed name to retry.
    }
  });

  return (
    <ManagedDialog open={open} onOpenChange={onOpenChange} guard={{ dirty: isDirty && !isSubmitting, locked: isSubmitting }}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <form id={formId} className="grid gap-4" noValidate onSubmit={(event) => { void submit(event); }}>
        <Field label={label} error={errors.name?.message}>
          <Input autoFocus autoComplete="off" maxLength={NAME_MAX} {...form.register('name')} />
        </Field>
      </form>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={isSubmitting} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="submit" form={formId} disabled={isSubmitting} aria-busy={isSubmitting || undefined}>{isSubmitting ? pendingLabel : submitLabel}</Button>
      </DialogFooter>
    </ManagedDialog>
  );
}
