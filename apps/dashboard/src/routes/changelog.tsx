import { createFileRoute } from '@tanstack/react-router';
import { ChangelogPage } from '@/features/changelog/changelog-page';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

export const Route = createFileRoute('/changelog')({
  staticData: { pageId: 'changelog' },
  validateSearch: noSearch,
  loader: (match) => warmPageRead('changelog', match),
  component: ChangelogPage
});
