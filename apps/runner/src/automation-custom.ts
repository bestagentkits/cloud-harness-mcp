import { createHmac, timingSafeEqual } from 'node:crypto';
import { AUTOMATION_LIMITS, AutomationCustomEnvelopeSchema, type AutomationRuleMatch } from '@cloud-harness/contracts';
import {
  boundedText,
  eventAddedLabels,
  packAddedLabels,
  rejectActor,
  type AutomationMatchVerdict,
  type AutomationNormalization,
  type NormalizedAutomationEvent,
  type ProviderAdapter
} from './automation-adapter.js';

/**
 * Custom webhook verification and normalization. A sender signs every request the Stripe way:
 *
 *   X-CloudHarness-Timestamp: <unix seconds>
 *   X-CloudHarness-Delivery:  <unique id, 1-100 of A-Za-z0-9._:->
 *   X-CloudHarness-Signature: v1=<hex HMAC-SHA256 of `${timestamp}.${rawBody}` keyed by the connection secret>
 *
 * The timestamp is part of the signed text and must be within five minutes of the runner's clock, and
 * the delivery id (and the exact body) are deduplicated by the service, so a captured request cannot
 * be replayed. The body is the fixed envelope in `AutomationCustomEnvelopeSchema`; it cannot name a
 * repository, workspace, profile, tool, command or instruction.
 */

const SIGNATURE_PREFIX = 'v1=';
const TIMESTAMP = /^\d{1,12}$/u;
const EVENT_NAME = /^[A-Za-z0-9._:-]{1,64}$/u;
/** How far the signed timestamp may be from the runner's clock, in either direction. */
export const CUSTOM_TIMESTAMP_TOLERANCE_SECONDS = 300;

/**
 * Custom labels may contain spaces, so `extras.addedLabels` joins them with a tab. A label that itself
 * contains a tab cannot be told apart in that list and is never matched.
 */
const ADDED_LABELS_SEPARATOR = '\t';

/** Constant-time check of `X-CloudHarness-Signature` over `${timestamp}.${rawBody}`, within the time window. */
export function verifyCustomSignature(secret: string, body: Buffer, headers: Readonly<Record<string, string>>, nowMs: number): boolean {
  const timestamp = headers['x-cloudharness-timestamp'] ?? '';
  const signature = headers['x-cloudharness-signature'] ?? '';
  if (!TIMESTAMP.test(timestamp) || !signature.startsWith(SIGNATURE_PREFIX)) return false;
  const provided = signature.slice(SIGNATURE_PREFIX.length);
  if (!/^[a-f0-9]{64}$/u.test(provided)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > CUSTOM_TIMESTAMP_TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(provided, 'hex'));
}

function parseBody(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Maps a verified envelope onto the custom event; anything that is not exactly the envelope is quarantined. */
export function normalizeCustomEvent(body: Buffer): AutomationNormalization {
  const parsed = parseBody(body);
  if (parsed === undefined) return { kind: 'quarantined', reason: 'malformed_json' };
  const result = AutomationCustomEnvelopeSchema.safeParse(parsed);
  if (!result.success) return { kind: 'quarantined', reason: 'invalid_envelope' };
  const { event, resource, actor } = result.data;
  const added = packAddedLabels(result.data.label === undefined ? result.data.labelsAdded ?? [] : [result.data.label], ADDED_LABELS_SEPARATOR);
  const label = added.labels[0];
  const normalized: NormalizedAutomationEvent = {
    provider: 'custom',
    eventType: 'custom.event',
    scope: event,
    resourceKey: `custom:${resource.id}`,
    resourceRef: resource.id,
    resourceUrl: resource.url ?? '',
    ...(label === undefined ? {} : { label }),
    actor: { login: actor?.login ?? 'webhook', ...(actor?.id === undefined ? {} : { id: actor.id }), isBot: actor?.isBot ?? false },
    title: boundedText(resource.title, AUTOMATION_LIMITS.maxUntrustedTitleChars),
    body: boundedText(resource.body, AUTOMATION_LIMITS.maxUntrustedBodyChars),
    ...(added.extras === undefined ? {} : { extras: added.extras })
  };
  return { kind: 'event', event: normalized };
}

/** Evaluates one custom rule: exact event name, the optional label, then the self-trigger guard. */
export function matchCustomRule(match: AutomationRuleMatch, event: NormalizedAutomationEvent, selfLogin: string | undefined): AutomationMatchVerdict {
  if (match.provider !== 'custom' || event.provider !== 'custom') return { matched: false, reason: 'provider_mismatch' };
  if (match.event.toLowerCase() !== event.scope.toLowerCase()) return { matched: false, reason: 'event_mismatch' };
  const wanted = match.label?.toLowerCase();
  if (wanted !== undefined && !eventAddedLabels(event, ADDED_LABELS_SEPARATOR).some((name) => name.toLowerCase() === wanted)) return { matched: false, reason: 'label_mismatch' };
  // Custom rules carry no bot or allowlist filters; the sender is the owner's own system.
  return rejectActor({ ignoreBots: false }, event.actor, selfLogin) ?? { matched: true, reason: 'matched' };
}

export const customAdapter: ProviderAdapter = {
  provider: 'custom',
  displayName: 'Custom webhook',
  verify: ({ secret, body, headers, now }) => (verifyCustomSignature(secret, body, headers, now)
    ? { ok: true }
    : { ok: false, reason: 'bad_signature' }),
  // The envelope's own event name once it is verified; a body that is not the envelope still gets
  // stored as a quarantined delivery instead of failing the request.
  eventName: (_headers, body) => {
    const event = (parseBody(body) as { event?: unknown } | null | undefined)?.event;
    return typeof event === 'string' && EVENT_NAME.test(event) ? event : 'custom.event';
  },
  deliveryId: (headers) => headers['x-cloudharness-delivery'],
  normalize: (_providerEvent, body) => normalizeCustomEvent(body),
  matches: (match, event, context) => matchCustomRule(match, event, context.selfLogin)
};
