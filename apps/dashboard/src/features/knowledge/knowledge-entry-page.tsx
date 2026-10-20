import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker, useNavigate } from '@tanstack/react-router';
import { FileSearchIcon, HistoryIcon } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { DetailList } from '@/components/data/detail-list';
import { Section } from '@/components/data/section';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { ErrorState } from '@/components/feedback/error-state';
import { ActionButton, Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Textarea } from '@/components/ui/textarea';
import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';
import { ApiError, apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { pageReadQuery } from '@/lib/page-read';
import { cn } from '@/lib/utils';
import { useConflictNotice, useFencedMutation } from '@/features/projects/use-fenced-mutation';
import { KnowledgeConflictDialog } from './knowledge-conflict-dialog';
import { clearDraft } from './knowledge-draft';
import { MarkdownView } from './knowledge-markdown';
import {
  CONTENT_MAX, itemTitle, JOURNAL_TYPE_LABELS, type JournalType, KIND_LABELS, type KnowledgeItem, knowledgeItem, type KnowledgeKind,
  type KnowledgeLink, SCOPE_LABELS, type KnowledgeScope
} from './knowledge-model';
import { knowledgeItemPath } from './knowledge-queries';
import { KNOWLEDGE_LIST_KEYS, type SaveState, useKnowledgeEditor } from './use-knowledge-editor';

const SAVE_LABELS: Record<SaveState, string> = { saved: 'Saved', dirty: 'Unsaved changes', saving: 'Saving…', error: 'Not saved' };

function labelOf<T extends string>(labels: Record<T, string>, value: unknown): string {
  return typeof value === 'string' ? (labels as Record<string, string>)[value] ?? value : '—';
}

function LinkList({ links, side, empty }: { links: KnowledgeLink[] | undefined; side: 'targetId' | 'sourceId'; empty: string }) {
  const rows = (links ?? []).filter((link) => typeof link[side] === 'string');
  if (!rows.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="grid gap-1 text-sm">
      {rows.map((link) => {
        const id = link[side] ?? '';
        return (
          <li key={link.id} className="flex flex-wrap items-center gap-2">
            {RESOURCE_ID_PATTERNS.knowledgeId.test(id) ? <Link to="/knowledge/$knowledgeId" params={{ knowledgeId: id }} className="font-mono text-xs underline hover:no-underline">{id}</Link> : <span className="font-mono text-xs">{id}</span>}
            <span className="text-xs text-muted-foreground">{link.relation ?? 'relates-to'}</span>
          </li>
        );
      })}
    </ul>
  );
}

function KnowledgeEditor({ item, knowledgeId }: { item: KnowledgeItem; knowledgeId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const itemQuery = pageReadQuery('knowledge-entry', { knowledgeId });
  const editor = useKnowledgeEditor(item, itemQuery.queryKey, () => queryClient.fetchQuery({ ...itemQuery, staleTime: 0 }));
  const notice = useConflictNotice();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const editorId = useId();
  const statusId = useId();
  const leaving = useRef(false);
  const dirty = useRef(editor.dirty);
  useEffect(() => { dirty.current = editor.dirty; });

  // R10: an in-app navigation away from a draft asks first; closing the tab gets the
  // browser's own prompt. A reload keeps the draft (restored from this tab's session).
  const blocker = useBlocker({ shouldBlockFn: () => dirty.current && !leaving.current, enableBeforeUnload: () => dirty.current && !leaving.current, withResolver: true });

  const remove = useFencedMutation<number, unknown>({
    mutationFn: (generation) => apiClient.request(knowledgeItemPath(item.id), { method: 'DELETE', body: { expectedGeneration: generation } }),
    invalidate: KNOWLEDGE_LIST_KEYS, refresh: [itemQuery.queryKey], onConflict: notice.report,
    successTitle: 'Knowledge entry deleted', errorTitle: 'The entry was not deleted',
    onSuccess: () => {
      leaving.current = true;
      clearDraft(item.id);
      queryClient.removeQueries({ queryKey: itemQuery.queryKey, exact: true });
      void navigate({ to: '/knowledge' });
    }
  });

  function onEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      editor.save().catch(() => undefined); // Reported by the toast and the save state.
    }
  }

  const generation = editor.base.generation ?? item.generation;
  const journalType = item.journalType ? labelOf<JournalType>(JOURNAL_TYPE_LABELS, item.journalType) : undefined;
  return (
    <div className="grid gap-(--stack-gap)">
      {notice.conflict ? <ErrorState error={notice.conflict} onRetry={async () => { notice.clear(); await queryClient.invalidateQueries({ queryKey: itemQuery.queryKey }); }} /> : null}
      {editor.restored ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-info/40 bg-surface p-3 text-sm animate-in fade-in-0 motion-reduce:animate-none">
          <span className="flex items-center gap-2"><HistoryIcon className="size-4" aria-hidden="true" />Restored your unsaved draft from this browser tab.</span>
          <Button size="sm" variant="outline" onClick={editor.discardDraft}>Discard draft</Button>
        </div>
      ) : null}
      <Section
        title={itemTitle(item)}
        id="knowledge-entry-summary"
        actions={<Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => { notice.clear(); setConfirmDelete(true); }}>Delete entry</Button>}
      >
        <DetailList
          items={[
            { label: 'Entry ID', value: <span className="flex min-w-0 items-center gap-2"><span className="break-all font-mono text-xs">{item.id}</span><CopyButton value={item.id} label="Copy ID" /></span> },
            { label: 'Kind', value: labelOf<KnowledgeKind>(KIND_LABELS, item.kind) },
            { label: 'Scope', value: item.scope === 'project' && item.projectId && RESOURCE_ID_PATTERNS.projectId.test(item.projectId)
              ? <>Project <Link to="/projects/$projectId" params={{ projectId: item.projectId }} className="font-mono text-xs underline">{item.projectId}</Link></>
              : labelOf<KnowledgeScope>(SCOPE_LABELS, item.scope) },
            ...(journalType ? [{ label: 'Journal type', value: journalType }] : []),
            { label: 'Generation', value: <span data-testid="knowledge-generation">{generation ?? '—'}</span> },
            { label: 'Updated', value: formatDateTime(item.updatedAt) }
          ]}
        />
        {item.tags?.length ? <ul className="flex flex-wrap gap-1" aria-label="Tags">{item.tags.map((tag) => <li key={tag} className="rounded-full bg-muted px-2 py-0.5 text-xs">{tag}</li>)}</ul> : null}
      </Section>

      <Section
        title="Content"
        description={<>Markdown, with a live preview. Press <kbd className="rounded border px-1 font-mono text-xs">Ctrl</kbd>/<kbd className="rounded border px-1 font-mono text-xs">⌘</kbd>+<kbd className="rounded border px-1 font-mono text-xs">S</kbd> in the editor to save.</>}
        actions={(
          <>
            <p id={statusId} role="status" data-testid="knowledge-save-state" data-save-state={editor.saveState} className={cn('text-xs', editor.saveState === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
              {SAVE_LABELS[editor.saveState]}
            </p>
            <ActionButton size="sm" disabled={!editor.dirty} onAction={() => editor.save()} pendingLabel="Saving…" successLabel="Saved" errorLabel="Not saved" aria-keyshortcuts="Control+S Meta+S">Save changes</ActionButton>
          </>
        )}
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="grid content-start gap-1.5">
            <label htmlFor={editorId} className="text-sm font-medium">Markdown source</label>
            <Textarea
              id={editorId}
              value={editor.draft}
              onChange={(event) => editor.setDraft(event.target.value)}
              onKeyDown={onEditorKeyDown}
              aria-describedby={statusId}
              maxLength={CONTENT_MAX}
              spellCheck={false}
              className="min-h-80 font-mono text-xs"
            />
          </div>
          <section aria-labelledby={`${editorId}-preview`} className="grid content-start gap-1.5">
            <h3 id={`${editorId}-preview`} className="text-sm font-medium">Preview</h3>
            <div className="min-h-80 rounded-md border bg-background p-3" data-testid="knowledge-preview">
              <MarkdownView source={editor.preview} />
            </div>
          </section>
        </div>
      </Section>

      <div className="grid gap-(--stack-gap) md:grid-cols-2">
        <Section title="Outgoing links"><LinkList links={item.outboundLinks} side="targetId" empty="No outgoing links." /></Section>
        <Section title="Backlinks"><LinkList links={item.backlinks} side="sourceId" empty="No incoming backlinks." /></Section>
      </div>

      <KnowledgeConflictDialog
        open={editor.conflict.open}
        onOpenChange={editor.conflict.setOpen}
        base={editor.conflict.base}
        server={editor.conflict.server}
        serverError={editor.conflict.error}
        draft={editor.draft}
        onLoadServer={editor.loadServer}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete knowledge entry?"
        description={`Permanently delete “${itemTitle(item)}”? Its links go with it.`}
        target={item.id}
        confirmLabel="Delete entry"
        pendingLabel="Deleting…"
        onConfirm={() => {
          if (typeof generation !== 'number') return Promise.reject(new Error('This entry has no generation to fence the delete; reload the page.'));
          return remove.mutateAsync(generation);
        }}
      />
      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => { if (!open && !leaving.current) blocker.reset?.(); }}
        title="Leave with unsaved changes?"
        description="Your draft of this entry has not been saved. Leaving discards it."
        confirmLabel="Discard and leave"
        onConfirm={async () => { leaving.current = true; clearDraft(item.id); blocker.proceed?.(); }}
      />
    </div>
  );
}

/**
 * One knowledge entry (parity 4.8): the Markdown editor with a debounced live preview, save
 * with the generation fence (a 409 opens the D8 conflict dialog and keeps the draft), delete
 * with a confirm, and its links. One read, `GET /knowledge/:id`, the registry read.
 */
export function KnowledgeEntryPage({ knowledgeId }: { knowledgeId: string }) {
  const read = useQuery(pageReadQuery('knowledge-entry', { knowledgeId }));
  if (read.error instanceof ApiError && read.error.status === 404) {
    return <EmptyState icon={FileSearchIcon} title="Knowledge entry not found" description="It was deleted or is not available to your signed-in identity." action={<Button asChild variant="outline" size="sm"><Link to="/knowledge">Back to knowledge</Link></Button>} />;
  }
  return (
    <AsyncStatus query={read} label="knowledge entry">
      {(body) => {
        const item = knowledgeItem(body);
        return item ? <KnowledgeEditor key={item.id} item={item} knowledgeId={knowledgeId} /> : <EmptyState icon={FileSearchIcon} title="Knowledge entry not found" description="The server returned no entry for this id." />;
      }}
    </AsyncStatus>
  );
}
