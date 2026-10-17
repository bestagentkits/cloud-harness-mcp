import { createHmac, timingSafeEqual } from 'node:crypto';
import { AUTOMATION_LIMITS, type AutomationEventType } from '@cloud-harness/contracts';

/**
 * GitHub webhook verification and normalization. Everything a webhook carries is untrusted: the
 * signature is checked over the exact received bytes before the body is parsed, and only bounded,
 * shape-checked fields survive into storage, rule matching and the agent prompt.
 */

const SIGNATURE_PREFIX = 'sha256=';
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/u;
const SENDER_TYPES = new Set(['User', 'Bot', 'Organization']);

/** Constant-time check of `X-Hub-Signature-256` (HMAC-SHA256 of the raw body, hex). */
export function verifyGitHubSignature(secret: string, body: Buffer, signature: string): boolean {
  if (!signature.startsWith(SIGNATURE_PREFIX)) return false;
  const provided = signature.slice(SIGNATURE_PREFIX.length);
  if (!/^[a-f0-9]{64}$/u.test(provided)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(provided, 'hex'));
}

export type NormalizedGitHubEvent = {
  eventType: AutomationEventType;
  repository: string;
  resourceNumber: number;
  resourceUrl: string;
  label: string;
  senderLogin: string;
  senderType: 'User' | 'Bot' | 'Organization';
  title: string;
  body: string;
};

export type GitHubNormalization =
  | { kind: 'event'; event: NormalizedGitHubEvent }
  | { kind: 'ignored'; reason: string }
  | { kind: 'quarantined'; reason: string };

/** Removes control characters other than tab and newline, then bounds the text by characters. */
export function boundedText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, '');
  const characters = Array.from(cleaned);
  return characters.length <= maxChars ? cleaned : `${characters.slice(0, maxChars).join('')}…`;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * Maps a verified GitHub delivery onto one of the admitted normalized event types. Event kinds and
 * actions no rule can match are `ignored` (GitHub's `ping` included); an admitted kind whose body
 * does not have the documented shape is `quarantined`.
 */
export function normalizeGitHubEvent(providerEvent: string, body: Buffer): GitHubNormalization {
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
      eventType: providerEvent === 'issues' ? 'github.issue.label_added' : 'github.pull_request.label_added',
      repository,
      resourceNumber: number,
      resourceUrl: url,
      label,
      senderLogin,
      senderType: senderType as NormalizedGitHubEvent['senderType'],
      title: boundedText(resource.title, AUTOMATION_LIMITS.maxUntrustedTitleChars),
      body: boundedText(resource.body, AUTOMATION_LIMITS.maxUntrustedBodyChars)
    }
  };
}
