import type { BudgetReservation, GatewayProfile, LeaseAccounting, LeaseGrant, TokenPrices, Usage } from './types.js';
import { normalizeProviderUsage, type NormalizedUsage } from './usage-normalizer.js';

export interface BudgetHooks {
  reserve(reservation: BudgetReservation): void | Promise<void>;
  reconcile(reservation: BudgetReservation, actual: Usage): void | Promise<void>;
}

export const noOpBudgetHooks: BudgetHooks = {
  reserve: () => undefined,
  reconcile: () => undefined
};

/**
 * Tokens reserved for each image, file, audio, or video content part on top of its
 * bytes. A small (even data-URL) image can cost providers more tokens than it
 * has bytes, so bytes alone cannot bound it.
 */
export const MEDIA_PART_RESERVE_TOKENS = 8_192;

const MEDIA_PART_TYPES: ReadonlySet<string> = new Set([
  'image', 'image_url', 'input_image', 'audio', 'input_audio', 'video', 'video_url', 'input_video', 'file', 'input_file'
]);
/**
 * Media fields that hold a URL. Only a `data:` URL is inline; any other URL is
 * content the provider would fetch for the agent.
 */
const MEDIA_URL_KEYS: ReadonlySet<string> = new Set(['url', 'image_url', 'video_url', 'audio_url', 'file_url']);
/** Media fields that hold inline content: a `data:` URL or bare base64, never a URL with another scheme. */
const MEDIA_DATA_KEYS: ReadonlySet<string> = new Set(['data', 'file_data']);
/** Media fields that name content stored with the provider instead of carrying it. */
const MEDIA_REFERENCE_KEYS: ReadonlySet<string> = new Set(['file_id']);
const DATA_URL = /^data:/i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Responses fields that pull stored server-side context into the prompt. The
 * gateway cannot see or bound that context, so it refuses them.
 */
const STATEFUL_RESPONSES_FIELDS = ['previous_response_id', 'conversation'] as const;
/**
 * Request fields that make the provider fetch web content. That adds unbounded
 * context and lets an agent in a network-none workspace reach the network
 * through the provider, so they are refused on every path (OpenRouter accepts
 * plugins on its Responses endpoint too).
 */
const PROVIDER_SIDE_FIELDS = ['plugins', 'web_search_options'] as const;
/**
 * Tool types the caller executes itself. Every other type is refused: hosted
 * tools the provider runs (web search, file search, code interpreter, remote
 * MCP, computer use, image generation) reach the network or stored data on the
 * agent's behalf and bill context the gateway cannot bound, and other built-in
 * types (local shell, apply patch) are outside the contract the gateway checks.
 */
const CALLER_TOOL_TYPES: ReadonlySet<string> = new Set(['function', 'custom']);

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Adds without leaving the safe-integer range; cost and settlement figures saturate instead. */
export function saturatingAdd(...values: number[]): number {
  return Math.min(values.reduce((total, value) => total + value, 0), MAX_SAFE);
}

/** A request the caller must fix; its message is safe to return to the caller verbatim. */
export class ModelRequestError extends Error {}

function costMicros(tokens: number, pricePerMillion: number): number {
  const micros = (BigInt(tokens) * BigInt(pricePerMillion) + 999_999n) / 1_000_000n;
  return micros > BigInt(MAX_SAFE) ? MAX_SAFE : Number(micros);
}

/** Prices for a prompt of `promptTokens`: the highest tier whose threshold it reaches, else the base prices. */
export function pricesForPrompt(profile: GatewayProfile, promptTokens: number): TokenPrices {
  let prices: TokenPrices = {
    inputMicrosPerMillionTokens: profile.inputMicrosPerMillionTokens,
    outputMicrosPerMillionTokens: profile.outputMicrosPerMillionTokens,
    cacheReadMicrosPerMillionTokens: profile.cacheReadMicrosPerMillionTokens ?? profile.inputMicrosPerMillionTokens,
    cacheWriteMicrosPerMillionTokens: profile.cacheWriteMicrosPerMillionTokens ?? profile.inputMicrosPerMillionTokens
  };
  for (const tier of profile.tiers ?? []) {
    if (tier.minPromptTokens > promptTokens) break;
    prices = tier;
  }
  return prices;
}

