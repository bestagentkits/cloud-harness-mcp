import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useId } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ManagedDialog } from '@/components/ui/managed-dialog';
import { Textarea } from '@/components/ui/textarea';
import { type ConflictError, apiClient } from '@/lib/api-client';
import { bffPath } from '@/lib/bff-query';
import { DESCRIPTION_MAX, DISPLAY_NAME_MAX, parseTags, positiveGeneration, type Skill, skillTags } from './skill-model';
import { type SkillDetailsValues, skillDetailsSchema } from './skill-form-schemas';
import { SKILLS_KEY, skillDetailKeys, useSkillMutation } from './use-skill-mutation';

function initialValues(skill: Skill): SkillDetailsValues {
  return { displayName: skill.displayName ?? '', description: skill.description ?? '', tags: skillTags(skill).join(', ') };
}

/**
 * Metadata edit (`PATCH /skills/:id`): display name, description and tags. The classic editor
 * names this operation as the place metadata changes go but never wired it, which left the
 * library's tag filter with no way to set a tag. Fenced by the source's generation.
 */
export function SkillDetailsDialog({ open, onOpenChange, skill, onConflict }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skill: Skill;
  onConflict: (error: ConflictError) => void;
}) {
  const formId = useId();
  const form = useForm<SkillDetailsValues>({ resolver: zodResolver(skillDetailsSchema), defaultValues: initialValues(skill) });
  const { isDirty, isSubmitting, errors } = form.formState;
  const keys = [SKILLS_KEY, ...skillDetailKeys(skill.id)];
  const update = useSkillMutation({
    mutationFn: (values: SkillDetailsValues) => apiClient.request(bffPath('skills', skill.id), {
      method: 'PATCH',
      body: { displayName: values.displayName, description: values.description, tags: parseTags(values.tags), expectedGeneration: positiveGeneration(skill.generation) }
    }),
    invalidate: keys,
    refresh: keys,
    onConflict,
    successTitle: 'Skill details saved',
    errorTitle: 'The skill details were not saved'
  });

  // Reset only when the dialog opens: a background refetch must not wipe what is being typed.
  useEffect(() => {
    if (open) form.reset(initialValues(skill));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, open]);

  const submit = form.handleSubmit(async (values) => {
    try {
      await update.mutateAsync(values);
      onOpenChange(false);
    } catch {
      // Reported by the toast (and the conflict notice); the draft stays.
    }
  });

  return (
    <ManagedDialog open={open} onOpenChange={onOpenChange} guard={{ dirty: isDirty && !isSubmitting, locked: isSubmitting }}>
      <DialogHeader>
        <DialogTitle>Edit details of {skill.slug ?? 'this skill'}</DialogTitle>
        <DialogDescription>The slug and the instructions do not change here.</DialogDescription>
      </DialogHeader>
      <form id={formId} className="grid gap-4" noValidate onSubmit={(event) => { void submit(event); }} aria-busy={isSubmitting || undefined}>
        <Field label="Display name" error={errors.displayName?.message}>
          <Input autoFocus autoComplete="off" maxLength={DISPLAY_NAME_MAX} {...form.register('displayName')} />
        </Field>
        <Field label="Description" optional error={errors.description?.message}>
          <Textarea rows={3} maxLength={DESCRIPTION_MAX} {...form.register('description')} />
        </Field>
        <Field label="Tags" optional description="Comma-separated, up to 16 tags of 32 characters." error={errors.tags?.message}>
          <Input autoComplete="off" {...form.register('tags')} />
        </Field>
      </form>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={isSubmitting} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="submit" form={formId} disabled={isSubmitting} aria-busy={isSubmitting || undefined}>{isSubmitting ? 'Saving…' : 'Save details'}</Button>
      </DialogFooter>
    </ManagedDialog>
  );
}
