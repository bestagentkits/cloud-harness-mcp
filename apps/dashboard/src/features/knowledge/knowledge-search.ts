/**
 * The Knowledge list's URL state and the reads it maps to, kept apart from the form schemas
 * so the route's search validator and loader (part of the initial bundle) do not pull zod in.
 */

export const KNOWLEDGE_KINDS = ['memory', 'journal'] as const;
export const KNOWLEDGE_SCOPES = ['owner', 'project', 'workspace'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export type KnowledgeScope = (typeof KNOWLEDGE_SCOPES)[number];

/** The list page's URL state. `view=graph` selects the graph tab (not a filter of the list). */
export type KnowledgeSearch = {
  kind?: KnowledgeKind | undefined;
  scope?: KnowledgeScope | undefined;
  projectId?: string | undefined;
  q?: string | undefined;
  cursor?: string | undefined;
  view?: 'graph' | undefined;
};

/** The `GET /knowledge` query for the list filters (the classic loader's parameters). */
export function listQuery(search: KnowledgeSearch): Record<string, string | undefined> {
  return { kind: search.kind, scope: search.scope, projectId: search.projectId, cursor: search.cursor };
}

/** The `POST /knowledge/search` body for a free-text query, as the classic loader sends it. */
export function searchBody(search: KnowledgeSearch & { q: string }) {
  return {
    query: search.q,
    ...(search.kind ? { kinds: [search.kind] } : {}),
    ...(search.scope ? { scope: search.scope } : {}),
    ...(search.projectId ? { projectId: search.projectId } : {}),
    ...(search.cursor ? { cursor: search.cursor } : {})
  };
}
