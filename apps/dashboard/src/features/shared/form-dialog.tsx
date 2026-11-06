import type { FormEvent, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ManagedDialog } from '@/components/ui/managed-dialog';
import { cn } from '@/lib/utils';

/**
 * A dialog holding one form, with the ADR 0005 guards: unsaved input asks before it is
 * discarded, and a submit in flight cannot be dismissed. The form's error appears inside
 * the dialog (`role="alert"`), where the operator is looking, never behind the backdrop.
 */
export function FormDialog({
  open, onOpenChange, title, description, submitLabel, pendingLabel, pending, error, dirty, onSubmit, children, testId, wide, submitDisabled, extraActions
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  submitLabel: string;
  pendingLabel: string;
  pending: boolean;
  error?: string | undefined;
  dirty?: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
  testId?: string;
  wide?: boolean;
  submitDisabled?: boolean;
  extraActions?: ReactNode;
}) {
  return (
    <ManagedDialog
      open={open}
      onOpenChange={onOpenChange}
      guard={{ dirty: Boolean(dirty) && !pending, locked: pending }}
      contentProps={{ className: cn('max-h-[calc(100dvh-2rem)] overflow-y-auto', wide && 'sm:max-w-2xl'), ...(testId ? { 'data-testid': testId } : {}) } as never}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
      </DialogHeader>
      <form className="grid gap-4" noValidate onSubmit={onSubmit} aria-busy={pending || undefined}>
        {children}
        {error ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm" data-testid="form-error">{error}</p> : null}
        <DialogFooter>
          {extraActions}
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={pending || submitDisabled} aria-busy={pending || undefined}>{pending ? pendingLabel : submitLabel}</Button>
        </DialogFooter>
      </form>
    </ManagedDialog>
  );
}
