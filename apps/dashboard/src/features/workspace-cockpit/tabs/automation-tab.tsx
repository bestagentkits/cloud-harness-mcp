import { useQuery } from '@tanstack/react-query';
import { SparklesIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { Section } from '@/components/data/section';
import { StatusBadge } from '@/components/data/status-badge';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ManagedDialog } from '@/components/ui/managed-dialog';
import { toast } from '@/components/ui/toast-store';
import { apiClient } from '@/lib/api-client';
import { type BffEnvelope, bffPath, bffQuery } from '@/lib/bff-query';
import { mutationErrorText, useBffMutation } from '@/lib/bff-mutation';
import type { CockpitTabProps } from '../cockpit-tab-registry';
import {
  groupHooksByLifecycle, hookRunBody, hooksOf, type RunResult, runResultOf, SCRIPT_PATTERN,
  skillRunFailure, skillsOf, type WorkspaceHook, type WorkspaceSkill
} from '../automation-model';
import { RunResultView } from './run-result';

const dataOf = (body: unknown) => (body as BffEnvelope<unknown>).data;

/**
 * The cockpit Automation tab: the workspace's resolved skills and its lifecycle hooks.
 * Every run is fenced by the digest the operator was shown (a skill's content digest, the
 * hook manifest digest), so a skill or hook changed since the page loaded is refused with
 * a 409 and the lists refetch. Activation and deactivation stay with the runner's manifest
 * contract, as on the classic tab.
 */
export default function AutomationTab({ workspaceId }: CockpitTabProps) {
  const skillsPath = `${bffPath('workspaces', workspaceId)}/skills`;
  const hooksPath = `${bffPath('workspaces', workspaceId)}/hooks`;
  const skills = useQuery(bffQuery<unknown>(skillsPath, {}));
  const hooks = useQuery(bffQuery<unknown>(hooksPath, {}));
  return (
    <div className="grid gap-(--stack-gap)">
      <p className="text-sm text-muted-foreground"><strong className="font-medium text-foreground">Workspace automation.</strong> Skills resolve from your library and pinned sets; hooks run at lifecycle events inside the executor.</p>
      <Section title="Skills" description="A script runs inside the workspace executor under the runner's verified-bytes contract. Nothing runs unless you name it here.">
        <AsyncStatus query={skills} label="skills">
          {(body) => <SkillList workspaceId={workspaceId} skills={skillsOf(dataOf(body))} invalidate={[skillsPath]} />}
        </AsyncStatus>
      </Section>
      <Section title="Hooks" description="Activation and deactivation stay with the runner's manifest contract. Running a hook here is a one-off manual run you confirm first; it does not activate the hook.">
        <AsyncStatus query={hooks} label="hooks">
          {(body) => {
            const parsed = hooksOf(dataOf(body));
            return <HookPipeline workspaceId={workspaceId} hooks={parsed.hooks} manifestSha256={parsed.manifestSha256} invalidate={[hooksPath]} />;
          }}
        </AsyncStatus>
      </Section>
    </div>
  );
}

