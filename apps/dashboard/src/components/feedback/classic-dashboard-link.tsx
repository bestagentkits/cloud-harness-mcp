import { useRouterState } from '@tanstack/react-router';
import type { ComponentProps } from 'react';

/**
 * `?ui=legacy` pins this browser to the classic Dashboard. The server takes the parameter
 * on any Dashboard path and redirects back to that path, so the link keeps the operator
 * on the page they were looking at instead of dropping them on the Overview.
 */
export function classicDashboardHref(pathname: string): string {
  const path = pathname === '/dashboard' || pathname.startsWith('/dashboard/') ? pathname : `/dashboard${pathname === '/' ? '' : pathname}`;
  return `${path}?ui=legacy`;
}

export function ClassicDashboardLink(props: Omit<ComponentProps<'a'>, 'href'>) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return <a {...props} href={classicDashboardHref(pathname)} />;
}
