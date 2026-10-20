import type { BffEnvelope } from '@/lib/bff-query';
import type { CreateKnowledgeValues } from './knowledge-form-schema';
import type { KnowledgeKind, KnowledgeScope } from './knowledge-search';

export { KNOWLEDGE_KINDS, KNOWLEDGE_SCOPES, type KnowledgeKind, type KnowledgeScope, type KnowledgeSearch, listQuery, searchBody } from './knowledge-search';

/**
 * Knowledge projections (`knowledgeItemKeys`, `knowledgeLinkKeys` and the graph mapping in
 * `apps/api/src/dashboard-response.ts`) and the bounds of the runner's input schemas
 * (`knowledge_dashboard_*` in `packages/contracts/src/internal-runner-api.ts`), mirrored so
 * the forms refuse what the server would.
 */
export const JOURNAL_TYPES = ['engineering-log', 'decision-record', 'session-reflection'] as const;
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

export const TITLE_MAX = 120;
export const CONTENT_MAX = 262_144;
export const TAGS_MAX = 16;
export const SEARCH_MAX = 512;
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

/** Comma-separated tags: trimmed, empty entries dropped, duplicates removed. */
export function parseTags(raw: string): string[] {
  return [...new Set(raw.split(',').map((tag) => tag.trim()).filter(Boolean))];
}

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
