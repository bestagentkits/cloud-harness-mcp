import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { DownloadIcon, SearchIcon } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { AsyncStatus } from '@/components/feedback/async-status';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { apiClient } from '@/lib/api-client';
import { type BffEnvelope, bffQuery } from '@/lib/bff-query';
import { useBffMutation } from '@/lib/bff-mutation';
import { SkillImportProgress } from './skill-import-progress';
import { IMPORT_SOURCE_KINDS, importBody, PROVIDER_LABELS, type SkillImportJob, type SkillSearchResult } from './skill-model';
import { type ImportValues, importSchema } from './skill-form-schemas';

/** Every provider the search schema allows, so a fan-out that reached only one is visible (classic page). */
const SEARCH_PROVIDERS = 'local,skills-sh,skillx';
export const SEARCH_MAX = 200;

/**
 * Discover: search the registries and import a skill from a source. Search runs on submit, as
 * the classic page does, because each search fans out to remote providers; the term is the
 * `find` search param so a reload shows the same results. The import job is held by the page,
 * so leaving this tab stops its poll and coming back resumes it.
 */
export function SkillsDiscover({ find, onFind, jobId, onJob }: {
  find: string | undefined;
  onFind: (next: string | undefined) => void;
  jobId: string | undefined;
  onJob: (jobId: string | undefined) => void;
}) {
  return (
    <div className="grid gap-6">
      <SearchPanel find={find} onFind={onFind} />
      <ImportPanel jobId={jobId} onJob={onJob} />
    </div>
  );
}

function SearchPanel({ find, onFind }: { find: string | undefined; onFind: (next: string | undefined) => void }) {
  const [draft, setDraft] = useState(find ?? '');
  const [synced, setSynced] = useState(find);
  if (find !== synced) { setSynced(find); setDraft(find ?? ''); }
  const search = useQuery({ ...bffQuery<SkillSearchResult>('/skills/search', { query: find, providers: SEARCH_PROVIDERS }), enabled: Boolean(find) });
  return (
    <section aria-labelledby="skills-search-heading" className="grid gap-3">
      <h2 id="skills-search-heading" className="text-base font-semibold">Search providers</h2>
      <form
        role="search"
        aria-label="Search skill providers"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => { event.preventDefault(); onFind(draft.trim().slice(0, SEARCH_MAX) || undefined); }}
      >
        <Field label="Search term" className="min-w-48 flex-1 sm:max-w-sm">
          <Input type="search" value={draft} maxLength={SEARCH_MAX} onChange={(event) => setDraft(event.target.value)} placeholder="Skill name" />
        </Field>
        <Button type="submit" variant="outline"><SearchIcon aria-hidden="true" />Search</Button>
      </form>
      {find ? (
        <AsyncStatus query={search} label="search results" skeleton={<Skeleton className="h-20 w-full" />}>
          {(body: BffEnvelope<SkillSearchResult>) => <SearchResults data={body?.data} />}
        </AsyncStatus>
      ) : <p className="text-sm text-muted-foreground">Search a registry to find a skill to import.</p>}
    </section>
  );
}

/** Hits and provider failures side by side: an empty list and a broken provider are different facts. */
function SearchResults({ data }: { data: SkillSearchResult | undefined }) {
  const local = data?.local ?? [];
  const remote = data?.results ?? [];
  const failed = (data?.providers ?? []).filter((provider) => provider.status !== 'ok');
  return (
    <div className="grid gap-2 animate-in fade-in-0 motion-reduce:animate-none" data-testid="skills-search-results">
      {failed.map((provider, index) => (
        <p key={`${provider.provider ?? 'provider'}-${index}`} role="note" className="text-xs text-warning">
          {PROVIDER_LABELS[provider.provider ?? ''] ?? provider.provider ?? 'A provider'}: {provider.warning ?? 'unavailable'}
        </p>
      ))}
      {local.length === 0 && remote.length === 0 ? <p className="text-sm text-muted-foreground">No skills matched.</p> : (
        <ul aria-label="Search results" className="grid gap-1.5 text-sm">
          {local.map((skill) => (
            <li key={`local-${skill.id}`} className="flex flex-wrap items-baseline gap-2 rounded-md border px-3 py-2">
              <span className="font-medium">{skill.displayName ?? skill.slug}</span>
              <span className="font-mono text-xs text-muted-foreground">{skill.slug}</span>
              <span className="text-xs text-muted-foreground">installed</span>
            </li>
          ))}
          {remote.map((hit, index) => (
            <li key={`${hit.provider ?? ''}-${hit.reference ?? index}`} className="grid gap-0.5 rounded-md border px-3 py-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">{hit.name ?? hit.reference}</span>
                <span className="font-mono text-xs break-all text-muted-foreground">{hit.reference}</span>
                <span className="text-xs text-muted-foreground">{PROVIDER_LABELS[hit.provider ?? ''] ?? hit.provider}</span>
              </div>
              {hit.description ? <p className="text-xs text-muted-foreground">{hit.description}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Starts an import (`POST /skill-imports`) and watches the job. Retry re-submits what the form
 * holds, so the submit and the retry are one path, as the classic wizard promises after a
 * cache miss.
 */
function ImportPanel({ jobId, onJob }: { jobId: string | undefined; onJob: (jobId: string | undefined) => void }) {
  const form = useForm<ImportValues>({ resolver: zodResolver(importSchema), defaultValues: { sourceKind: 'skills-sh', sourceRef: '', ref: '' } });
  const { errors, isSubmitting } = form.formState;
  const start = useBffMutation({
    mutationFn: (values: ImportValues) => apiClient.request<BffEnvelope<SkillImportJob>>('/skill-imports', { method: 'POST', body: importBody(values) }),
    successTitle: 'Import started',
    errorTitle: 'The import did not start',
    onSuccess: (result) => { if (typeof result?.data?.id === 'string') onJob(result.data.id); }
  });
  const submit = form.handleSubmit(async (values) => { await start.mutateAsync(values).catch(() => undefined); });

  return (
    <section aria-labelledby="skills-import-heading" className="grid gap-3">
      <h2 id="skills-import-heading" className="text-base font-semibold">Import a skill</h2>
      <form className="grid gap-3 sm:grid-cols-[10rem_1fr_1fr_auto] sm:items-start" noValidate onSubmit={(event) => { void submit(event); }} aria-busy={isSubmitting || undefined}>
        <Field label="Source kind">
          <NativeSelect {...form.register('sourceKind')}>
            {IMPORT_SOURCE_KINDS.map((kind) => <option key={kind} value={kind}>{PROVIDER_LABELS[kind] ?? kind}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Source" description="owner/repository (a SkillX reference for SkillX)." error={errors.sourceRef?.message}>
          <Input autoComplete="off" spellCheck={false} maxLength={300} placeholder="owner/repository" {...form.register('sourceRef')} />
        </Field>
        <Field label="Ref" optional description="A full 40 or 64 character commit id." error={errors.ref?.message}>
          <Input autoComplete="off" spellCheck={false} maxLength={64} className="font-mono" {...form.register('ref')} />
        </Field>
        <Button type="submit" className="sm:mt-6" disabled={isSubmitting} aria-busy={isSubmitting || undefined}><DownloadIcon aria-hidden="true" />{isSubmitting ? 'Starting…' : 'Import'}</Button>
      </form>
      {jobId ? <SkillImportProgress key={jobId} jobId={jobId} onRetry={() => submit()} /> : null}
    </section>
  );
}
