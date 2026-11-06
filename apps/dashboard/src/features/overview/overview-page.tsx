import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleCheckIcon, HourglassIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { DetailList } from '@/components/data/detail-list';
import { Section } from '@/components/data/section';
import { StatusBadge } from '@/components/data/status-badge';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { ErrorState } from '@/components/feedback/error-state';
import { PageSkeleton } from '@/components/feedback/page-skeleton';
import { NavLink } from '@/components/layouts/nav-link';
import { CopyButton } from '@/components/ui/copy-button';
import { Skeleton } from '@/components/ui/skeleton';
import { type BffEnvelope, bffQuery } from '@/lib/bff-query';
import { EMPTY, formatBytes, formatDateTime } from '@/lib/format';
import { pageReadQuery } from '@/lib/page-read';
import { displayName, profileQuery } from '@/lib/profile';
import { cn } from '@/lib/utils';
import { OverviewAnalytics } from './overview-analytics';
import { attentionItems, decisionTiles, expiryBuckets, serverFacts } from './overview-model';

export const serverQuery = bffQuery<unknown>('/server');

/** A timestamp, or "Never" when the server reports none (a session without an expiry). */
const optionalTime = (value: string | null | undefined) => (value ? formatDateTime(value) : 'Never');

/**
 * The Overview answers decision questions first: what needs attention, what is running,
 * what it costs and what expires soon. Every tile links to the filtered list that explains
 * it; analytics follow, then Access and Server. Reads match the classic page: `/overview`
 * (the registry read), `/metrics?window=24h`, `/reliability`, `/server`, and the shell's
 * shared `/profile`. Each section loads and fails on its own; nothing polls.
 */
export function OverviewPage() {
  const overview = useQuery(pageReadQuery('overview', {}));
  return (
    <div className="grid gap-(--stack-gap)">
      <AsyncStatus query={overview} label="overview" skeleton={<OverviewSkeleton />}>
        {(body) => {
          const data = (body as BffEnvelope<unknown> | undefined)?.data;
          return (
            <div className="grid gap-(--stack-gap) animate-in fade-in-0 motion-reduce:animate-none">
              <DecisionTileGrid overview={data} />
              <div className="grid gap-(--stack-gap) lg:grid-cols-2">
                <AttentionPanel overview={data} />
                <ExpiryPanel overview={data} />
              </div>
              <OverviewAnalytics overview={data} />
            </div>
          );
        }}
      </AsyncStatus>
      <div className="grid gap-(--stack-gap) lg:grid-cols-2">
        <AccessPanel />
        <ServerPanel />
      </div>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div role="status" aria-label="Loading overview" data-testid="page-skeleton" className="grid gap-(--stack-gap)">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-28 w-full" />)}</div>
      <div className="grid gap-3 lg:grid-cols-2"><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></div>
    </div>
  );
}

const TILE_CLASS = 'grid h-full gap-1 rounded-lg border bg-surface p-4 transition-colors hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none motion-reduce:transition-none';

/** One tile's text. The value and its note are words, so an alert never relies on the border colour. */
function TileBody({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{note}</span>
    </>
  );
}

/** The four decision tiles, each a typed link to the filtered list that explains it. */
function DecisionTileGrid({ overview }: { overview: unknown }) {
  const tiles = decisionTiles(overview);
  const attention = tiles.attention.count > 0;
  const expiring = tiles.expiry.count > 0;
  return (
    <ul aria-label="Decision metrics" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <li data-tile="attention">
        <Link to="/agents" search={{ attention: 'needs-attention' }} className={cn(TILE_CLASS, attention && 'border-warning/60')}>
          <TileBody label="Needs attention" value={String(tiles.attention.count)} note={attention ? 'Open the agents needing attention; the list below also covers workspaces and approvals.' : 'Nothing needs action right now.'} />
        </Link>
      </li>
      <li data-tile="running">
        <Link to="/agents" search={{ status: 'RUNNING' }} className={TILE_CLASS}>
          <TileBody label="Running now" value={String(tiles.running.agents)} note={`${tiles.running.workspaces} active workspace(s)`} />
        </Link>
      </li>
      <li data-tile="cost">
        <Link to="/agents" search={{ status: 'RUNNING' }} className={TILE_CLASS}>
          <TileBody label="Cost" value={tiles.cost.value} note={`scope: ${tiles.cost.scope}`} />
        </Link>
      </li>
      <li data-tile="expiry">
        <Link to="/workspaces" search={{ expiring: 60 }} className={cn(TILE_CLASS, expiring && 'border-warning/60')}>
          <TileBody label="Expiring soon" value={String(tiles.expiry.count)} note="lease(s) within the hour" />
        </Link>
      </li>
    </ul>
  );
}

