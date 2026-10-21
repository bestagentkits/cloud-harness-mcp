import { createFileRoute, notFound } from '@tanstack/react-router';
import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';
import { KnowledgeEntryPage } from '@/features/knowledge/knowledge-entry-page';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

export const Route = createFileRoute('/knowledge/$knowledgeId')({
  staticData: { pageId: 'knowledge-entry' },
  validateSearch: noSearch,
  beforeLoad: ({ params }) => { if (!RESOURCE_ID_PATTERNS.knowledgeId.test(params.knowledgeId)) throw notFound(); },
  loader: (match) => warmPageRead('knowledge-entry', match),
  component: KnowledgeEntryRoute
});

function KnowledgeEntryRoute() {
  const { knowledgeId } = Route.useParams();
  // Keyed by id: a draft, its fence and any open dialog never carry over to another entry.
  return <KnowledgeEntryPage key={knowledgeId} knowledgeId={knowledgeId} />;
}
