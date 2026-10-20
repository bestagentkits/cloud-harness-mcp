import { useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { DetailList } from '@/components/data/detail-list';
import { Section } from '@/components/data/section';
import { ActionButton } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { mutationErrorMessage } from '@/lib/bff-mutation';
import type { BffEnvelope } from '@/lib/bff-query';
import { formatDateTime } from '@/lib/format';
import {
  canAdoptDefault, CUSTOM_GRANT, grantFact, MANAGEMENT_LABELS, maximumLabel, oauthAdoptInput, oauthDefaults, oauthDurationLabel, oauthSchema,
  type OAuthUpdate, oauthUpdateInput, type OAuthValues, type OAuthView, readOAuthView, tokenFact
} from './oauth-model';
import { Callout, SectionRead, StatusLine } from './settings-feedback';
import { oauthRead, useConflictReload, useOAuthWrite } from './settings-queries';

const UNAVAILABLE = 'OAuth session settings are temporarily unavailable.';
const CONFLICT_MESSAGE = 'The OAuth settings changed in the provider after you opened Settings. The panel now shows the current values; review them and save again.';

function facts(view: OAuthView) {
  const { management, effective, lastSync } = view;
  const managedNote = management.updatedAt
    ? ` — ${management.updatedBy === 'startup-default' ? 'default applied automatically at first start' : 'last saved here'} ${formatDateTime(management.updatedAt)}`
    : '';
  return [
    { label: 'Provider', value: view.provider.label },
    { label: 'Stay signed in', value: effective?.grantIsProviderMaximum ? 'On — provider maximum' : effective ? 'Custom duration' : 'Not available' },
    { label: 'Grant duration (effective)', value: grantFact(view) },
    { label: 'Access-token lifetime (effective)', value: tokenFact(view) },
    { label: 'Management', value: `${management.state ? MANAGEMENT_LABELS[management.state] : 'Unknown'}${managedNote}` },
    {
      label: 'Last provider sync',
      value: lastSync
        ? <>{formatDateTime(lastSync.at)} — {lastSync.ok ? 'OK' : <>failed (<span className="font-mono">{lastSync.errorCode ?? 'unknown'}</span>)</>}</>
        : 'Never'
    }
  ];
}

/**
 * The grant and token-lifetime form, shown only when the provider lets Cloud Harness write.
 * It follows the provider read-back (`values`), so a save's answer resets it to what the
 * provider confirmed rather than to what was sent.
 */
function OAuthForm({ view, onStatus, reload }: { view: OAuthView; onStatus: (message: string) => void; reload: () => Promise<unknown> }) {
  const saveButton = useRef<HTMLButtonElement>(null);
  const defaults = useMemo(() => oauthDefaults(view), [view]);
  const schema = useMemo(() => oauthSchema(view), [view]);
  const form = useForm<OAuthValues>({ resolver: zodResolver(schema), values: defaults });
  const write = useOAuthWrite();
  const reloadOnConflict = useConflictReload(oauthRead().queryKey);
  const persistent = useWatch({ control: form.control, name: 'persistent' });
  const grant = useWatch({ control: form.control, name: 'grant' });
  const errors = form.formState.errors;
  const bounds = view.capabilities.tokenLifetime;
  const minHours = Math.ceil(view.capabilities.minGrantSeconds / 3_600);
  const maxHours = view.capabilities.maxGrantSeconds ? Math.floor(view.capabilities.maxGrantSeconds / 3_600) : undefined;

  async function persist(body: OAuthUpdate, savedMessage: string) {
    onStatus('Saving…');
    try {
      await write.mutateAsync(body);
      onStatus(savedMessage);
    } catch (error) {
      onStatus(await reloadOnConflict(error) ? CONFLICT_MESSAGE : mutationErrorMessage(error));
      throw error;
    }
  }

  async function save() {
    const captured: { values?: OAuthValues } = {};
    await form.handleSubmit((values) => { captured.values = values; })();
    const { errors: saveErrors, body } = oauthUpdateInput(view, captured.values ?? form.getValues());
    if (!captured.values || !body) {
      const message = Object.values(saveErrors)[0] ?? 'Fix the highlighted fields before saving.';
      onStatus(message);
      throw new Error(message);
    }
    await persist(body, 'OAuth settings saved and confirmed by the provider.');
  }

  return (
    <form noValidate aria-label="MCP OAuth sessions" className="grid gap-4" onSubmit={(event) => { event.preventDefault(); saveButton.current?.click(); }}>
      <Controller
        control={form.control}
        name="persistent"
        render={({ field }) => (
          <div className="flex items-center gap-2">
            <Checkbox id="oauth-persistent" ref={field.ref} checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} onBlur={field.onBlur} />
            <label htmlFor="oauth-persistent" className="text-sm">Stay signed in — use the provider maximum ({maximumLabel(view)})</label>
          </div>
        )}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Grant duration" error={errors.grant?.message}>
          <NativeSelect disabled={persistent} {...form.register('grant')}>
            {view.capabilities.grantPresetsSeconds.map((seconds) => <option key={seconds} value={String(seconds)}>{oauthDurationLabel(seconds)}</option>)}
            <option value={CUSTOM_GRANT}>Custom</option>
          </NativeSelect>
        </Field>
        <Field label="Custom duration (hours)" error={errors.customHours?.message}>
          <Input type="number" inputMode="numeric" step={1} min={minHours} max={maxHours} disabled={persistent || grant !== CUSTOM_GRANT} {...form.register('customHours')} />
        </Field>
      </div>
      <Field
        label="Access-token lifetime (minutes)"
        error={errors.tokenMinutes?.message}
        description={`Keep this short. ${oauthDurationLabel(bounds.defaultSeconds)} is the default; a longer token does not reduce sign-ins, it only delays policy re-checks.`}
      >
        <Input type="number" inputMode="numeric" step={1} min={bounds.minSeconds / 60} max={bounds.maxSeconds / 60} className="max-w-48" {...form.register('tokenMinutes')} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <ActionButton ref={saveButton} data-testid="save-oauth" pendingLabel="Saving…" successLabel="Saved" onAction={save}>Save OAuth settings</ActionButton>
        {canAdoptDefault(view)
          ? <ActionButton variant="outline" pendingLabel="Saving…" successLabel="Adopted" onAction={() => persist(oauthAdoptInput(view), 'Default adopted: clients stay signed in for the provider maximum.')}>Adopt default: stay signed in, {oauthDurationLabel(bounds.defaultSeconds)} tokens</ActionButton>
          : null}
        <ReloadButton reload={reload} />
      </div>
    </form>
  );
}

