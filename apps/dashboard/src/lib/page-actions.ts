/**
 * Page actions the embedded Dewee assistant may call, and the non-secret page context it
 * sees. This module is the zod-free half of the registry so pages can register without
 * pulling zod or the widget into their chunk: a spec's `schema` is a factory that receives
 * zod from the lazy assistant chunk (`features/assistant/dewee-webchat.tsx`), which turns it
 * into the widget's JSON Schema subset and re-validates every call strictly.
 *
 * Rules every spec follows (the assistant chunk enforces them, docs/security-model.md
 * records them):
 * - `prepare` actions never send anything. They build the exact typed request body; the
 *   assistant shows that body in a confirmation dialog and sends it only after the owner
 *   clicks confirm. Agent arguments never reach the API as a raw payload.
 * - Results and page context carry only non-secret data: route, filters, selection ids,
 *   counts and statuses. Never file contents, terminal output, diffs, logs or secret values.
 * - Context field names avoid `value`, `key`, `token`, `secret`, `pass` and `auth`: the BFF
 *   redacts those keys before the gateway sees them.
 *
 * Cockpit tabs (terminal, files, git, automation, deploy, artifacts) register their own
 * actions with `usePageActions('workspace.<tab>', specs)` from inside the tab component, so
 * the actions exist only while that tab is mounted.
 */

import type { ZodType, z as zod } from 'zod';
import { useEffect, useSyncExternalStore } from 'react';
import type { InvalidateTarget } from './bff-mutation';

export type PageActionSensitivity = 'read' | 'navigate' | 'mutate' | 'destructive';

/** A fully built BFF request shown verbatim to the owner before anything is sent. */
export type PreparedMutation = {
  /** Dialog title, phrased as a question ("Revoke this API key?"). */
  title: string;
  /** What happens. Irreversibility is stated by `irreversible`, not in this text. */
  description: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  /** BFF path below `/dashboard/api/v1`, already percent-encoded. */
  path: string;
  /** The exact JSON body that will be sent; `undefined` sends no body. */
  body: Record<string, unknown> | undefined;
  confirmLabel: string;
  destructive: boolean;
  /** The change cannot be undone; the dialog says so in fixed wording. */
  irreversible?: boolean;
  /** The resource the request targets (an id or name), shown in monospace. */
  target?: string;
  /** Non-secret fields of the response worth returning to the agent (ids, state). */
  summarize?: (response: unknown) => Record<string, unknown>;
  /**
   * The reads this change affects, refetched after it lands (and after a 409, so the page
   * shows the latest generation), as the page's own mutation for the same change does.
   */
  invalidate: readonly InvalidateTarget[];
};

/**
 * The zod builders a spec's schema factory may use. Passing named builders instead of the
 * whole `z` namespace keeps zod tree-shakeable: the shared zod chunk that route pages load
 * would otherwise carry every schema type the namespace exposes.
 */
export type SchemaKit = Pick<typeof zod, 'object' | 'string' | 'enum' | 'number' | 'boolean' | 'literal' | 'union' | 'array'>;

type SpecBase<A> = {
  /** `^[a-z][a-z0-9_.-]{0,63}$`, unique across everything registered at once. */
  name: string;
  /** Written for the agent: what it does and when to use it. At most 1,000 characters. */
  description: string;
  schema: (z: SchemaKit) => ZodType<A>;
};

export type RunPageAction<A = Record<string, unknown>> = SpecBase<A> & {
  sensitivity: 'read' | 'navigate';
  /** Returns JSON-serialisable, non-secret data. */
  run: (args: A) => unknown;
};

export type PreparePageAction<A = Record<string, unknown>> = SpecBase<A> & {
  sensitivity: 'mutate' | 'destructive';
  /** Builds the request; throws an Error with an operator-readable message when it cannot. */
  prepare: (args: A) => PreparedMutation | Promise<PreparedMutation>;
};

// `any` keeps a list of specs with different argument types assignable to one array.
export type PageActionSpec = RunPageAction<any> | PreparePageAction<any>;

/** A no-argument entry for the command palette. */
export type PaletteEntry = { id: string; label: string; hint?: string; run: () => void };

type Registration = { owner: string; actions: readonly PageActionSpec[]; context?: () => Record<string, unknown>; palette?: readonly PaletteEntry[] };

const registrations = new Map<string, Registration>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribePageActions(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function pageActionsVersion(): number {
  return version;
}

/** Registers (or replaces) everything an owner contributes; returns the unregister function. */
export function registerPageActions(registration: Registration): () => void {
  registrations.set(registration.owner, registration);
  changed();
  return () => {
    if (registrations.get(registration.owner) !== registration) return;
    registrations.delete(registration.owner);
    changed();
  };
}

/** Every registered action; when two owners use one name the first registration wins. */
export function registeredPageActions(): PageActionSpec[] {
  const byName = new Map<string, PageActionSpec>();
  for (const registration of registrations.values()) {
    for (const action of registration.actions) if (!byName.has(action.name)) byName.set(action.name, action);
  }
  return [...byName.values()];
}

/** The merged non-secret context slices, keyed by owner. A failing slice is skipped. */
export function registeredPageContext(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const registration of registrations.values()) {
    if (!registration.context) continue;
    try { out[registration.owner] = registration.context(); } catch { /* a page bug must not break chat */ }
  }
  return out;
}

export function registeredPaletteEntries(): PaletteEntry[] {
  return [...registrations.values()].flatMap((registration) => registration.palette ?? []);
}

/**
 * Registers a page's actions, context and palette entries while the calling component is
 * mounted. Pass memoised values: a new array or function re-registers.
 */
export function usePageActions(owner: string, options: Omit<Registration, 'owner'>): void {
  const { actions, context, palette } = options;
  useEffect(() => registerPageActions({ owner, actions, ...(context ? { context } : {}), ...(palette ? { palette } : {}) }), [owner, actions, context, palette]);
}

/** Re-renders when the registry changes. */
export function usePageActionsVersion(): number {
  return useSyncExternalStore(subscribePageActions, pageActionsVersion, pageActionsVersion);
}
