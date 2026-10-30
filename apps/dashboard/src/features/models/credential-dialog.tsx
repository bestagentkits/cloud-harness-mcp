import { useForm, useWatch } from 'react-hook-form';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SecretInput } from '@/components/ui/secret-input';
import { NativeSelect } from '@/components/ui/select';
import { mutationErrorText, useBffMutation } from '@/lib/bff-mutation';
import { FormDialog } from '../shared/form-dialog';
import { MODELS_READS, modelsApi } from './models-api';
import { AUTH_MODE_LABELS, providerAuthModes } from './models-queries';
import type { ModelProvider, ProviderCredential } from './models-types';

type Values = { label: string; provider: string; authMode: string; apiKey: string };

/**
 * Add or rotate a provider key (parity matrix D6). The key is write-only: it is cleared
 * from the field the moment the request is sent, so a failed save asks for it again, and
 * closing the dialog resets the form. Rotation sends only the new key and the credential's
 * fence; label, provider and auth header cannot change.
 */
export function CredentialDialog({ open, onOpenChange, credential, providers }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when rotating. */
  credential?: ProviderCredential | undefined;
  providers: readonly ModelProvider[];
}) {
  const rotate = credential !== undefined;
  const first = providers[0];
  const form = useForm<Values>({
    defaultValues: rotate
      ? { label: credential.label, provider: credential.provider, authMode: credential.authMode, apiKey: '' }
      : { label: '', provider: first?.id ?? 'openai', authMode: first?.defaultAuthMode ?? 'bearer', apiKey: '' }
  });
  const { errors, isDirty } = form.formState;
  const providerId = useWatch({ control: form.control, name: 'provider' });
  const provider = providers.find((entry) => entry.id === providerId);
  const authModes = providerAuthModes(provider);

  const mutation = useBffMutation<Values>({
    mutationFn: (values) => (rotate ? modelsApi.rotateCredential(credential, values.apiKey) : modelsApi.createCredential(values)),
    invalidate: MODELS_READS,
    successToast: rotate ? 'Provider credential rotated.' : 'Provider credential saved.'
  });

  function setOpen(next: boolean) {
    if (!next) {
      form.reset({ ...form.getValues(), apiKey: '' });
      mutation.reset();
    }
    onOpenChange(next);
  }

  const submit = form.handleSubmit(async (values) => {
    form.setValue('apiKey', '');
    try {
      await mutation.mutateAsync(values);
      setOpen(false);
    } catch { /* shown in the dialog */ }
  });

  return (
    <FormDialog
      testId="credential-dialog"
      open={open}
      onOpenChange={setOpen}
      title={rotate ? `Rotate credential (${credential.label})` : 'Add provider credential'}
      description="Configure an API key for subagent LLM providers. Values are write-only and encrypted."
      submitLabel={rotate ? 'Rotate key' : 'Save credential'}
      pendingLabel={rotate ? 'Rotating…' : 'Saving…'}
      pending={mutation.isPending}
      error={mutation.isError ? mutationErrorText(mutation.error) : undefined}
      dirty={isDirty}
      onSubmit={(event) => { void submit(event); }}
    >
      <Field label="Label" error={errors.label?.message}>
        <Input
          autoFocus={!rotate}
          disabled={rotate}
          maxLength={100}
          placeholder="e.g. Production OpenAI Key"
          {...form.register('label', { validate: (value) => (rotate || value.trim() ? true : 'Enter a label for the key.') })}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Provider">
          <NativeSelect
            disabled={rotate}
            {...form.register('provider', {
              onChange: (event: { target: { value: string } }) => {
                const next = providers.find((entry) => entry.id === event.target.value);
                form.setValue('authMode', next?.defaultAuthMode ?? 'bearer');
              }
            })}
          >
            {providers.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Auth header">
          <NativeSelect disabled={rotate} {...form.register('authMode')}>
            {(rotate ? [credential.authMode] : authModes).map((mode) => <option key={mode} value={mode}>{AUTH_MODE_LABELS[mode] ?? mode}</option>)}
          </NativeSelect>
        </Field>
      </div>
      <Field label={rotate ? 'New API key (write-only)' : 'API key (write-only)'} error={errors.apiKey?.message} description="Encrypted on the server and never shown again.">
        <SecretInput autoFocus={rotate} placeholder="sk-..." {...form.register('apiKey', { validate: (value) => (value.trim() ? true : 'Paste the API key.') })} />
      </Field>
    </FormDialog>
  );
}
