import { useRef, useState } from 'react';
import { ActionButton, Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ManagedDialog } from '@/components/ui/managed-dialog';
import { toast } from '@/components/ui/toast-store';
import { mutationErrorText } from '@/lib/bff-mutation';
import { useOneTimeReveal } from '@/lib/one-time-reveal';
import { createGeminiClient, type GeminiClientCredentials, geminiRedirectUriProblem } from './gemini-client-model';

/**
 * The one-time reveal of a new Gemini client. Only "I have saved them" and Escape close it,
 * and the owner clears the credentials on every other exit (navigation, link click,
 * `pagehide`, session end). A failed copy clears them too, so a secret the operator could
 * not save is never left on screen.
 */
function GeminiClientRevealDialog({ credentials, onDismiss }: { credentials: GeminiClientCredentials | undefined; onDismiss: () => void }) {
  const [copied, setCopied] = useState<'id' | 'secret' | undefined>(undefined);
  function dismiss() { setCopied(undefined); onDismiss(); }
  async function copy(which: 'id' | 'secret') {
    if (!credentials) return;
    try {
      await navigator.clipboard.writeText(which === 'id' ? credentials.clientId : credentials.clientSecret);
      setCopied(which);
    } catch {
      dismiss();
      toast({ title: 'The client credentials could not be copied and were cleared.', description: 'Create another client.', variant: 'destructive' });
    }
  }
  return (
    <ManagedDialog
      open={credentials !== undefined}
      onOpenChange={(open) => { if (!open) dismiss(); }}
      guard={{ reveal: true }}
      contentProps={{ onEscapeKeyDown: () => dismiss(), 'data-testid': 'gemini-client-reveal-dialog' } as never}
    >
      <DialogHeader>
        <DialogTitle>Paste these into Gemini now</DialogTitle>
        <DialogDescription>In Gemini's connector dialog, open the advanced settings and paste both values. The secret is shown only this once and cannot be recovered; if you lose it, create another client.</DialogDescription>
      </DialogHeader>
      <Field label="OAuth client ID">
        <Input readOnly value={credentials?.clientId ?? ''} className="font-mono text-xs" autoComplete="off" spellCheck={false} onFocus={(event) => event.currentTarget.select()} />
      </Field>
      <Field label="OAuth client secret">
        <Input readOnly value={credentials?.clientSecret ?? ''} className="font-mono text-xs" autoComplete="off" spellCheck={false} data-reveal="oauth-client-secret" onFocus={(event) => event.currentTarget.select()} />
      </Field>
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
        {copied === 'id' ? 'Client ID copied.' : copied === 'secret' ? 'Client secret copied. Paste it into Gemini before copying anything else.' : ''}
      </p>
      <DialogFooter>
        <Button variant="outline" onClick={dismiss}>I have saved them</Button>
        <Button variant="outline" onClick={() => { void copy('id'); }}>{copied === 'id' ? 'Copied' : 'Copy client ID'}</Button>
        <Button autoFocus onClick={() => { void copy('secret'); }}>{copied === 'secret' ? 'Copied' : 'Copy client secret'}</Button>
      </DialogFooter>
    </ManagedDialog>
  );
}

/**
 * Connect Gemini: Gemini's own client registration fails against Cloudflare Access, so this
 * registers a client for one Google account's callback and shows its credentials once.
 */
export function GeminiClientSection({ onStatus }: { onStatus: (message: string) => void }) {
  const createButton = useRef<HTMLButtonElement>(null);
  const [redirectUri, setRedirectUri] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const reveal = useOneTimeReveal<GeminiClientCredentials>();

  async function create() {
    const problem = geminiRedirectUriProblem(redirectUri);
    setError(problem);
    if (problem) throw new Error(problem);
    onStatus('Creating the client…');
    try {
      const credentials = await createGeminiClient(redirectUri);
      setRedirectUri('');
      onStatus('Gemini client created. Copy its ID and secret now.');
      reveal.reveal(credentials);
    } catch (caught) {
      onStatus(mutationErrorText(caught));
      throw caught;
    }
  }

  return (
    <div className="grid gap-3 border-t pt-4" data-testid="gemini-client">
      <div className="grid gap-1">
        <h3 className="text-sm font-semibold">Connect Gemini</h3>
        <p className="text-sm text-muted-foreground">If Gemini reports that automatic registration failed and asks for a client ID and secret, create them here. First allow Gemini's callback: tick "Gemini custom apps" under Allowed redirect URIs, or add https://oauth-redirect.googleusercontent.com/r/* in Cloudflare Zero Trust. Each Google account has its own redirect URI, so each Gemini user creates their own client.</p>
      </div>
      {/* A form, so Enter after pasting the URI creates the client through the same action button. */}
      <form noValidate aria-label="Connect Gemini" className="grid gap-3" onSubmit={(event) => { event.preventDefault(); createButton.current?.click(); }}>
        <Field label="Gemini redirect URI" error={error} description='In the Gemini connector dialog, click "Copy redirect URI" and paste it here.'>
          <Input value={redirectUri} spellCheck={false} autoComplete="off" className="font-mono text-xs" placeholder="https://oauth-redirect.googleusercontent.com/r/…" onChange={(event) => { setRedirectUri(event.target.value); setError(undefined); }} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <ActionButton ref={createButton} data-testid="create-gemini-client" disabled={redirectUri.trim() === ''} pendingLabel="Creating…" successLabel="Created" onAction={create}>Create Gemini client</ActionButton>
        </div>
      </form>
      <GeminiClientRevealDialog credentials={reveal.value} onDismiss={reveal.clear} />
    </div>
  );
}