function ReloadButton({ reload }: { reload: () => Promise<unknown> }) {
  return <ActionButton variant="outline" pendingLabel="Reloading…" successLabel="Reloaded" onAction={reload}>Reload from provider</ActionButton>;
}

/**
 * MCP OAuth sessions: how long an MCP client stays connected after one sign-in. A provider
 * outage fails into this panel only, never the rest of Settings.
 */
export function OAuthSection() {
  const query = useQuery(oauthRead());
  const [status, setStatus] = useState('');

  async function reload() {
    setStatus('Reloading…');
    const result = await query.refetch();
    if (result.isError) {
      const message = mutationErrorMessage(result.error);
      setStatus(message);
      throw new Error(message);
    }
    setStatus('Reloaded from the provider.');
  }

  return (
    <Section
      id="settings-oauth"
      title="MCP OAuth sessions"
      description="How long an MCP client such as ChatGPT or Claude stays connected after one sign-in. Access tokens stay short and refresh silently; every refresh re-checks your access policy, so revoking access still takes effect at the next refresh. This is separate from the browser session for this dashboard."
    >
      <SectionRead query={query} what="OAuth session settings">
        {(body) => {
          const view = readOAuthView((body as BffEnvelope<unknown> | undefined)?.data);
          if (!view) return <Callout><p>{UNAVAILABLE}</p></Callout>;
          return (
            <>
              <DetailList items={facts(view)} />
              {view.readOnlyReason ? <Callout><p>{view.readOnlyReason}</p></Callout> : null}
              {view.capabilities.canWriteGrantConfiguration
                ? <OAuthForm view={view} onStatus={setStatus} reload={reload} />
                : view.provider.id !== 'none' ? <div><ReloadButton reload={reload} /></div> : null}
            </>
          );
        }}
      </SectionRead>
      <StatusLine testId="oauth-status" message={status} />
    </Section>
  );
}
