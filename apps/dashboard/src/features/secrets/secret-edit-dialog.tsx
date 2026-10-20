import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Field } from '@/components/ui/field';
import { SecretInput } from '@/components/ui/secret-input';
import { Textarea } from '@/components/ui/textarea';
import { mutationErrorText, useBffMutation } from '@/lib/bff-mutation';
import { FormDialog } from '../shared/form-dialog';
import { SECRET_DESCRIPTION_MAX, type SecretReference, secretValueError } from './secret-model';
import { type SecretScope, secretsApi, secretsPath } from './secrets-api';

export type SecretEditMode = 'rotate' | 'describe';
type Values = { value: string; description: string };

/**
 * Rotate a secret's value (with an optional new description) or edit only its
 * description. Both carry the row's generation, so a change made elsewhere since the page
 * loaded is refused with 409 and the list refetches.
 */
export function SecretEditDialog({ scope, secret, mode, onClose }: { scope: SecretScope; secret: SecretReference | undefined; mode: SecretEditMode; onClose: () => void }) {
  const global = scope.kind === 'global';
  const form = useForm<Values>({ defaultValues: { value: '', description: '' } });
  const { errors, isDirty } = form.formState;
  useEffect(() => {
    if (secret) form.reset({ value: '', description: mode === 'describe' ? secret.description ?? '' : '' });
  }, [form, mode, secret]);

  const mutation = useBffMutation<{ target: SecretReference } & Values>({
    mutationFn: ({ target, value, description }) => (mode === 'rotate' ? secretsApi.rotate(scope, target, { value, description }) : secretsApi.describe(scope, target, description)),
    invalidate: [secretsPath(scope)],
    successToast: mode === 'rotate'
      ? (global ? 'Global secret rotated. Value was not retained in the page.' : 'Secret rotated. Value was not retained in the page.')
      : (global ? 'Global secret description updated.' : 'Secret description updated.')
  });

  function setOpen(next: boolean) {
    if (next) return;
    form.reset({ value: '', description: '' });
    mutation.reset();
    onClose();
  }

  const submit = form.handleSubmit(async (values) => {
    if (!secret) return;
    form.setValue('value', '');
    try {
      await mutation.mutateAsync({ target: secret, ...values });
      setOpen(false);
    } catch { /* shown in the dialog */ }
  });

  const rotate = mode === 'rotate';
  return (
    <FormDialog
      testId="secret-edit-dialog"
      open={secret !== undefined}
      onOpenChange={setOpen}
      title={rotate ? `Rotate ${secret?.name ?? 'secret'}` : `Edit description of ${secret?.name ?? 'secret'}`}
      description={rotate ? 'The new value replaces the current one for future workspace opens. Running workspaces keep the value they started with.' : 'Descriptions are shown to operators and exported in .env.example files.'}
      submitLabel={rotate ? 'Rotate' : 'Save description'}
      pendingLabel={rotate ? 'Rotating…' : 'Saving…'}
      pending={mutation.isPending}
      error={mutation.isError ? mutationErrorText(mutation.error) : undefined}
      dirty={isDirty}
      onSubmit={(event) => { void submit(event); }}
    >
      {rotate ? (
        <Field label="New write-only value" error={errors.value?.message}>
          <SecretInput autoFocus {...form.register('value', { validate: (value) => secretValueError(value) ?? true })} />
        </Field>
      ) : null}
      <Field label={rotate ? 'New description' : 'Description'} optional={rotate} description={rotate ? 'Leave empty to keep the current description.' : 'Leave empty to clear it.'}>
        <Textarea rows={2} maxLength={SECRET_DESCRIPTION_MAX} {...form.register('description')} />
      </Field>
    </FormDialog>
  );
}
