import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { DetailList } from '@/components/data/detail-list';
import { Section } from '@/components/data/section';
import { ActionButton } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { NativeSelect } from '@/components/ui/select';
import { apiClient } from '@/lib/api-client';
import { useBffMutation } from '@/lib/bff-mutation';
import type { BffEnvelope } from '@/lib/bff-query';
import { NETWORK_OPTIONS, NETWORK_PROFILES, type NetworkProfileView, networkProfileLabel, networkSelection, type Readiness, readinessMessage, readReadiness } from './network-model';
import { Callout, StatusLine } from './settings-feedback';
import { useSettingsWrite } from './settings-queries';

const networkSchema = z.object({ profile: z.union([z.enum(NETWORK_PROFILES), z.literal('')]) });
type NetworkValues = z.infer<typeof networkSchema>;

/**
 * The instance default network profile: save a choice, reset to the runner default, and
 * probe egress readiness. Saving never starts or changes a running workspace. The form
 * follows the server value (`values`), so a save's read-back resets it.
 */
export function NetworkProfileSection({ view }: { view: NetworkProfileView }) {
  const [status, setStatus] = useState('');
  const [readiness, setReadiness] = useState<Readiness>();
  const form = useForm<NetworkValues>({ resolver: zodResolver(networkSchema), values: { profile: networkSelection(view) } });
  const write = useSettingsWrite('The network profile was not saved');
  const check = useBffMutation<void, BffEnvelope<unknown>>({
    mutationFn: () => apiClient.request<BffEnvelope<unknown>>('/settings/network-check', { method: 'POST', body: {} }),
    errorTitle: 'The readiness check failed'
  });

  async function store(profile: NetworkValues['profile'], pending: string, done: string) {
    setStatus(pending);
    try {
      await write.mutateAsync({ defaultNetworkProfile: profile === '' ? null : profile });
      setStatus(done);
    } catch (error) {
      setStatus('');
      throw error;
    }
  }

  async function save() {
    if (!(await form.trigger())) throw new Error('The selected network profile is not valid.');
    const profile = form.getValues('profile');
    await store(profile, 'Saving…', profile === '' ? 'Runner default restored.' : 'Default network profile saved.');
  }

  async function runCheck() {
    setStatus('Checking…');
    try {
      const result = readReadiness((await check.mutateAsync()).data);
      setReadiness(result);
      setStatus(readinessMessage(result));
    } catch (error) {
      setStatus('');
      throw error;
    }
  }

  const facts = [
    { label: 'Effective profile', value: <>{networkProfileLabel(view.value)} <span className="font-mono text-xs">{view.value}</span></> },
    { label: 'Source', value: view.stored ? 'Set in this dashboard' : 'Runner default (WORKSPACE_NETWORK_PROFILE or built-in)' },
    ...(readiness ? [{ label: 'Egress readiness', value: readiness.ready ? 'Ready' : `Not ready: ${readiness.reason ?? 'the readiness probe reported no reason'}` }] : [])
  ];

  return (
    <Section id="settings-network" title="Default network profile" description="Choose the network posture for newly opened workspaces.">
      <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); }} aria-label="Default network profile">
        <Field label="Effective default">
          <NativeSelect {...form.register('profile')} className="max-w-xl">
            {NETWORK_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            <option value="">Use runner default</option>
          </NativeSelect>
        </Field>
        <DetailList items={facts} />
        <Callout>
          <p><strong>Dependency access grants outbound network access to repository-controlled code.</strong> A dependency, build script, or agent command can then reach the network and exfiltrate any credential injected into the workspace, including a global GH_TOKEN. A fine-grained token scoped only to the repositories a workspace needs is safer than a broadly scoped credential. Check egress readiness before relying on it.</p>
        </Callout>
        <div className="flex flex-wrap gap-2">
          <ActionButton data-testid="save-network-profile" pendingLabel="Saving…" successLabel="Saved" onAction={save}>Save</ActionButton>
          <ActionButton data-testid="reset-network-profile" variant="outline" pendingLabel="Resetting…" successLabel="Reset" onAction={() => store('', 'Resetting…', 'Runner default restored.')}>Reset to runner default</ActionButton>
          <ActionButton data-testid="check-network" variant="outline" pendingLabel="Checking…" successLabel="Checked" onAction={runCheck}>Check egress readiness</ActionButton>
        </div>
        <StatusLine testId="network-status" message={status} />
      </form>
    </Section>
  );
}
