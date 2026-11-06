import { useQuery } from '@tanstack/react-query';
import { DetailList } from '@/components/data/detail-list';
import { Section } from '@/components/data/section';
import { workspaceHasAction, networkLabel, workspaceStatusLabel } from '@/features/workspaces/workspace-model';
import { bffPath, bffQuery } from '@/lib/bff-query';
import { rec } from '@/lib/format';
import type { CockpitTabProps } from '../cockpit-tab-registry';
import { workspaceAttention } from '../workspace-lease';

type WorkspaceContext = {
  branch?: string;
  capabilities?: Record<string, unknown>;
  manifest?: { itemCount?: number; truncated?: boolean };
};

/**
 * What the Dashboard can read about the workspace today. Repository context is an executor
 * operation, so it is read only when the runner offers `workspace_context` (a closed or failed
 * workspace would answer a predictable 409); a failed read degrades to "Not reported".
 */
export default function SummaryTab({ workspaceId, workspace }: CockpitTabProps) {
  const contextAvailable = workspaceHasAction(workspace, 'workspace_context');
  const context = useQuery({ ...bffQuery<WorkspaceContext>(`${bffPath('workspaces', workspaceId)}/context`, {}), enabled: contextAvailable, retry: false });
  const data = context.data?.data;
  const manifest = rec(data?.manifest) as WorkspaceContext['manifest'];
  const capabilities = Object.entries(rec(data?.capabilities)).filter(([, value]) => value === true).map(([key]) => key);
  const attention = workspaceAttention(workspace);
  const pendingContext = contextAvailable && context.isPending;
  const itemCount = typeof manifest?.itemCount === 'number' ? `${manifest.itemCount} attributable item(s)${manifest.truncated === true ? ' (truncated)' : ''}` : 'Not reported';
  return (
    <div className="grid gap-(--stack-gap)">
      <Section title="Needs attention" id="attention">
        {attention.length ? (
          <ul className="grid gap-2" data-testid="attention-list">
            {attention.map((item) => (
              <li key={item.id} className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm animate-in fade-in-0 motion-reduce:animate-none">
                <p className="font-medium">{item.label}</p>
                <p className="text-muted-foreground">{item.detail}</p>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">Nothing needs attention right now.</p>}
      </Section>
      <Section title="Summary" description="Cost, budget, agent and task counts arrive with the phases that expose them; this panel never invents a number.">
        <div aria-busy={pendingContext || undefined}>
          <DetailList items={[
            { label: 'Status', value: workspaceStatusLabel(workspace.status) },
            { label: 'Branch', value: pendingContext ? 'Loading…' : data?.branch ?? workspace.ref ?? 'Default branch' },
            { label: 'Repository context', value: pendingContext ? 'Loading…' : itemCount },
            { label: 'Capabilities', value: pendingContext ? 'Loading…' : capabilities.length ? capabilities.join(', ') : 'Not reported' },
            { label: 'Network posture', value: networkLabel(workspace.networkProfile) },
            { label: 'Cost used', value: 'Not reported for workspaces yet' }
          ]} />
        </div>
      </Section>
    </div>
  );
}
