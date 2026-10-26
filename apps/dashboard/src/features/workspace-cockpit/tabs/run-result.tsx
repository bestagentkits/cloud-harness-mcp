import { DetailList } from '@/components/data/detail-list';
import { StatusBadge } from '@/components/data/status-badge';
import type { RunResult } from '../automation-model';

const preClass = 'max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-words focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none';

const EXECUTION_MODES: Record<string, string> = { 'helper-container': 'Disposable helper container' };

/**
 * The bounded result of a skill, hook or deployment run: exit status, where it ran, the signal
 * that stopped it (a timeout), duration and output. A `failed` run still ran, so it shows the same.
 */
export function RunResultView({ title, result, failed = false }: { title: string; result: RunResult; failed?: boolean }) {
  return (
    <section className="grid gap-2 rounded-md border p-3" aria-label={title}>
      <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">{title}{failed ? <StatusBadge status="FAILED" label="Exited with an error" /> : null}</h3>
      <DetailList items={[
        { label: 'Exit code', value: result.exitCode ?? 'Not reported', mono: true },
        ...(result.executionMode ? [{ label: 'Ran in', value: EXECUTION_MODES[result.executionMode] ?? result.executionMode }] : []),
        ...(result.signal ? [{ label: 'Stopped by', value: result.signal, mono: true }] : []),
        { label: 'Duration', value: result.durationMs !== undefined ? `${result.durationMs} ms` : 'Not reported' },
        ...(result.status ? [{ label: 'Status', value: result.status }] : [])
      ]} />
      <pre className={preClass} tabIndex={0} aria-label={`${title} output`}>{result.output || 'No output.'}</pre>
    </section>
  );
}
