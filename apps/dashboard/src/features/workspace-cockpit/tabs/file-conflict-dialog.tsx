import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * The file conflict dialog (parity matrix D2). A save, patch or delete was refused because
 * the file changed after it was opened. The operator's text stays in the editor; they can
 * copy it, or load the latest version (which replaces the editor text). One controlled
 * Radix dialog, so a repeated conflict never stacks handlers (R11).
 */
export function FileConflictDialog({ open, onOpenChange, localContent, onReviewLatest }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What "Copy my changes" copies: the editor text, or the patch's two texts. */
  localContent: string;
  onReviewLatest: () => void;
}) {
  const [status, setStatus] = useState('');
  const changeOpen = (next: boolean) => { if (!next) setStatus(''); onOpenChange(next); };

  async function copy() {
    try {
      await navigator.clipboard.writeText(localContent);
      setStatus('Your changes were copied.');
    } catch {
      setStatus('The browser blocked clipboard access. Select the text in the editor and copy it manually.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>This file changed</DialogTitle>
          <DialogDescription>This item changed after you opened it. Your unsaved content is still in the editor.</DialogDescription>
        </DialogHeader>
        <p className="text-sm" role="status" aria-live="polite">{status}</p>
        <DialogFooter>
          <Button type="button" variant="outline" autoFocus onClick={() => changeOpen(false)}>Cancel</Button>
          <Button type="button" variant="outline" onClick={() => { void copy(); }}>Copy my changes</Button>
          <Button type="button" onClick={() => { changeOpen(false); onReviewLatest(); }}>Review latest</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