/** Prices normalised usage, charging the most expensive prompt interpretation and never less than the provider's own cost. */
export function costUsage(normalized: NormalizedUsage, profile: GatewayProfile): Usage {
  const priced = normalized.prompt.map((prompt): Usage => {
    const prices = pricesForPrompt(profile, prompt.promptTokens);
    return {
      inputTokens: prompt.promptTokens,
      cacheReadTokens: prompt.cacheReadTokens,
      cacheWriteTokens: prompt.cacheWriteTokens,
      outputTokens: normalized.outputTokens,
      reasoningTokens: normalized.reasoningTokens,
      costMicros: saturatingAdd(
        costMicros(prompt.uncachedInputTokens, prices.inputMicrosPerMillionTokens),
        costMicros(prompt.cacheReadTokens, prices.cacheReadMicrosPerMillionTokens),
        costMicros(prompt.cacheWriteTokens, prices.cacheWriteMicrosPerMillionTokens),
        costMicros(normalized.outputTokens, prices.outputMicrosPerMillionTokens)
      )
    };
  });
  const charged = priced.reduce((best, candidate) => candidate.costMicros > best.costMicros ? candidate : best);
  return { ...charged, costMicros: Math.max(charged.costMicros, normalized.providerCostMicros ?? 0) };
}

export function usageFromProvider(value: unknown, profile: GatewayProfile): Usage | undefined {
  const normalized = normalizeProviderUsage(value);
  return normalized === undefined ? undefined : costUsage(normalized, profile);
}

/**
 * OpenAI reasoning models reject `max_tokens` on Chat Completions, while every
 * OpenAI chat model accepts `max_completion_tokens`; other OpenAI-compatible
 * providers keep the widely supported `max_tokens`. A profile counts as OpenAI
 * by its credential provider or by its upstream host.
 */
function outputTokenField(profile: GatewayProfile): string {
  if (profile.downstreamPath === '/v1/responses') return 'max_output_tokens';
  const openai = profile.provider.toLowerCase() === 'openai' || profile.upstream.hostname.toLowerCase() === 'api.openai.com';
  return openai ? 'max_completion_tokens' : 'max_tokens';
}

