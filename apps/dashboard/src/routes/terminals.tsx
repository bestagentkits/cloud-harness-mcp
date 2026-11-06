import { createFileRoute } from '@tanstack/react-router';
import { TerminalsPage } from '@/features/terminal/terminals-page';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

export const Route = createFileRoute('/terminals')({
  staticData: { pageId: 'terminals' },
  validateSearch: noSearch,
  loader: (match) => warmPageRead('terminals', match),
  component: TerminalsPage
});
