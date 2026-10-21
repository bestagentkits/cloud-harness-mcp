import { DetailList } from '@/components/data/detail-list';
import type { RunResult } from '../automation-model';

const preClass = 'max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-words focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none';

/** The bounded result of a skill, hook or deployment run: exit status, duration, output. */
export function RunResultView({ title, result }: { title: string; result: RunResult }) {
  return (
    <section className="grid gap-2 rounded-md border p-3" aria-label={title}>
      <h3 className="text-sm font-medium">{title}</h3>
      <DetailList items={[
        { label: 'Exit code', value: result.exitCode ?? 'Not reported', mono: true },
        { label: 'Duration', value: result.durationMs !== undefined ? `${result.durationMs} ms` : 'Not reported' },
        ...(result.status ? [{ label: 'Status', value: result.status }] : [])
      ]} />
      <pre className={preClass} tabIndex={0} aria-label={`${title} output`}>{result.output || 'No output.'}</pre>
    </section>
  );
}
