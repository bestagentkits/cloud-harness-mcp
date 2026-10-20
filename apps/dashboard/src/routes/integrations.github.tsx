import { createFileRoute, useRouterState } from '@tanstack/react-router';
import { githubCallbackSearch, hasGitHubCallbackParams } from '@/features/github/github-callback-search';
import { GitHubPage } from '@/features/github/github-page';
import { warmPageRead } from '@/lib/page-read';

/**
 * The GitHub App installation callback lands here with `state` and `installation_id`
 * (`setup_action` is ignored, as in the classic Dashboard). The page completes it natively
 * and then replaces the URL, so the one-time state does not stay in history. An invalid or
 * incomplete callback is not sent, but its params are cleared from the URL all the same.
 */
export const Route = createFileRoute('/integrations/github')({
  staticData: { pageId: 'github' },
  validateSearch: githubCallbackSearch,
  loader: (match) => warmPageRead('github', match),
  component: GitHubRoute
});

function GitHubRoute() {
  const { state, installation_id: installationId } = githubCallbackSearch(Route.useSearch());
  // The raw query, before validation: invalid values are `undefined` in the validated search.
  const callbackParams = useRouterState({ select: (router) => hasGitHubCallbackParams(router.location.searchStr) });
  return <GitHubPage callback={state && installationId ? { state, installationId } : undefined} callbackParams={callbackParams} />;
}
