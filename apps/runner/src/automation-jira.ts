import { createHash } from 'node:crypto';
import { AUTOMATION_LIMITS, AutomationJiraBaseUrlSchema } from '@cloud-harness/contracts';
import {
  boundedText,
  eventAddedLabels,
  packAddedLabels,
  record,
  rejectActor,
  type AutomationMatchVerdict,
  type AutomationNormalization,
  type AutomationPublishRequest,
  type AutomationPublishResult,
  type NormalizedAutomationEvent,
  type ProviderAdapter
} from './automation-adapter.js';
import { verifyGitHubSignature } from './automation-github.js';
import { createProviderHttpClient, ProviderHttpError, type ProviderHttpClient, type ProviderHttpResponse } from './model-provider-http.js';

/**
 * Jira Cloud webhook verification, normalization and comment publishing. A Jira admin webhook with
 * a secret signs the raw body as `X-Hub-Signature: sha256=<hex HMAC-SHA256>`, the same scheme
 * GitHub uses. The body is untrusted: only bounded, shape-checked fields survive, and the issue
 * link is built from the connection's configured site, never from a URL the payload carries.
 */

/**
 * The signature does not cover the delivery headers, so replay is bounded by the body's own
 * `timestamp` (epoch ms, covered by the signature): older than the window below, or more than one
 * minute ahead of this host's clock, is rejected. A retry repeats the original body, so its
 * timestamp is the original event time. Atlassian retries a failed delivery for up to roughly 30
 * minutes after the first failure (and warns that delivery itself can lag by that much), so the
 * window is 90 minutes: the full retry schedule plus slack. Replay inside it is bounded by delivery
 * dedupe on `X-Atlassian-Webhook-Identifier` (identical across retries) and by the body digest.
 */
export const JIRA_MAX_AGE_MS = 90 * 60_000;
export const JIRA_MAX_FUTURE_SKEW_MS = 60_000;

const UPDATED_EVENT = 'jira:issue_updated';
/** Stands in for an unreadable event name so the service still stores the delivery as quarantined. */
const MALFORMED_EVENT = 'jira:malformed';
const EVENT_NAME = /^[A-Za-z0-9._:-]{1,64}$/u;
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,19}$/u;
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,19}-[0-9]{1,10}$/u;
const COMMENT_ID = /^[0-9]{1,20}$/u;
const PUBLISH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

