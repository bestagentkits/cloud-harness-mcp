import { zodResolver } from '@hookform/resolvers/zod';
import { SendIcon } from 'lucide-react';
import { useRef } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ActionButton } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { apiClient } from '@/lib/api-client';
import { bffPath } from '@/lib/bff-query';
import { useBffMutation } from '@/lib/bff-mutation';
import { useIdempotencyKey } from '@/lib/idempotency';
import { AGENT_MESSAGE_MAX_BYTES, utf8Bytes } from './agent-model';

/** Mirrors `agent_message` in `packages/contracts/src/tool-schemas.ts`. */
export const agentMessageSchema = z.object({
  mode: z.enum(['steer', 'followUp']),
  message: z.string()
    .refine((value) => value.trim().length > 0, 'Write a message for the agent.')
    .refine((value) => utf8Bytes(value) <= AGENT_MESSAGE_MAX_BYTES, `A message can be at most ${AGENT_MESSAGE_MAX_BYTES.toLocaleString()} bytes.`)
});
export type AgentMessageValues = z.infer<typeof agentMessageSchema>;

/**
 * Steer a running agent or queue a follow-up. The idempotency key belongs to the intent
 * (R5): a retry of the same message after a timeout or a failure reuses it, so the runner
 * can never deliver it twice; it is renewed after the server accepted the message, or when
 * the operator changes what they are sending (a different message is a new intent).
 */
export function AgentMessageForm({ agentId, workspaceId, invalidate }: { agentId: string; workspaceId: string | undefined; invalidate: () => Promise<unknown> }) {
  const idempotency = useIdempotencyKey();
  const keyedFor = useRef<string | null>(null);
  const form = useForm<AgentMessageValues>({ resolver: zodResolver(agentMessageSchema), defaultValues: { mode: 'steer', message: '' } });
  const send = useBffMutation({
    mutationFn: ({ values, idempotencyKey }: { values: AgentMessageValues; idempotencyKey: string }) => apiClient.request(bffPath('agents', agentId, 'messages'), {
      method: 'POST',
      // Only schema fields: the path already names the agent (no body override of a path id).
      body: { ...(workspaceId ? { workspaceId } : {}), message: values.message, mode: values.mode, idempotencyKey }
    }),
    successToast: 'Message sent to the agent',
    errorTitle: 'The message was not sent',
    onSuccess: () => {
      idempotency.renew();
      keyedFor.current = null;
      form.reset({ mode: form.getValues('mode'), message: '' });
      void invalidate();
    }
  });

  /** Validates, then sends; rejects on an invalid form or a failed send so the button shows it. */
  async function submit() {
    if (!(await form.trigger())) {
      form.setFocus('message');
      throw new Error('invalid');
    }
    const values = form.getValues();
    const intent = JSON.stringify([values.mode, values.message]);
    if (keyedFor.current !== null && keyedFor.current !== intent) idempotency.renew();
    keyedFor.current = intent;
    await send.mutateAsync({ values, idempotencyKey: idempotency.current() });
  }

  const errors = form.formState.errors;
  return (
    <form className="grid gap-3" noValidate onSubmit={(event) => { event.preventDefault(); void submit().catch(() => undefined); }} aria-busy={send.isPending || undefined}>
      <Field label="Delivery" description="Steering reaches the running turn; a follow-up waits for the next one.">
        <NativeSelect {...form.register('mode')}>
          <option value="steer">Steer the running agent</option>
          <option value="followUp">Queue a follow-up</option>
        </NativeSelect>
      </Field>
      <Field label="Message" error={errors.message?.message}>
        <Textarea rows={3} {...form.register('message')} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <ActionButton type="button" onAction={submit} pendingLabel="Sending…" successLabel="Sent" errorLabel="Not sent">
          <SendIcon aria-hidden="true" />Send message
        </ActionButton>
        {send.isError ? <p className="text-xs text-muted-foreground" role="status">Sending again reuses the same delivery key, so the agent receives it at most once.</p> : null}
      </div>
    </form>
  );
}
