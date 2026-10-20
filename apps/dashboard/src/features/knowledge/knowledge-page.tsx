import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { BookOpenIcon, SearchXIcon } from 'lucide-react';
import { useState } from 'react';
import { CursorPager } from '@/components/data/cursor-pager';
import { FilterBar, SearchFilter, SelectFilter } from '@/components/data/filter-bar';
import { TruncationNotice } from '@/components/data/truncation-notice';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiClient } from '@/lib/api-client';
import { type BffEnvelope, bffKey } from '@/lib/bff-query';
import { useBffMutation } from '@/lib/bff-mutation';
import { formatDateTime } from '@/lib/format';
import { lazyDialog } from '@/lib/lazy-dialog';
import { usePagePrimaryAction } from '@/lib/page-primary-action';
import { renderInline } from './knowledge-markdown';
import { KnowledgeGraphView } from './knowledge-graph-view';
import { createBody, itemTitle, JOURNAL_TYPE_LABELS, type JournalType, KIND_LABELS, type KnowledgeKind, type KnowledgeRow, knowledgeGraph, knowledgeItem, knowledgeRows, type KnowledgeSearch, KNOWLEDGE_SCOPES, SCOPE_LABELS, type KnowledgeScope } from './knowledge-model';
import type { CreateKnowledgeValues } from './knowledge-form-schema';
import { KNOWLEDGE_GRAPH_PATH, KNOWLEDGE_PATH, KNOWLEDGE_SEARCH_PATH, knowledgeGraphQuery, knowledgeListQuery, knowledgeSearchQuery } from './knowledge-queries';

// The create form loads on first use, so the list ships without zod.
const CreateKnowledgeDialog = lazyDialog(async () => (await import('./create-knowledge-dialog')).CreateKnowledgeDialog);

type Tab = 'all' | KnowledgeKind | 'graph';
const PREVIEW_CHARS = 160;

function label<T extends string>(labels: Record<T, string>, value: unknown): string | undefined {
  return typeof value === 'string' && value in labels ? labels[value as T] : typeof value === 'string' ? value : undefined;
}

