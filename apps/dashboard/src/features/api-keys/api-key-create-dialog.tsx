import { Controller, useForm, useWatch } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { mutationErrorText, useBffMutation } from '@/lib/bff-mutation';
import { Callout } from '../shared/callout';
import { FormDialog } from '../shared/form-dialog';
import { apiKeyInput, apiKeysApi, EXPIRY_PRESETS } from './api-key-model';

type Values = { name: string; days: string; acknowledged: boolean };
const DEFAULTS: Values = { name: '', days: '30', acknowledged: false };

/**
 * Create an MCP API key. The acknowledgement is a client-side gate only (the legacy body
 * is exactly `{ name, expiresInDays }`). On success the plaintext goes straight to the
 * reveal (`onCreated`), never into this form or a cache.
 */
export function ApiKeyCreateDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (key: string) => void }) {
  const form = useForm<Values>({ defaultValues: DEFAULTS });
  const { errors, isDirty } = form.formState;
  const days = useWatch({ control: form.control, name: 'days' });
  const mutation = useBffMutation<Values & { onKey: (key: string) => void }>({
    mutationFn: async ({ name, days, onKey }) => apiKeysApi.create(apiKeyInput(name, days), onKey),
    invalidate: ['/api-keys'],
    successToast: 'API key created. Copy it now; it will not be shown again.'
  });

  function setOpen(next: boolean) {
    if (!next) { form.reset(DEFAULTS); mutation.reset(); }
    onOpenChange(next);
  }

  const submit = form.handleSubmit(async (values) => {
    // The plaintext stays in this closure until the form dialog has closed, then moves to
    // the reveal: two modal dialogs never compete for focus.
    let created: string | undefined;
    try {
      await mutation.mutateAsync({ ...values, onKey: (key) => { created = key; } });
    } catch { return; /* shown in the dialog */ }
    setOpen(false);
    const key = created;
    created = undefined;
    if (key) setTimeout(() => onCreated(key), 0);
  });

  return (
    <FormDialog
      testId="api-key-create-dialog"
      open={open}
      onOpenChange={setOpen}
      title="Create API key"
      description="The key is shown once and cannot be recovered. It carries full MCP access as your identity, including command execution."
      submitLabel="Create API key"
      pendingLabel="Creating key…"
      pending={mutation.isPending}
      error={mutation.isError ? mutationErrorText(mutation.error) : undefined}
      dirty={isDirty}
      onSubmit={(event) => { void submit(event); }}
    >
      <Callout tone="warning" title="Full remote execution authority.">
        This key grants full MCP access as your identity, including arbitrary command execution. It expires, cannot be recovered, and must be revoked if exposed.
      </Callout>
      <Field label="Key name" error={errors.name?.message} description="Name it after the client that will use it.">
        <Input autoComplete="off" maxLength={100} {...form.register('name', { validate: (value) => (value.trim() ? true : 'Enter a key name.') })} />
      </Field>
      <Field label="Expires after (days)" error={errors.days?.message}>
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={3650}
          step={1}
          {...form.register('days', { validate: (value) => (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 3650 ? true : 'Enter a whole number of days from 1 to 3650.') })}
        />
      </Field>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Expiry presets">
        {EXPIRY_PRESETS.map((preset) => (
          <Button key={preset} size="sm" variant="outline" aria-pressed={days === String(preset)} onClick={() => form.setValue('days', String(preset), { shouldDirty: true, shouldValidate: true })}>
            {preset === 365 ? '1 year' : `${preset} days`}
          </Button>
        ))}
      </div>
      <div className="grid gap-1">
        <div className="flex items-start gap-2">
          <Controller
            control={form.control}
            name="acknowledged"
            rules={{ validate: (value) => (value ? true : 'Confirm that you understand the key’s authority.') }}
            render={({ field }) => (
              <Checkbox
                id="api-key-acknowledge"
                ref={field.ref}
                checked={field.value}
                onBlur={field.onBlur}
                aria-invalid={errors.acknowledged ? true : undefined}
                aria-describedby={errors.acknowledged ? 'api-key-acknowledge-error' : undefined}
                onCheckedChange={(checked) => field.onChange(checked === true)}
              />
            )}
          />
          <Label htmlFor="api-key-acknowledge" className="leading-snug font-normal">I understand this key permits full MCP and command-execution access and will be shown only once.</Label>
        </div>
        {errors.acknowledged ? <p id="api-key-acknowledge-error" role="alert" className="text-xs text-destructive">{errors.acknowledged.message}</p> : null}
      </div>
    </FormDialog>
  );
}
