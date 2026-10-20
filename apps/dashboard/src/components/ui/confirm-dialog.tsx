import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';
import { type ReactNode, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from './button';

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  /** What the action targets (a workspace id, a key name), shown in monospace. */
  target?: string;
  confirmLabel: string;
  pendingLabel?: string;
  destructive?: boolean;
  /** The confirmed action. While it runs the dialog cannot be dismissed. */
  onConfirm: () => Promise<unknown>;
  /** A failure closes the dialog; the page reports it through this callback (its page alert). */
  onError?: (error: unknown) => void;
};

/**
 * Confirmation for consequential actions (parity matrix D1). Cancel takes initial focus and
 * Escape cancels, so the safe choice is always the default; the confirm button shows its
 * pending label and the dialog refuses dismissal while the action is in flight, so a
 * destructive mutation is never abandoned half-way. Focus returns to the invoker on close.
 */
export function ConfirmDialog({
  open, onOpenChange, title, description, target, confirmLabel, pendingLabel = 'Working…', destructive = true, onConfirm, onError
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (error) {
      onOpenChange(false);
      onError?.(error);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <AlertDialogPrimitive.Content
          aria-busy={pending || undefined}
          onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }}
          className="fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border bg-popover p-6 text-popover-foreground shadow-lg outline-none duration-(--motion-base) data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-md"
        >
          <AlertDialogPrimitive.Title className="text-lg font-semibold">{title}</AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description className="text-sm text-muted-foreground">{description}</AlertDialogPrimitive.Description>
          {target ? <p className="rounded-md bg-muted px-2 py-1 font-mono text-xs break-all">{target}</p> : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialogPrimitive.Cancel className={cn(buttonVariants({ variant: 'outline' }))} disabled={pending}>Cancel</AlertDialogPrimitive.Cancel>
            {/* Not AlertDialog.Action: that closes immediately, before the action settles. */}
            <Button variant={destructive ? 'destructive' : 'default'} aria-busy={pending || undefined} disabled={pending} onClick={() => { void confirm(); }}>
              {pending ? pendingLabel : confirmLabel}
            </Button>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
