import { useMemo, useRef, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { DetailList } from '@/components/data/detail-list';
import { Section } from '@/components/data/section';
import { ActionButton } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { mutationErrorMessage } from '@/lib/bff-mutation';
import { formatDateTime, rec } from '@/lib/format';
import {
  bytesLabel, durationLabel, fieldBounds, graceIsZero, LIFECYCLE_FIELDS, type LifecycleField, type LifecycleUpdate, type LifecycleValues,
  type LifecycleView, lifecycleDefaults, lifecycleResetInput, lifecycleSchema, lifecycleSummary, lifecycleUpdateInput, readLifecycleView, sourceLabel, valueLabel
} from './lifecycle-model';
import { Callout, StatusLine } from './settings-feedback';
import { settingsRead, useConflictReload, useSettingsWrite } from './settings-queries';

const CONFLICT_MESSAGE = 'These settings changed elsewhere after you opened Settings. The panel now shows the current values; review them and save again.';
const INVALID_MESSAGE = 'Fix the highlighted fields before saving.';

/** Field help, in display order; each explains what the runner does with the value. */
function fieldHelp(field: LifecycleField, view: LifecycleView) {
  const { settings, usage, executorCeilings: ceilings } = view;
  const quota = settings.maxActiveWorkspacesPerOwner.value;
  if (field.name === 'maxActiveWorkspacesPerOwner') {
    const atLimit = ceilings.memoryBytes !== undefined && ceilings.cpus !== undefined && ceilings.pids !== undefined
      ? ` At the current limit of ${quota}, one principal alone could reach ${bytesLabel(ceilings.memoryBytes * quota)} memory, ${Math.round(ceilings.cpus * quota * 100) / 100} CPU and ${ceilings.pids * quota} pids.`
      : '';
    return (
      <div className="grid gap-2">
        <DetailList items={[
          { label: 'Your active workspaces', value: <><span className="font-mono">{usage.counted} / {usage.limit ?? quota}</span> counted against the effective limit</> },
          { label: 'Expired, recoverable', value: `${usage.recoverable} (not counted; their checkouts still use disk)` }
        ]} />
        <Callout><p>Each executor is capped at {bytesLabel(ceilings.memoryBytes)} memory, {ceilings.cpus ?? 'unknown'} CPU, {ceilings.pids ?? 'unknown'} pids. These are ceilings, not reservations, and they multiply with every concurrent workspace, so this per-principal quota does not guarantee the host has capacity.{atLimit}</p></Callout>
        <p className="text-xs text-muted-foreground">The limit is enforced at the next open, recover, or lease renew. Lowering it below current usage blocks new opens but never closes an existing workspace.</p>
      </div>
    );
  }
  if (field.name === 'idleTtlSeconds') {
    return <p className="text-xs text-muted-foreground">A workspace expires after this long without activity. Tool calls that operate on the workspace refresh the idle lease: exec, files, git, shell, session, and task operations, <span className="font-mono">workspace_lease_renew</span>, and resuming with <span className="font-mono">workspace_recover</span>. <span className="font-mono">workspace_list</span>, <span className="font-mono">workspace_status</span>, and Dashboard polling or metadata reads do not keep a workspace alive.</p>;
  }
  if (field.name === 'wallTtlSeconds') {
    return <p className="text-xs text-muted-foreground">A hard deadline counted from creation; activity never extends it. The effective active lifetime is the earlier of the idle expiry and this deadline (now: idle {durationLabel(settings.idleTtlSeconds.value)}, hard deadline {durationLabel(settings.wallTtlSeconds.value)}). The idle timeout may not exceed the lifetime.</p>;
  }
  return <p className="text-xs text-muted-foreground">How long an expired workspace stays recoverable before the reaper may close it. It closes at about expiry + grace + up to one reaper interval ({durationLabel(view.reaperIntervalSeconds)}).</p>;
}

function Timeline({ view }: { view: LifecycleView }) {
  const idle = durationLabel(view.settings.idleTtlSeconds.value);
  const wall = durationLabel(view.settings.wallTtlSeconds.value);
  const grace = durationLabel(view.settings.recoverableGraceSeconds.value);
  const reaper = durationLabel(view.reaperIntervalSeconds);
  return (
    <div className="grid gap-3">
      <ol aria-label="Workspace lifecycle states" className="grid gap-2 text-sm sm:grid-cols-3">
        <li className="grid gap-1 rounded-md border p-3"><strong className="font-mono text-xs">ACTIVE</strong>Counts against the quota. Expires at the earlier of {idle} idle or {wall} after creation.</li>
        <li className="grid gap-1 rounded-md border p-3"><strong className="font-mono text-xs">EXPIRED_RECOVERABLE</strong>Frees its active slot, but its checkout still uses disk. Recoverable with <span className="font-mono">workspace_recover</span> for {grace}.</li>
        <li className="grid gap-1 rounded-md border p-3"><strong className="font-mono text-xs">CLOSED</strong>Auto-closed at about expiry + {grace} + up to {reaper}. Auto-close never deletes uncommitted, untracked, stashed, or unpushed work, nor a workspace with running agents (Git-ignored files are not checked): those stay recoverable until closed explicitly with <span className="font-mono">workspace_close</span> or recovered.</li>
      </ol>
      <DetailList items={[
        { label: 'Retained by auto-close', value: `${view.usage.autoCloseDeferred} of your workspaces` },
        { label: 'Last changed', value: <>{view.updatedAt ? formatDateTime(view.updatedAt) : 'Never changed in this dashboard'} <span className="font-mono text-xs">rev {view.revision}</span></> }
      ]} />
    </div>
  );
}

/**
 * Workspace limits and lifecycle. Every effective value is the runner's read-back; the form
 * edits the Dashboard overrides, a save sends only the changed fields with the loaded
 * revision, and a reset hands each field back to the runner value printed beside it.
 */
export function LifecycleSection({ view }: { view: LifecycleView }) {
  const [status, setStatus] = useState('');
  const saveButton = useRef<HTMLButtonElement>(null);
  const defaults = useMemo(() => lifecycleDefaults(view), [view]);
  const schema = useMemo(() => lifecycleSchema(view), [view]);
  const form = useForm<LifecycleValues>({ resolver: zodResolver(schema), values: defaults, mode: 'onChange' });
  const write = useSettingsWrite('The workspace lifecycle settings were not saved');
  const reloadOnConflict = useConflictReload(settingsRead().queryKey);
  const grace = useWatch({ control: form.control, name: 'recoverableGraceSeconds' });
  const errors = form.formState.errors;

  async function persist(body: LifecycleUpdate, savedMessage: string) {
    setStatus('Saving…');
    try {
      const result = await write.mutateAsync({ workspaceLifecycle: body });
      setStatus(`${savedMessage} ${lifecycleSummary(readLifecycleView(rec(result.data).workspaceLifecycle))}`.trim());
    } catch (error) {
      setStatus(await reloadOnConflict(error) ? CONFLICT_MESSAGE : mutationErrorMessage(error));
      throw error;
    }
  }

  async function save() {
    const captured: { values?: LifecycleValues } = {};
    await form.handleSubmit((values) => { captured.values = values; })();
    if (!captured.values) { setStatus(INVALID_MESSAGE); throw new Error(INVALID_MESSAGE); }
    const { errors: saveErrors, body } = lifecycleUpdateInput(view, captured.values, captured.values.acknowledgeImmediateClose);
    if (saveErrors.acknowledgeImmediateClose) {
      form.setError('acknowledgeImmediateClose', { type: 'required', message: saveErrors.acknowledgeImmediateClose }, { shouldFocus: true });
      setStatus(INVALID_MESSAGE);
      throw new Error(INVALID_MESSAGE);
    }
    if (!body) { setStatus('No changes to save.'); return; }
    await persist(body, 'Workspace lifecycle settings saved.');
  }

  async function reset() {
    const input = lifecycleResetInput(view);
    if (input.error !== undefined) { setStatus(input.error); throw new Error(input.error); }
    await persist(input.body, 'Runner values restored.');
  }

  return (
    <Section id="settings-lifecycle" title="Workspace limits & lifecycle" description="Instance-wide quota and lifetimes for workspaces. Effective values below are what the runner reports.">
      <Callout><p><strong>Not retroactive.</strong> Idle timeout, lifetime, and grace changes apply only to newly opened workspaces; open workspaces keep the policy they were opened with. The quota applies to the next open, recover, or renew. These are separate from the MCP OAuth session lifetime and from agent task TTLs.</p></Callout>
      <Timeline view={view} />
      <form
        noValidate
        aria-label="Workspace lifecycle"
        className="grid gap-5"
        onSubmit={(event) => { event.preventDefault(); saveButton.current?.click(); }}
      >
        {LIFECYCLE_FIELDS.map((field) => {
          const setting = view.settings[field.name];
          const bounds = fieldBounds(field, setting);
          const range = field.unit === 'count' ? `${bounds.min}–${bounds.max}` : `${bounds.min}–${bounds.max} min`;
          const deps = field.name === 'idleTtlSeconds' ? ['wallTtlSeconds' as const] : field.name === 'wallTtlSeconds' ? ['idleTtlSeconds' as const] : [];
          return (
            <div key={field.name} className="grid gap-2">
              <Field label={field.label} error={errors[field.name]?.message} description={`Source: ${sourceLabel(setting.source)} · Runner value: ${valueLabel(field, setting.runnerValue)} · Allowed: ${range}`}>
                <Input type="number" inputMode="numeric" step={1} min={bounds.min} max={bounds.max} required className="max-w-48" {...form.register(field.name, { deps })} />
              </Field>
              {fieldHelp(field, view)}
            </div>
          );
        })}
        {graceIsZero(grace) ? (
          <div className="grid gap-2 rounded-md border border-warning/50 p-3 animate-in fade-in-0 motion-reduce:animate-none">
            <p className="text-sm"><strong>A grace of 0 closes clean expired workspaces on the next reaper pass.</strong> There is no window to recover them after expiry.</p>
            <Controller
              control={form.control}
              name="acknowledgeImmediateClose"
              render={({ field }) => (
                <Field label="I understand expired workspaces close without a recovery window" error={errors.acknowledgeImmediateClose?.message}>
                  <Checkbox ref={field.ref} checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} onBlur={field.onBlur} />
                </Field>
              )}
            />
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <ActionButton ref={saveButton} data-testid="save-lifecycle" pendingLabel="Saving…" successLabel="Saved" onAction={save}>Save lifecycle settings</ActionButton>
          <ActionButton data-testid="reset-lifecycle" variant="outline" pendingLabel="Resetting…" successLabel="Restored" onAction={reset}>Reset to runner values</ActionButton>
        </div>
        <StatusLine testId="lifecycle-status" message={status} />
      </form>
    </Section>
  );
}
