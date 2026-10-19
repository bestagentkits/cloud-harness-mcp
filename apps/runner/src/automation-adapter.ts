import {
  AUTOMATION_LIMITS,
  AutomationEventTypeSchema,
  type AutomationEventType,
  type AutomationProvider,
  type AutomationRuleMatch,
  type AutomationWorkflowState,
  type RunnerOperation
} from '@cloud-harness/contracts';

/**
 * The contract every automation provider implements. An adapter turns one provider's signed webhook
 * into a provider-neutral event, decides whether an owner-authored rule matches it, and optionally
 * posts progress back. Everything a webhook carries is untrusted: `verify` runs over the exact
 * received bytes before anything is parsed, and only the bounded fields of a
 * `NormalizedAutomationEvent` survive into storage, rule matching and the agent prompt. No event
 * field can choose the repository, owner, workspace, profile, tools or commands of a workflow.
 */

/** Who caused the event, as the provider reports it. */
export type AutomationEventActor = {
  /**
   * Who to name in prompts and on the Dashboard: GitHub login, Linear user email or name, Jira
   * display name. Linear names and Jira display names are editable by their users, so only the
   * GitHub login (unique and stable per account) is ever compared with an actor allowlist.
   */
  login: string;
  /** Stable provider id when it differs from `login` (Linear user id, Jira account id). */
  id?: string;
  /** Linear user email, when the payload carries one; unique per Linear account. */
  email?: string;
  /** Bots, apps and integrations; ignored by rules unless the owner opts in. */
  isBot: boolean;
  /** Provider actor kind shown to the agent, such as GitHub's `User` or `Bot`. */
  type?: string;
};

export type NormalizedAutomationEvent = {
  provider: AutomationProvider;
  eventType: AutomationEventType;
  /**
   * The container a rule scopes on: the GitHub `owner/name`, the Linear team key, the Jira project
   * key, or the custom event name. It is matched against the rule; it never selects a repository
   * for a non-GitHub rule.
   */
  scope: string;
  /** Stable per-resource key; repeat triggers on one key coalesce and share a cooldown. */
  resourceKey: string;
  /** Human reference: `#12`, `ENG-123`. */
  resourceRef: string;
  /** GitHub issue or pull request number; absent for other providers. */
  resourceNumber?: number;
  /** HTTPS link to the source, or empty when the provider sends none. */
  resourceUrl: string;
  /** The label added, for `*.label_added` and labelled custom events. */
  label?: string;
  /** The previous and new state or status, for `*.state_changed` and `*.status_changed`. */
  fromState?: string;
  toState?: string;
  actor: AutomationEventActor;
  /** Untrusted text, bounded with `boundedText`; cleared from storage once the delivery is matched. */
  title: string;
  body: string;
  /** Small provider-specific values a publisher may need (an issue uuid, a site id). */
  extras?: Record<string, string | number | boolean>;
};

export type AutomationVerifyInput = {
  secret: string;
  body: Buffer;
  /** The allowlisted headers, lower-cased; any of them may be missing. */
  headers: Readonly<Record<string, string>>;
  now: number;
};

/** A stale timestamp or a replay window violation is a rejection, the same as a bad signature. */
export type AutomationVerifyResult = { ok: true } | { ok: false; reason: string };

export type AutomationNormalization =
  | { kind: 'event'; event: NormalizedAutomationEvent }
  | { kind: 'ignored'; reason: string }
  | { kind: 'quarantined'; reason: string };

/** Non-secret connection settings, such as a Jira site's `baseUrl`. */
export type AutomationConnectionContext = { config: Readonly<Record<string, string>> };

export type AutomationMatchVerdict = { matched: boolean; reason: string };

export type AutomationMatchContext = {
  /** This harness's GitHub App login (`<slug>[bot]`), when configured. */
  selfLogin?: string | undefined;
};

/** The outcome of one workspace or agent operation driven on the owner's behalf. */
export type AutomationOperationResult = {
  ok: boolean;
  data?: unknown;
  error?: { code: string; retryable?: boolean } | undefined;
};

/** What a publisher stored about its provider object (a comment id, a check run id). */
export type AutomationPublishRef = Record<string, string | number>;

export type AutomationPublishWorkflow = {
  id: string;
  state: AutomationWorkflowState;
  ruleName: string;
  provider: AutomationProvider;
  eventType: AutomationEventType;
  /** The repository the workspace checked out. */
  repository: string;
  resourceKey: string;
  resourceRef: string;
  resourceNumber: number | null;
  resourceUrl: string;
  label: string;
  workspaceId: string | null;
  agentId: string | null;
  /** The agent's final answer, unescaped; present for `completed`. */
  resultText: string | null;
  /** Why a terminal workflow did not complete, such as `AGENT_TIMED_OUT` or `OWNER_CANCELLED`. */
  errorCode: string | null;
  /** The normalized event's `extras`, re-checked when stored; empty once the delivery is purged. */
  extras: Readonly<Record<string, string | number | boolean>>;
};

