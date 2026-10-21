import { createFileRoute } from '@tanstack/react-router';
import { SecretsPage } from '@/features/secrets/secrets-page';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

export const Route = createFileRoute('/secrets')({
  staticData: { pageId: 'secrets' },
  validateSearch: noSearch,
  loader: (match) => warmPageRead('secrets', match),
  component: SecretsPage
});
