import { createHmac, timingSafeEqual } from 'node:crypto';
import { AUTOMATION_LIMITS, type AutomationRuleMatch } from '@cloud-harness/contracts';
import {
  boundedText,
  isRetryableResult,
  record,
  rejectActor,
  type AutomationMatchVerdict,
  type AutomationNormalization,
  type AutomationOperationResult,
  type AutomationPublishRequest,
  type AutomationPublishWorkflow,
  type AutomationPublishResult,
  type NormalizedAutomationEvent,
  type ProviderAdapter
} from './automation-adapter.js';

/**
 * GitHub webhook verification and normalization. Everything a webhook carries is untrusted: the
 * signature is checked over the exact received bytes before the body is parsed, and only bounded,
 * shape-checked fields survive into storage, rule matching and the agent prompt.
 */

const SIGNATURE_PREFIX = 'sha256=';
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/u;
const SENDER_TYPES = new Set(['User', 'Bot', 'Organization']);
const EVENT_NAME = /^[a-z_]{1,64}$/u;
const HEAD_SHA = /^[0-9a-f]{40}$/u;

/** Constant-time check of `X-Hub-Signature-256` (HMAC-SHA256 of the raw body, hex). */
export function verifyGitHubSignature(secret: string, body: Buffer, signature: string): boolean {
  if (!signature.startsWith(SIGNATURE_PREFIX)) return false;
  const provided = signature.slice(SIGNATURE_PREFIX.length);
  if (!/^[a-f0-9]{64}$/u.test(provided)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(provided, 'hex'));
}

/** GitHub senders are bots by type or by the `[bot]` login suffix GitHub Apps carry. */
export const isGitHubBot = (login: string, type: string): boolean => type === 'Bot' || login.endsWith('[bot]');

/**
 * Maps a verified GitHub delivery onto one of the admitted normalized event types. Event kinds and
 * actions no rule can match are `ignored` (GitHub's `ping` included); an admitted kind whose body
 * does not have the documented shape is `quarantined`.
 */
export function normalizeGitHubEvent(providerEvent: string, body: Buffer): AutomationNormalization {
  if (providerEvent !== 'issues' && providerEvent !== 'pull_request') return { kind: 'ignored', reason: 'unsupported_event' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { kind: 'quarantined', reason: 'malformed_json' };
  }
  const payload = record(parsed);
  if (!payload) return { kind: 'quarantined', reason: 'malformed_payload' };
  if (payload.action !== 'labeled') return { kind: 'ignored', reason: 'unsupported_action' };
  const resource = record(providerEvent === 'issues' ? payload.issue : payload.pull_request);
  const repository = record(payload.repository)?.full_name;
  const label = record(payload.label)?.name;
  const sender = record(payload.sender);
  const number = resource?.number;
  const url = resource?.html_url;
  if (!resource || typeof repository !== 'string' || !REPOSITORY.test(repository)) return { kind: 'quarantined', reason: 'invalid_repository' };
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return { kind: 'quarantined', reason: 'invalid_number' };
  if (typeof url !== 'string' || !url.startsWith(`https://github.com/${repository}/`) || url.length > 300) return { kind: 'quarantined', reason: 'invalid_url' };
  if (typeof label !== 'string' || label.length < 1 || label.length > 100 || /[\0\r\n]/u.test(label)) return { kind: 'quarantined', reason: 'invalid_label' };
  const senderLogin = sender?.login;
  const senderType = sender?.type;
  if (typeof senderLogin !== 'string' || !LOGIN.test(senderLogin)) return { kind: 'quarantined', reason: 'invalid_sender' };
  if (typeof senderType !== 'string' || !SENDER_TYPES.has(senderType)) return { kind: 'quarantined', reason: 'invalid_sender' };
  // The signed payload's head commit anchors the pull request's check run. A malformed value only
  // costs the check run, so it is dropped rather than quarantining the delivery.
  const headSha = providerEvent === 'pull_request' ? record(resource.head)?.sha : undefined;
  return {
    kind: 'event',
    event: {
      provider: 'github',
      eventType: providerEvent === 'issues' ? 'github.issue.label_added' : 'github.pull_request.label_added',
      scope: repository,
      resourceKey: `${repository.toLowerCase()}#${number}`,
      resourceRef: `#${number}`,
      resourceNumber: number,
      resourceUrl: url,
      label,
      actor: { login: senderLogin, isBot: isGitHubBot(senderLogin, senderType), type: senderType },
      title: boundedText(resource.title, AUTOMATION_LIMITS.maxUntrustedTitleChars),
      body: boundedText(resource.body, AUTOMATION_LIMITS.maxUntrustedBodyChars),
      ...(typeof headSha === 'string' && HEAD_SHA.test(headSha) ? { extras: { headSha } } : {})
    }
  };
}

