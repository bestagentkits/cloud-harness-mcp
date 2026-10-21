import type { QueryClient } from '@tanstack/react-query';
import type { PageAction } from 'dewee-webchat';
import { array, boolean, enum as zodEnum, literal, number, object, string, union } from 'zod';
import { toast } from '@/components/ui/toast-store';
import { ApiError, apiClient, ConflictError, ForbiddenError, NetworkError, RateLimitedError, ServerError, UnauthorizedError } from '@/lib/api-client';
import { bffPrefix, mutationErrorText } from '@/lib/bff-mutation';
import { type PageActionSpec, type SchemaKit, type PreparedMutation, registeredPageActions, registeredPageContext } from '@/lib/page-actions';
import { catalogActions, type CatalogDeps, pageContextSnapshot } from './page-action-catalog';
import { fitPageContext, parametersFor, parseArgs } from './widget-host-setup';

/** The builders handed to every spec's schema factory. */
const z: SchemaKit = { array, boolean, enum: zodEnum, literal, number, object, string, union };

/** The widget's own cap (dewee-webchat `ACTION_LIMITS.maxActions`). */
export const MAX_ACTIONS = 32;

/** A prepared request waiting for the owner's decision in the confirmation dialog. */
export type PendingRequest = { callId: string; mutation: PreparedMutation };

type Outcome = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

const ERROR_CODE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * What the agent is told about a failed send: fixed text chosen by error class, plus the HTTP
 * status and a short machine code. Never the server's message, which can quote caller input or
 * upstream text; the owner's toast shows that message instead.
 */
export function agentErrorText(error: unknown): string {
  const status = error instanceof ApiError ? ` (HTTP ${error.status}${error.code && ERROR_CODE.test(error.code) ? `, ${error.code}` : ''})` : '';
  if (error instanceof UnauthorizedError) return `The dashboard session ended; the owner must reload the page${status}.`;
  if (error instanceof ForbiddenError) return `The server refused the request${status}.`;
  if (error instanceof ConflictError) return `The resource changed since the page loaded; read the page again before preparing it${status}.`;
  if (error instanceof RateLimitedError) return `The server is rate limiting requests; wait before trying again${status}.`;
  if (error instanceof ServerError) return `The server failed to complete the request${status}.`;
  if (error instanceof ApiError) return `The server rejected the request${status}.`;
  if (error instanceof NetworkError) return 'The dashboard could not reach the server.';
  return 'The request could not be completed.';
}

export type AssistantControllerOptions = {
  queryClient: QueryClient;
  /** Shows (or, with `undefined`, hides) the confirmation dialog. */
  onPending: (request: PendingRequest | undefined) => void;
  send?: (mutation: PreparedMutation) => Promise<unknown>;
};

/**
 * The only path from an agent request to a write. The widget calls `confirm` for every
 * `mutate`/`destructive` action before its handler: `confirm` validates the arguments,
 * builds the exact request and shows it; `approve` (the owner's click) sends that stored
 * request; the handler then only reports the recorded, non-secret outcome. Dismissing the
 * dialog is a denial and nothing is sent. Agent arguments never reach the API directly.
 */
