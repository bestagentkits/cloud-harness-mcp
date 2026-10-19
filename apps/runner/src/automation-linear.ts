import { createHmac, timingSafeEqual } from 'node:crypto';
import { AUTOMATION_LIMITS, type AutomationRuleMatch } from '@cloud-harness/contracts';
import {
  boundedText,
  eventAddedLabels,
  packAddedLabels,
  record,
  rejectActor,
  type AutomationEventActor,
  type AutomationMatchVerdict,
  type AutomationNormalization,
  type AutomationPublishRequest,
  type AutomationPublishResult,
  type NormalizedAutomationEvent,
  type ProviderAdapter
} from './automation-adapter.js';

/**
 * Linear webhook verification, normalization and comment publishing. A delivery is signed with the
 * hex HMAC-SHA256 of the raw body in `Linear-Signature`, and carries `webhookTimestamp` (ms) so a
 * captured body cannot be replayed later. Linear sends no "labeled" action: label and state
 * transitions are derived by comparing the issue with `updatedFrom`, the previous values of the
 * fields that changed.
 */

const GRAPHQL_URL = 'https://api.linear.app/graphql';
/** Linear's documented replay window for `webhookTimestamp`, applied in both directions. */
const TIMESTAMP_TOLERANCE_MS = 60_000;
const EVENT_NAME = /^[A-Za-z]{1,64}$/u;
const TEAM_KEY = /^[A-Za-z0-9_]{1,16}$/u;
const IDENTIFIER = /^[A-Za-z0-9_]{1,16}-\d{1,9}$/u;
const SINGLE_LINE = /^[^\0\r\n]+$/u;
const MAX_LABELS = 250;
/**
 * Linear label names may contain spaces, so `extras.addedLabels` joins them with a tab. The extras
 * check allows a tab (only CR, LF and NUL are refused); a label that itself contains one is skipped.
 */
const ADDED_LABELS_SEPARATOR = '\t';
const MAX_COMMENT_CHARS = 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

/** Constant-time check of `Linear-Signature` (hex HMAC-SHA256 of the raw body). */
export function verifyLinearSignature(secret: string, body: Buffer, signature: string): boolean {
  if (!/^[a-f0-9]{64}$/iu.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

function parseBody(body: Buffer): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(body.toString('utf8')));
  } catch {
    return undefined;
  }
}

const line = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && SINGLE_LINE.test(value);

type IssueLabel = { id: string; name: string };

function issueLabels(data: Record<string, unknown>): IssueLabel[] | undefined {
  if (data.labels === undefined) return [];
  if (!Array.isArray(data.labels) || data.labels.length > MAX_LABELS) return undefined;
  const labels: IssueLabel[] = [];
  for (const entry of data.labels) {
    const label = record(entry);
    if (!label || !line(label.id, 100) || !line(label.name, 100)) return undefined;
    labels.push({ id: label.id, name: label.name });
  }
  return labels;
}

function idList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_LABELS || !value.every((id) => line(id, 100))) return undefined;
  return value as string[];
}

/** Linear integrations, OAuth apps and system changes are not people; only `user` actors are. */
function linearActor(value: unknown): AutomationEventActor | undefined {
  if (value === undefined || value === null) return { login: 'linear', isBot: true, type: 'system' };
  const actor = record(value);
  if (!actor) return undefined;
  const type = typeof actor.type === 'string' ? actor.type : 'user';
  const login = [actor.email, actor.name, actor.id].find((candidate) => line(candidate, 254));
  if (!login || !line(type, 40)) return undefined;
  return {
    login: login as string,
    ...(line(actor.id, 200) ? { id: actor.id } : {}),
    ...(line(actor.email, 254) ? { email: actor.email } : {}),
    isBot: type.toLowerCase() !== 'user',
    type
  };
}

/**
 * Maps a verified Linear delivery onto an admitted event type. Only `Issue` creates and updates
 * can carry a transition; everything else, and an issue change that is neither a label added nor a
 * state change, is `ignored`. An issue with a missing or malformed field is `quarantined`.
 *
 * One delivery yields one event that keeps every transition. `label` is the first label added and
 * `extras.addedLabels` lists all of them (as many as fit), and a state change makes it a
 * `state_changed` event that still carries the labels. `matchLinearRule` checks the added labels and
 * the state separately, so a label rule and a state rule can both fire from one update.
 */