/** Evaluates one GitHub rule: event kind, exact repository and label, then the actor filters. */
export function matchGitHubRule(match: AutomationRuleMatch, event: NormalizedAutomationEvent, selfLogin: string | undefined): AutomationMatchVerdict {
  if (match.provider === 'linear' || match.provider === 'jira' || match.provider === 'custom' || event.provider !== 'github') {
    return { matched: false, reason: 'provider_mismatch' };
  }
  const selected = event.eventType === 'github.issue.label_added' ? 'issues' : event.eventType === 'github.pull_request.label_added' ? 'pull_request' : undefined;
  if (!selected || !match.events.includes(selected)) return { matched: false, reason: 'event_not_selected' };
  if (match.repository.toLowerCase() !== event.scope.toLowerCase()) return { matched: false, reason: 'repository_mismatch' };
  if (match.label.toLowerCase() !== (event.label ?? '').toLowerCase()) return { matched: false, reason: 'label_mismatch' };
  return rejectActor(match, event.actor, selfLogin) ?? { matched: true, reason: 'matched' };
}

/** GitHub's limit on a check run summary; the contract also bounds its UTF-8 bytes to the same number. */
export const CHECK_RUN_SUMMARY_MAX = 65_535;
const CHECK_RUN_LINE_MAX = 255;
/** `gh issue comment` prints the new comment's URL, which ends in its id. */
const COMMENT_URL_ID = /#issuecomment-([1-9][0-9]{0,18})\b/u;
/** Broker errors meaning the App installation cannot write checks; retrying cannot help. */
const CHECKS_UNAVAILABLE_CODES = new Set(['GITHUB_PERMISSION_MISSING', 'FORBIDDEN']);
/** Recorded in the publish ref once checks are unavailable, so later phases do not ask again. */
export const CHECKS_UNAVAILABLE = 'unavailable';

type CheckConclusion = 'success' | 'failure' | 'cancelled' | 'timed_out';
type Failure = { ok: false; code: string; retryable: boolean };

const failure = (result: AutomationOperationResult): Failure =>
  ({ ok: false, code: result.error?.code ?? 'UNKNOWN', retryable: isRetryableResult(result) });

const positiveId = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/** The id of a comment `issue_comment` created, from the comment URL the helper printed. */
function createdCommentId(result: AutomationOperationResult): number | undefined {
  const output = record(result.data)?.output;
  const match = typeof output === 'string' ? COMMENT_URL_ID.exec(output) : null;
  return match ? positiveId(Number(match[1])) : undefined;
}

/** The id of a check run `check_run_create` created, from the JSON the helper printed. */
function createdCheckRunId(result: AutomationOperationResult): number | undefined {
  const output = record(result.data)?.output;
  if (typeof output !== 'string') return undefined;
  try {
    return positiveId(record(JSON.parse(output))?.id);
  } catch {
    return undefined;
  }
}

/** Maps a terminal workflow onto a check run conclusion. */
export function checkRunConclusion(workflow: Pick<AutomationPublishWorkflow, 'state' | 'errorCode'>): CheckConclusion {
  if (workflow.state === 'COMPLETED') return 'success';
  if (workflow.state === 'CANCELLED' || workflow.errorCode === 'AGENT_CANCELLED') return 'cancelled';
  if (workflow.state === 'EXPIRED' || workflow.errorCode === 'AGENT_TIMED_OUT') return 'timed_out';
  return 'failure';
}

const singleLine = (value: string): string => boundedText(value.replace(/\s+/gu, ' ').trim(), CHECK_RUN_LINE_MAX - 1);

/** Strips control characters, then bounds the text to the summary limit in UTF-8 bytes (and so in characters). */
export function boundedCheckSummary(text: string): string {
  const cleaned = boundedText(text, CHECK_RUN_SUMMARY_MAX);
  if (Buffer.byteLength(cleaned) <= CHECK_RUN_SUMMARY_MAX) return cleaned;
  const room = CHECK_RUN_SUMMARY_MAX - Buffer.byteLength('…');
  let bytes = 0;
  let kept = '';
  for (const character of cleaned) {
    bytes += Buffer.byteLength(character);
    if (bytes > room) break;
    kept += character;
  }
  return `${kept}…`;
}

const CHECK_TITLES: Record<CheckConclusion, string> = {
  success: 'Agent completed',
  failure: 'Agent failed',
  cancelled: 'Agent cancelled',
  timed_out: 'Agent timed out'
};

/**
 * Creates the progress comment on `started`, or edits it on `completed`. A missing reference or a
 * comment deleted since (`NOT_FOUND`) falls back to creating one; the per-phase idempotency key keeps
 * a retried create from posting twice.
 */
