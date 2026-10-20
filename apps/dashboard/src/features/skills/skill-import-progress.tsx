import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { StatusBadge } from '@/components/data/status-badge';
import { ErrorState } from '@/components/feedback/error-state';
import { ActionButton } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { apiClient } from '@/lib/api-client';
import { type BffEnvelope, bffKey, bffPath, bffQuery, pollUntil } from '@/lib/bff-query';
import { pollingOptions } from '@/lib/query-client';
import {
  cancelGeneration, IMPORT_POLL_INTERVAL_MS, IMPORT_POLL_MAX_READS, importGuidance, importPercent, isTerminalImport, type SkillImportJob
} from './skill-model';
import { SKILLS_KEY, useSkillMutation } from './use-skill-mutation';

type JobEnvelope = BffEnvelope<SkillImportJob>;
type PollState = { state: { data: JobEnvelope | undefined; dataUpdateCount: number; status: string } };

/**
 * The `refetchInterval` of the import poll (T1): every 1.5 s until the job is terminal, a
 * read fails, or the classic 40-read budget is spent. Returning `false` stops the timer.
 */
export function importJobPolling(query: PollState): number | false {
  if (query.state.status === 'error' || query.state.dataUpdateCount >= IMPORT_POLL_MAX_READS) return false;
  return pollUntil<JobEnvelope>(IMPORT_POLL_INTERVAL_MS, (data) => isTerminalImport(data?.data))(query);
}

/**
 * One import job. This query is the only owner of the poll, and it stops when the component
 * unmounts (leaving the tab or the page), which the classic `setTimeout` chain never did (R7).
 * A failed read stops the poll and offers Retry instead of retrying on a timer.
 */
export function SkillImportProgress({ jobId, onRetry }: { jobId: string; onRetry: () => Promise<unknown> }) {
  const queryClient = useQueryClient();
  const key = bffKey(bffPath('skill-imports', jobId));
  const job = useQuery({
    ...bffQuery<SkillImportJob>(bffPath('skill-imports', jobId)),
    ...pollingOptions(IMPORT_POLL_INTERVAL_MS),
    refetchInterval: importJobPolling,
    retry: false
  });
  const current = job.data?.data;
  const terminal = isTerminalImport(current);
  const reads = queryClient.getQueryState(key)?.dataUpdateCount ?? 0;
  const exhausted = job.isSuccess && !terminal && !job.isFetching && reads >= IMPORT_POLL_MAX_READS;
  const succeeded = current?.state === 'succeeded';

  // The new skill is listed once the server says it exists, not when the import was queued.
  useEffect(() => {
    if (succeeded) void queryClient.invalidateQueries({ queryKey: SKILLS_KEY });
  }, [queryClient, succeeded]);

  const cancel = useSkillMutation({
    mutationFn: () => apiClient.request<JobEnvelope>(bffPath('skill-imports', jobId, 'cancel'), {
      method: 'POST',
      // The fence comes from the job being watched (R9), not a constant.
      body: { expectedGeneration: cancelGeneration(current) }
    }),
    invalidate: [key],
    refresh: [key],
    successTitle: 'Import cancelled',
    errorTitle: 'The import was not cancelled'
  });

  return (
    <div className="grid gap-2 rounded-md border p-3 animate-in fade-in-0 motion-reduce:animate-none" data-testid="skill-import-job" data-job-id={jobId}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Import job</h3>
        <span className="font-mono text-xs break-all text-muted-foreground">{current?.sourceRef ?? jobId}</span>
        {current ? <StatusBadge status={current.state} /> : null}
      </div>
      {terminal ? null : <Progress label="Import progress" value={importPercent(current)} />}
      <p role="status" className="text-sm">{current ? importGuidance(current) : 'Import queued.'}</p>
      {exhausted ? <p className="text-xs text-muted-foreground">Stopped checking after {IMPORT_POLL_MAX_READS} reads. The job continues on the runner; check again later.</p> : null}
      {job.isError ? <ErrorState error={job.error} onRetry={() => job.refetch()} /> : null}
      <div className="flex flex-wrap gap-2">
        {terminal || !current ? null : <ActionButton size="sm" variant="outline" pendingLabel="Cancelling…" onAction={() => cancel.mutateAsync()}>Cancel import</ActionButton>}
        {terminal && !succeeded ? <ActionButton size="sm" variant="outline" pendingLabel="Starting…" onAction={onRetry}>Retry import</ActionButton> : null}
        {exhausted ? <ActionButton size="sm" variant="ghost" pendingLabel="Checking…" onAction={() => job.refetch()}>Check again</ActionButton> : null}
      </div>
    </div>
  );
}
