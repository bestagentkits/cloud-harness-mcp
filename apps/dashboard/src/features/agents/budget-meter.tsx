import { TriangleAlertIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BudgetUtilization } from './agent-model';

const TONE: Record<BudgetUtilization['state'], string> = {
  ok: 'text-muted-foreground',
  // The warning tone is below 4.5:1 for small text on light surfaces; the icon carries it.
  close: 'text-foreground',
  exhausted: 'text-destructive',
  unknown: 'text-muted-foreground'
};

const WORD: Record<BudgetUtilization['state'], string | null> = { ok: null, close: 'Close to limit', exhausted: 'Limit reached', unknown: null };

/**
 * Usage against a limit as a native `<meter>` (no inline width, so the strict style CSP and
 * the no-`style`-attribute rule both hold) plus words for the warning states, so the state
 * never depends on colour alone. An unknown limit renders no meter at all.
 */
export function BudgetMeter({ utilization, label, className }: { utilization: BudgetUtilization; label: string; className?: string }) {
  if (utilization.percent === undefined) return null;
  const word = WORD[utilization.state];
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <meter aria-label={label} min={0} max={100} low={80} high={99} optimum={0} value={utilization.percent} className="h-1.5 w-full min-w-16 flex-1" />
      {word ? (
        <span className={cn('inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap', TONE[utilization.state])}>
          <TriangleAlertIcon aria-hidden="true" className={cn('size-3.5', utilization.state === 'close' ? 'text-warning' : 'text-destructive')} />{word}
        </span>
      ) : null}
    </span>
  );
}
