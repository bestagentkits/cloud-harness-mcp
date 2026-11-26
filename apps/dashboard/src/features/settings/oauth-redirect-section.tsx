import { useState } from 'react';
import { DetailList } from '@/components/data/detail-list';
import { ActionButton, Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { mutationErrorText } from '@/lib/bff-mutation';
import { parseUriLines, presetState, type RedirectUrisView, removedUris, sameUris, togglePreset } from './oauth-redirect-model';
import { Callout } from './settings-feedback';
import { oauthRead, useConflictReload, useRedirectUrisWrite } from './settings-queries';

const CONFLICT_MESSAGE = 'The OAuth settings changed in the provider after you opened Settings. The panel now shows the current values; review them and save again.';

function flag(value: boolean | null, on: string, off: string): string {
  if (value === null) return 'Not set';
  return value ? on : off;
}

/**
 * The redirect allowlist for dynamic client registration: a new MCP client (Gemini, ChatGPT,
 * Claude) can connect only once its callback is listed. Presets fill in known callbacks; the
 * runner validates every line and the panel shows only what the provider confirmed. Callers
 * key it by the provider revision, so a save or reload resets the draft to the read-back.
 */
export function RedirectUrisPanel({ view, revision, onStatus }: { view: RedirectUrisView; revision: string | null; onStatus: (message: string) => void }) {
  const saved = view.uris ?? [];
  const [text, setText] = useState(saved.join('\n'));
  const [confirming, setConfirming] = useState(false);
  const write = useRedirectUrisWrite();
  const reloadOnConflict = useConflictReload(oauthRead().queryKey);
  const draft = parseUriLines(text);
  const removed = removedUris(saved, draft);
  const unchanged = sameUris(saved, draft);

  async function persist() {
    onStatus('Saving…');
    try {
      await write.mutateAsync({ uris: draft, expectedRevision: revision });
      onStatus('Redirect URIs saved and confirmed by the provider.');
    } catch (error) {
      onStatus(await reloadOnConflict(error) ? CONFLICT_MESSAGE : mutationErrorText(error));
      throw error;
    }
  }

  const facts = [
    { label: 'Dynamic client registration', value: flag(view.dynamicRegistrationEnabled, 'On', 'Off — clients cannot register themselves') },
    { label: 'Any localhost callback', value: flag(view.allowAnyOnLocalhost, 'Allowed', 'Not allowed') },
    { label: 'Any 127.0.0.1 callback', value: flag(view.allowAnyOnLoopback, 'Allowed', 'Not allowed') }
  ];

  return (
    <div className="grid gap-3 border-t pt-4" data-testid="oauth-redirect-uris">
      <div className="grid gap-1">
        <h3 className="text-sm font-semibold">Allowed redirect URIs</h3>
        <p className="text-sm text-muted-foreground">An MCP client connects only when its OAuth callback is listed here. A trailing <span className="font-mono">/*</span> matches every sub-path; an origin-wide wildcard is refused.</p>
      </div>
      <DetailList items={facts} />
      {view.readOnlyReason ? <Callout><p>{view.readOnlyReason}</p></Callout> : null}
      {view.canWrite
        ? (
          <>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Known clients</legend>
              {view.presets.map((preset) => {
                const state = presetState(preset, draft);
                const id = `oauth-preset-${preset.id}`;
                return (
                  <div key={preset.id} className="flex items-start gap-2">
                    <Checkbox
                      id={id}
                      checked={state === 'on' ? true : state === 'partial' ? 'indeterminate' : false}
                      onCheckedChange={(checked) => setText(togglePreset(draft, preset, checked === true).join('\n'))}
                    />
                    <label htmlFor={id} className="grid text-sm">
                      <span>{preset.label}{state === 'partial' ? ' (partly listed)' : ''}</span>
                      <span className="font-mono text-xs break-all text-muted-foreground">{preset.uris.join('  ')}</span>
                    </label>
                  </div>
                );
              })}
            </fieldset>
            <Field label="Redirect URIs (one per line)" description="Copy a client's exact callback from its connector dialog when it is not a known client.">
              <Textarea rows={Math.min(12, Math.max(4, draft.length + 1))} spellCheck={false} className="font-mono text-xs" value={text} onChange={(event) => setText(event.target.value)} />
            </Field>
            <div className="flex flex-wrap gap-2">
              {removed.length > 0
                // A removal is saved only from the confirmation dialog, so this button just opens it.
                ? <Button data-testid="save-oauth-redirect-uris" onClick={() => setConfirming(true)}>Save redirect URIs…</Button>
                : <ActionButton data-testid="save-oauth-redirect-uris" disabled={unchanged} pendingLabel="Saving…" successLabel="Saved" onAction={persist}>Save redirect URIs</ActionButton>}
            </div>
            <ConfirmDialog
              open={confirming}
              onOpenChange={setConfirming}
              title={`Remove ${removed.length} redirect URI${removed.length === 1 ? '' : 's'}?`}
              description="Clients that use these callbacks can no longer register or complete a new sign-in."
              details={<ul className="grid gap-1 rounded-md bg-muted px-2 py-1 font-mono text-xs break-all">{removed.map((uri) => <li key={uri}>{uri}</li>)}</ul>}
              confirmLabel="Save and remove"
              pendingLabel="Saving…"
              onConfirm={persist}
            />
          </>
        )
        : saved.length > 0
          ? <ul className="grid gap-1 font-mono text-xs break-all">{saved.map((uri) => <li key={uri}>{uri}</li>)}</ul>
          : view.readOnlyReason ? null : <p className="text-sm text-muted-foreground">{view.uris === null ? 'Not available.' : 'No redirect URIs are listed.'}</p>}
    </div>
  );
}
