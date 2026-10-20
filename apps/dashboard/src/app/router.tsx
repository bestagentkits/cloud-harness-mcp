import type { QueryClient } from '@tanstack/react-query';
import { createRouter, type RouterHistory } from '@tanstack/react-router';
import { NotFoundPage } from '@/components/feedback/not-found-page';
import { RouteErrorPage } from '@/components/feedback/route-error-page';
import { routeTree } from '@/routeTree.gen';

/** Matches Vite's `base`; the Express API serves the SPA under this prefix. */
export const DASHBOARD_BASEPATH = '/dashboard';

export type RouterContext = { queryClient: QueryClient };

export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    basepath: DASHBOARD_BASEPATH,
    context: { queryClient },
    defaultPreload: 'intent',
    // Route loaders hand data to TanStack Query, which owns freshness.
    defaultPreloadStaleTime: 0,
    defaultNotFoundComponent: NotFoundPage,
    defaultErrorComponent: RouteErrorPage,
    scrollRestoration: true,
    ...(history ? { history } : {})
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
