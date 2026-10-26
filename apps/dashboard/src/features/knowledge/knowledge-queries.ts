import { queryOptions } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import { type BffEnvelope, bffKey, bffPath, bffQuery } from '@/lib/bff-query';
import { type KnowledgeSearch, listQuery, searchBody } from './knowledge-search';

export const KNOWLEDGE_PATH = '/knowledge';
export const KNOWLEDGE_SEARCH_PATH = '/knowledge/search';
export const KNOWLEDGE_GRAPH_PATH = '/knowledge-graph';

export function knowledgeItemPath(id: string): string {
  return bffPath('knowledge', id);
}

/**
 * `GET /knowledge` with the list filters. Without filters its key is the registry read's key
 * (`pageReadQuery('knowledge', {})`), so the route's warm prefetch is the page's read.
 */
export function knowledgeListQuery(search: KnowledgeSearch) {
  return bffQuery<unknown>(KNOWLEDGE_PATH, listQuery(search));
}

/**
 * `POST /knowledge/search` for a free-text query. It has no side effect (the classic page
 * reads with it too), so it is a cached query keyed by its body; the API client adds the
 * CSRF header a POST needs.
 */
export function knowledgeSearchQuery(search: KnowledgeSearch & { q: string }) {
  const body = searchBody(search);
  return queryOptions({
    queryKey: bffKey(KNOWLEDGE_SEARCH_PATH, { query: body.query, kind: search.kind, scope: search.scope, projectId: search.projectId, cursor: search.cursor }),
    queryFn: ({ signal }) => apiClient.request<BffEnvelope<unknown>>(KNOWLEDGE_SEARCH_PATH, { method: 'POST', body, signal })
  });
}

/** The graph tab's read, with the classic page's bounds (depth 2, at most 50 nodes). */
export function knowledgeGraphQuery(projectId: string | undefined) {
  return bffQuery<unknown>(KNOWLEDGE_GRAPH_PATH, { projectId, depth: 2, maxNodes: 50 });
}

/** The one read the Knowledge page renders for these search params: the graph, a search, or the filtered list. */
export function knowledgePageQuery(search: KnowledgeSearch & { view?: 'graph' | undefined }) {
  if (search.view === 'graph') return knowledgeGraphQuery(search.projectId);
  return search.q ? knowledgeSearchQuery({ ...search, q: search.q }) : knowledgeListQuery(search);
}
