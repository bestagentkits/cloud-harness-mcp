import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useId } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ManagedDialog } from '@/components/ui/managed-dialog';
import { Textarea } from '@/components/ui/textarea';
import { ConflictError, apiClient } from '@/lib/api-client';
import { type BffEnvelope, bffPath } from '@/lib/bff-query';
import {
  CREATE_INSTRUCTIONS_MAX, type CreateSkillValues, createSkillSchema, DISPLAY_NAME_MAX, positiveGeneration,
  REVISION_INSTRUCTIONS_MAX, type RevisionValues, revisionSchema, type Skill
} from './skill-model';
import { SKILLS_KEY, skillDetailKeys, useSkillMutation } from './use-skill-mutation';

type SaveResult = BffEnvelope<{ warning?: unknown }>;

/** Version drift is advisory: the runner reports it beside a successful save, never as a failure. */
function savedTitle(outcome: string, result: SaveResult): string {
  const warning = result?.data?.warning;
  return typeof warning === 'string' && warning ? `${outcome} ${warning}` : outcome;
}

/**
 * Creating a custom skill (`POST /skills`) and adding a revision to an existing one
 * (`POST /skills/:id/revisions`) share one dialog, so their validation cannot drift. A revision
 * carries only the instructions: the slug and name are fixed while editing, so no field looks
 * like a change the save would drop. A failed save keeps the draft.
 */
export function SkillEditorDialog({ open, onOpenChange, skill, onConflict }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The skill a revision is added to; undefined creates a new skill. */
  skill?: Skill | undefined;
  onConflict: (error: ConflictError) => void;
}) {
  return skill
    ? <RevisionForm open={open} onOpenChange={onOpenChange} skill={skill} onConflict={onConflict} />
    : <CreateForm open={open} onOpenChange={onOpenChange} />;
}

function CreateForm({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const formId = useId();
  const form = useForm<CreateSkillValues>({ resolver: zodResolver(createSkillSchema), defaultValues: { slug: '', displayName: '', instructions: '' } });
  const { isDirty, isSubmitting, errors } = form.formState;
  const create = useSkillMutation({
    mutationFn: (values: CreateSkillValues) => apiClient.request<SaveResult>('/skills', {
      method: 'POST',
      body: { slug: values.slug, displayName: values.displayName, instructions: values.instructions, expectedGeneration: 0 }
    }),
    invalidate: [SKILLS_KEY],
    refresh: [],
    successTitle: (result) => savedTitle('Skill created.', result),
    errorTitle: 'The skill was not created'
  });

  useEffect(() => {
    if (open) form.reset({ slug: '', displayName: '', instructions: '' });
  }, [form, open]);

  const submit = form.handleSubmit(async (values) => {
    try {
      await create.mutateAsync(values);
      onOpenChange(false);
    } catch (error) {
      // A 409 on create is a slug that already exists; the draft stays for a new slug.
      if (error instanceof ConflictError) form.setError('slug', { message: 'A skill with this slug already exists. Choose another slug.' });
    }
  });

  return (
    <ManagedDialog open={open} onOpenChange={onOpenChange} guard={{ dirty: isDirty && !isSubmitting, locked: isSubmitting }} contentProps={{ className: 'sm:max-w-2xl' }}>
      <DialogHeader>
        <DialogTitle>Create a custom skill</DialogTitle>
        <DialogDescription>Instructions are stored as the skill&apos;s SKILL.md. Nothing runs when you save.</DialogDescription>
      </DialogHeader>
      <form id={formId} className="grid gap-4" noValidate onSubmit={(event) => { void submit(event); }} aria-busy={isSubmitting || undefined}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Slug" description="Letters, digits, dot, dash and underscore." error={errors.slug?.message}>
            <Input autoFocus autoComplete="off" spellCheck={false} maxLength={120} placeholder="my-skill" {...form.register('slug')} />
          </Field>
          <Field label="Display name" error={errors.displayName?.message}>
            <Input autoComplete="off" maxLength={DISPLAY_NAME_MAX} {...form.register('displayName')} />
          </Field>
        </div>
        <Field label="Instructions" error={errors.instructions?.message}>
          <Textarea rows={12} spellCheck={false} maxLength={CREATE_INSTRUCTIONS_MAX} className="font-mono text-xs" {...form.register('instructions')} />
        </Field>
      </form>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={isSubmitting} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="submit" form={formId} disabled={isSubmitting} aria-busy={isSubmitting || undefined}>{isSubmitting ? 'Saving…' : 'Save skill'}</Button>
      </DialogFooter>
    </ManagedDialog>
  );
}

function RevisionForm({ open, onOpenChange, skill, onConflict }: { open: boolean; onOpenChange: (open: boolean) => void; skill: Skill; onConflict: (error: ConflictError) => void }) {
  const formId = useId();
  const form = useForm<RevisionValues>({ resolver: zodResolver(revisionSchema), defaultValues: { instructions: '' } });
  const { isDirty, isSubmitting, errors } = form.formState;
  const keys = [SKILLS_KEY, ...skillDetailKeys(skill.id)];
  const revise = useSkillMutation({
    // The fence is the source's current generation: the runner refuses any other value, so the
    // classic page's hard-coded 0 could never succeed once a source existed.
    mutationFn: (values: RevisionValues) => apiClient.request<SaveResult>(bffPath('skills', skill.id, 'revisions'), {
      method: 'POST',
      body: { instructions: values.instructions, expectedGeneration: positiveGeneration(skill.generation) }
    }),
    invalidate: keys,
    refresh: keys,
    onConflict,
    successTitle: (result) => savedTitle('Revision added.', result),
    errorTitle: 'The revision was not saved'
  });

  useEffect(() => {
    if (open) form.reset({ instructions: '' });
  }, [form, open]);

  const submit = form.handleSubmit(async (values) => {
    try {
      await revise.mutateAsync(values);
      onOpenChange(false);
    } catch {
      // Reported by the toast (and the conflict notice); the draft stays.
    }
  });

  return (
    <ManagedDialog open={open} onOpenChange={onOpenChange} guard={{ dirty: isDirty && !isSubmitting, locked: isSubmitting }} contentProps={{ className: 'sm:max-w-2xl' }}>
      <DialogHeader>
        <DialogTitle>Add a revision to {skill.slug ?? 'this skill'}</DialogTitle>
        <DialogDescription>Saving adds a revision of the instructions. The slug and display name stay as they are, and workspaces pinned to an earlier revision keep it.</DialogDescription>
      </DialogHeader>
      <form id={formId} className="grid gap-4" noValidate onSubmit={(event) => { void submit(event); }} aria-busy={isSubmitting || undefined}>
        <Field label="Instructions" description="The complete SKILL.md for the new revision." error={errors.instructions?.message}>
          <Textarea autoFocus rows={14} spellCheck={false} maxLength={REVISION_INSTRUCTIONS_MAX} className="font-mono text-xs" {...form.register('instructions')} />
        </Field>
      </form>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={isSubmitting} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="submit" form={formId} disabled={isSubmitting} aria-busy={isSubmitting || undefined}>{isSubmitting ? 'Saving…' : 'Save revision'}</Button>
      </DialogFooter>
    </ManagedDialog>
  );
}