export function createAssistantController(options: AssistantControllerOptions) {
  const send = options.send ?? ((mutation) => apiClient.request<unknown>(mutation.path, { method: mutation.method, ...(mutation.body ? { body: mutation.body } : {}) }));
  let deps: CatalogDeps | undefined;
  let specs = new Map<string, PageActionSpec>();
  const outcomes = new Map<string, Outcome>();
  const waiting = new Map<string, (approved: boolean) => void>();
  const sending = new Set<string>();
  let pending: PendingRequest | undefined;

  function show(next: PendingRequest | undefined) {
    pending = next;
    options.onPending(next);
  }

  function settle(callId: string, approved: boolean) {
    const resolve = waiting.get(callId);
    waiting.delete(callId);
    if (pending?.callId === callId) show(undefined);
    resolve?.(approved);
  }

  /** Refetches only the reads the change affects, not the whole BFF cache. */
  function refresh(mutation: PreparedMutation) {
    for (const target of mutation.invalidate) void options.queryClient.invalidateQueries({ queryKey: typeof target === 'string' ? bffPrefix(target) : target });
  }

  function pageContext(): Record<string, unknown> {
    return deps ? fitPageContext(pageContextSnapshot(deps, registeredPageContext())) : {};
  }

  function toWidgetAction(spec: PageActionSpec): PageAction {
    const schema = spec.schema(z);
    return {
      name: spec.name,
      description: spec.description,
      sensitivity: spec.sensitivity,
      parameters: parametersFor(schema),
      handler: async (args, context) => {
        if ('run' in spec) return await spec.run(parseArgs(schema, args)) ?? { done: true };
        // A prepared action only reports what the confirmation recorded: it never sends.
        const outcome = outcomes.get(context.callId);
        outcomes.delete(context.callId);
        if (!outcome) throw new Error('The owner has not confirmed this request.');
        if (!outcome.ok) throw new Error(outcome.error);
        return outcome.result;
      }
    };
  }

  return {
    setDeps(next: CatalogDeps) { deps = next; },
    pageContext,

    /** The actions to advertise for the current route and page registrations. */
    actions(): PageAction[] {
      if (!deps) return [];
      const offered = [...catalogActions(deps, pageContext), ...registeredPageActions()];
      if (offered.length > MAX_ACTIONS && import.meta.env.DEV) console.warn(`Page actions over the widget's limit of ${MAX_ACTIONS} were not offered: ${offered.slice(MAX_ACTIONS).map((spec) => spec.name).join(', ')}`);
      const all = offered.slice(0, MAX_ACTIONS);
      specs = new Map(all.map((spec) => [spec.name, spec]));
      return all.map(toWidgetAction);
    },

    /**
     * The widget's approval hook. Resolves `true` only after the owner's click sent the
     * request, or when the request could not be built (the handler then reports that error
     * and nothing was sent); resolves `false` when the owner dismisses the dialog.
     */
    async confirm(name: string, callId: string, args: Record<string, unknown>): Promise<boolean> {
      // A call id is chosen by the agent and may be reused: drop any outcome a previous call left.
      outcomes.delete(callId);
      const spec = specs.get(name);
      if (!spec || !('prepare' in spec)) return false;
      let mutation: PreparedMutation;
      try {
        mutation = await spec.prepare(parseArgs(spec.schema(z), args));
      } catch (error) {
        outcomes.set(callId, { ok: false, error: error instanceof Error ? error.message : 'The request could not be prepared.' });
        return true;
      }
      if (pending) settle(pending.callId, false);
      return new Promise<boolean>((resolve) => {
        waiting.set(callId, resolve);
        show({ callId, mutation });
      });
    },

    /** The owner confirmed: send exactly the stored request. A failure is toasted and reported to the agent. */
    async approve(request: PendingRequest): Promise<void> {
      const { mutation } = request;
      if (sending.has(request.callId)) return;
      sending.add(request.callId);
      try {
        const response = await send(mutation);
        outcomes.set(request.callId, { ok: true, result: { sent: true, method: mutation.method, path: mutation.path, ...mutation.summarize?.(response) } });
        refresh(mutation);
        toast({ title: `${mutation.confirmLabel}: done`, description: 'The page is refreshing. Ask the assistant what to do next.', variant: 'success' });
      } catch (error) {
        if (error instanceof ConflictError) refresh(mutation);
        const message = mutationErrorText(error);
        outcomes.set(request.callId, { ok: false, error: agentErrorText(error) });
        toast({ title: `${mutation.confirmLabel} failed`, description: `${message} Check the page for its current state, then ask the assistant to prepare it again.`, variant: 'destructive' });
      }
      sending.delete(request.callId);
      settle(request.callId, true);
    },

    /** The owner dismissed the dialog: a denial, nothing sent. */
    deny(request: PendingRequest) {
      // Once the owner's click is sending, closing the dialog no longer denies it.
      if (waiting.has(request.callId) && !sending.has(request.callId)) settle(request.callId, false);
    },

    /** Denies whatever is still waiting (the assistant unmounts). */
    dispose() {
      for (const callId of [...waiting.keys()]) settle(callId, false);
    }
  };
}

export type AssistantController = ReturnType<typeof createAssistantController>;