function parseBody(body: Buffer): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(body.toString('utf8')));
  } catch {
    return undefined;
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const validLabel = (value: string): boolean => value.length >= 1 && value.length <= 100 && !/[\0\r\n\s]/u.test(value);

/** Plain text of an Atlassian Document Format node tree; the newer webhooks send descriptions this way. */
function adfText(node: unknown, limit: number): string {
  let out = '';
  const walk = (current: unknown, depth: number): void => {
    if (out.length >= limit || depth > 20) return;
    const item = record(current);
    if (!item) return;
    if (typeof item.text === 'string') out += item.text;
    if (Array.isArray(item.content)) for (const child of item.content) walk(child, depth + 1);
    if (item.type === 'paragraph' || item.type === 'heading' || item.type === 'hardBreak') out += '\n';
  };
  walk(node, 0);
  return out;
}

const descriptionText = (value: unknown): string =>
  boundedText(typeof value === 'string' ? value : adfText(value, AUTOMATION_LIMITS.maxUntrustedBodyChars * 2), AUTOMATION_LIMITS.maxUntrustedBodyChars);

type Changelog = { toStatus?: string; fromStatus?: string; addedLabels: string[] };

/** Reads the changelog items that matter: the status field and the (space-separated) labels field. */
function readChangelog(payload: Record<string, unknown>): Changelog | undefined {
  const items = record(payload.changelog)?.items;
  if (!Array.isArray(items)) return undefined;
  const changes: Changelog = { addedLabels: [] };
  for (const raw of items) {
    const item = record(raw);
    if (!item) return undefined;
    if (item.field === 'status') {
      const to = text(item.toString);
      if (to !== '' && to.length <= 100 && !/[\0\r\n]/u.test(to)) {
        changes.toStatus = to;
        changes.fromStatus = boundedText(text(item.fromString), 100);
      }
    } else if (item.field === 'labels') {
      const before = new Set(text(item.fromString).split(' ').filter(Boolean));
      for (const name of text(item.toString).split(' ')) {
        if (name !== '' && !before.has(name) && validLabel(name) && !changes.addedLabels.includes(name)) changes.addedLabels.push(name);
      }
    }
  }
  return changes;
}

/**
 * Several labels can be added in one update, and one update can also move the status. The event
 * keeps all of it: `label` is the first label added, `extras.addedLabels` lists every added label
 * (in changelog order, as many as fit), and a status change makes it a `status_changed` event that
 * still carries the labels. `matches` looks at the added labels and the status separately, so a
 * rule for any of them fires.
 */
function normalizeUpdate(payload: Record<string, unknown>, baseUrl: string | undefined): AutomationNormalization {
  // Jira sends an update without a changelog when a comment is added or edited (including this
  // harness's own comments); that is not a field change, so it is ignored rather than quarantined.
  if (payload.changelog === undefined || payload.changelog === null) return { kind: 'ignored', reason: 'no_relevant_change' };
  const issue = record(payload.issue);
  const fields = record(issue?.fields);
  const key = issue?.key;
  const projectKey = record(fields?.project)?.key;
  if (typeof key !== 'string' || !ISSUE_KEY.test(key)) return { kind: 'quarantined', reason: 'invalid_issue_key' };
  if (typeof projectKey !== 'string' || !PROJECT_KEY.test(projectKey) || !key.toLowerCase().startsWith(`${projectKey.toLowerCase()}-`)) {
    return { kind: 'quarantined', reason: 'invalid_project' };
  }
  const user = record(payload.user);
  const accountId = text(user?.accountId);
  const login = boundedText(text(user?.displayName) || accountId, 250).replace(/\s+/gu, ' ').trim();
  if (!user || login === '') return { kind: 'quarantined', reason: 'invalid_actor' };
  const parsedBase = AutomationJiraBaseUrlSchema.safeParse(baseUrl);
  if (!parsedBase.success) return { kind: 'quarantined', reason: 'invalid_base_url' };
  const changes = readChangelog(payload);
  if (!changes) return { kind: 'quarantined', reason: 'invalid_changelog' };
  if (changes.toStatus === undefined && changes.addedLabels.length === 0) return { kind: 'ignored', reason: 'no_relevant_change' };

  const added = packAddedLabels(changes.addedLabels, ' ');
  const event: NormalizedAutomationEvent = {
    provider: 'jira',
    eventType: changes.toStatus === undefined ? 'jira.issue.label_added' : 'jira.issue.status_changed',
    scope: projectKey,
    resourceKey: `jira:${key.toLowerCase()}`,
    resourceRef: key,
    resourceUrl: `${parsedBase.data}/browse/${key}`,
    ...(added.labels[0] === undefined ? {} : { label: added.labels[0] }),
    ...(changes.toStatus === undefined ? {} : { fromState: changes.fromStatus ?? '', toState: changes.toStatus }),
    actor: {
      login,
      ...(accountId === '' ? {} : { id: boundedText(accountId, 200) }),
      isBot: user.accountType === 'app',
      ...(typeof user.accountType === 'string' && /^[A-Za-z]{1,40}$/u.test(user.accountType) ? { type: user.accountType } : {})
    },
    title: boundedText(fields?.summary, AUTOMATION_LIMITS.maxUntrustedTitleChars),
    body: descriptionText(fields?.description),
    ...(added.extras === undefined ? {} : { extras: added.extras })
  };
  return { kind: 'event', event };
}

function matchJiraRule(match: Parameters<ProviderAdapter['matches']>[0], event: NormalizedAutomationEvent, selfLogin: string | undefined): AutomationMatchVerdict {
  if (match.provider !== 'jira' || event.provider !== 'jira') return { matched: false, reason: 'provider_mismatch' };
  if (match.projectKey.toLowerCase() !== event.scope.toLowerCase()) return { matched: false, reason: 'project_mismatch' };
  if (match.trigger === 'label_added') {
    const wanted = match.label?.toLowerCase();
    if (!eventAddedLabels(event, ' ').some((name) => name.toLowerCase() === wanted)) return { matched: false, reason: 'label_mismatch' };
  } else {
    if (event.eventType !== 'jira.issue.status_changed') return { matched: false, reason: 'status_not_changed' };
    if (match.toStatus !== undefined && match.toStatus.toLowerCase() !== (event.toState ?? '').toLowerCase()) return { matched: false, reason: 'status_mismatch' };
  }
  // Only the account id identifies a Jira user; the display name is editable by its owner.
  return rejectActor(match, event.actor, selfLogin, [event.actor.id]) ?? { matched: true, reason: 'matched' };
}

/** Resolves a host to its addresses; injectable so tests never touch DNS. */
export type JiraHostLookup = NonNullable<NonNullable<Parameters<typeof createProviderHttpClient>[0]>['lookup']>;

const failure = (code: string, retryable: boolean): AutomationPublishResult => ({ ok: false, code, retryable });

/** Auth failures, missing issues and other client errors will not change on retry; throttling and server errors may. */
const statusFailure = (status: number): AutomationPublishResult =>
  failure(`JIRA_HTTP_${status}`, status === 408 || status === 425 || status === 429 || status >= 500);

/** Atlassian Document Format body: one paragraph per non-empty line of the rendered Markdown. */
function commentDocument(markdown: string): { type: 'doc'; version: 1; content: unknown[] } {
  const lines = markdown.split('\n').filter((line) => line.trim() !== '');
  return {
    type: 'doc',
    version: 1,
    content: (lines.length > 0 ? lines : [' ']).map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }))
  };
}

