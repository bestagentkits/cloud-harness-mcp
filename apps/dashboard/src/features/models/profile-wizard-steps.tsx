import type { ReactNode, RefObject } from 'react';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SecretInput } from '@/components/ui/secret-input';
import { NativeSelect } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { plural } from '../shared/format';
import { verificationLabel } from './models-pricing';
import { providerAuthModes } from './models-queries';
import type { ModelProvider, ProviderCredential } from './models-types';
import { type WizardState, selectProvider, setField } from './models-wizard-state';

export type WizardStepProps = {
  state: WizardState;
  update: (change: (state: WizardState) => WizardState) => void;
  provider: ModelProvider | undefined;
  providers: readonly ModelProvider[];
  credentials: readonly ProviderCredential[];
  errors: Record<string, string>;
  busy: boolean;
};

/** A radio rendered as a selectable card; the native input keeps keyboard and screen-reader behaviour. */
export function ChoiceCard({ name, value, checked, disabled, onSelect, title, note, meta }: {
  name: string; value: string; checked: boolean; disabled?: boolean; onSelect: () => void; title: ReactNode; note?: ReactNode; meta?: ReactNode;
}) {
  return (
    <label className={cn('flex cursor-pointer gap-3 rounded-lg border p-3 text-sm has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50', checked && 'border-primary bg-primary/5', disabled && 'cursor-not-allowed opacity-60')}>
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={onSelect} className="mt-0.5 size-4 accent-primary" />
      <span className="grid gap-0.5">
        <span className="font-medium">{title}</span>
        {note ? <span className="text-muted-foreground">{note}</span> : null}
        {meta ? <span className="text-xs text-muted-foreground">{meta}</span> : null}
      </span>
    </label>
  );
}

export function ProviderStep({ state, update, providers, credentials, errors }: WizardStepProps) {
  return (
    <fieldset className="grid gap-2 sm:grid-cols-2" aria-describedby={errors.provider ? 'wizard-provider-error' : undefined}>
      <legend className="sr-only">Provider</legend>
      {providers.map((entry) => {
        const saved = credentials.filter((credential) => credential.provider === entry.id && credential.status === 'ACTIVE').length;
        return (
          <ChoiceCard
            key={entry.id}
            name="provider"
            value={entry.id}
            checked={state.provider === entry.id}
            onSelect={() => update((current) => selectProvider(current, entry.id, entry, credentials))}
            title={entry.displayName}
            note={entry.description}
            meta={saved ? `${plural(saved, 'saved key')}` : 'No saved key yet'}
          />
        );
      })}
      {errors.provider ? <p id="wizard-provider-error" role="alert" className="text-xs text-destructive sm:col-span-2">{errors.provider}</p> : null}
    </fieldset>
  );
}

const AUTH_HEADER_LABELS: Record<string, string> = { bearer: 'Authorization: Bearer', 'x-api-key': 'X-API-Key' };

/**
 * Choose a saved key or add one. A new key is typed into an uncontrolled write-only input
 * owned by the wizard (`keyRef`): it never enters wizard state, React state or storage, and
 * the wizard clears it once the server has stored it.
 */
export function ConnectStep({ state, update, provider, credentials, errors, keyRef }: WizardStepProps & { keyRef: RefObject<HTMLInputElement | null> }) {
  const saved = credentials.filter((credential) => credential.provider === state.provider && credential.status === 'ACTIVE');
  const authModes = providerAuthModes(provider);
  const name = provider?.displayName ?? state.provider;
  return (
    <div className="grid gap-4">
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="sr-only">Key</legend>
        <ChoiceCard name="credentialChoice" value="saved" checked={state.credentialChoice === 'saved'} disabled={!saved.length} onSelect={() => update((current) => ({ ...current, credentialChoice: 'saved', credentialId: current.credentialId || saved[0]?.id || '' }))} title="Use a saved key" note={saved.length ? undefined : '(none saved for this provider)'} />
        <ChoiceCard name="credentialChoice" value="new" checked={state.credentialChoice === 'new'} onSelect={() => update((current) => ({ ...current, credentialChoice: 'new' }))} title="Add a new key" />
      </fieldset>
      {state.credentialChoice === 'saved' && saved.length ? (
        <Field label="Saved key" error={errors.credentialId}>
          <NativeSelect value={state.credentialId} onChange={(event) => update((current) => ({ ...current, credentialId: event.target.value }))}>
            {saved.map((credential) => (
              <option key={credential.id} value={credential.id}>
                {`${credential.label} · v${credential.activeVersion}${credential.lastVerification ? ` · key ${verificationLabel(credential.lastVerification.outcome).toLowerCase()}` : ''}`}
              </option>
            ))}
          </NativeSelect>
        </Field>
      ) : null}
      {state.credentialChoice === 'new' ? (
        <div className="grid gap-4">
          <Field label="Label" error={errors.newCredentialLabel}>
            <Input maxLength={100} placeholder={`e.g. ${name} production`} value={state.newCredentialLabel} onChange={(event) => update((current) => setField(current, 'newCredentialLabel', event.target.value))} />
          </Field>
          {authModes.length > 1 ? (
            <Field label="Auth header">
              <NativeSelect value={state.newCredentialAuthMode || provider?.defaultAuthMode || authModes[0]} onChange={(event) => update((current) => ({ ...current, newCredentialAuthMode: event.target.value }))}>
                {authModes.map((mode) => <option key={mode} value={mode}>{AUTH_HEADER_LABELS[mode] ?? mode}</option>)}
              </NativeSelect>
            </Field>
          ) : null}
          <Field label="API key (write-only)" error={errors.apiKey} description="The key is encrypted on the server when you continue and is never shown again.">
            <SecretInput ref={keyRef} placeholder="sk-..." data-testid="wizard-api-key" />
          </Field>
          {provider?.apiKeyUrl?.startsWith('https://') ? (
            <p className="text-xs"><a href={provider.apiKeyUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">Create a key in the {name} console.</a></p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
