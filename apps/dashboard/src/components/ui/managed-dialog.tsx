import { type ComponentProps, type ReactNode, useState } from 'react';
import { Button } from './button';
import { Dialog, DialogContent } from './dialog';

export type DialogGuard = {
  /** Unsaved input: dismissal (outside click, Escape, close button) asks before discarding. */
  dirty?: boolean;
  /** A destructive mutation is in flight: nothing dismisses the dialog until it settles. */
  locked?: boolean;
  /** A one-time reveal: only an explicit acknowledgement (calling `onOpenChange(false)` from the dialog's own button) closes it. */
  reveal?: boolean;
};

/**
 * The ADR 0005 dialog rules on top of Radix Dialog. By default a dialog dismisses on an
 * outside click and on Escape and restores focus to its invoker (Radix does both). The
 * guard narrows that: `locked` refuses every dismissal, `reveal` refuses everything but an
 * explicit acknowledgement, and `dirty` turns a dismissal into an inline "Discard changes?"
 * confirmation instead of silently losing input.
 */
export function ManagedDialog({
  open, onOpenChange, guard = {}, children, contentProps
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  guard?: DialogGuard;
  children: ReactNode;
  contentProps?: Omit<ComponentProps<typeof DialogContent>, 'children'>;
}) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const blocksAll = Boolean(guard.locked || guard.reveal);

  function requestClose() {
    if (blocksAll) return;
    if (guard.dirty) { setConfirmingDiscard(true); return; }
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else requestClose();
      }}
    >
      <DialogContent
        showCloseButton={!blocksAll}
        {...contentProps}
        aria-busy={guard.locked || undefined}
        onEscapeKeyDown={(event) => { if (blocksAll || guard.dirty) { event.preventDefault(); requestClose(); } contentProps?.onEscapeKeyDown?.(event); }}
        onInteractOutside={(event) => { if (blocksAll || guard.dirty) { event.preventDefault(); requestClose(); } contentProps?.onInteractOutside?.(event); }}
      >
        {children}
        {confirmingDiscard ? (
          <div role="alertdialog" aria-labelledby="discard-title" className="grid gap-2 rounded-md border border-warning/50 bg-surface p-3">
            <p id="discard-title" className="text-sm font-medium">Discard unsaved changes?</p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" autoFocus onClick={() => setConfirmingDiscard(false)}>Keep editing</Button>
              <Button size="sm" variant="destructive" onClick={() => { setConfirmingDiscard(false); onOpenChange(false); }}>Discard</Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
