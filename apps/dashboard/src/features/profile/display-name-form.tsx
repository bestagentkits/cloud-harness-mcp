import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Section } from '@/components/data/section';
import { ActionButton } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api-client';
import { mutationErrorMessage, useBffMutation } from '@/lib/bff-mutation';
import { profileQuery } from '@/lib/profile';
import { DISPLAY_NAME_MAX, displayNameSchema, type DisplayNameValues } from './profile-model';

type PreferencesAnswer = { data?: { displayName?: string | null } };

/** The cached `/profile` body with the saved display name, so the top-bar chip updates at once. */
function withDisplayName(body: unknown, displayName: string | null): unknown {
  if (!body || typeof body !== 'object') return body;
  const envelope = body as { data?: { preferences?: Record<string, unknown> } & Record<string, unknown> };
  if (!envelope.data) return body;
  return { ...envelope, data: { ...envelope.data, preferences: { ...envelope.data.preferences, displayName } } };
}

/**
 * The operator's display name, stored by the BFF in an HTTP-only cookie (`PUT /preferences`).
 * The verified sign-on name and email stay authoritative and are never changed here. After a
 * save the shared `/profile` cache takes the server's answer and refetches, so the Profile
 * page and the shell's display-name chip show the same name.
 */
export function DisplayNameForm({ displayName, signOnName }: { displayName: string; signOnName: string | undefined }) {
  const queryClient = useQueryClient();
  const saveButton = useRef<HTMLButtonElement>(null);
  const [status, setStatus] = useState('');
  const form = useForm<DisplayNameValues>({ resolver: zodResolver(displayNameSchema), values: { displayName } });
  const save = useBffMutation<string, PreferencesAnswer>({
    mutationFn: (value) => apiClient.request<PreferencesAnswer>('/preferences', { method: 'PUT', body: { displayName: value } }),
    onSuccess: (result) => { queryClient.setQueryData(profileQuery.queryKey, (body: unknown) => withDisplayName(body, result.data?.displayName ?? null)); },
    invalidate: [profileQuery.queryKey],
    successTitle: (_result, value) => (value ? 'Display name updated' : 'Display name reset to your sign-on name'),
    errorTitle: 'The display name was not saved'
  });

  async function store(value: string) {
    setStatus('Saving…');
    try {
      await save.mutateAsync(value);
      setStatus(value ? 'Display name updated.' : 'Display name reset to your sign-on name.');
    } catch (error) {
      setStatus(mutationErrorMessage(error));
      throw error;
    }
  }

  async function submit() {
    const captured: { value?: string } = {};
    await form.handleSubmit((values) => { captured.value = values.displayName; })();
    if (captured.value === undefined) {
      setStatus('Fix the display name before saving.');
      throw new Error('invalid display name');
    }
    await store(captured.value);
  }

  return (
    <Section
      id="profile-display"
      title="Display name"
      description="Shown in the dashboard header. Your verified sign-on name and email stay authoritative and are never changed here."
    >
      <form noValidate className="grid gap-3" onSubmit={(event) => { event.preventDefault(); saveButton.current?.click(); }}>
        <Field
          label="Display name"
          optional
          error={form.formState.errors.displayName?.message}
          description={`Letters, numbers, spaces, and . _ - ' are accepted, up to ${DISPLAY_NAME_MAX} characters.`}
        >
          <Input maxLength={DISPLAY_NAME_MAX} autoComplete="off" spellCheck={false} placeholder={signOnName ?? 'Your sign-on name'} className="max-w-md" {...form.register('displayName')} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <ActionButton ref={saveButton} data-testid="save-display-name" pendingLabel="Saving…" successLabel="Saved" onAction={submit}>Save display name</ActionButton>
          <ActionButton variant="outline" pendingLabel="Saving…" successLabel="Reset" onAction={() => store('')}>Use sign-on name</ActionButton>
        </div>
        <p role="status" aria-live="polite" data-testid="display-name-status" className="min-h-5 text-sm text-muted-foreground">{status}</p>
      </form>
    </Section>
  );
}