function requestedOutputTokens(body: Record<string, unknown>, profile: GatewayProfile): number {
  const fields = profile.downstreamPath === '/v1/responses'
    ? ['max_output_tokens']
    : ['max_tokens', 'max_completion_tokens'];
  const requested: number[] = [];
  for (const field of fields) {
    const value = body[field];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} must be a positive integer`);
    requested.push(value as number);
  }
  return requested.length === 0 ? profile.limits.maxOutputTokens : Math.min(...requested);
}

function refuse(message: string): never {
  throw new ModelRequestError(message);
}

/**
 * Refuses request fields whose context or side effects the gateway cannot
 * bound: stored server-side state, provider-side web access, and hosted tools.
 */
function assertBoundedRequest(body: Record<string, unknown>, profile: GatewayProfile): void {
  const present = (field: string) => body[field] !== undefined && body[field] !== null;
  for (const field of PROVIDER_SIDE_FIELDS) {
    if (present(field)) refuse(`${field} is not supported: the gateway does not allow provider-side web access`);
  }
  const responses = profile.downstreamPath === '/v1/responses';
  for (const field of responses ? STATEFUL_RESPONSES_FIELDS : []) {
    if (present(field)) refuse(`${field} is not supported: the gateway cannot bound stored server-side context; resend the full input`);
  }
  if (responses && body.prompt !== null && typeof body.prompt === 'object') {
    refuse('an object-valued prompt is not supported: the gateway cannot bound a stored prompt template; send the input inline');
  }
  if (body.tools === undefined || body.tools === null) return;
  if (!Array.isArray(body.tools)) refuse('tools must be an array');
  for (const tool of body.tools as unknown[]) {
    const type = tool !== null && typeof tool === 'object' ? (tool as Record<string, unknown>).type : undefined;
    if (typeof type !== 'string') refuse('every tools entry needs a type');
    if (!CALLER_TOOL_TYPES.has(type)) {
      refuse(`tool type ${JSON.stringify(type).slice(0, 80)} is not supported through the model gateway: use function or custom tools`);
    }
  }
}

/**
 * A media part must carry its content inline, as a `data:` URL or base64. A
 * remote URL or a provider file id makes the provider fetch content for the
 * agent, which is network access the workspace may not have and context the
 * gateway cannot bound.
 */
function assertInlineMedia(part: Record<string, unknown>, type: string): void {
  const pending: object[] = [part];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined || value === null) continue;
      if (MEDIA_REFERENCE_KEYS.has(key)) refuse(`${type} parts with ${key} are not supported: send the media inline as a data: URL or base64`);
      if (typeof value === 'string') {
        const remote = MEDIA_URL_KEYS.has(key)
          ? !DATA_URL.test(value)
          : MEDIA_DATA_KEYS.has(key) && URL_SCHEME.test(value) && !DATA_URL.test(value);
        if (remote) refuse(`${type} parts with a non-data URL in ${key} are not supported: send the media inline as a data: URL or base64`);
      } else if (typeof value === 'object') {
        pending.push(value);
      }
    }
  }
}

/** Counts image, file, audio, and video content parts anywhere in the request body. */
function mediaPartCount(body: Record<string, unknown>): number {
  let parts = 0;
  const pending: object[] = [body];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (!Array.isArray(next)) {
      const node = next as Record<string, unknown>;
      if (typeof node.type === 'string' && MEDIA_PART_TYPES.has(node.type)) {
        assertInlineMedia(node, node.type);
        parts += 1;
      }
    }
    for (const child of Object.values(next)) if (child !== null && typeof child === 'object') pending.push(child as object);
  }
  return parts;
}

/**
 * Reserves the worst case for one request before it is sent upstream.
 *
 * Input is estimated at one token per request-body byte. That never
 * under-reserves text: byte-level BPE tokens cover at least one UTF-8 byte
 * each, and the chat-template tokens a provider adds per message are fewer than
 * the JSON framing bytes (braces, quotes, keys) that message costs in the body.
 * Media is the exception, so each media part adds MEDIA_PART_RESERVE_TOKENS.
 *
 * Reserved input is priced at the highest of the input, cache-read and
 * cache-write prices of the tier the estimate falls in. The estimate is never
 * below the real prompt and tier prices never fall, so that tier is never
 * cheaper than the one the provider bills.
 */
export function reserveBudget(
  body: Record<string, unknown>,
  bodyBytes: number,
  lease: LeaseGrant,
  profile: GatewayProfile
): BudgetReservation {
  assertBoundedRequest(body, profile);
  const estimatedInputTokens = Math.max(1, bodyBytes) + mediaPartCount(body) * MEDIA_PART_RESERVE_TOKENS;
  const inputTokens = Math.min(estimatedInputTokens, lease.remainingInputTokens, profile.limits.maxInputTokens);
  if (estimatedInputTokens > inputTokens) throw new Error('input token budget exceeded');
  const prices = pricesForPrompt(profile, estimatedInputTokens);
  const inputPrice = Math.max(prices.inputMicrosPerMillionTokens, prices.cacheReadMicrosPerMillionTokens, prices.cacheWriteMicrosPerMillionTokens);
  const inputCost = costMicros(inputTokens, inputPrice);
  if (inputCost > lease.remainingCostMicros) throw new Error('input cost budget exceeded');
  const requested = Math.min(requestedOutputTokens(body, profile), lease.remainingOutputTokens, profile.limits.maxOutputTokens);
  let affordableOutput = requested;
  if (prices.outputMicrosPerMillionTokens !== 0) {
    const affordable = BigInt(lease.remainingCostMicros - inputCost) * 1_000_000n / BigInt(prices.outputMicrosPerMillionTokens);
    affordableOutput = Number(affordable > BigInt(requested) ? BigInt(requested) : affordable);
  }
  const outputTokens = Math.min(requested, affordableOutput);
  if (outputTokens < 1) throw new Error('output cost budget exhausted');
  // The reserved cap is the only output limit sent upstream on every path.
  delete body.max_tokens;
  delete body.max_completion_tokens;
  body[outputTokenField(profile)] = outputTokens;
  if (profile.downstreamPath === '/v1/chat/completions') {
    body.stream_options = { include_usage: true };
  }
  body.model = profile.model;
  body.stream = true;
  const reservation: BudgetReservation = {
    lease,
    inputTokens,
    outputTokens,
    costMicros: saturatingAdd(inputCost, costMicros(outputTokens, prices.outputMicrosPerMillionTokens))
  };
  lease.remainingInputTokens -= reservation.inputTokens;
  lease.remainingOutputTokens -= reservation.outputTokens;
  lease.remainingCostMicros -= reservation.costMicros;
  lease.accounting.requests += 1;
  return reservation;
}

function reservationAsUsage(reservation: BudgetReservation): Usage {
  return {
    inputTokens: reservation.inputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: reservation.outputTokens,
    reasoningTokens: 0,
    costMicros: reservation.costMicros
  };
}

type RemainingField = 'remainingInputTokens' | 'remainingOutputTokens' | 'remainingCostMicros';

/**
 * Settles one budget component: refunds at most what was reserved, and takes
 * any overrun from the remaining budget, floored at 0. Returns the overrun the
 * remaining budget could not absorb.
 */
function settleComponent(lease: LeaseGrant, field: RemainingField, reserved: number, charged: number, refund: boolean): number {
  if (charged <= reserved) {
    if (refund) lease[field] += reserved - charged;
    return 0;
  }
  const overrun = charged - reserved;
  const absorbed = Math.min(overrun, lease[field]);
  lease[field] -= absorbed;
  return overrun - absorbed;
}

function recordUsage(accounting: LeaseAccounting, usage: Usage, reported: boolean): void {
  accounting.promptTokens = saturatingAdd(accounting.promptTokens, usage.inputTokens);
  accounting.cacheReadTokens = saturatingAdd(accounting.cacheReadTokens, usage.cacheReadTokens);
  accounting.cacheWriteTokens = saturatingAdd(accounting.cacheWriteTokens, usage.cacheWriteTokens);
  accounting.outputTokens = saturatingAdd(accounting.outputTokens, usage.outputTokens);
  accounting.reasoningTokens = saturatingAdd(accounting.reasoningTokens, usage.reasoningTokens);
  if (!reported) accounting.requestsWithoutUsage += 1;
}

export interface ReconcileResult {
  /** What the request is charged: the provider usage, or the reservation when usage is missing. */
  charged: Usage;
  /** Cost charged beyond the reservation; non-zero means the provider billed more than was reserved. */
  overrunCostMicros: number;
}

function charge(reservation: BudgetReservation, charged: Usage, refund: boolean, reported: boolean): ReconcileResult {
  const { lease } = reservation;
  settleComponent(lease, 'remainingInputTokens', reservation.inputTokens, charged.inputTokens, refund);
  settleComponent(lease, 'remainingOutputTokens', reservation.outputTokens, charged.outputTokens, refund);
  const unabsorbed = settleComponent(lease, 'remainingCostMicros', reservation.costMicros, charged.costMicros, refund);
  const overrunCostMicros = Math.max(0, charged.costMicros - reservation.costMicros);
  lease.accounting.overrunCostMicros = saturatingAdd(lease.accounting.overrunCostMicros, overrunCostMicros);
  lease.accounting.unabsorbedOverrunCostMicros = saturatingAdd(lease.accounting.unabsorbedOverrunCostMicros, unabsorbed);
  recordUsage(lease.accounting, charged, reported);
  return { charged, overrunCostMicros };
}

/** Settles a completed request: refunds unused reservation and records any overrun. */
export function reconcileBudget(reservation: BudgetReservation, actual: Usage | undefined): ReconcileResult {
  return charge(reservation, actual ?? reservationAsUsage(reservation), true, actual !== undefined);
}

/**
 * Settles a failed or cancelled request. The reservation is kept in full,
 * because the provider may have billed work the gateway never saw; usage the
 * provider did report can only add an overrun.
 */
export function settleFailedRequest(reservation: BudgetReservation, actual: Usage | undefined): ReconcileResult {
  const reserved = reservationAsUsage(reservation);
  const charged = actual === undefined ? reserved : {
    ...actual,
    inputTokens: Math.max(actual.inputTokens, reserved.inputTokens),
    outputTokens: Math.max(actual.outputTokens, reserved.outputTokens),
    costMicros: Math.max(actual.costMicros, reserved.costMicros)
  };
  return charge(reservation, charged, false, actual !== undefined);
}
