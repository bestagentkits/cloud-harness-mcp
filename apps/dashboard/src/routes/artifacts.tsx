import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';
import { compact, cursor } from '@/lib/search-params';

export const Route = createFileRoute('/artifacts')({
  staticData: { pageId: 'artifacts' },
  validateSearch: (raw: Record<string, unknown>) => compact({ cursor: cursor(raw) }),
  loader: (match) => warmPageRead('artifacts', match),
  component: () => <PagePlaceholder pageId="artifacts" />
});