export type AutomationPublishRequest = {
  /** `started` once when the agent starts (best effort), `completed` with retries after it ends. */
  phase: 'started' | 'completed';
  workflow: AutomationPublishWorkflow;
  /** Rendered Markdown with `@` mentions neutralized. A publisher may re-render from `workflow`. */
  body: string;
  /** Stable per workflow and phase; replaying it must not post twice. */
  idempotencyKey: string;
  /** What an earlier publish of this workflow returned, so a publisher can edit instead of post. */
  publishRef: AutomationPublishRef | null;
  /** The connection's unsealed outbound credential. Never log, store, return or forward it. */
  outbound: Readonly<Record<string, string>> | null;
  config: Readonly<Record<string, string>>;
  /** Owner-scoped harness operations, such as the brokered `github_action`. */
  call(operation: RunnerOperation, input: Record<string, unknown>): Promise<AutomationOperationResult>;
  fetch: typeof fetch;
};

export type AutomationPublishResult =
  | { ok: true; publishRef?: AutomationPublishRef }
  | { ok: false; code: string; retryable: boolean };

export interface ProviderAdapter {
  readonly provider: AutomationProvider;
  /** Name used in prompts and comments: `GitHub`, `Linear`. */
  readonly displayName: string;
  /** Constant-time signature check (and timestamp window, if the provider signs one). Must not throw. */
  verify(input: AutomationVerifyInput): AutomationVerifyResult;
  /** The provider's event name, from a header or the verified body; undefined when malformed. */
  eventName(headers: Readonly<Record<string, string>>, body: Buffer): string | undefined;
  /** The provider's dedupe key, from a header or the verified body; undefined when missing. */
  deliveryId(headers: Readonly<Record<string, string>>, body: Buffer): string | undefined;
  normalize(providerEvent: string, body: Buffer, connection: AutomationConnectionContext): AutomationNormalization;
  /** Deterministic; never consults a model. The reason names the first filter that rejected. */
  matches(match: AutomationRuleMatch, event: NormalizedAutomationEvent, context: AutomationMatchContext): AutomationMatchVerdict;
  /** Posts progress back to the source. Without it, rules of this provider cannot `publishComment`. */
  publish?(request: AutomationPublishRequest): Promise<AutomationPublishResult>;
}

const RETRYABLE_CODES = new Set(['UNAVAILABLE', 'TIMEOUT', 'GITHUB_RATE_LIMITED', 'INTERNAL']);

export function isRetryableResult(result: AutomationOperationResult): boolean {
  return result.error?.retryable === true || RETRYABLE_CODES.has(result.error?.code ?? '');
}

/** Removes control characters other than tab and newline, then bounds the text by characters. */
export function boundedText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, '');
  const characters = Array.from(cleaned);
  return characters.length <= maxChars ? cleaned : `${characters.slice(0, maxChars).join('')}…`;
}

export const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * The shared actor filters, in order: this harness's own app, bots, then the allowlist. The
 * allowlist is compared, case-insensitively, only with `identities`: the stable identifiers the
 * adapter vouches for (a GitHub login, a Jira account id, a Linear user id or email). A display
 * name is never one of them, because anyone can set theirs to an allowed id. Undefined when the
 * actor passes.
 */
export function rejectActor(
  filters: { ignoreBots?: boolean | undefined; actorAllowlist?: readonly string[] | undefined },
  actor: AutomationEventActor,
  selfLogin: string | undefined,
  identities: readonly (string | undefined)[]
): AutomationMatchVerdict | undefined {
  if (selfLogin && actor.login.toLowerCase() === selfLogin.toLowerCase()) return { matched: false, reason: 'self_trigger' };
  if (filters.ignoreBots !== false && actor.isBot) return { matched: false, reason: 'bot_sender' };
  const stable = identities.filter((value): value is string => typeof value === 'string' && value !== '').map((value) => value.toLowerCase());
  if (filters.actorAllowlist && !filters.actorAllowlist.some((entry) => stable.includes(entry.toLowerCase()))) {
    return { matched: false, reason: 'actor_not_allowed' };
  }
  return undefined;
}

/** Rule index value that matches any event value. Real scopes and triggers are never empty. */
export const ANY_INDEX_KEY = '';

/**
 * The two indexed columns of a rule: `repository_key` holds the scope (repository, team key,
 * project key, custom event name) and `label_key` the trigger value (label, or target state or
 * status). An omitted optional filter is stored as `ANY_INDEX_KEY`. They only narrow the candidate
 * rules; the adapter's `matches` decides.
 */
