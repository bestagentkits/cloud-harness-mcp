import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';
import { compact, cursor } from '@/lib/search-params';

export const Route = createFileRoute('/audit')({
  staticData: { pageId: 'audit' },
  validateSearch: (raw: Record<string, unknown>) => compact({ cursor: cursor(raw) }),
  loader: (match) => warmPageRead('audit', match),
  component: () => <PagePlaceholder pageId="audit" />
});
