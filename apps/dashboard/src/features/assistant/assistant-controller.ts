import type { QueryClient } from '@tanstack/react-query';
import type { PageAction } from 'dewee-webchat';
import { array, boolean, enum as zodEnum, literal, number, object, string, union } from 'zod';
import { toast } from '@/components/ui/toast-store';
import { ApiError, apiClient, ConflictError, ForbiddenError, NetworkError, RateLimitedError, ServerError, UnauthorizedError } from '@/lib/api-client';
import { mutationErrorText } from '@/lib/bff-mutation';
import { type PageActionSpec, type SchemaKit, type PreparedMutation, registeredPageActions, registeredPageContext } from '@/lib/page-actions';
import { catalogActions, type CatalogDeps, pageContextSnapshot } from './page-action-catalog';
import { fitPageContext, parametersFor, parseArgs } from './widget-host-setup';

/** The builders handed to every spec's schema factory. */
const z: SchemaKit = { array, boolean, enum: zodEnum, literal, number, object, string, union };

/** The widget's own cap (dewee-webchat `ACTION_LIMITS.maxActions`). */
export const MAX_ACTIONS = 32;

/**
 * A prepared request waiting for the owner's decision in the confirmation dialog. `ticket` is
 * a host-side nonce minted per `confirm`: the agent chooses `callId` and may reuse it, so all
 * per-request state is keyed by the ticket.
 */
export type PendingRequest = { ticket: number; callId: string; mutation: PreparedMutation };

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
  let nextTicket = 0;
  const outcomes = new Map<number, Outcome>();
  const waiting = new Map<number, { callId: string; resolve: (approved: boolean) => void }>();
  const sending = new Set<number>();
  /** The newest ticket minted for each call id. */
  const latest = new Map<string, number>();
  /** Per call id, the outcome of its newest approved request, for the widget's handler to report. */
  const reports = new Map<string, Outcome>();
  let pending: PendingRequest | undefined;

  function show(next: PendingRequest | undefined) {
    pending = next;
    options.onPending(next);
  }

  function settle(ticket: number, approved: boolean) {
    const entry = waiting.get(ticket);
    waiting.delete(ticket);
    const outcome = outcomes.get(ticket);
    outcomes.delete(ticket);
    if (pending?.ticket === ticket) show(undefined);
    if (!entry) return;
    // The widget runs the handler right after an approval resolves, so it reads this outcome.
    // A superseded ticket's chain was stopped, so its outcome must not reach the newer call.
    if (latest.get(entry.callId) === ticket) {
      latest.delete(entry.callId);
      if (approved && outcome) reports.set(entry.callId, outcome);
    }
    entry.resolve(approved);
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
        const outcome = reports.get(context.callId);
        reports.delete(context.callId);
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
     * and nothing was sent); resolves `false` when the owner dismisses the dialog. A newer
     * request replaces the dialog: one still waiting is denied, while one whose send is in
     * flight keeps its promise.
     */
    async confirm(name: string, callId: string, args: Record<string, unknown>): Promise<boolean> {
      // A call id is chosen by the agent and may be reused: drop any outcome a previous call left.
      reports.delete(callId);
      latest.delete(callId);
      const spec = specs.get(name);
      if (!spec || !('prepare' in spec)) return false;
      let mutation: PreparedMutation;
      try {
        mutation = await spec.prepare(parseArgs(spec.schema(z), args));
      } catch (error) {
        reports.set(callId, { ok: false, error: error instanceof Error ? error.message : 'The request could not be prepared.' });
        return true;
      }
      // A newer request replaces the dialog. One still waiting is denied; one whose send is in
      // flight keeps its promise and settles with its own outcome when the send completes.
      if (pending && !sending.has(pending.ticket)) settle(pending.ticket, false);
      const ticket = ++nextTicket;
      latest.set(callId, ticket);
      return new Promise<boolean>((resolve) => {
        waiting.set(ticket, { callId, resolve });
        show({ ticket, callId, mutation });
      });
    },

    /** The owner confirmed: send exactly the stored request. A failure is toasted and reported to the agent. */
    async approve(request: PendingRequest): Promise<void> {
      const { mutation, ticket } = request;
      if (!waiting.has(ticket) || sending.has(ticket)) return;
      sending.add(ticket);
      try {
        const response = await send(mutation);
        outcomes.set(ticket, { ok: true, result: { sent: true, method: mutation.method, path: mutation.path, ...mutation.summarize?.(response) } });
        void options.queryClient.invalidateQueries({ queryKey: ['bff'] });
        toast({ title: `${mutation.confirmLabel}: done`, description: 'The page is refreshing. Ask the assistant what to do next.', variant: 'success' });
      } catch (error) {
        const message = mutationErrorText(error);
        outcomes.set(ticket, { ok: false, error: agentErrorText(error) });
        toast({ title: `${mutation.confirmLabel} failed`, description: `${message} Check the page for its current state, then ask the assistant to prepare it again.`, variant: 'destructive' });
      }
      sending.delete(ticket);
      settle(ticket, true);
    },

    /** The owner dismissed the dialog: a denial, nothing sent. */
    deny(request: PendingRequest) {
      // Once the owner's click is sending, closing the dialog no longer denies it.
      if (waiting.has(request.ticket) && !sending.has(request.ticket)) settle(request.ticket, false);
    },

    /** Denies whatever is still waiting (the assistant unmounts). */
    dispose() {
      for (const ticket of [...waiting.keys()]) settle(ticket, false);
    }
  };
}

export type AssistantController = ReturnType<typeof createAssistantController>;
