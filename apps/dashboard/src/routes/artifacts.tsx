import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';
import { exact, cursor } from '@/lib/search-params';

export const Route = createFileRoute('/artifacts')({
  staticData: { pageId: 'artifacts' },
  validateSearch: (raw: Record<string, unknown>) => exact({ cursor: cursor(raw) }),
  loader: (match) => warmPageRead('artifacts', match),
  component: () => <PagePlaceholder pageId="artifacts" />
});
