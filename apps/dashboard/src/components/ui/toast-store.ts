import { useSyncExternalStore } from 'react';

/**
 * The toast queue, kept apart from the Radix view in `toast.tsx` so raising a toast never
 * pulls Radix Toast into the entry chunk: `LazyToaster` loads the view on the first toast.
 *
 * Toast text must never contain secrets, tokens or raw terminal output.
 */
export type ToastVariant = 'default' | 'success' | 'destructive';
export type ToastInput = { title: string; description?: string; variant?: ToastVariant; durationMs?: number };
export type ToastRecord = ToastInput & { id: number; open: boolean };

const MAX_TOASTS = 3;
let records: ToastRecord[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export function toast(input: ToastInput): number {
  const id = nextId++;
  records = [...records, { ...input, id, open: true }].slice(-MAX_TOASTS);
  emit();
  return id;
}

export function dismissToast(id: number): void {
  records = records.map((record) => (record.id === id ? { ...record, open: false } : record));
  emit();
}

export function removeToast(id: number): void {
  records = records.filter((record) => record.id !== id);
  emit();
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The live toast list, for the view and for `LazyToaster`'s first-toast check. */
export function useToasts(): ToastRecord[] {
  return useSyncExternalStore(subscribeToasts, () => records, () => records);
}
