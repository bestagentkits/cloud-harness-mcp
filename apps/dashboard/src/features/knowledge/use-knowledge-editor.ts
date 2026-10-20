import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ConflictError, apiClient } from '@/lib/api-client';
import { type BffEnvelope, bffKey } from '@/lib/bff-query';
import { useBffMutation } from '@/lib/bff-mutation';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import type { ConflictVersion } from './knowledge-conflict-dialog';
import { clearDraft, readDraft, writeDraft } from './knowledge-draft';
import { type KnowledgeItem, knowledgeItem } from './knowledge-model';
import { KNOWLEDGE_GRAPH_PATH, KNOWLEDGE_PATH, KNOWLEDGE_SEARCH_PATH, knowledgeItemPath } from './knowledge-queries';

/** The version the draft is based on. `content` is unknown for a draft restored onto an older generation. */
type Base = { generation: number | undefined; content: string | undefined };
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

/** The classic preview debounce (T9). */
export const PREVIEW_DEBOUNCE_MS = 200;

function baseOf(item: KnowledgeItem): Base {
  return { generation: item.generation, content: typeof item.content === 'string' ? item.content : '' };
}

function initialState(item: KnowledgeItem): { base: Base; draft: string; restored: boolean } {
  const base = baseOf(item);
  const stored = readDraft(item.id);
  if (!stored || stored.content === base.content) return { base, draft: base.content ?? '', restored: false };
  // A draft from an older generation keeps that generation as its fence, so saving it is a
  // conflict the operator resolves instead of a silent overwrite of the newer version.
  return { base: stored.generation === item.generation ? base : { generation: stored.generation, content: undefined }, draft: stored.content, restored: true };
}

/** Lists that show an entry; a save, create or delete refreshes them. */
export const KNOWLEDGE_LIST_KEYS: QueryKey[] = [bffKey(KNOWLEDGE_PATH).slice(0, 2), bffKey(KNOWLEDGE_SEARCH_PATH).slice(0, 2), bffKey(KNOWLEDGE_GRAPH_PATH).slice(0, 2)];

/**
 * The knowledge editor's state: the draft, the version it is based on (the generation fence
 * a save sends) and the save/conflict flow. A background refetch replaces the editor text only
 * while there is no draft; a draft is never overwritten without the operator's say-so.
 */
export function useKnowledgeEditor(item: KnowledgeItem, itemKey: QueryKey, fetchServer: () => Promise<unknown>) {
  const queryClient = useQueryClient();
  const [state, setState] = useState(() => initialState(item));
  const [failed, setFailed] = useState(false);
  const [conflict, setConflict] = useState<{ open: boolean; base: Base; server: ConflictVersion | undefined; error: boolean }>({ open: false, base: state.base, server: undefined, error: false });
  const dirty = state.draft !== state.base.content;

  // Follow a newer server version while the editor holds no draft (render-time sync).
  const itemVersion = `${String(item.generation)}:${item.content ?? ''}`;
  const [seenVersion, setSeenVersion] = useState(itemVersion);
  if (itemVersion !== seenVersion) {
    setSeenVersion(itemVersion);
    if (!dirty) setState({ base: baseOf(item), draft: item.content ?? '', restored: false });
  }

  const preview = useDebouncedValue(state.draft, PREVIEW_DEBOUNCE_MS);
  const settledDraft = useDebouncedValue(state, PREVIEW_DEBOUNCE_MS);
  useEffect(() => {
    const { base, draft } = settledDraft;
    if (draft !== base.content && typeof base.generation === 'number') writeDraft(item.id, { generation: base.generation, content: draft });
    else clearDraft(item.id);
  }, [item.id, settledDraft]);

  const mutation = useBffMutation<{ content: string; generation: number }, BffEnvelope<unknown>>({
    mutationFn: ({ content, generation }) => apiClient.request(knowledgeItemPath(item.id), { method: 'PUT', body: { content, expectedGeneration: generation } }),
    invalidate: [itemKey, ...KNOWLEDGE_LIST_KEYS],
    successTitle: 'Knowledge entry saved',
    errorTitle: 'The entry was not saved'
  });

  function setDraft(draft: string) {
    setFailed(false);
    setState((current) => ({ ...current, draft }));
  }

  async function save(): Promise<void> {
    if (mutation.isPending || !dirty) return;
    const content = state.draft;
    const generation = state.base.generation;
    if (typeof generation !== 'number') { setFailed(true); throw new Error('This entry has no generation to fence the save; reload the page.'); }
    try {
      const result = await mutation.mutateAsync({ content, generation });
      const saved = knowledgeItem(result);
      setState((current) => ({ base: { generation: saved?.generation ?? generation + 1, content }, draft: current.draft, restored: false }));
      if (saved) queryClient.setQueryData(itemKey, result);
    } catch (error) {
      setFailed(true);
      if (error instanceof ConflictError) openConflict();
      throw error;
    }
  }

  function openConflict() {
    setConflict({ open: true, base: state.base, server: undefined, error: false });
    fetchServer().then((body) => {
      const server = knowledgeItem(body);
      setConflict((current) => ({ ...current, server: server ? { generation: server.generation, content: server.content ?? '' } : undefined, error: !server }));
    }, () => setConflict((current) => ({ ...current, error: true })));
  }

  function loadServer(server: ConflictVersion) {
    clearDraft(item.id);
    setFailed(false);
    setState({ base: server, draft: server.content, restored: false });
    setConflict((current) => ({ ...current, open: false }));
  }

  function discardDraft() {
    clearDraft(item.id);
    setFailed(false);
    setState({ base: baseOf(item), draft: item.content ?? '', restored: false });
  }

  const saveState: SaveState = mutation.isPending ? 'saving' : !dirty ? 'saved' : failed ? 'error' : 'dirty';
  return {
    draft: state.draft, base: state.base, preview, dirty, restored: state.restored, saveState,
    setDraft, save, discardDraft, loadServer,
    conflict: { ...conflict, setOpen: (open: boolean) => setConflict((current) => ({ ...current, open })) }
  };
}
