import { createFileRoute } from '@tanstack/react-router';
import { githubCallbackSearch } from '@/features/github/github-callback-search';
import { GitHubPage } from '@/features/github/github-page';
import { warmPageRead } from '@/lib/page-read';

/**
 * The GitHub App installation callback lands here with `state` and `installation_id`
 * (`setup_action` is ignored, as in the classic Dashboard). The page completes it natively
 * and then replaces the URL, so the one-time state does not stay in history.
 */
export const Route = createFileRoute('/integrations/github')({
  staticData: { pageId: 'github' },
  validateSearch: githubCallbackSearch,
  loader: (match) => warmPageRead('github', match),
  component: GitHubRoute
});

function GitHubRoute() {
  const { state, installation_id: installationId } = githubCallbackSearch(Route.useSearch());
  return <GitHubPage callback={state && installationId ? { state, installationId } : undefined} />;
}
