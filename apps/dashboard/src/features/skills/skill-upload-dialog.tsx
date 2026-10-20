import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { StatusBadge } from '@/components/data/status-badge';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ManagedDialog } from '@/components/ui/managed-dialog';
import { useBffMutation } from '@/lib/bff-mutation';
import { uploadSkillArchive } from './skill-archive-upload';
import { type ArchiveResult, archiveProblem, archiveSummary } from './skill-model';
import { SKILLS_KEY } from './use-skill-mutation';

const uploadSchema = z.object({
  archive: z.custom<FileList | undefined>().superRefine((files, context) => {
    const problem = archiveProblem(files?.[0]);
    if (problem) context.addIssue({ code: 'custom', message: problem });
  })
});
type UploadValues = z.infer<typeof uploadSchema>;

/**
 * "Upload skill", the page's primary action: a zip of skill directories, each `SKILL.md`
 * becoming a skill. The type and the 8 MiB cap are checked here before any byte is sent; the
 * route checks both again. Per-entry results stay in the dialog, because a partial upload
 * has to say which entries were refused while the operator is still looking.
 */
export function SkillUploadDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const formId = useId();
  const [results, setResults] = useState<ArchiveResult[] | null>(null);
  const form = useForm<UploadValues>({ resolver: zodResolver(uploadSchema), defaultValues: { archive: undefined } });
  const { isDirty, isSubmitting, errors } = form.formState;
  const upload = useBffMutation({
    mutationFn: (file: File) => uploadSkillArchive(file),
    invalidate: [SKILLS_KEY],
    successTitle: (rows) => archiveSummary(rows),
    errorTitle: 'The archive was not imported'
  });

  // Each opening starts clean: results from the previous upload are cleared during render.
  const [openedFor, setOpenedFor] = useState(open);
  if (open !== openedFor) {
    setOpenedFor(open);
    if (open) setResults(null);
  }
  useEffect(() => {
    if (open) form.reset({ archive: undefined });
  }, [form, open]);

  const submit = form.handleSubmit(async ({ archive }) => {
    const file = archive?.[0];
    if (!file) return;
    setResults(null);
    try {
      const rows = await upload.mutateAsync(file);
      setResults(rows);
      form.reset({ archive: undefined });
    } catch {
      // The toast explains the failure; the chosen file stays selected for a retry.
    }
  });

  return (
    <ManagedDialog open={open} onOpenChange={onOpenChange} guard={{ dirty: isDirty && !isSubmitting, locked: isSubmitting }}>
      <DialogHeader>
        <DialogTitle>Upload skills</DialogTitle>
        <DialogDescription>A zip of skill directories. Each directory&apos;s SKILL.md becomes a skill. Up to 200 skills, 8 MiB per upload.</DialogDescription>
      </DialogHeader>
      <form id={formId} className="grid gap-4" noValidate onSubmit={(event) => { void submit(event); }} aria-busy={isSubmitting || undefined}>
        <Field label="Archive" description="A .zip file." error={errors.archive?.message}>
          <Input type="file" accept=".zip,application/zip" className="py-1.5" {...form.register('archive')} />
        </Field>
      </form>
      {results ? (
        <div className="grid gap-2 animate-in fade-in-0 motion-reduce:animate-none">
          <p role="status" className="text-sm">{archiveSummary(results)}</p>
          {results.length > 0 ? (
            <ul aria-label="Upload results" className="grid max-h-60 gap-1 overflow-y-auto text-sm">
              {results.map((row, index) => (
                <li key={`${row.slug ?? 'entry'}-${index}`} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs break-all">{row.slug || 'unnamed entry'}</span>
                  <StatusBadge status={row.ok ? 'created' : (row.error ?? 'failed')} tone={row.ok ? 'success' : 'danger'} />
                  {!row.ok && row.message ? <span className="text-xs text-muted-foreground">{row.message}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={isSubmitting} onClick={() => onOpenChange(false)}>Close</Button>
        <Button type="submit" form={formId} disabled={isSubmitting} aria-busy={isSubmitting || undefined}>{isSubmitting ? 'Uploading…' : 'Upload'}</Button>
      </DialogFooter>
    </ManagedDialog>
  );
}
