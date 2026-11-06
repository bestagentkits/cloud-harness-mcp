import { useRouterState } from '@tanstack/react-router';
import type { ComponentProps } from 'react';

/**
 * `?ui=legacy` pins this browser to the classic Dashboard. The server takes the parameter
 * on any Dashboard path and redirects back to that path, so the link keeps the operator
 * on the page they were looking at instead of dropping them on the Overview.
 */
export function classicDashboardHref(pathname: string, search = ''): string {
  const path = pathname === '/dashboard' || pathname.startsWith('/dashboard/') ? pathname : `/dashboard${pathname === '/' ? '' : pathname}`;
  // Keep the page's own query (filters, a callback's params); the server drops `ui` and
  // redirects back with the rest.
  const query = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  query.delete('ui');
  query.append('ui', 'legacy');
  return `${path}?${query.toString()}`;
}

export function ClassicDashboardLink(props: Omit<ComponentProps<'a'>, 'href'>) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const search = useRouterState({ select: (state) => state.location.searchStr });
  return <a {...props} href={classicDashboardHref(pathname, search)} />;
}
