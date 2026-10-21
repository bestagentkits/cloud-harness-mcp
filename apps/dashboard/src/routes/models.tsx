import { createFileRoute } from '@tanstack/react-router';
import { ModelsPage } from '@/features/models/models-page';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

export const Route = createFileRoute('/models')({
  staticData: { pageId: 'models' },
  validateSearch: noSearch,
  loader: (match) => warmPageRead('models', match),
  component: ModelsPage
});
