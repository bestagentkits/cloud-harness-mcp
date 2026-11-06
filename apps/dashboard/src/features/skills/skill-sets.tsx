import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { LayersIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { TruncationNotice } from '@/components/data/truncation-notice';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ManagedDialog } from '@/components/ui/managed-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { type ConflictError, apiClient } from '@/lib/api-client';
import { type BffEnvelope, bffKey, bffPath, bffQuery } from '@/lib/bff-query';
import { EMPTY, formatRelative } from '@/lib/format';
import { DESCRIPTION_MAX, DISPLAY_NAME_MAX, positiveGeneration, type Skill, type SkillSet, type SkillSetItem, skillLabel, skillSetItems } from './skill-model';
import { type SkillSetValues, skillSetSchema } from './skill-form-schemas';
import { SKILL_SETS_KEY, useSkillMutation } from './use-skill-mutation';

/**
 * Skill sets: build a set from the library (each member pins its skill's current revision)
 * and manage the sets that exist. The classic tab could only create, so a set, once saved,
 * was invisible here; the list, detail, rename and delete re-host `GET /skill-sets`,
 * `GET`/`PATCH`/`DELETE /skill-sets/:id`.
 */
export function SkillSets({ skills, onConflict }: { skills: Skill[]; onConflict: (error: ConflictError) => void }) {
  const sets = useQuery(bffQuery<{ sets?: SkillSet[] }>('/skill-sets'));
  const [open, setOpen] = useState<SkillSet | null>(null);
  const columns: DataTableColumn<SkillSet>[] = [
    {
      id: 'name',
      header: 'Name',
      cell: (set) => (
        <button type="button" className="text-left font-medium break-words underline-offset-2 transition-colors hover:underline focus-visible:underline focus-visible:outline-none" onClick={() => setOpen(set)}>
          {set.name || set.id}
        </button>
      )
    },
    { id: 'description', header: 'Description', cell: (set) => set.description || EMPTY, className: 'hidden sm:table-cell' },
    { id: 'updated', header: 'Updated', cell: (set) => formatRelative(set.updatedAt), className: 'whitespace-nowrap' }
  ];
  return (
    <div className="grid gap-6">
      <section aria-labelledby="skill-sets-heading" className="grid gap-3">
        <h2 id="skill-sets-heading" className="text-base font-semibold">Skill sets</h2>
        <AsyncStatus query={sets} label="skill sets">
          {(body) => {
            const rows = body?.data?.sets ?? [];
            return (
              <div className="grid gap-2">
                <TruncationNotice truncated={body?.truncated} what="skill sets" />
                <DataTable caption="Skill sets" columns={columns} rows={rows} rowKey={(set) => set.id}
                  empty={<EmptyState icon={LayersIcon} title="No skill sets yet" description="Build one below; a workspace launch can then bind every skill in it at once." />} />
              </div>
            );
          }}
        </AsyncStatus>
      </section>
      <SkillSetBuilder skills={skills} />
      {open ? <SkillSetDialog set={open} onClose={() => setOpen(null)} onConflict={onConflict} /> : null}
    </div>
  );
}