function SkillList({ workspaceId, skills, invalidate }: { workspaceId: string; skills: WorkspaceSkill[]; invalidate: string[] }) {
  const [running, setRunning] = useState<WorkspaceSkill>();
  const [result, setResult] = useState<{ title: string; result: RunResult; failed: boolean }>();
  if (!skills.length) return <EmptyState icon={SparklesIcon} title="No skills are resolved for this workspace" />;
  return (
    <>
      <ul className="grid gap-2" aria-label="Workspace skills">
        {skills.map((skill) => (
          <li key={`${skill.name}:${skill.tier ?? ''}:${skill.contentSha256 ?? ''}`} className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3">
            <div className="grid min-w-0 gap-1">
              <span className="flex flex-wrap items-center gap-2 font-medium">{skill.name}{skill.tier ? <StatusBadge status="neutral" label={skill.tier} /> : null}</span>
              {skill.description ? <p className="text-sm text-muted-foreground">{skill.description}</p> : null}
              {skill.contentSha256 ? <code className="font-mono text-xs break-all text-muted-foreground">{skill.contentSha256.slice(0, 16)}</code> : null}
            </div>
            <Button size="sm" variant="outline" disabled={!skill.contentSha256} onClick={() => setRunning(skill)}>
              Run script<span className="sr-only"> of {skill.name}</span>
            </Button>
          </li>
        ))}
      </ul>
      {skills.some((skill) => !skill.contentSha256) ? <p className="text-xs text-muted-foreground">A skill without a reported content digest cannot run from here: the run is fenced by that digest.</p> : null}
      {result ? <RunResultView title={result.title} result={result.result} failed={result.failed} /> : null}
      <SkillRunDialog
        workspaceId={workspaceId}
        skill={running}
        invalidate={invalidate}
        onOpenChange={(open) => { if (!open) setRunning(undefined); }}
        onResult={(title, next, failed) => setResult({ title, result: next, failed })}
      />
    </>
  );
}

/**
 * Runs one named script of a skill. The body carries the skill's content digest; the runner
 * may also ask for an owner privilege grant, which the Dashboard cannot attach, so that
 * refusal surfaces as the error it is. A script that ran and exited non-zero is not a
 * dialog error: its exit code and output are shown like a finished run's.
 */
function SkillRunDialog({ workspaceId, skill, invalidate, onOpenChange, onResult }: {
  workspaceId: string;
  skill: WorkspaceSkill | undefined;
  invalidate: string[];
  onOpenChange: (open: boolean) => void;
  onResult: (title: string, result: RunResult, failed: boolean) => void;
}) {
  const formId = useId();
  const [script, setScript] = useState('');
  const [error, setError] = useState('');
  const open = skill !== undefined;
  const changeOpen = (next: boolean) => { if (!next) { setScript(''); setError(''); } onOpenChange(next); };
  const run = useBffMutation<{ name: string; script: string; contentSha256: string }, unknown>({
    mutationFn: ({ name, script: chosen, contentSha256 }) => apiClient.request(`${bffPath('workspaces', workspaceId, 'skills', name)}/run`, {
      method: 'POST', body: { script: chosen, expectedContentSha256: contentSha256 }
    }),
    invalidate,
    successToast: 'Skill script finished.',
    onSuccess: (data, vars) => onResult(`${vars.name} · ${vars.script}`, runResultOf((data as BffEnvelope<unknown> | undefined)?.data), false)
  });

  async function submit() {
    if (!skill?.contentSha256) return;
    const chosen = script.trim();
    if (!SCRIPT_PATTERN.test(chosen)) { setError('Use the script name only: letters, digits, dot, dash or underscore, at most 120 characters.'); return; }
    setError('');
    try {
      await run.mutateAsync({ name: skill.name, script: chosen, contentSha256: skill.contentSha256 });
      changeOpen(false);
    } catch (failure) {
      const ran = skillRunFailure(failure);
      if (!ran) { setError(mutationErrorText(failure)); return; }
      onResult(`${skill.name} · ${chosen}`, ran, true);
      toast({ title: 'Skill script exited with an error.', variant: 'destructive' });
      changeOpen(false);
    }
  }

  return (
    <ManagedDialog open={open} onOpenChange={changeOpen} guard={{ dirty: script !== '' && !run.isPending, locked: run.isPending }}>
      <DialogHeader>
        <DialogTitle>Run a skill script</DialogTitle>
        <DialogDescription>
          The script runs inside the workspace executor for <span className="font-mono">{skill?.name}</span>, against the content digest shown on this page.
        </DialogDescription>
      </DialogHeader>
      <form id={formId} className="grid gap-4" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Field label="Script" description="The script's name inside the skill, for example check.sh." error={error || undefined}>
          <Input autoFocus autoComplete="off" maxLength={120} className="font-mono" value={script} onChange={(event) => setScript(event.target.value)} />
        </Field>
      </form>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={run.isPending} onClick={() => changeOpen(false)}>Cancel</Button>
        <Button type="submit" form={formId} disabled={run.isPending} aria-busy={run.isPending || undefined}>{run.isPending ? 'Running…' : 'Run script'}</Button>
      </DialogFooter>
    </ManagedDialog>
  );
}