function KnowledgeCard({ row }: { row: KnowledgeRow }) {
  const { item, match } = row;
  const content = typeof item.content === 'string' ? item.content : '';
  const when = item.occurredAt ?? item.updatedAt;
  const journalType = label<JournalType>(JOURNAL_TYPE_LABELS, item.journalType);
  return (
    <li className="grid gap-2 rounded-lg border bg-surface p-4 transition-colors duration-(--motion-fast) hover:border-ring/50">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 text-base font-semibold break-words">
          <Link to="/knowledge/$knowledgeId" params={{ knowledgeId: item.id }} className="hover:underline">{itemTitle(item)}</Link>
        </h3>
        {match?.relevancePercent !== undefined ? (
          <span className="rounded-full border px-2 py-0.5 text-xs tabular-nums" title="Search relevance">
            {match.matchMode ? `${match.matchMode} match · ` : ''}{match.relevancePercent}%
          </span>
        ) : null}
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{label<KnowledgeKind>(KIND_LABELS, item.kind) ?? 'Entry'}</span>
        <span>{label<KnowledgeScope>(SCOPE_LABELS, item.scope) ?? 'Unknown'} scope</span>
        {journalType ? <span>{journalType}</span> : null}
        <span>{formatDateTime(when)}</span>
        <span>Generation {item.generation ?? '—'}</span>
        <span className="font-mono">{item.id}</span>
      </p>
      {content ? <p className="text-sm break-words text-muted-foreground">{renderInline(content.slice(0, PREVIEW_CHARS).replace(/\s+/g, ' '))}{content.length > PREVIEW_CHARS ? '…' : ''}</p> : null}
      {item.tags?.length ? (
        <ul className="flex flex-wrap gap-1" aria-label="Tags">
          {item.tags.map((tag) => <li key={tag} className="rounded-full bg-muted px-2 py-0.5 text-xs">{tag}</li>)}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The knowledge list (parity matrix 4.8). Like the classic page it makes one read per view:
 * `GET /knowledge` with the kind/scope/project/cursor filters, `POST /knowledge/search` when
 * there is a text query, or `GET /knowledge-graph` on the graph tab. Every filter and the
 * tab live in the URL; a filter change starts again from the first page.
 */
export function KnowledgePage({ search, onSearch }: { search: KnowledgeSearch; onSearch: (next: KnowledgeSearch) => void }) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  usePagePrimaryAction('knowledge', { run: () => setCreating(true) });

  const graphView = search.view === 'graph';
  const q = search.q;
  const listRead = useQuery({ ...knowledgeListQuery(search), enabled: !graphView && !q });
  const searchRead = useQuery({ ...knowledgeSearchQuery({ ...search, q: q ?? '' }), enabled: !graphView && Boolean(q) });
  const graphRead = useQuery({ ...knowledgeGraphQuery(search.projectId), enabled: graphView });
  const read = graphView ? graphRead : q ? searchRead : listRead;

  const create = useBffMutation<CreateKnowledgeValues, BffEnvelope<unknown>>({
    mutationFn: (values) => apiClient.request(KNOWLEDGE_PATH, { method: 'POST', body: createBody(values) }),
    invalidate: [bffKey(KNOWLEDGE_PATH).slice(0, 2), bffKey(KNOWLEDGE_SEARCH_PATH).slice(0, 2), bffKey(KNOWLEDGE_GRAPH_PATH).slice(0, 2)],
    successTitle: 'Knowledge entry created',
    errorTitle: 'The entry was not created',
    onSuccess: (result) => {
      const created = knowledgeItem(result);
      if (created) void navigate({ to: '/knowledge/$knowledgeId', params: { knowledgeId: created.id } });
    }
  });

  const tab: Tab = graphView ? 'graph' : search.kind ?? 'all';
  const filtered = Boolean(search.kind || search.scope || search.projectId || q);
  const change = (next: Partial<KnowledgeSearch>) => onSearch({ ...search, ...next, cursor: undefined });

  return (
    <div className="grid gap-(--stack-gap)">
      <p className="max-w-prose text-sm text-muted-foreground">
        Scoped memories and chronological journals persist independently of volatile workspace files and repository state.
      </p>
      <Tabs className="grid gap-(--stack-gap)" value={tab} onValueChange={(value) => change(value === 'graph' ? { view: 'graph' } : { view: undefined, kind: value === 'all' ? undefined : value as KnowledgeKind })}>
        <TabsList aria-label="Knowledge views" className="max-w-full overflow-x-auto">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="memory">Memories</TabsTrigger>
          <TabsTrigger value="journal">Journals</TabsTrigger>
          <TabsTrigger value="graph">Graph</TabsTrigger>
        </TabsList>
        {/* One panel for the active view: every view shares the filters and the result area. */}
        <TabsContent value={tab} className="grid gap-(--stack-gap)">
        <FilterBar label="Knowledge filters" active={filtered} onClear={() => onSearch(graphView ? { view: 'graph' } : {})}>
          {graphView ? null : <SearchFilter label="Search knowledge" placeholder="Search titles and content" value={q} onChange={(next) => change({ q: next })} />}
          {graphView ? null : <SelectFilter label="Scope" value={search.scope} options={KNOWLEDGE_SCOPES.map((value) => ({ value, label: SCOPE_LABELS[value] }))} onChange={(scope) => change({ scope })} />}
          {search.projectId ? <span className="rounded-full border px-2.5 py-0.5 font-mono text-xs">Project {search.projectId}</span> : null}
        </FilterBar>
        <AsyncStatus query={read} label={graphView ? 'knowledge graph' : 'knowledge'}>
          {(body) => {
            if (graphView) return <KnowledgeGraphView graph={knowledgeGraph(body)} />;
            const envelope = body as BffEnvelope<unknown>;
            const rows = knowledgeRows(envelope);
            return (
              <section aria-labelledby="knowledge-list-heading" className="grid gap-3 animate-in fade-in-0 motion-reduce:animate-none">
                <h2 id="knowledge-list-heading" className="sr-only">Knowledge entries</h2>
                {q ? <p className="text-sm text-muted-foreground" role="status">{rows.length} results for “{q}”</p> : null}
                <TruncationNotice truncated={envelope.truncated} what="knowledge entries" />
                {rows.length ? (
                  <ul className="grid gap-3">{rows.map((row) => <KnowledgeCard key={row.item.id} row={row} />)}</ul>
                ) : filtered || search.cursor ? (
                  <EmptyState icon={SearchXIcon} title="No entries match these filters" action={<Button variant="outline" size="sm" onClick={() => onSearch({})}>Clear filters</Button>} />
                ) : (
                  <EmptyState icon={BookOpenIcon} title="No knowledge yet" description="Use New entry to record a memory note or a journal entry with durable context." />
                )}
                <CursorPager label="Knowledge" cursor={search.cursor} nextCursor={envelope.cursor} onCursor={(cursor) => onSearch({ ...search, cursor })} />
              </section>
            );
          }}
        </AsyncStatus>
        </TabsContent>
      </Tabs>
      <CreateKnowledgeDialog open={creating} onOpenChange={setCreating} onCreate={(values) => create.mutateAsync(values)} />
    </div>
  );
}
