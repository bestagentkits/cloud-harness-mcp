import { OctagonXIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ConflictError, apiClient } from '@/lib/api-client';
import { bffPath } from '@/lib/bff-query';
import { useBffMutation } from '@/lib/bff-mutation';
import { AGENT_CANCEL_REASON_MAX } from './agent-model';

/**
 * Cancel an agent and, through the runner's cascade, every agent it spawned. The operator
 * may record a bounded reason (the `agent_cancel.reason` bound), and a confirmation naming
 * the agent always comes first. A conflict (the agent changed meanwhile) refetches it.
 */
export function AgentCancelControl({ agentId, workspaceId, invalidate }: { agentId: string; workspaceId: string | undefined; invalidate: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const cancel = useBffMutation({
    mutationFn: (note: string) => apiClient.request(bffPath('agents', agentId, 'cancel'), {
      method: 'POST',
      body: { ...(workspaceId ? { workspaceId } : {}), ...(note ? { reason: note } : {}) }
    }),
    successToast: 'Agent cancelled',
    errorTitle: 'The agent was not cancelled',
    onSuccess: () => { setReason(''); void invalidate(); }
  });
  return (
    <div className="grid gap-3">
      <Field label="Reason" optional description="Recorded with the cancellation. At most 2,000 characters.">
        <Input value={reason} maxLength={AGENT_CANCEL_REASON_MAX} onChange={(event) => setReason(event.target.value)} autoComplete="off" />
      </Field>
      <div>
        <Button variant="destructive" onClick={() => setOpen(true)} disabled={cancel.isPending}>
          <OctagonXIcon aria-hidden="true" />Cancel agent
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Cancel this agent and its children?"
        description="Cancellation cascades to every agent this one spawned and cannot be undone."
        target={agentId}
        confirmLabel="Cancel agent"
        pendingLabel="Cancelling…"
        onConfirm={async () => {
          try {
            await cancel.mutateAsync(reason.trim());
          } catch (error) {
            if (error instanceof ConflictError) await invalidate();
            throw error;
          }
        }}
      />
    </div>
  );
}