type PendingHook = { hook: WorkspaceHook; event: string; eventLabel: string };

function HookPipeline({ workspaceId, hooks, manifestSha256, invalidate }: {
  workspaceId: string;
  hooks: WorkspaceHook[];
  manifestSha256: string | undefined;
  invalidate: string[];
}) {
  const groups = groupHooksByLifecycle(hooks);
  const [pending, setPending] = useState<PendingHook>();
  const [result, setResult] = useState<{ title: string; result: RunResult }>();
  const run = useBffMutation<PendingHook, unknown>({
    mutationFn: ({ hook, event }) => {
      const body = hookRunBody(hook, event, manifestSha256);
      return apiClient.request(`${bffPath('workspaces', workspaceId, 'hooks')}/run`, { method: 'POST', body: body ?? {} });
    },
    invalidate,
    successToast: 'Hooks finished.',
    errorTitle: 'The hooks did not run',
    onSuccess: (data, vars) => setResult({ title: `${vars.hook.name} · ${vars.eventLabel}`, result: runResultOf((data as BffEnvelope<unknown> | undefined)?.data) })
  });

  return (
    <div className="grid gap-4">
      <ol className="grid gap-2 sm:grid-cols-5" aria-label="Hook lifecycle in run order">
        {groups.map((group) => (
          <li key={group.id} className={`grid gap-0.5 rounded-md border p-2 text-sm ${group.hooks.length ? 'border-primary/50 bg-primary/5' : ''}`}>
            <span className="font-medium">{group.label}</span>
            <span className="text-xs text-muted-foreground">{group.hooks.length} hook(s)</span>
          </li>
        ))}
      </ol>
      {groups.map((group) => (
        <section key={group.id} aria-labelledby={`hooks-${group.id}`} className="grid gap-2">
          <h3 id={`hooks-${group.id}`} className="text-sm font-medium">{group.label}</h3>
          {group.hooks.length ? (
            <ul className="grid gap-2">
              {group.hooks.map((hook) => {
                // The runner runs any manifest hook on request, active or not, as the classic tab does;
                // a manual run does not activate it.
                const runnable = hookRunBody(hook, group.id, manifestSha256) !== undefined;
                return (
                  <li key={hook.name} className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3">
                    <div className="grid min-w-0 gap-1">
                      <span className="flex flex-wrap items-center gap-2 font-medium">{hook.name}<StatusBadge status={hook.active ? 'active' : 'inactive'} label={hook.active ? 'Active' : 'Inactive'} /></span>
                      {hook.description ? <p className="text-sm text-muted-foreground">{hook.description}</p> : null}
                    </div>
                    <Button size="sm" variant="outline" disabled={!runnable} onClick={() => setPending({ hook, event: group.id, eventLabel: group.label })}>
                      Run hook<span className="sr-only"> {hook.name} at {group.label}</span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : <p className="text-sm text-muted-foreground">No hooks run at this stage.</p>}
        </section>
      ))}
      {result ? <RunResultView title={result.title} result={result.result} /> : null}
      <ConfirmDialog
        open={pending !== undefined}
        onOpenChange={(open) => { if (!open) setPending(undefined); }}
        title="Run this hook?"
        description={pending ? `The hook runs now as a bounded shell command inside the executor, for the “${pending.eventLabel}” stage. A hook manifest changed since this page loaded is refused.` : ''}
        {...(pending ? { target: pending.hook.name } : {})}
        confirmLabel="Run hook"
        pendingLabel="Running…"
        onConfirm={() => (pending ? run.mutateAsync(pending) : Promise.resolve())}
      />
    </div>
  );
}
