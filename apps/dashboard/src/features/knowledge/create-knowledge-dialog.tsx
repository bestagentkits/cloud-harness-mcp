import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ManagedDialog } from '@/components/ui/managed-dialog';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { bffQuery } from '@/lib/bff-query';
import { displayName, PROJECTS_PATH, projectsFrom } from '@/features/projects/project-model';
import {
  CONTENT_MAX, CREATE_DEFAULTS, createKnowledgeSchema, type CreateKnowledgeValues, JOURNAL_TYPE_LABELS, JOURNAL_TYPES,
  KIND_LABELS, KNOWLEDGE_KINDS, KNOWLEDGE_SCOPES, SCOPE_LABELS, TITLE_MAX
} from './knowledge-model';

/**
 * "New entry" (parity D9): a memory note or a journal entry. The form resets each time it
 * opens; project scope loads `/projects` (the same cached read as the Projects page) only
 * once that scope is chosen, and workspace scope asks for the workspace id the runner
 * requires. An edited form asks before an accidental close discards it.
 */
export function CreateKnowledgeDialog({ open, onOpenChange, onCreate }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves when the server accepted the entry; the dialog then closes. */
  onCreate: (values: CreateKnowledgeValues) => Promise<unknown>;
}) {
  const formId = useId();
  const form = useForm<CreateKnowledgeValues>({ resolver: zodResolver(createKnowledgeSchema), defaultValues: CREATE_DEFAULTS });
  const { isDirty, isSubmitting, errors } = form.formState;
  const kind = useWatch({ control: form.control, name: 'kind' });
  const scope = useWatch({ control: form.control, name: 'scope' });
  const projects = useQuery({ ...bffQuery<unknown>(PROJECTS_PATH), enabled: open && scope === 'project' });
  const projectOptions = projectsFrom(projects.data);

  useEffect(() => {
    if (open) form.reset(CREATE_DEFAULTS);
  }, [form, open]);

  // Preselect the first project once the list arrives, as the classic select did.
  useEffect(() => {
    const first = projectsFrom(projects.data)[0];
    if (scope === 'project' && first && !form.getValues('projectId')) form.setValue('projectId', first.id);
  }, [form, projects.data, scope]);

  const submit = form.handleSubmit(async (values) => {
    try {
      await onCreate(values);
      onOpenChange(false);
    } catch {
      // The mutation's toast explains the failure; the draft stays for a retry.
    }
  });

  return (
    <ManagedDialog open={open} onOpenChange={onOpenChange} guard={{ dirty: isDirty && !isSubmitting, locked: isSubmitting }} contentProps={{ className: 'sm:max-w-xl' }}>
      <DialogHeader>
        <DialogTitle>New knowledge entry</DialogTitle>
        <DialogDescription>Create a scoped memory note or a chronological journal entry.</DialogDescription>
      </DialogHeader>
      <form id={formId} className="grid max-h-[60vh] gap-4 overflow-y-auto p-0.5" noValidate onSubmit={(event) => { void submit(event); }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Kind">
            <NativeSelect {...form.register('kind')}>
              {KNOWLEDGE_KINDS.map((value) => <option key={value} value={value}>{KIND_LABELS[value]}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Scope">
            <NativeSelect {...form.register('scope')}>
              {KNOWLEDGE_SCOPES.map((value) => <option key={value} value={value}>{SCOPE_LABELS[value]}</option>)}
            </NativeSelect>
          </Field>
        </div>
        {scope === 'project' ? (
          <Field
            label="Project"
            error={errors.projectId?.message}
            description={projects.isPending ? 'Loading projects…' : projects.isError ? 'Projects could not load. Close and retry.' : projectOptions.length === 0 ? 'No projects yet. Create one on the Projects page first.' : undefined}
          >
            <NativeSelect disabled={projectOptions.length === 0} {...form.register('projectId')}>
              {projectOptions.length === 0 ? <option value="">No projects available</option> : null}
              {projectOptions.map((project) => <option key={project.id} value={project.id}>{displayName(project)}</option>)}
            </NativeSelect>
          </Field>
        ) : null}
        {scope === 'workspace' ? (
          <Field label="Workspace ID" error={errors.workspaceId?.message} description="The workspace this entry belongs to.">
            <Input autoComplete="off" spellCheck={false} placeholder="ws_…" maxLength={83} className="font-mono" {...form.register('workspaceId')} />
          </Field>
        ) : null}
        {kind === 'journal' ? (
          <Field label="Journal type">
            <NativeSelect {...form.register('journalType')}>
              {JOURNAL_TYPES.map((value) => <option key={value} value={value}>{JOURNAL_TYPE_LABELS[value]}</option>)}
            </NativeSelect>
          </Field>
        ) : null}
        <Field label="Title" error={errors.title?.message}>
          <Input autoFocus autoComplete="off" maxLength={TITLE_MAX} placeholder="Database connection pooling" {...form.register('title')} />
        </Field>
        <Field label="Tags" optional error={errors.tags?.message} description="Comma-separated, for example: postgres, caching, adr">
          <Input autoComplete="off" {...form.register('tags')} />
        </Field>
        <Field label="Markdown content" error={errors.content?.message}>
          <Textarea rows={6} maxLength={CONTENT_MAX} spellCheck={false} className="font-mono" {...form.register('content')} />
        </Field>
      </form>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={isSubmitting} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="submit" form={formId} disabled={isSubmitting} aria-busy={isSubmitting || undefined}>{isSubmitting ? 'Creating…' : 'Create entry'}</Button>
      </DialogFooter>
    </ManagedDialog>
  );
}
