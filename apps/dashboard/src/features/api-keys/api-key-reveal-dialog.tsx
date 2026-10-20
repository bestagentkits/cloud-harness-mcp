import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ManagedDialog } from '@/components/ui/managed-dialog';
import { toast } from '@/components/ui/toast-store';

/**
 * Parity matrix D3: the one-time reveal of a new API key. Only "I have saved it" and
 * Escape close it (an outside click does not), and the owner clears the key on every
 * other exit (navigation, link click, `pagehide`, session end). A failed copy clears the
 * key too, so a key the operator could not save is never left on screen.
 */
export function ApiKeyRevealDialog({ apiKey, onDismiss }: { apiKey: string | undefined; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  function dismiss() { setCopied(false); onDismiss(); }
  async function copy() {
    if (!apiKey) return;
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
    } catch {
      dismiss();
      toast({ title: 'The API key could not be copied and was cleared.', description: 'Create a replacement key.', variant: 'destructive' });
    }
  }
  return (
    <ManagedDialog
      open={apiKey !== undefined}
      onOpenChange={(open) => { if (!open) dismiss(); }}
      guard={{ reveal: true }}
      contentProps={{ onEscapeKeyDown: () => dismiss(), 'data-testid': 'api-key-reveal-dialog' } as never}
    >
      <DialogHeader>
        <DialogTitle>Copy this API key now</DialogTitle>
        <DialogDescription>This is the only time the complete key will be shown. It cannot be recovered later. Anyone with it has full MCP access, including arbitrary command execution as your identity.</DialogDescription>
      </DialogHeader>
      <Field label="New API key">
        <Input readOnly value={apiKey ?? ''} className="font-mono text-xs" autoComplete="off" spellCheck={false} data-reveal="api-key" onFocus={(event) => event.currentTarget.select()} />
      </Field>
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-muted-foreground">{copied ? 'API key copied. Save it before closing this window.' : ''}</p>
      <DialogFooter>
        <Button variant="outline" onClick={dismiss}>I have saved it</Button>
        <Button autoFocus onClick={() => { void copy(); }}>{copied ? 'Copied' : 'Copy API key'}</Button>
      </DialogFooter>
    </ManagedDialog>
  );
}