function createPublisher(http: ProviderHttpClient) {
  return async function publishJiraComment(request: AutomationPublishRequest): Promise<AutomationPublishResult> {
    const { email, apiToken } = request.outbound ?? {};
    if (!email || !apiToken) return failure('OUTBOUND_NOT_CONFIGURED', false);
    const base = AutomationJiraBaseUrlSchema.safeParse(request.config.baseUrl);
    const key = request.workflow.resourceRef;
    if (!base.success || !ISSUE_KEY.test(key)) return failure('INVALID_TARGET', false);

    const existing = request.publishRef?.commentId;
    const commentId = typeof existing === 'string' || typeof existing === 'number' ? String(existing) : undefined;
    if (commentId !== undefined && !COMMENT_ID.test(commentId)) return failure('INVALID_TARGET', false);
    const url = `${base.data}/rest/api/3/issue/${encodeURIComponent(key)}/comment${commentId === undefined ? '' : `/${commentId}`}`;
    // The provider client resolves the site once, refuses private and reserved addresses, and pins
    // the socket to the address it checked, so a rebind cannot redirect the credential. It never
    // follows redirects, so a 3xx is just a non-retryable status.
    let response: ProviderHttpResponse;
    try {
      response = await http.request({
        url,
        method: commentId === undefined ? 'POST' : 'PUT',
        headers: { authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}` },
        body: JSON.stringify({ body: commentDocument(request.body) }),
        timeoutMs: PUBLISH_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES
      });
    } catch (error) {
      return error instanceof ProviderHttpError && error.kind === 'forbidden_host' ? failure('JIRA_ADDRESS_FORBIDDEN', false) : failure('JIRA_NETWORK', true);
    }
    if (response.status < 200 || response.status > 299) return statusFailure(response.status);
    if (commentId !== undefined) return { ok: true, publishRef: { commentId } };
    try {
      const created = record(JSON.parse(response.body))?.id;
      const id = typeof created === 'number' ? String(created) : created;
      return typeof id === 'string' && COMMENT_ID.test(id) ? { ok: true, publishRef: { commentId: id } } : failure('JIRA_BAD_RESPONSE', false);
    } catch {
      return failure('JIRA_BAD_RESPONSE', false);
    }
  };
}

export function createJiraAdapter(options: { lookup?: JiraHostLookup } = {}): ProviderAdapter {
  const http = createProviderHttpClient(options.lookup ? { lookup: options.lookup } : {});
  return {
    provider: 'jira',
    displayName: 'Jira',
    verify: ({ secret, body, headers, now }) => {
      const signature = headers['x-hub-signature'] ?? '';
      if (!verifyGitHubSignature(secret, body, signature)) return { ok: false, reason: 'bad_signature' };
      const timestamp = parseBody(body)?.timestamp;
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return { ok: false, reason: 'missing_timestamp' };
      if (now - timestamp > JIRA_MAX_AGE_MS) return { ok: false, reason: 'stale_timestamp' };
      if (timestamp - now > JIRA_MAX_FUTURE_SKEW_MS) return { ok: false, reason: 'future_timestamp' };
      return { ok: true };
    },
    eventName: (_headers, body) => {
      const name = parseBody(body)?.webhookEvent;
      return typeof name === 'string' && EVENT_NAME.test(name) ? name : MALFORMED_EVENT;
    },
    // Jira repeats the identifier on every retry of one delivery; without it the exact bytes identify it.
    deliveryId: (headers, body) => headers['x-atlassian-webhook-identifier'] ?? `body-${createHash('sha256').update(body).digest('hex').slice(0, 40)}`,
    normalize: (providerEvent, body, connection) => {
      if (providerEvent === MALFORMED_EVENT) return { kind: 'quarantined', reason: 'malformed_payload' };
      if (providerEvent !== UPDATED_EVENT) return { kind: 'ignored', reason: 'unsupported_event' };
      const payload = parseBody(body);
      return payload ? normalizeUpdate(payload, connection.config.baseUrl) : { kind: 'quarantined', reason: 'malformed_payload' };
    },
    matches: (match, event, context) => matchJiraRule(match, event, context.selfLogin),
    publish: createPublisher(http)
  };
}

export const jiraAdapter: ProviderAdapter = createJiraAdapter();
