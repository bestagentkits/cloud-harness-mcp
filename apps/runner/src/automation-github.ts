import { createHmac, timingSafeEqual } from 'node:crypto';
import { AUTOMATION_LIMITS, type AutomationRuleMatch } from '@cloud-harness/contracts';
import {
  boundedText,
  isRetryableResult,
  record,
  rejectActor,
  type AutomationMatchVerdict,
  type AutomationNormalization,
  type AutomationPublishRequest,
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
      body: boundedText(resource.body, AUTOMATION_LIMITS.maxUntrustedBodyChars)
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

/**
 * Posts the agent's answer as one comment through the brokered `issue_comment` action, which runs
 * with the workspace's GitHub App installation. Nothing is posted when the agent starts.
 */
async function publishGitHubComment(request: AutomationPublishRequest): Promise<AutomationPublishResult> {
  if (request.phase !== 'completed') return { ok: true };
  const { workspaceId, resourceNumber } = request.workflow;
  if (!workspaceId || resourceNumber === null) return { ok: false, code: 'WORKSPACE_LOST', retryable: false };
  const posted = await request.call('github_action', {
    workspaceId,
    action: 'issue_comment',
    issueNumber: resourceNumber,
    body: request.body,
    idempotencyKey: request.idempotencyKey
  });
  return posted.ok ? { ok: true } : { ok: false, code: posted.error?.code ?? 'UNKNOWN', retryable: isRetryableResult(posted) };
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
  publish: publishGitHubComment
};
