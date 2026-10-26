import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ManagedDialog } from '@/components/ui/managed-dialog';

export type ConflictVersion = { generation: number | undefined; content: string };

function Pane({ title, content, busy }: { title: string; content: string | undefined; busy?: boolean }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid min-w-0 content-start gap-1.5">
      <h3 id={id} className="text-sm font-medium">{title}</h3>
      <pre aria-busy={busy || undefined} className="max-h-64 min-h-24 overflow-auto rounded-md border bg-muted p-2 font-mono text-xs whitespace-pre-wrap break-words">
        {content === undefined ? (busy ? 'Loading the server version…' : 'Not available.') : content || '(empty)'}
      </pre>
    </section>
  );
}

/**
 * The save conflict (parity D8): the entry changed on the server after the editor loaded
 * it. The base, current server and "your changes" versions sit side by side. Closing the
 * dialog (Escape, Cancel) always keeps the draft; "Load server version" replaces it only
 * after a second, explicit confirmation (R10), and "Copy my changes" saves it to the
 * clipboard first.
 */
export function KnowledgeConflictDialog({ open, onOpenChange, base, server, serverError, draft, onLoadServer }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `content` is unknown for a draft restored onto an older generation. */
  base: { generation: number | undefined; content: string | undefined };
  /** Undefined while the server version loads. */
  server: ConflictVersion | undefined;
  serverError: boolean;
  draft: string;
  onLoadServer: (server: ConflictVersion) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const confirmId = useId();
  const change = (next: boolean) => {
    if (!next) setConfirming(false);
    onOpenChange(next);
  };

  return (
    <ManagedDialog open={open} onOpenChange={change} contentProps={{ className: 'sm:max-w-4xl' }}>
      <DialogHeader>
        <DialogTitle>This entry changed elsewhere</DialogTitle>
        <DialogDescription>
          Your save was not applied: someone updated the entry after you opened it. Your draft is still in the editor. Compare the versions, copy your changes if you need them, then decide.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3 md:grid-cols-3">
        <Pane title={`Base version (generation ${base.generation ?? '—'})`} content={base.content} />
        <Pane title={server ? `Current on server (generation ${server.generation ?? '—'})` : 'Current on server'} content={server?.content} busy={!server && !serverError} />
        <Pane title="Your changes (unsaved)" content={draft} />
      </div>
      {serverError ? <p role="alert" className="text-sm text-destructive">The server version could not load. Keep your draft and try saving again later.</p> : null}
      {confirming && server ? (
        <div role="alertdialog" aria-labelledby={confirmId} className="grid gap-2 rounded-md border border-warning/50 bg-surface p-3">
          <p id={confirmId} className="text-sm font-medium">Discard your draft and load the server version? Your unsaved changes will be lost.</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" autoFocus onClick={() => setConfirming(false)}>Cancel</Button>
            <Button size="sm" variant="destructive" onClick={() => { setConfirming(false); onLoadServer(server); }}>Discard draft and load</Button>
          </div>
        </div>
      ) : null}
      <DialogFooter className="flex-wrap">
        <Button variant="outline" autoFocus onClick={() => change(false)}>Keep my draft</Button>
        <CopyButton value={draft} label="Copy my changes" className="h-control px-3 text-sm" />
        <Button variant="secondary" disabled={!server || confirming} onClick={() => setConfirming(true)}>Load server version</Button>
      </DialogFooter>
    </ManagedDialog>
  );
}
