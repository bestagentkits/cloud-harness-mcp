import { createFileRoute, useRouterState } from '@tanstack/react-router';
import { GitHubPage } from '@/features/github/github-page';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

/**
 * The GitHub App callbacks land here: the setup return (`installation_id`, optional
 * `state`) and the OAuth return (`code` + `state`, or `error`). The page classifies the raw
 * query, acts on it once, and replaces the URL so the one-time values do not stay in the
 * address bar or history. A callback that cannot be acted on is cleared all the same.
 */
export const Route = createFileRoute('/integrations/github')({
  staticData: { pageId: 'github' },
  validateSearch: noSearch,
  loader: (match) => warmPageRead('github', match),
  component: GitHubRoute
});

function GitHubRoute() {
  // The raw query string: the page classifies it itself, since a validated search would drop a malformed callback.
  const search = useRouterState({ select: (router) => router.location.searchStr });
  return <GitHubPage search={search} />;
}
