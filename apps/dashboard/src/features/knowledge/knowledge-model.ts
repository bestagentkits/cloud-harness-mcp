import { z } from 'zod';
import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';
import type { BffEnvelope } from '@/lib/bff-query';

/**
 * Knowledge projections (`knowledgeItemKeys`, `knowledgeLinkKeys` and the graph mapping in
 * `apps/api/src/dashboard-response.ts`) and the bounds of the runner's input schemas
 * (`knowledge_dashboard_*` in `packages/contracts/src/internal-runner-api.ts`), mirrored so
 * the forms refuse what the server would.
 */
export const KNOWLEDGE_KINDS = ['memory', 'journal'] as const;
export const KNOWLEDGE_SCOPES = ['owner', 'project', 'workspace'] as const;
export const JOURNAL_TYPES = ['engineering-log', 'decision-record', 'session-reflection'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export type KnowledgeScope = (typeof KNOWLEDGE_SCOPES)[number];
export type JournalType = (typeof JOURNAL_TYPES)[number];

export const KIND_LABELS: Record<KnowledgeKind, string> = { memory: 'Memory', journal: 'Journal' };
export const SCOPE_LABELS: Record<KnowledgeScope, string> = { owner: 'Owner', project: 'Project', workspace: 'Workspace' };
export const JOURNAL_TYPE_LABELS: Record<JournalType, string> = { 'engineering-log': 'Engineering log', 'decision-record': 'Decision record', 'session-reflection': 'Session reflection' };

export type KnowledgeLink = { id: string; sourceId?: string; targetId?: string; relation?: string; origin?: string; generation?: number; createdAt?: number };

export type KnowledgeItem = {
  id: string;
  kind?: string;
  scope?: string;
  projectId?: string | null;
  workspaceId?: string | null;
  title?: string;
  content?: string;
  journalType?: string | null;
  occurredAt?: number | null;
  generation?: number;
  createdAt?: number;
  updatedAt?: number;
  tags?: string[];
  outboundLinks?: KnowledgeLink[];
  backlinks?: KnowledgeLink[];
};

export type KnowledgeSearchResult = { item: KnowledgeItem; relevancePercent?: number; matchMode?: string };
export type KnowledgeRow = { item: KnowledgeItem; match?: { relevancePercent?: number; matchMode?: string } };

export type KnowledgeGraphNode = { id: string; kind?: string; scope?: string; title?: string; journalType?: string; tags?: string[]; updatedAt?: number };
export type KnowledgeGraph = { nodes: KnowledgeGraphNode[]; edges: KnowledgeLink[]; truncated: boolean };

/** The list page's URL state. `view=graph` selects the graph tab (not a filter of the list). */
export type KnowledgeSearch = {
  kind?: KnowledgeKind | undefined;
  scope?: KnowledgeScope | undefined;
  projectId?: string | undefined;
  q?: string | undefined;
  cursor?: string | undefined;
  view?: 'graph' | undefined;
};

export const TITLE_MAX = 120;
export const CONTENT_MAX = 262_144;
export const TAGS_MAX = 16;
export const SEARCH_MAX = 512;
const TAG = /^[A-Za-z0-9._/-]{1,50}$/;

function isItem(value: unknown): value is KnowledgeItem {
  return Boolean(value) && typeof (value as { id?: unknown }).id === 'string';
}

/** List rows from either answer: `{ items }` from `GET /knowledge`, `{ results }` from `POST /knowledge/search`. */
export function knowledgeRows(body: unknown): KnowledgeRow[] {
  const data = (body as BffEnvelope<Record<string, unknown>> | undefined)?.data;
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.results)) {
    return (data.results as KnowledgeSearchResult[]).filter((result) => isItem(result?.item)).map((result) => ({
      item: result.item,
      match: { ...(typeof result.relevancePercent === 'number' ? { relevancePercent: result.relevancePercent } : {}), ...(typeof result.matchMode === 'string' ? { matchMode: result.matchMode } : {}) }
    }));
  }
  return Array.isArray(data.items) ? (data.items as unknown[]).filter(isItem).map((item) => ({ item })) : [];
}

export function knowledgeGraph(body: unknown): KnowledgeGraph {
  const data = (body as BffEnvelope<Partial<KnowledgeGraph>> | undefined)?.data;
  const nodes = Array.isArray(data?.nodes) ? data.nodes.filter((node): node is KnowledgeGraphNode => isItem(node)) : [];
  const edges = Array.isArray(data?.edges) ? data.edges.filter((edge): edge is KnowledgeLink => Boolean(edge) && typeof edge.sourceId === 'string' && typeof edge.targetId === 'string') : [];
  return { nodes, edges, truncated: data?.truncated === true };
}

export function knowledgeItem(body: unknown): KnowledgeItem | undefined {
  const data = (body as BffEnvelope<unknown> | undefined)?.data;
  return isItem(data) ? data : undefined;
}

export function itemTitle(item: { id: string; title?: string | undefined }): string {
  return typeof item.title === 'string' && item.title.trim() ? item.title : item.id;
}

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

/** Comma-separated tags: trimmed, empty entries dropped, duplicates removed. */
export function parseTags(raw: string): string[] {
  return [...new Set(raw.split(',').map((tag) => tag.trim()).filter(Boolean))];
}

export const createKnowledgeSchema = z.object({
  kind: z.enum(KNOWLEDGE_KINDS),
  scope: z.enum(KNOWLEDGE_SCOPES),
  projectId: z.string(),
  workspaceId: z.string(),
  journalType: z.enum(JOURNAL_TYPES),
  title: z.string().trim().min(1, 'Enter a title.').max(TITLE_MAX, `Use at most ${TITLE_MAX} characters.`),
  tags: z.string().max(2_000).refine((raw) => parseTags(raw).length <= TAGS_MAX, `Use at most ${TAGS_MAX} tags.`).refine((raw) => parseTags(raw).every((tag) => TAG.test(tag)), 'Tags use letters, digits and . _ / - (50 characters at most).'),
  content: z.string().max(CONTENT_MAX, 'The content is too long.')
}).superRefine((values, context) => {
  if (values.scope === 'project' && !RESOURCE_ID_PATTERNS.projectId.test(values.projectId)) context.addIssue({ code: 'custom', path: ['projectId'], message: 'Choose a project.' });
  if (values.scope === 'workspace' && !RESOURCE_ID_PATTERNS.workspaceId.test(values.workspaceId.trim())) context.addIssue({ code: 'custom', path: ['workspaceId'], message: 'Enter a workspace ID (ws_…).' });
});
export type CreateKnowledgeValues = z.infer<typeof createKnowledgeSchema>;

export const CREATE_DEFAULTS: CreateKnowledgeValues = { kind: 'memory', scope: 'owner', projectId: '', workspaceId: '', journalType: 'engineering-log', title: '', tags: '', content: '' };

/** The `POST /knowledge` body: only schema fields, scope ids only for their scope, `expectedGeneration: 0`. */
export function createBody(values: CreateKnowledgeValues) {
  return {
    kind: values.kind,
    scope: values.scope,
    ...(values.scope === 'project' ? { projectId: values.projectId } : {}),
    ...(values.scope === 'workspace' ? { workspaceId: values.workspaceId.trim() } : {}),
    title: values.title.trim(),
    content: values.content,
    ...(values.kind === 'journal' ? { journalType: values.journalType } : {}),
    tags: parseTags(values.tags),
    expectedGeneration: 0 as const
  };
}
