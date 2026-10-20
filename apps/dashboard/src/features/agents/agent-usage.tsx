import { Section } from '@/components/data/section';
import { formatBytes, formatDuration, formatNumber } from '@/lib/format';
import { type Agent, budgetUtilization, costOf, percentLabel, usageOf } from './agent-model';
import { BudgetMeter } from './budget-meter';

type Row = { label: string; used: unknown; max: unknown; format?: (value: unknown) => string };

/**
 * The runner's usage counters against the agent's budget: tokens, cost and output, each
 * with its share of the limit. A limit that was never configured reads "Not reported"
 * rather than 0%, so nothing here looks like a measurement the runner did not make.
 */
export function AgentUsage({ agent }: { agent: Agent }) {
  const usage = agent.usage ?? {};
  const budget = agent.budget ?? {};
  const rows: Row[] = [
    { label: 'Input tokens', used: usage.inputTokens, max: budget.maxInputTokens },
    { label: 'Output tokens', used: usage.outputTokens, max: budget.maxOutputTokens },
    { label: 'Cost', used: usage.costMicros, max: budget.maxCostMicros, format: costOf },
    { label: 'Output', used: usage.outputBytes, max: budget.maxOutputBytes, format: formatBytes }
  ];
  return (
    <Section title="Usage and budget" id="agent-usage" description="The runner's reported counters; a limit that was never configured reads Not reported.">
      <ul className="grid gap-3 sm:grid-cols-2">
        {rows.map((row) => {
          const utilization = budgetUtilization(row.used, row.max);
          return (
            <li key={row.label} className="grid gap-1 rounded-md border bg-background p-3">
              <span className="text-xs text-muted-foreground">{row.label}</span>
              <span className="text-sm tabular-nums">{usageOf(row.used, row.max, row.format)} ({percentLabel(utilization)})</span>
              <BudgetMeter utilization={utilization} label={`${row.label} against the limit`} />
            </li>
          );
        })}
      </ul>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <div><dt className="text-xs text-muted-foreground">Tool time</dt><dd className="tabular-nums">{formatDuration(usage.toolTimeMs)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Wall time</dt><dd className="tabular-nums">{formatDuration(usage.wallTimeMs)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Events</dt><dd className="tabular-nums">{formatNumber(usage.eventCount)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Time limit</dt><dd className="tabular-nums">{typeof budget.ttlSeconds === 'number' ? formatDuration(budget.ttlSeconds * 1_000) : 'Not reported'}</dd></div>
      </dl>
    </Section>
  );
}
