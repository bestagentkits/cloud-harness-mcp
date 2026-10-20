import { useQuery } from '@tanstack/react-query';
import { useMatch, useParams, useRouter, useSearch } from '@tanstack/react-router';
import { ConstructionIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { type PageId, pageById } from '@/app/page-registry';
import { AsyncStatus } from '@/components/feedback/async-status';
import { ClassicDashboardLink } from '@/components/feedback/classic-dashboard-link';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { pageReadQuery, summarizeRead } from '@/lib/page-read';

/**
 * Search params that must never be rendered: the GitHub App callback's one-time `state`
 * and `installation_id`. Everything else a deep link carries is a plain filter.
 */
export const HIDDEN_SEARCH_KEYS: ReadonlySet<string> = new Set(['state', 'installation_id']);

/**
 * The search params this page's own route declares. A match's `search` also carries every
 * raw key a parent passed through, so the route's validator is re-applied: it builds a new
 * object from its known keys only, and an undeclared param (`?notice=…`) is never rendered.
 */
function useDeclaredSearch(): Record<string, unknown> {
  const router = useRouter();
  const routeId = useMatch({ strict: false, select: (match) => match.routeId });
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const routes = router.routesById as unknown as Record<string, { options: { validateSearch?: unknown } } | undefined>;
  const validate = routeId ? routes[routeId]?.options.validateSearch : undefined;
  return typeof validate === 'function' ? (validate as (raw: Record<string, unknown>) => Record<string, unknown>)(search) : {};
}

function visibleFilters(search: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(search)
    .filter(([key, value]) => !HIDDEN_SEARCH_KEYS.has(key) && value !== undefined && value !== '')
    .map(([key, value]) => [key, String(value)]);
}

/**
 * The body of a page that has a route, identity and primary read but whose content has not
 * moved from the classic Dashboard yet. It still runs the page's real read (abortable,
 * key-fenced) so navigation, error and retry behaviour is exercised end to end, and it
 * reports only a record count: no response field reaches the DOM.
 */
export function PagePlaceholder({ pageId, children }: { pageId: PageId; children?: ReactNode }) {
  const page = pageById(pageId);
  const params = useParams({ strict: false }) as Record<string, string>;
  const search = useDeclaredSearch();
  const read = useQuery(pageReadQuery(pageId, params));
  const filters = visibleFilters(search);
  return (
    <div className="grid gap-(--stack-gap)" data-testid="page-placeholder">
      {filters.length ? (
        <ul aria-label="Active filters" className="flex flex-wrap gap-2">
          {filters.map(([key, value]) => (
            <li key={key} className="rounded-full border bg-surface px-2.5 py-0.5 font-mono text-xs"><span className="text-muted-foreground">{key}:</span> {value}</li>
          ))}
        </ul>
      ) : null}
      {children}
      {page.read ? (
        <AsyncStatus query={read} label={page.title}>
          {(body) => {
            const { count } = summarizeRead(body);
            return (
              <p className="text-sm text-muted-foreground" data-testid="read-summary">
                {count === undefined ? `${page.title} data loaded.` : `${count} ${count === 1 ? 'record' : 'records'} loaded.`}
              </p>
            );
          }}
        </AsyncStatus>
      ) : null}
      <EmptyState
        icon={ConstructionIcon}
        title={`${page.title} is moving to the new Dashboard`}
        description="This page keeps its address, title and navigation here already. Its full controls are still in the classic Dashboard."
        action={<Button asChild variant="outline" size="sm"><ClassicDashboardLink>Open in classic Dashboard</ClassicDashboardLink></Button>}
      />
    </div>
  );
}
