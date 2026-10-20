import { createFileRoute } from '@tanstack/react-router';
import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';
import { KnowledgePage } from '@/features/knowledge/knowledge-page';
import { KNOWLEDGE_KINDS, KNOWLEDGE_SCOPES } from '@/features/knowledge/knowledge-model';
import { knowledgePageQuery } from '@/features/knowledge/knowledge-queries';
import { compact, cursor, exact, matching, oneOf, text } from '@/lib/search-params';

export const Route = createFileRoute('/knowledge/')({
  staticData: { pageId: 'knowledge' },
  // `exact`: every known key is present (undefined when invalid), so a malformed raw value
  // can never survive the router's merge of raw and validated search.
  validateSearch: (raw: Record<string, unknown>) => exact({
    kind: oneOf(raw, 'kind', KNOWLEDGE_KINDS),
    scope: oneOf(raw, 'scope', KNOWLEDGE_SCOPES),
    projectId: matching(raw, 'projectId', RESOURCE_ID_PATTERNS.projectId),
    q: text(raw, 'q'),
    cursor: cursor(raw),
    view: oneOf(raw, 'view', ['graph'] as const)
  }),
  loaderDeps: ({ search }) => search,
  // Preload warms exactly the read the page renders for these filters, never the unfiltered list.
  loader: ({ context, deps, preload }) => {
    if (preload) void context.queryClient.prefetchQuery(knowledgePageQuery(deps));
  },
  component: KnowledgeRoute
});

function KnowledgeRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <KnowledgePage search={search} onSearch={(next) => { void navigate({ search: compact(next), replace: true }); }} />;
}