export function normalizeLinearEvent(providerEvent: string, body: Buffer): AutomationNormalization {
  if (providerEvent !== 'Issue') return { kind: 'ignored', reason: 'unsupported_event' };
  const payload = parseBody(body);
  if (!payload) return { kind: 'quarantined', reason: 'malformed_payload' };
  if (payload.type !== 'Issue') return { kind: 'ignored', reason: 'unsupported_event' };
  if (payload.action !== 'update' && payload.action !== 'create') return { kind: 'ignored', reason: 'unsupported_action' };
  const data = record(payload.data);
  if (!data) return { kind: 'quarantined', reason: 'malformed_payload' };
  const updatedFrom = payload.action === 'update' ? record(payload.updatedFrom) : {};
  if (!updatedFrom) return { kind: 'ignored', reason: 'no_transition' };

  const teamKey = record(data.team)?.key;
  if (typeof teamKey !== 'string' || !TEAM_KEY.test(teamKey)) return { kind: 'quarantined', reason: 'invalid_team' };
  const identifier = data.identifier;
  if (typeof identifier !== 'string' || !IDENTIFIER.test(identifier)) return { kind: 'quarantined', reason: 'invalid_identifier' };
  if (!line(data.id, 100)) return { kind: 'quarantined', reason: 'invalid_issue_id' };
  const url = data.url ?? payload.url;
  if (typeof url !== 'string' || !url.startsWith('https://linear.app/') || url.length > 300 || !SINGLE_LINE.test(url)) return { kind: 'quarantined', reason: 'invalid_url' };
  const actor = linearActor(payload.actor);
  if (!actor) return { kind: 'quarantined', reason: 'invalid_actor' };

  const base = {
    provider: 'linear' as const,
    scope: teamKey,
    resourceKey: `linear:${data.id}`,
    resourceRef: identifier,
    resourceUrl: url,
    actor,
    title: boundedText(data.title, AUTOMATION_LIMITS.maxUntrustedTitleChars),
    body: boundedText(data.description, AUTOMATION_LIMITS.maxUntrustedBodyChars),
    extras: { issueId: data.id }
  };

  // A created issue gained all its labels; an update only touched labels when `updatedFrom` has them.
  const previousLabels = payload.action === 'create' ? [] : updatedFrom.labelIds === undefined ? undefined : idList(updatedFrom.labelIds) ?? null;
  if (previousLabels === null) return { kind: 'quarantined', reason: 'invalid_labels' };
  const labelNames = previousLabels ? addedLabelNames(data, previousLabels) : [];
  if (labelNames === 'invalid') return { kind: 'quarantined', reason: 'invalid_labels' };
  const added = packAddedLabels(labelNames, ADDED_LABELS_SEPARATOR);

  let toState: string | undefined;
  const previousState = updatedFrom.stateId;
  if (payload.action === 'update' && previousState !== undefined) {
    const stateName = record(data.state)?.name;
    if (!line(previousState, 100) || !line(data.stateId, 100) || !line(stateName, 100)) return { kind: 'quarantined', reason: 'invalid_state' };
    if (previousState !== data.stateId) toState = stateName;
  }
  if (toState === undefined && added.labels.length === 0) return { kind: 'ignored', reason: 'no_transition' };

  return {
    kind: 'event',
    event: {
      ...base,
      eventType: toState === undefined ? 'linear.issue.label_added' : 'linear.issue.state_changed',
      ...(added.labels[0] === undefined ? {} : { label: added.labels[0] }),
      ...(toState === undefined ? {} : { toState }),
      extras: { issueId: data.id, ...added.extras }
    }
  };
}

/** Names of the labels present now that were absent before, in the issue's `labelIds` order. */
function addedLabelNames(data: Record<string, unknown>, previous: readonly string[]): string[] | 'invalid' {
  const labels = issueLabels(data);
  const current = data.labelIds === undefined ? labels?.map((entry) => entry.id) : idList(data.labelIds);
  if (!labels || !current) return 'invalid';
  const before = new Set(previous);
  const names = new Map(labels.map((entry) => [entry.id, entry.name]));
  const added: string[] = [];
  for (const id of current) {
    if (before.has(id)) continue;
    const name = names.get(id);
    if (name === undefined) return 'invalid';
    added.push(name);
  }
  return added;
}

/** Evaluates one Linear rule: team, then the label or state trigger, then the actor filters. */
export function matchLinearRule(
  match: AutomationRuleMatch,
  event: NormalizedAutomationEvent,
  selfLogin: string | undefined
): AutomationMatchVerdict {
  if (match.provider !== 'linear' || event.provider !== 'linear') return { matched: false, reason: 'provider_mismatch' };
  if (match.teamKey !== undefined && match.teamKey.toLowerCase() !== event.scope.toLowerCase()) return { matched: false, reason: 'team_mismatch' };
  if (match.trigger === 'label_added') {
    const wanted = (match.label ?? '').toLowerCase();
    const added = eventAddedLabels(event, ADDED_LABELS_SEPARATOR);
    if (added.length === 0) return { matched: false, reason: 'event_not_selected' };
    if (!added.some((name) => name.toLowerCase() === wanted)) return { matched: false, reason: 'label_mismatch' };
  } else {
    if (event.eventType !== 'linear.issue.state_changed') return { matched: false, reason: 'event_not_selected' };
    if (match.toState !== undefined && match.toState.toLowerCase() !== (event.toState ?? '').toLowerCase()) return { matched: false, reason: 'state_mismatch' };
  }
  // The user id, and the email when Linear sends one, identify a user; the name is editable.
  return rejectActor(match, event.actor, selfLogin, [event.actor.id, event.actor.email]) ?? { matched: true, reason: 'matched' };
}

