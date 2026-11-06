import { useId } from 'react';
import { cn } from '@/lib/utils';

export type BarDatum = { key: string; label: string; value: number; display?: string };

/**
 * A small bar chart drawn as SVG attributes (no inline style, so it renders under the CSP)
 * with its data as a real table: screen readers and keyboard users get the table, and
 * sighted users can open it under the chart. The table's caption names the chart.
 */
export function BarChart({ data, caption, valueLabel, className }: { data: readonly BarDatum[]; caption: string; valueLabel: string; className?: string }) {
  const id = useId();
  const max = Math.max(1, ...data.map((datum) => datum.value));
  const width = 100;
  const gap = data.length > 1 ? 2 : 0;
  const barWidth = data.length ? (width - gap * (data.length - 1)) / data.length : width;
  return (
    <figure className={cn('grid gap-2', className)} aria-labelledby={`${id}-caption`}>
      <figcaption id={`${id}-caption`} className="text-sm font-medium">{caption}</figcaption>
      {data.length ? (
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-32 w-full text-info" aria-hidden="true" focusable="false">
          {data.map((datum, index) => {
            const height = datum.value > 0 ? Math.max(1, (datum.value / max) * 38) : 0;
            return <rect key={datum.key} x={index * (barWidth + gap)} y={40 - height} width={barWidth} height={height} rx={0.6} fill="currentColor" opacity={0.8}><title>{`${datum.label}: ${datum.display ?? datum.value}`}</title></rect>;
          })}
        </svg>
      ) : <p className="text-sm text-muted-foreground">No data in this window.</p>}
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-muted-foreground">Show as table</summary>
        <table className="mt-2 w-full border-collapse text-xs">
          <caption className="sr-only">{caption}</caption>
          <thead><tr className="border-b text-left text-muted-foreground"><th scope="col" className="py-1 pr-2 font-medium">Period</th><th scope="col" className="py-1 font-medium">{valueLabel}</th></tr></thead>
          <tbody>{data.map((datum) => <tr key={datum.key} className="border-b last:border-0"><td className="py-1 pr-2">{datum.label}</td><td className="py-1 tabular-nums">{datum.display ?? datum.value}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}
