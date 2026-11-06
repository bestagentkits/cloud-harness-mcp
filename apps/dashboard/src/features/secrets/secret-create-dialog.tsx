import { useForm } from 'react-hook-form';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SecretInput } from '@/components/ui/secret-input';
import { Textarea } from '@/components/ui/textarea';
import { mutationErrorText, useBffMutation } from '@/lib/bff-mutation';
import { FormDialog } from '../shared/form-dialog';
import { SECRET_DESCRIPTION_MAX, secretNameError, secretValueError } from './secret-model';
import { type SecretScope, secretsApi, secretsPath } from './secrets-api';

type Values = { name: string; value: string; description: string };
const EMPTY: Values = { name: '', value: '', description: '' };

/**
 * Create a secret reference. The value is write-only: it leaves the form state before the
 * request is sent (a failed save asks for it again), the form keeps no draft, and closing
 * the dialog resets every field.
 */
export function SecretCreateDialog({ scope, open, onOpenChange }: { scope: SecretScope; open: boolean; onOpenChange: (open: boolean) => void }) {
  const global = scope.kind === 'global';
  const form = useForm<Values>({ defaultValues: EMPTY });
  const { errors, isDirty } = form.formState;
  const mutation = useBffMutation<Values>({
    mutationFn: (values) => secretsApi.create(scope, values),
    invalidate: [secretsPath(scope)],
    successToast: global ? 'Global secret created. Value was not retained in the page.' : 'Secret reference created. Value was not retained in the page.'
  });

  function setOpen(next: boolean) {
    if (!next) { form.reset(EMPTY); mutation.reset(); }
    onOpenChange(next);
  }

  const submit = form.handleSubmit(async (values) => {
    form.setValue('value', '');
    try {
      await mutation.mutateAsync({ ...values, name: values.name.trim() });
      setOpen(false);
    } catch { /* shown in the dialog */ }
  });

  return (
    <FormDialog
      testId="secret-create-dialog"
      open={open}
      onOpenChange={setOpen}
      title={global ? 'Add global secret' : 'Add secret reference'}
      description="The value is write-only: it is encrypted, never returned, and never rendered again after you save it."
      submitLabel={global ? 'Create global secret' : 'Create secret reference'}
      pendingLabel="Creating…"
      pending={mutation.isPending}
      error={mutation.isError ? mutationErrorText(mutation.error) : undefined}
      dirty={isDirty}
      onSubmit={(event) => { void submit(event); }}
    >
      <Field label="Secret name" error={errors.name?.message} description="An environment-style name such as STRIPE_API_KEY.">
        <Input autoComplete="off" spellCheck={false} maxLength={100} className="font-mono" {...form.register('name', { validate: (value) => secretNameError(value.trim()) ?? true })} />
      </Field>
      <Field label="Write-only value" error={errors.value?.message}>
        <SecretInput {...form.register('value', { validate: (value) => secretValueError(value) ?? true })} />
      </Field>
      <Field label="Description" optional error={errors.description?.message}>
        <Textarea rows={2} maxLength={SECRET_DESCRIPTION_MAX} {...form.register('description')} />
      </Field>
    </FormDialog>
  );
}
