import { useQuery } from '@tanstack/react-query';
import { BarChart } from '@/components/data/bar-chart';
import { Section } from '@/components/data/section';
import { AsyncStatus } from '@/components/feedback/async-status';
import { Skeleton } from '@/components/ui/skeleton';
import { type BffEnvelope, bffQuery } from '@/lib/bff-query';
import { rec } from '@/lib/format';
import { BarTable, ChartEmpty, StackedBarChart } from './overview-charts';
import {
  agentSeriesScope, burnRows, costSeries, expiryRows, METRICS_WINDOW, metricsSeries, outcomeBuckets, profileRows, reliabilityRows
} from './overview-model';

/** The two secondary analytics reads. Keys match `bffQuery` elsewhere, so nothing reads them twice. */
export const metricsQuery = bffQuery<unknown>('/metrics', { window: METRICS_WINDOW });
export const reliabilityQuery = bffQuery<unknown>('/reliability');

function ChartSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="grid gap-2">
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

/**
 * The analytics section. Every chart states the scope it measured: the execution-health and
 * cost series cover the retained agent window the projection names (`agentSeriesScope`),
 * the audit series names its window, and no chart is drawn for data the harness does not
 * keep. `/metrics` and `/reliability` load and fail independently of the Overview read.
 */
export function OverviewAnalytics({ overview }: { overview: unknown }) {
  const metrics = useQuery(metricsQuery);
  const reliability = useQuery(reliabilityQuery);
  const scope = agentSeriesScope(overview);
  const cost = costSeries(overview);
  return (
    <Section
      title="Analytics"
      id="analytics"
      description={<>Each chart states the scope it measured. Execution health and cost cover the <strong className="font-medium text-foreground">{scope}</strong>, because the harness keeps agent state and per-agent usage rather than a dated outcome or billing ledger.</>}
    >
      <div className="grid gap-6 md:grid-cols-2">
        <AsyncStatus query={metrics} label="audit events" skeleton={<ChartSkeleton label="Loading audit events" />}>
          {(body) => {
            const data = rec((body as BffEnvelope<unknown> | undefined)?.data);
            const window = typeof data.window === 'string' && data.window ? data.window : METRICS_WINDOW;
            const caption = `Retained audit events per bucket (${window})`;
            const series = metricsSeries(data);
            return (
              <div className="grid gap-1">
                {series.length ? <BarChart data={series} caption={caption} valueLabel="Events" /> : <ChartEmpty caption={caption} note="No retained events in this window." />}
                {typeof data.scope === 'string' && data.scope ? <p className="text-xs text-muted-foreground">Scope: {data.scope}</p> : null}
              </div>
            );
          }}
        </AsyncStatus>
        <StackedBarChart buckets={outcomeBuckets(overview)} caption={`Execution health over retained agents (${scope})`} emptyNote="No agents are on record yet." />
        {cost.length
          ? <BarChart data={cost} caption={`Cost over retained agents (${scope})`} valueLabel="Cost (USD)" />
          : <ChartEmpty caption={`Cost over retained agents (${scope})`} note="No agent usage is on record yet." />}
        <BarTable rows={profileRows(overview)} caption="Cost by model profile" valueLabel="Cost" emptyNote="No agent usage reported yet." />
        <BarTable rows={burnRows(overview)} caption="Budget burn of running agents" valueLabel="Cost" emptyNote="No running agents report a budget." />
        <BarTable rows={expiryRows(overview)} caption="Workspace expiry buckets" valueLabel="Workspaces" emptyNote="No workspaces are close to expiry." />
        <AsyncStatus query={reliability} label="MCP reliability" skeleton={<ChartSkeleton label="Loading MCP reliability" />}>
          {(body) => <BarTable rows={reliabilityRows((body as BffEnvelope<unknown> | undefined)?.data)} caption="MCP reliability by server" valueLabel="Calls" emptyNote="No gateway traces reported yet." />}
        </AsyncStatus>
      </div>
    </Section>
  );
}
