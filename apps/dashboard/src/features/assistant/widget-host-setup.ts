import type { DeweeChatElement, JsonSchema } from 'dewee-webchat';
import { toJSONSchema, type ZodType } from 'zod';

/**
 * Host-side adapters that keep the pinned `dewee-webchat` widget inside the Dashboard's
 * security rules. Each one compensates for a widget default; the E2E suite
 * (`e2e/dewee-assistant.spec.ts`) fails if a widget upgrade changes the behaviour relied on.
 */

/** The BFF prefix the widget talks to (`apps/api/src/dashboard-dewee-router.ts`). */
export const DEWEE_ENDPOINT = '/dashboard/api/v1/dewee';

/** Where the widget's `ApiClient` saves its visitor session token (dewee-webchat 0.3.0). */
export const WIDGET_SESSION_STORAGE_KEY = `dewee-webchat:session:${DEWEE_ENDPOINT}`;

/**
 * The widget stores its bearer session token in `localStorage` whatever `persist` says. The
 * Dashboard keeps no token in browser storage, so the entry is removed as soon as it is
 * written; the widget keeps the token in memory and mints a fresh one after a reload. The
 * conversation id and acknowledgement hashes it also stores are not credentials.
 */
export function scrubWidgetSession(): void {
  try { globalThis.localStorage?.removeItem(WIDGET_SESSION_STORAGE_KEY); } catch { /* storage unavailable */ }
}

/** The slice of the Dashboard API client the widget fetch uses to renew its CSRF session. */
export type WidgetSession = {
  csrfHeaders: (signal?: AbortSignal) => Promise<Record<string, string>>;
  clearSession: () => void;
  /** Called when a fresh session cannot recover the request (the Access assertion ended). */
  onSessionEnded?: () => void;
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function isSessionEndedAnswer(response: Response): Promise<boolean> {
  try { return (await response.clone().json() as { error?: unknown }).error === 'session_ended'; } catch { return false; }
}

/**
 * Dashboard sessions live in API memory, so after an API restart the widget's next write is
 * answered `401 session_ended` while the API client still holds the old CSRF token. As in
 * the API client, the token is dropped, the session bootstrapped once and the request sent
 * once more with the new header: the session verifier rejects before any handler runs, so
 * the retry cannot repeat a write. A refused bootstrap or a second 401 ends the session.
 */
async function retryWithFreshSession(base: typeof fetch, session: WidgetSession, input: RequestInfo | URL, init: RequestInit | undefined, ended: Response): Promise<Response> {
  const signal = init?.signal ?? undefined;
  const sent = new Headers(init?.headers).get('x-csrf-token') ?? '';
  let fresh: Record<string, string>;
  try {
    // Drop the token only if it is still the one this request sent: a concurrent request
    // may already have bootstrapped a fresh session, and a stale 401 must not discard it.
    if ((await session.csrfHeaders(signal))['x-csrf-token'] === sent) session.clearSession();
    fresh = await session.csrfHeaders(signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    // The bootstrap itself is refused once the Access assertion has ended.
    session.onSessionEnded?.();
    return ended;
  }
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(fresh)) headers.set(name, value);
  const retried = await base(input, { ...init, headers, credentials: 'same-origin' });
  if (retried.status === 401) session.onSessionEnded?.();
  return retried;
}

/**
 * Same-origin fetch for every widget request. The widget saves a new session token right
 * after it parses the session response, in the same microtask chain, so wrapping `json()`
 * and scrubbing on the next task removes the entry deterministically. With `session`, a
 * write answered `401 session_ended` is retried once under a fresh CSRF session.
 */
export function createWidgetFetch(base: typeof fetch = (...args) => globalThis.fetch(...args), session?: WidgetSession): typeof fetch {
  return async (input, init) => {
    let response = await base(input, { ...init, credentials: 'same-origin' });
    const method = (init?.method ?? 'GET').toUpperCase();
    if (session && response.status === 401 && !SAFE_METHODS.has(method) && await isSessionEndedAnswer(response)) {
      response = await retryWithFreshSession(base, session, input, init, response);
    }
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/\/dewee\/session(?:\?|$)/.test(url)) {
      const json = response.json.bind(response);
      response.json = async () => {
        try { return await json(); } finally { setTimeout(scrubWidgetSession, 0); }
      };
    }
    return response;
  };
}

