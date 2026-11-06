import type { ReactNode } from 'react';

/**
 * The one tooltip that is open (or about to open) in the Dashboard, shared by every trigger
 * in `tooltip.tsx` and the lazily loaded Radix layer in `tooltip-layer.tsx`.
 */

export type TipContent = { children: ReactNode; side: 'top' | 'right' | 'bottom' | 'left'; sideOffset: number; className?: string };
export type Tip = { id: string; anchor: HTMLElement; read: () => TipContent | undefined };

/** After a tip closes, the next hover opens at once for this long (Radix's skip delay). */
const SKIP_DELAY_MS = 300;
/** How long a tip stays after the pointer leaves, so it can move onto the tip itself. */
const CLOSE_GRACE_MS = 100;

let current: Tip | null = null;
let pending: ReturnType<typeof setTimeout> | undefined;
/** The trigger whose open (or close) is pending. */
let pendingId: string | undefined;
let closedAt = Number.NEGATIVE_INFINITY;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

function clearPending(): void {
  if (pending !== undefined) clearTimeout(pending);
  pending = undefined;
  pendingId = undefined;
}

function schedule(id: string, action: () => void, delayMs: number): void {
  clearPending();
  pendingId = id;
  pending = setTimeout(action, delayMs);
}

function open(tip: Tip): void {
  clearPending();
  current = tip;
  emit();
}

function close(): void {
  clearPending();
  if (!current) return;
  current = null;
  closedAt = Date.now();
  emit();
}

export const tooltipStore = {
  current: (): Tip | null => current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** The DOM id of the tip's text, which describes its trigger while open. */
  contentId: (id: string): string => `${id}-tip`,
  show(tip: Tip, delayMs: number): void {
    if (current?.id === tip.id) { clearPending(); return; }
    const wait = current || Date.now() - closedAt < SKIP_DELAY_MS ? 0 : delayMs;
    if (wait <= 0) open(tip);
    else schedule(tip.id, () => open(tip), wait);
  },
  /** Closes `id` (or cancels its pending open); another trigger's tip is left alone. */
  hide(id: string): void {
    if (current?.id === id) close();
    else if (pendingId === id) clearPending();
  },
  hideSoon(id: string): void {
    if (current?.id === id) schedule(id, close, CLOSE_GRACE_MS);
    else if (pendingId === id) clearPending();
  },
  /** The pointer reached the tip: keep it open. */
  keep(): void {
    clearPending();
  },
  close,
  /** The open tip's content changed while it shows. */
  refresh(id: string): void {
    if (current?.id === id) emit();
  }
};