// ---------------------------------------------------------------- publishing

const failure = (code: string, retryable: boolean): AutomationPublishResult => ({ ok: false, code, retryable });

/** Reads at most `MAX_RESPONSE_BYTES` of a response body and parses it as JSON. */
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) return undefined;
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

type GraphQlOutcome = { ok: true; data: Record<string, unknown> } | { ok: false; code: string; retryable: boolean };

async function graphql(request: AutomationPublishRequest, apiKey: string, query: string, variables: Record<string, unknown>): Promise<GraphQlOutcome> {
  let response: Response;
  try {
    response = await request.fetch(GRAPHQL_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', authorization: apiKey },
      body: JSON.stringify({ query, variables })
    });
  } catch {
    return { ok: false, code: 'LINEAR_UNREACHABLE', retryable: true };
  }
  const parsed = record(await boundedJson(response));
  const errors = Array.isArray(parsed?.errors) ? parsed.errors.map(record) : [];
  const rateLimited = response.status === 429 || errors.some((error) => record(error?.extensions)?.code === 'RATELIMITED');
  if (response.status === 401 || response.status === 403) return { ok: false, code: 'LINEAR_UNAUTHORIZED', retryable: false };
  if (rateLimited) return { ok: false, code: 'LINEAR_RATE_LIMITED', retryable: true };
  if (response.status >= 500) return { ok: false, code: 'LINEAR_UNAVAILABLE', retryable: true };
  const authError = errors.some((error) => /^(?:authentication|forbidden)/iu.test(String(record(error?.extensions)?.type ?? '')));
  if (authError) return { ok: false, code: 'LINEAR_UNAUTHORIZED', retryable: false };
  const data = record(parsed?.data);
  if (!response.ok || errors.length > 0 || !data) return { ok: false, code: 'LINEAR_REJECTED', retryable: false };
  return { ok: true, data };
}

const ISSUE_QUERY = 'query Issue($id: String!) { issue(id: $id) { id } }';
const COMMENT_CREATE = 'mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }';
const COMMENT_UPDATE = 'mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success comment { id } } }';

/**
 * Posts one Linear comment per workflow: the first publish creates it and records its id, and every
 * later phase edits that same comment. The API key is sent only to Linear's GraphQL endpoint.
 */
async function publishLinearComment(request: AutomationPublishRequest): Promise<AutomationPublishResult> {
  const apiKey = request.outbound?.apiKey;
  if (!apiKey) return failure('OUTBOUND_NOT_CONFIGURED', false);
  const body = boundedText(request.body, MAX_COMMENT_CHARS);
  const existing = request.publishRef?.commentId;

  if (typeof existing === 'string' && existing !== '') {
    const updated = await graphql(request, apiKey, COMMENT_UPDATE, { id: existing, input: { body } });
    if (!updated.ok) return failure(updated.code, updated.retryable);
    return record(updated.data.commentUpdate)?.success === true ? { ok: true, publishRef: { commentId: existing } } : failure('LINEAR_REJECTED', false);
  }

  // The reference (`ENG-123`) is what the workflow keeps; Linear resolves it to the issue id.
  const issue = await graphql(request, apiKey, ISSUE_QUERY, { id: request.workflow.resourceRef });
  if (!issue.ok) return failure(issue.code, issue.retryable);
  const issueId = record(issue.data.issue)?.id;
  if (!line(issueId, 100)) return failure('LINEAR_ISSUE_NOT_FOUND', false);
  const created = await graphql(request, apiKey, COMMENT_CREATE, { input: { issueId, body } });
  if (!created.ok) return failure(created.code, created.retryable);
  const commentId = record(record(created.data.commentCreate)?.comment)?.id;
  return record(created.data.commentCreate)?.success === true && line(commentId, 100)
    ? { ok: true, publishRef: { commentId } }
    : failure('LINEAR_REJECTED', false);
}

export const linearAdapter: ProviderAdapter = {
  provider: 'linear',
  displayName: 'Linear',
  verify: ({ secret, body, headers, now }) => {
    if (!verifyLinearSignature(secret, body, headers['linear-signature'] ?? '')) return { ok: false, reason: 'bad_signature' };
    const timestamp = parseBody(body)?.webhookTimestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return { ok: false, reason: 'missing_timestamp' };
    return Math.abs(now - timestamp) > TIMESTAMP_TOLERANCE_MS ? { ok: false, reason: 'stale_timestamp' } : { ok: true };
  },
  eventName: (headers, body) => {
    const name = headers['linear-event'] ?? parseBody(body)?.type;
    return typeof name === 'string' && EVENT_NAME.test(name) ? name : undefined;
  },
  deliveryId: (headers) => headers['linear-delivery'],
  normalize: (providerEvent, body) => normalizeLinearEvent(providerEvent, body),
  matches: (match, event, context) => matchLinearRule(match, event, context.selfLogin),
  publish: publishLinearComment
};