/**
 * The widget renders its shadow DOM with an inline `<style>` that the Dashboard CSP
 * (`style-src 'self' 'nonce-…'`) refuses. Rendering the shell while the element is still
 * detached never evaluates that style block, so it is lifted into a constructed stylesheet
 * (`adoptedStyleSheets`, which `style-src` does not govern) before the element connects;
 * `connectedCallback` skips its own render because the shell already exists.
 */
export function adoptWidgetStyles(element: DeweeChatElement): void {
  if (element.isConnected) throw new Error('The assistant must be prepared before it is attached.');
  (element as unknown as { renderShell: () => void }).renderShell();
  const root = element.shadowRoot;
  const style = root?.querySelector('style');
  if (!root || !style) throw new Error('The assistant widget changed its markup.');
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(style.textContent ?? '');
  style.remove();
  const overrides = new CSSStyleSheet();
  overrides.replaceSync(ACCESSIBLE_STATE_COLOURS);
  root.adoptedStyleSheets = [sheet, overrides];
}

/**
 * The widget hard-codes its action-state colours, and on its light surface the pending
 * (#b06f00) and done (#13a06f) labels fall below WCAG AA for 11px text. These replace them
 * with AA colours for each theme without touching the widget's other styles.
 */
const ACCESSIBLE_STATE_COLOURS = `
:host { --ch-state-ok: #0b6e4b; --ch-state-wait: #8a5300; --ch-state-bad: #a8253f; }
:host([data-theme="dark"]) { --ch-state-ok: #4fd6a2; --ch-state-wait: #f2b35a; --ch-state-bad: #ff8a9e; }
.action[data-status="done"] .action-state, .tool[data-status="done"] .tool-state { color: var(--ch-state-ok); }
.action[data-status="awaiting-confirmation"] .action-state { color: var(--ch-state-wait); }
.action[data-status="denied"] .action-state, .action[data-status="error"] .action-state, .tool[data-status="error"] .tool-state { color: var(--ch-state-bad); }
`;

const SCHEMA_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'enum', 'const', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'items', 'minItems', 'maxItems', 'description'
]);

/** Reduces a JSON Schema to the keyword subset the widget validates and advertises. */
export function widgetSchema(schema: unknown): JsonSchema {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {};
  const out: JsonSchema = {};
  for (const [keyword, member] of Object.entries(schema as Record<string, unknown>)) {
    if (!SCHEMA_KEYWORDS.has(keyword)) continue;
    if (keyword === 'properties' && member && typeof member === 'object') {
      out.properties = Object.fromEntries(Object.entries(member as Record<string, unknown>).map(([name, child]) => [name, widgetSchema(child)]));
    } else if (keyword === 'items') {
      out.items = widgetSchema(member);
    } else if (keyword === 'additionalProperties') {
      if (typeof member === 'boolean') out.additionalProperties = member;
      else if (member && typeof member === 'object' && Object.keys(member).length === 0) out.additionalProperties = true;
    } else {
      out[keyword] = member;
    }
  }
  return out;
}

/** The widget's parameter schema for a spec's zod schema (its input shape). */
export function parametersFor(schema: ZodType): JsonSchema {
  const json = widgetSchema(toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));
  return { type: 'object', properties: {}, additionalProperties: false, ...json };
}

const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];

/** True when `value` or any nested object has an own prototype-polluting key. */
function hasUnsafeKey(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object') return false;
  if (depth > 16) return true;
  if (!Array.isArray(value) && UNSAFE_KEYS.some((key) => Object.hasOwn(value, key))) return true;
  return Object.values(value).some((entry) => hasUnsafeKey(entry, depth + 1));
}

/** Parses agent arguments strictly; the message names the field, never echoes the input. */
export function parseArgs<T>(schema: ZodType<T>, args: unknown): T {
  // Refused here as well as by the widget: an own `__proto__` key survives JSON.parse.
  if (hasUnsafeKey(args)) throw new Error('Invalid arguments: args has a reserved key');
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new Error(`Invalid arguments: ${issue?.path.join('.') || 'args'} ${issue?.message ?? 'is invalid'}`);
}

/** Drops page-context items until the JSON fits the widget's 4 KB cap. */
export function fitPageContext(context: Record<string, unknown>, maxBytes = 4096): Record<string, unknown> {
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const items = Array.isArray(context.items) ? [...context.items] : undefined;
  let next = context;
  while (size(next) > maxBytes && items && items.length > 0) {
    items.pop();
    next = { ...context, items: [...items], itemsTruncated: true };
  }
  if (size(next) > maxBytes) {
    next = Object.fromEntries(Object.entries(next).filter(([name]) => name !== 'sections' && name !== 'items'));
    next.itemsTruncated = true;
  }
  return next;
}
