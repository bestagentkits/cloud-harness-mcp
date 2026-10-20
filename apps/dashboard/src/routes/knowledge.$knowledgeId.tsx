import { createFileRoute, notFound } from '@tanstack/react-router';
import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

export const Route = createFileRoute('/knowledge/$knowledgeId')({
  staticData: { pageId: 'knowledge-entry' },
  validateSearch: noSearch,
  beforeLoad: ({ params }) => { if (!RESOURCE_ID_PATTERNS.knowledgeId.test(params.knowledgeId)) throw notFound(); },
  loader: (match) => warmPageRead('knowledge-entry', match),
  component: () => <PagePlaceholder pageId="knowledge-entry" />
});
