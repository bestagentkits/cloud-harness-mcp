import { isNotFound, useRouterState } from '@tanstack/react-router';
import { type DashboardPage, navOwner, type PageId, pageById } from './page-registry';

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** The registry page this route renders; the shell derives all page identity from it. */
    pageId?: PageId;
  }
}

export type CurrentPage = {
  page: DashboardPage | undefined;
  /** The sidebar entry that is current. */
  navId: PageId | undefined;
  /** The resource id a detail page names (workspace, agent...), shown in the breadcrumb and title. */
  detail: string | undefined;
  /** Params of the committed match, for reads and breadcrumbs. */
  params: Record<string, string>;
};

type MatchLike = { staticData?: { pageId?: PageId }; params?: unknown; status?: string; globalNotFound?: boolean; error?: unknown };

/**
 * Reads page identity from the deepest committed route match. The URL, sidebar, breadcrumb,
 * `<h1>`, `document.title`, primary action and page frame all call this, and none of them
 * reads the pending location or Link's own active state, so they always describe the same
 * page — including mid-navigation, when the router has committed page B and B's content is
 * still a skeleton.
 */
export function resolveCurrentPage(matches: readonly MatchLike[]): CurrentPage {
  // A `notFound()` from a route's `beforeLoad` lands on the nearest boundary (the root) as
  // its error, so any not-found match means the page did not resolve.
  if (matches.some((match) => match.globalNotFound || match.status === 'notFound' || isNotFound(match.error))) {
    return { page: undefined, navId: undefined, detail: undefined, params: {} };
  }
  const match = [...matches].reverse().find((candidate) => candidate.staticData?.pageId);
  const pageId = match?.staticData?.pageId;
  if (!match || !pageId) return { page: undefined, navId: undefined, detail: undefined, params: {} };
  const page = pageById(pageId);
  const params = (match.params ?? {}) as Record<string, string>;
  return { page, navId: navOwner(page), detail: page.detailParam ? params[page.detailParam] : undefined, params };
}

export function useCurrentPage(): CurrentPage {
  const matches = useRouterState({ select: (state) => state.matches });
  return resolveCurrentPage(matches as unknown as readonly MatchLike[]);
}
