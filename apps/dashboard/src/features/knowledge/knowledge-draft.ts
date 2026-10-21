import { CONTENT_MAX } from './knowledge-model';

/**
 * Unsaved knowledge drafts survive a reload of the same tab through `sessionStorage`.
 * Knowledge content is non-secret operator notes (ADR 0005 allows browser storage for
 * non-secret UI restore); the record holds only the entry's draft text and the generation it
 * was based on, never ids of the principal, tokens or anything from another page. The tab's
 * session storage ends with the tab.
 */
export type StoredDraft = { generation: number; content: string };

const PREFIX = 'cloud-harness:knowledge-draft:';

function storage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined; // Storage disabled: drafts simply do not survive a reload.
  }
}

export function readDraft(id: string): StoredDraft | undefined {
  try {
    const raw = storage()?.getItem(PREFIX + id);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<StoredDraft>;
    if (typeof parsed.content !== 'string' || parsed.content.length > CONTENT_MAX) return undefined;
    if (typeof parsed.generation !== 'number' || !Number.isInteger(parsed.generation) || parsed.generation < 1) return undefined;
    return { generation: parsed.generation, content: parsed.content };
  } catch {
    return undefined;
  }
}

export function writeDraft(id: string, draft: StoredDraft): void {
  try {
    storage()?.setItem(PREFIX + id, JSON.stringify(draft));
  } catch {
    // Quota exceeded or storage disabled: the in-page draft is unaffected.
  }
}

export function clearDraft(id: string): void {
  try {
    storage()?.removeItem(PREFIX + id);
  } catch {
    // Nothing to clear.
  }
}