function AttentionPanel({ overview }: { overview: unknown }) {
  const items = attentionItems(overview);
  return (
    <Section title="Needs attention" id="overview-attention">
      {items.length ? (
        <ul className="grid gap-2">
          {items.map((item) => (
            <li key={item.id} className="grid gap-0.5 rounded-md border px-3 py-2">
              {item.href
                ? <NavLink to={item.href} current={false} className="text-sm font-medium hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">{item.label}</NavLink>
                : <span className="text-sm font-medium">{item.label}</span>}
              {item.detail ? <span className="text-xs text-muted-foreground">{item.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : <EmptyState icon={CircleCheckIcon} title="Nothing needs attention right now." />}
    </Section>
  );
}

function ExpiryPanel({ overview }: { overview: unknown }) {
  const buckets = expiryBuckets(overview);
  return (
    <Section title="Expiring soon" id="overview-expiry">
      {buckets.length ? (
        <ul className="grid gap-2">
          {buckets.map((bucket, index) => (
            <li key={`${bucket.label}-${index}`} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <Link
                to="/workspaces"
                search={bucket.windowMinutes ? { expiring: bucket.windowMinutes } : {}}
                className="font-medium hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {bucket.label || EMPTY}
              </Link>
              <span className="text-muted-foreground tabular-nums">{bucket.count} workspace(s)</span>
            </li>
          ))}
        </ul>
      ) : <EmptyState icon={HourglassIcon} title="No workspaces are close to expiry." />}
    </Section>
  );
}

/** Signed-in identity from the shell's shared `/profile` read (one request for chip, Overview and Profile). */
function AccessPanel() {
  const profile = useQuery(profileQuery);
  return (
    <Section title="Access" id="overview-access">
      {profile.isPending ? (
        <div className="grid gap-2" role="status" aria-label="Loading profile">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
      ) : profile.isError && !profile.data ? (
        <ErrorState error={profile.error} onRetry={() => profile.refetch()} />
      ) : (
        <DetailList
          className="lg:grid-cols-2"
          items={[
            { label: 'Signed in as', value: displayName(profile.data) ?? 'Not provided' },
            { label: 'Email', value: profile.data?.identity.email || 'Not provided', mono: true },
            { label: 'Session expires', value: optionalTime(profile.data?.sessionExpiresAt) }
          ]}
        />
      )}
    </Section>
  );
}

function CopyableValue({ value, label }: { value: string; label: string }): ReactNode {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-xs break-all">{value}</span>
      <CopyButton value={value} label={label} />
    </span>
  );
}

function ServerPanel() {
  const server = useQuery(serverQuery);
  return (
    <Section title="Server" id="overview-server" actions={server.data ? <StatusBadge status="Online" tone="success" /> : undefined}>
      <AsyncStatus query={server} label="server" skeleton={<PageSkeleton label="Loading server" />}>
        {(body) => {
          const facts = serverFacts((body as BffEnvelope<unknown> | undefined)?.data);
          return (
            <DetailList
              className="lg:grid-cols-2"
              items={[
                { label: 'Auth mode', value: facts.authMode, mono: true },
                { label: 'Version', value: facts.version, mono: true },
                { label: 'Managed OAuth', value: facts.managedOAuthUrl ? <CopyableValue value={facts.managedOAuthUrl} label="Copy URL" /> : 'Not published' },
                { label: 'API-key gateway', value: facts.gateway.enabled ? (facts.gateway.endpoint ? <span className="grid gap-1">Enabled<CopyableValue value={facts.gateway.endpoint} label="Copy endpoint" /></span> : 'Enabled') : 'Disabled' },
                { label: 'Max request', value: facts.maxRequestBytes === undefined ? 'Unknown' : formatBytes(facts.maxRequestBytes) },
                { label: 'Request timeout', value: facts.requestTimeoutSeconds === undefined ? 'Unknown' : `${facts.requestTimeoutSeconds}s` },
                { label: 'Session expires', value: optionalTime(facts.sessionExpiresAt) },
                { label: 'Checked', value: optionalTime(facts.checkedAt) }
              ]}
            />
          );
        }}
      </AsyncStatus>
    </Section>
  );
}