function SkillSetBuilder({ skills }: { skills: Skill[] }) {
  const formId = useId();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [memberError, setMemberError] = useState<string | null>(null);
  const form = useForm<SkillSetValues>({ resolver: zodResolver(skillSetSchema), defaultValues: { name: '', description: '' } });
  const { errors, isSubmitting } = form.formState;
  const create = useSkillMutation({
    mutationFn: (body: SkillSetValues & { items: { skillSourceId: string; revisionId: string; name: string }[] }) => apiClient.request('/skill-sets', {
      method: 'POST',
      body: { name: body.name, description: body.description, items: body.items, expectedGeneration: 0 }
    }),
    invalidate: [SKILL_SETS_KEY],
    refresh: [],
    successToast: 'Skill set created',
    errorTitle: 'The skill set was not created'
  });
  const candidates = skills.filter((skill) => skill.state !== 'archived');
  const submit = form.handleSubmit(async (values) => {
    const built = skillSetItems(skills, selectedIds);
    if (!built.ok) { setMemberError(built.message); return; }
    setMemberError(null);
    try {
      await create.mutateAsync({ ...values, items: built.items });
      form.reset({ name: '', description: '' });
      setSelectedIds([]);
    } catch {
      // The toast explains; the form keeps the name and the members.
    }
  });
  return (
    <section aria-labelledby="skill-set-builder-heading" className="grid gap-3 rounded-lg border bg-surface p-4">
      <h2 id="skill-set-builder-heading" className="text-base font-semibold">Build a skill set</h2>
      <form id={formId} className="grid gap-4" noValidate onSubmit={(event) => { void submit(event); }} aria-busy={isSubmitting || undefined}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={errors.name?.message}>
            <Input autoComplete="off" maxLength={DISPLAY_NAME_MAX} {...form.register('name')} />
          </Field>
          <Field label="Description" optional error={errors.description?.message}>
            <Input autoComplete="off" maxLength={DESCRIPTION_MAX} {...form.register('description')} />
          </Field>
        </div>
        <fieldset className="grid gap-2" aria-describedby={memberError ? `${formId}-members-error` : undefined}>
          <legend className="text-sm font-medium">Members</legend>
          {candidates.length === 0 ? <p className="text-sm text-muted-foreground">No skills to add yet.</p> : (
            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {candidates.map((skill) => {
                const id = `${formId}-member-${skill.id}`;
                return (
                  <div key={skill.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      id={id}
                      checked={selectedIds.includes(skill.id)}
                      onCheckedChange={(checked) => setSelectedIds((previous) => (checked === true ? [...previous, skill.id] : previous.filter((value) => value !== skill.id)))}
                    />
                    <label htmlFor={id} className="min-w-0 break-words">{skillLabel(skill)}</label>
                  </div>
                );
              })}
            </div>
          )}
          {memberError ? <p id={`${formId}-members-error`} role="alert" className="text-xs text-destructive">{memberError}</p> : null}
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={isSubmitting} aria-busy={isSubmitting || undefined}>{isSubmitting ? 'Saving…' : 'Save set'}</Button>
          <span className="text-xs text-muted-foreground">{selectedIds.length} selected; each member pins its current revision.</span>
        </div>
      </form>
    </section>
  );
}

/** One set: its pinned members (`GET /skill-sets/:id`), rename (`PATCH`) and delete (`DELETE`, confirmed). */
function SkillSetDialog({ set, onClose, onConflict }: { set: SkillSet; onClose: () => void; onConflict: (error: ConflictError) => void }) {
  const formId = useId();
  const path = bffPath('skill-sets', set.id);
  const detail = useQuery(bffQuery<SkillSet & { items?: SkillSetItem[] }>(path));
  const [deleting, setDeleting] = useState(false);
  const form = useForm<SkillSetValues>({ resolver: zodResolver(skillSetSchema), defaultValues: { name: set.name ?? '', description: set.description ?? '' } });
  const { isDirty, isSubmitting, errors } = form.formState;
  const keys = [SKILL_SETS_KEY, bffKey(path)];
  // The fence is the generation the detail read returned, falling back to the list row.
  const generation = positiveGeneration(detail.data?.data?.generation ?? set.generation);
  const update = useSkillMutation({
    mutationFn: (values: SkillSetValues) => apiClient.request(path, { method: 'PATCH', body: { name: values.name, description: values.description, expectedGeneration: generation } }),
    invalidate: keys,
    refresh: keys,
    onConflict,
    successToast: 'Skill set saved',
    errorTitle: 'The skill set was not saved'
  });
  const remove = useSkillMutation({
    mutationFn: () => apiClient.request(path, { method: 'DELETE', body: { expectedGeneration: generation } }),
    invalidate: [SKILL_SETS_KEY],
    refresh: keys,
    onConflict,
    successToast: `${set.name || 'Skill set'} deleted`,
    errorTitle: 'The skill set was not deleted'
  });
  useEffect(() => { form.reset({ name: set.name ?? '', description: set.description ?? '' }); }, [form, set]);

  const submit = form.handleSubmit(async (values) => {
    try { await update.mutateAsync(values); onClose(); } catch { /* toast and notice explain; the draft stays */ }
  });

  return (
    <ManagedDialog open onOpenChange={(next) => { if (!next) onClose(); }} guard={{ dirty: isDirty && !isSubmitting, locked: isSubmitting }}>
      <DialogHeader>
        <DialogTitle>{set.name || 'Skill set'}</DialogTitle>
        <DialogDescription>Members pin an exact revision, so a launch resolves the bytes the set was saved with.</DialogDescription>
      </DialogHeader>
      <AsyncStatus query={detail} label="skill set" skeleton={<Skeleton className="h-16 w-full" />}>
        {(body: BffEnvelope<SkillSet & { items?: SkillSetItem[] }>) => {
          const items = body?.data?.items ?? [];
          return items.length === 0 ? <p className="text-sm text-muted-foreground">This set has no members.</p> : (
            <ol aria-label="Members" className="grid max-h-48 gap-1 overflow-y-auto text-sm">
              {items.map((item, index) => (
                <li key={`${item.skillSourceId ?? index}-${item.revisionId ?? ''}`} className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{item.name ?? EMPTY}</span>
                  <span className="font-mono text-xs break-all text-muted-foreground">{item.revisionId}</span>
                </li>
              ))}
            </ol>
          );
        }}
      </AsyncStatus>
      <form id={formId} className="grid gap-4" noValidate onSubmit={(event) => { void submit(event); }} aria-busy={isSubmitting || undefined}>
        <Field label="Name" error={errors.name?.message}>
          <Input autoComplete="off" maxLength={DISPLAY_NAME_MAX} {...form.register('name')} />
        </Field>
        <Field label="Description" optional error={errors.description?.message}>
          <Textarea rows={2} maxLength={DESCRIPTION_MAX} {...form.register('description')} />
        </Field>
      </form>
      <DialogFooter className="sm:justify-between">
        <Button type="button" variant="outline" className="text-destructive" disabled={isSubmitting} onClick={() => setDeleting(true)}><Trash2Icon aria-hidden="true" />Delete set</Button>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="outline" disabled={isSubmitting} onClick={onClose}>Close</Button>
          <Button type="submit" form={formId} disabled={isSubmitting || !isDirty} aria-busy={isSubmitting || undefined}>{isSubmitting ? 'Saving…' : 'Save changes'}</Button>
        </div>
      </DialogFooter>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this skill set?"
        description="Launches can no longer bind it. Skills and workspaces that already resolved its members are not changed."
        target={set.name || set.id}
        confirmLabel="Delete set"
        pendingLabel="Deleting…"
        onConfirm={async () => { await remove.mutateAsync(); onClose(); }}
      />
    </ManagedDialog>
  );
}
