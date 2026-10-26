import { useQuery } from '@tanstack/react-query';
import { RocketIcon } from 'lucide-react';
import { useCallback, useState } from 'react';
import { DetailList } from '@/components/data/detail-list';
import { Section } from '@/components/data/section';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { apiClient } from '@/lib/api-client';
import { type BffEnvelope, bffPath, bffQuery } from '@/lib/bff-query';
import { useBffMutation } from '@/lib/bff-mutation';
import { useRestorableState } from '@/lib/restorable-state';
import type { CockpitTabProps } from '../cockpit-tab-registry';
import { type DeployDraft, type DeploymentTarget, deploymentsOf, parseDeployDraft, type RunResult, runResultOf } from '../automation-model';
import { RunResultView } from './run-result';

/**
 * Deployment targets the repository defines, run as a short wizard: choose a target, review
 * what it runs, confirm (a run executes repository commands with external effects), then
 * read its exit status, duration and bounded output. The chosen target and step survive a
 * reload; the run output never leaves memory. The list refetches for the last result.
 */
export default function DeployTab({ workspaceId }: CockpitTabProps) {
  const path = `${bffPath('workspaces', workspaceId)}/deployments`;
  const read = useQuery(bffQuery<unknown>(path, {}));
  const [draft, setDraft, clearDraft] = useRestorableState<DeployDraft>(`deploy:${workspaceId}`, parseDeployDraft, useCallback((): DeployDraft => ({}), []));
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ name: string; result: RunResult }>();
  const run = useBffMutation<string, unknown>({
    mutationFn: (name) => apiClient.request(`${path}/run`, { method: 'POST', body: { name } }),
    invalidate: [path],
    successToast: 'Deployment finished.',
    errorTitle: 'The deployment did not run',
    onSuccess: (data, name) => { setResult({ name, result: runResultOf((data as BffEnvelope<unknown> | undefined)?.data) }); clearDraft(); }
  });
  return (
    <div className="grid gap-(--stack-gap)">
      <p className="text-sm text-muted-foreground"><strong className="font-medium text-foreground">Deployments run repository-defined commands.</strong> They are external-effect operations: each run confirms first and reports its exit status here.</p>
      <AsyncStatus query={read} label="deployment targets">
        {(body) => {
          const targets = deploymentsOf((body as BffEnvelope<unknown>).data);
          if (!targets.length) return <Section title="Deployment targets"><EmptyState icon={RocketIcon} title="No deployment targets are defined for this repository" /></Section>;
          const chosen = targets.find((target) => target.name === draft.target);
          return chosen
            ? <DeployReview target={chosen} running={run.isPending} onBack={clearDraft} onRun={() => setConfirming(true)} />
            : <TargetList targets={targets} onChoose={(name) => { setResult(undefined); setDraft({ target: name }); }} />;
        }}
      </AsyncStatus>
      {result ? <RunResultView title={`Deployment ${result.name}`} result={result.result} /> : null}
      <ConfirmDialog
        open={confirming && draft.target !== undefined}
        onOpenChange={setConfirming}
        title="Run this deployment target?"
        description="Deployment commands have external effects and run outside the harness sandbox."
        {...(draft.target ? { target: draft.target } : {})}
        confirmLabel="Run deployment"
        pendingLabel="Running…"
        destructive
        onConfirm={() => (draft.target ? run.mutateAsync(draft.target) : Promise.resolve())}
      />
    </div>
  );
}

function TargetList({ targets, onChoose }: { targets: DeploymentTarget[]; onChoose: (name: string) => void }) {
  return (
    <Section title="Deployment targets" description="Step 1 of 2: choose the target to deploy.">
      <ul className="grid gap-3" aria-label="Deployment targets">
        {targets.map((target) => (
          <li key={target.name} className="grid gap-3 rounded-md border p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="grid min-w-0">
                <h3 className="font-medium">{target.name}</h3>
                <span className="font-mono text-xs break-all text-muted-foreground">{target.cwd}</span>
              </div>
              <Button size="sm" variant="outline" onClick={() => onChoose(target.name)}>Review deployment<span className="sr-only"> {target.name}</span></Button>
            </div>
            <TargetFacts target={target} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function DeployReview({ target, running, onBack, onRun }: { target: DeploymentTarget; running: boolean; onBack: () => void; onRun: () => void }) {
  return (
    <Section title={`Review deployment: ${target.name}`} description="Step 2 of 2: check the target, then run it. The run executes the repository's own commands with external effects.">
      <div className="grid gap-4">
        <DetailList items={[{ label: 'Target', value: target.name, mono: true }, { label: 'Working directory', value: target.cwd || 'Repository root', mono: Boolean(target.cwd) }]} />
        <TargetFacts target={target} />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={running} onClick={onBack}>Back to targets</Button>
          <Button variant="destructive" disabled={running} aria-busy={running || undefined} onClick={onRun}>{running ? 'Running…' : 'Run deployment'}</Button>
        </div>
      </div>
    </Section>
  );
}

function TargetFacts({ target }: { target: DeploymentTarget }) {
  return (
    <DetailList items={[
      { label: 'Last result', value: target.lastResult },
      { label: 'Duration', value: target.duration },
      { label: 'Failure detail', value: target.failure }
    ]} />
  );
}
