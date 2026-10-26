import { createFileRoute } from '@tanstack/react-router';
import { GitHubPage } from '@/features/github/github-page';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

export const Route = createFileRoute('/integrations/')({
  staticData: { pageId: 'integrations' },
  validateSearch: noSearch,
  loader: (match) => warmPageRead('integrations', match),
  component: () => <GitHubPage />
});
