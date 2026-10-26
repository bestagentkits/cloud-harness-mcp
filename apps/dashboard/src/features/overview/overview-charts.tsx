import { useId } from 'react';
import { cn } from '@/lib/utils';
import { OUTCOME_CATEGORIES, type OutcomeBucket, outcomeDescription, type RowDatum } from './overview-model';

/**
 * Stacked bars for the execution-health series. Like the shared `BarChart`, geometry is SVG
 * attributes and colour comes from classes (no inline style, so it renders under the CSP).
 * The categories are named in a visible legend, every bucket's counts are spelled out in its
 * `<title>`, and the same numbers are a real table under the figure, so nothing is conveyed
 * by colour or height alone.
 */
export function StackedBarChart({ buckets, caption, emptyNote }: { buckets: readonly OutcomeBucket[]; caption: string; emptyNote: string }) {
  const id = useId();
  if (!buckets.length) return <ChartEmpty caption={caption} note={emptyNote} />;
  const totals = buckets.map((bucket) => OUTCOME_CATEGORIES.reduce((sum, category) => sum + bucket.segments[category.key], 0));
  const ceiling = Math.max(1, ...totals);
  const gap = buckets.length > 1 ? 2 : 0;
  const barWidth = (100 - gap * (buckets.length - 1)) / buckets.length;
  return (
    <figure className="grid min-w-0 gap-2" aria-labelledby={`${id}-caption`}>
      <figcaption id={`${id}-caption`} className="text-sm font-medium">{caption}</figcaption>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
        {OUTCOME_CATEGORIES.map((category) => (
          <li key={category.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn('size-2.5 rounded-sm', category.swatch)} />
            {category.label}
          </li>
        ))}
      </ul>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-32 w-full" aria-hidden="true" focusable="false">
        {buckets.map((bucket, index) => {
          let top = 40;
          return (
            <g key={bucket.key}>
              <title>{outcomeDescription(bucket)}</title>
              {OUTCOME_CATEGORIES.map((category) => {
                const value = bucket.segments[category.key];
                if (value <= 0) return null;
                const height = (value / ceiling) * 38;
                top -= height;
                return <rect key={category.key} data-segment={category.key} x={index * (barWidth + gap)} y={top} width={barWidth} height={height} className={category.fill} opacity={0.85} />;
              })}
            </g>
          );
        })}
      </svg>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-muted-foreground">Show as table</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th scope="col" className="py-1 pr-2 font-medium">Bucket</th>
                {OUTCOME_CATEGORIES.map((category) => <th key={category.key} scope="col" className="py-1 pr-2 font-medium">{category.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket) => (
                <tr key={bucket.key} className="border-b last:border-0">
                  <th scope="row" className="py-1 pr-2 text-left font-normal">{bucket.label}</th>
                  {OUTCOME_CATEGORIES.map((category) => <td key={category.key} className="py-1 pr-2 tabular-nums">{bucket.segments[category.key]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

/**
 * Horizontal bars for values that read better as rows (cost per profile, budget burn,
 * expiry buckets, MCP reliability). The table is the chart: each row carries its label,
 * value and note as text, and the bar beside them is decoration hidden from assistive tech.
 */
export function BarTable({ rows, caption, valueLabel, emptyNote }: { rows: readonly RowDatum[]; caption: string; valueLabel: string; emptyNote: string }) {
  if (!rows.length) return <ChartEmpty caption={caption} note={emptyNote} />;
  const ceiling = Math.max(1, ...rows.map((row) => row.value));
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <caption className="pb-2 text-left text-sm font-medium">{caption}</caption>
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="py-1 pr-2 font-medium">Item</th>
            <th scope="col" className="py-1 pr-2 font-medium">{valueLabel}</th>
            <th scope="col" className="py-1 pr-2 font-medium">Note</th>
            <th scope="col" className="w-24 py-1 font-medium"><span className="sr-only">Relative size</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b last:border-0">
              <th scope="row" className="max-w-40 truncate py-1 pr-2 text-left font-normal" title={row.label}>{row.label}</th>
              <td className="py-1 pr-2 whitespace-nowrap tabular-nums">{row.display}</td>
              <td className="py-1 pr-2 text-muted-foreground">{row.note}</td>
              <td className="py-1">
                <svg viewBox="0 0 100 8" preserveAspectRatio="none" className="h-2 w-24 text-info" aria-hidden="true" focusable="false">
                  <rect x={0} y={0} width={Math.max(row.value > 0 ? 1 : 0, (row.value / ceiling) * 100)} height={8} rx={1} fill="currentColor" opacity={0.8} />
                </svg>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A chart with nothing to draw says why instead of rendering an empty axis. */
export function ChartEmpty({ caption, note }: { caption: string; note: string }) {
  return (
    <div className="grid min-w-0 gap-2">
      <p className="text-sm font-medium">{caption}</p>
      <p className="text-sm text-muted-foreground">{note}</p>
    </div>
  );
}