export function ruleIndexKeys(match: AutomationRuleMatch): { scope: string; trigger: string } {
  // One Linear or Jira update can add several labels and move the state, and one custom event can list
  // several added labels, so for those providers only the scope narrows the candidates.
  if (match.provider === 'linear') return { scope: (match.teamKey ?? ANY_INDEX_KEY).toLowerCase(), trigger: ANY_INDEX_KEY };
  if (match.provider === 'jira') return { scope: match.projectKey.toLowerCase(), trigger: ANY_INDEX_KEY };
  if (match.provider === 'custom') return { scope: match.event.toLowerCase(), trigger: ANY_INDEX_KEY };
  return { scope: match.repository.toLowerCase(), trigger: match.label.toLowerCase() };
}

/** Longest `extras.addedLabels` value; a flat extras value is bounded to 200 characters. */
const ADDED_LABELS_MAX_CHARS = 200;

/**
 * The labels an event added, packed for `extras.addedLabels`: in order, deduplicated, as many as fit,
 * joined by `separator`. A label containing the separator would split in two, so it is skipped. The
 * separator must pass the single-line extras check (not CR, LF or NUL): a space for Jira, whose labels
 * hold no whitespace, and a tab for providers whose labels may contain spaces.
 */
export function packAddedLabels(labels: readonly string[], separator: string): { labels: string[]; extras: { addedLabels: string } | undefined } {
  const kept: string[] = [];
  let used = 0;
  for (const name of labels) {
    if (name === '' || name.includes(separator) || kept.includes(name)) continue;
    const cost = name.length + (kept.length > 0 ? separator.length : 0);
    if (used + cost > ADDED_LABELS_MAX_CHARS) break;
    used += cost;
    kept.push(name);
  }
  return { labels: kept, extras: kept.length === 0 ? undefined : { addedLabels: kept.join(separator) } };
}

/** The labels packed by `packAddedLabels`, or the event's single `label` when it carries no list. */
export function eventAddedLabels(event: NormalizedAutomationEvent, separator: string): string[] {
  const listed = event.extras?.addedLabels;
  return typeof listed === 'string' ? listed.split(separator).filter(Boolean) : event.label ? [event.label] : [];
}

export function eventIndexKeys(event: NormalizedAutomationEvent): { scope: string; trigger: string } {
  return { scope: event.scope.toLowerCase(), trigger: (event.label ?? event.toState ?? ANY_INDEX_KEY).toLowerCase() };
}

const SINGLE_LINE = /^[^\0\r\n]+$/u;
const EXTRA_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/u;
const MAX_EXTRAS = 16;

const optionalLine = (value: unknown, max: number): boolean =>
  value === undefined || (typeof value === 'string' && value.length <= max && SINGLE_LINE.test(value));
const line = (value: unknown, max: number): boolean => typeof value === 'string' && value.length > 0 && optionalLine(value, max);

/**
 * Re-checks an adapter's output before it is stored, so a defective adapter cannot persist
 * unbounded or malformed data. Returns the first offending field, or undefined.
 */
export function normalizedEventProblem(event: NormalizedAutomationEvent): string | undefined {
  if (!AutomationEventTypeSchema.safeParse(event.eventType).success || !event.eventType.startsWith(`${event.provider}.`)) return 'eventType';
  if (!line(event.scope, 200)) return 'scope';
  if (!line(event.resourceKey, 300)) return 'resourceKey';
  if (!line(event.resourceRef, 100)) return 'resourceRef';
  if (event.resourceNumber !== undefined && (!Number.isSafeInteger(event.resourceNumber) || event.resourceNumber < 1)) return 'resourceNumber';
  if (typeof event.resourceUrl !== 'string' || event.resourceUrl.length > 300 || (event.resourceUrl !== '' && !event.resourceUrl.startsWith('https://'))) return 'resourceUrl';
  if (!optionalLine(event.label, 100) || event.label === '') return 'label';
  if (!optionalLine(event.fromState, 100) || !optionalLine(event.toState, 100)) return 'state';
  if (!record(event.actor) || !line(event.actor.login, 254) || !optionalLine(event.actor.id, 200) || !optionalLine(event.actor.email, 254) || !optionalLine(event.actor.type, 40) || typeof event.actor.isBot !== 'boolean') return 'actor';
  if (typeof event.title !== 'string' || Array.from(event.title).length > AUTOMATION_LIMITS.maxUntrustedTitleChars + 1) return 'title';
  if (typeof event.body !== 'string' || Array.from(event.body).length > AUTOMATION_LIMITS.maxUntrustedBodyChars + 1) return 'body';
  if (event.extras !== undefined) {
    const entries = record(event.extras) ? Object.entries(event.extras) : undefined;
    if (!entries || entries.length > MAX_EXTRAS) return 'extras';
    for (const [key, value] of entries) {
      if (!EXTRA_KEY.test(key)) return 'extras';
      if (typeof value === 'string' ? !optionalLine(value, 200) : typeof value === 'number' ? !Number.isFinite(value) : typeof value !== 'boolean') return 'extras';
    }
  }
  return undefined;
}