async function publishProgressComment(request: AutomationPublishRequest, workspaceId: string, issueNumber: number): Promise<{ commentId?: number } | Failure> {
  const previous = positiveId(request.publishRef?.commentId);
  if (previous !== undefined) {
    if (request.phase === 'started') return { commentId: previous };
    const edited = await request.call('github_action', { workspaceId, action: 'issue_comment_update', commentId: previous, body: request.body });
    if (edited.ok) return { commentId: previous };
    if (edited.error?.code !== 'NOT_FOUND') return failure(edited);
  }
  const posted = await request.call('github_action', {
    workspaceId,
    action: 'issue_comment',
    issueNumber,
    body: request.body,
    idempotencyKey: request.idempotencyKey
  });
  if (!posted.ok) return failure(posted);
  const commentId = createdCommentId(posted);
  return commentId === undefined ? {} : { commentId };
}

/**
 * Reports a pull request workflow as one check run on the head commit of the signed webhook payload:
 * created `in_progress` on `started` and completed with the mapped conclusion on `completed`. An
 * installation without the `checks` permission is recorded once and the comment carries on alone.
 */
async function publishCheckRun(request: AutomationPublishRequest, workspaceId: string): Promise<{ checkRunId?: number; checks?: string } | Failure> {
  const { workflow, publishRef } = request;
  if (workflow.eventType !== 'github.pull_request.label_added' || publishRef?.checks === CHECKS_UNAVAILABLE) return {};
  const previous = positiveId(publishRef?.checkRunId);
  const completed = request.phase === 'completed';
  if (previous !== undefined && !completed) return { checkRunId: previous };
  const headSha = workflow.extras.headSha;
  if (previous === undefined && (typeof headSha !== 'string' || !HEAD_SHA.test(headSha))) return {};

  const conclusion = completed ? checkRunConclusion(workflow) : undefined;
  const detail = conclusion && conclusion !== 'success' && workflow.errorCode ? ` (${workflow.errorCode})` : '';
  const fields = {
    workspaceId,
    ...(conclusion ? { status: 'completed', conclusion } : { status: 'in_progress' }),
    title: singleLine(conclusion ? `${CHECK_TITLES[conclusion]}${detail}` : 'Agent running'),
    summary: boundedCheckSummary(request.body)
  };
  const result = previous !== undefined
    ? await request.call('github_action', { ...fields, action: 'check_run_update', checkRunId: previous })
    : await request.call('github_action', {
      ...fields,
      action: 'check_run_create',
      sha: headSha,
      name: singleLine(`Cloud Harness: ${workflow.ruleName}`),
      externalId: workflow.id,
      idempotencyKey: `${request.idempotencyKey}:check`
    });
  if (!result.ok) return CHECKS_UNAVAILABLE_CODES.has(result.error?.code ?? '') ? { checks: CHECKS_UNAVAILABLE } : failure(result);
  const checkRunId = previous ?? createdCheckRunId(result);
  return checkRunId === undefined ? {} : { checkRunId };
}

/**
 * Keeps one progress comment per workflow and, for pull requests, one check run, both through the
 * brokered `github_action` operation, which runs with the workspace's GitHub App installation.
 *
 * The comment decides the outcome. A check run failure never fails `started`; on `completed` only a
 * retryable one does, because every step replays safely: edits are idempotent and creates carry
 * idempotency keys. Any other check run failure leaves the comment as the only report.
 */
async function publishGitHubProgress(request: AutomationPublishRequest): Promise<AutomationPublishResult> {
  const { workspaceId, resourceNumber } = request.workflow;
  if (!workspaceId || resourceNumber === null) return { ok: false, code: 'WORKSPACE_LOST', retryable: false };
  const comment = await publishProgressComment(request, workspaceId, resourceNumber);
  const check = await publishCheckRun(request, workspaceId);
  const checkRef = 'ok' in check ? {} : check;
  if ('ok' in comment) {
    // A check run created on `started` is still kept, so completion updates it instead of adding a second one.
    return request.phase === 'started' && Object.keys(checkRef).length > 0 ? { ok: true, publishRef: { ...request.publishRef, ...checkRef } } : comment;
  }
  if ('ok' in check && check.retryable && request.phase === 'completed') return check;
  return { ok: true, publishRef: { ...request.publishRef, ...comment, ...checkRef } };
}

export const githubAdapter: ProviderAdapter = {
  provider: 'github',
  displayName: 'GitHub',
  verify: ({ secret, body, headers }) => (verifyGitHubSignature(secret, body, headers['x-hub-signature-256'] ?? '')
    ? { ok: true }
    : { ok: false, reason: 'bad_signature' }),
  eventName: (headers) => {
    const event = headers['x-github-event'];
    return event !== undefined && EVENT_NAME.test(event) ? event : undefined;
  },
  deliveryId: (headers) => headers['x-github-delivery'],
  normalize: (providerEvent, body) => normalizeGitHubEvent(providerEvent, body),
  matches: (match, event, context) => matchGitHubRule(match, event, context.selfLogin),
  publish: publishGitHubProgress
};
