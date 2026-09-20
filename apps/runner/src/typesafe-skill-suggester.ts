import { createHash } from 'node:crypto';
import { SecretSnapshotRedactor } from './output-redactor.js';
import {
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
  CALL_TIMEOUT_MS,
  FITS_THRESHOLD,
  GATE_QUESTIONS,
  GATE_THRESHOLD,
  MAX_EGRESS_BYTES,
  MAX_EGRESS_CEILING,
  RATE_LIMIT_PER_MINUTE,
  SHORTLIST,
  TOTAL_BUDGET_MS,
  TYPESAFE_ALLOWED_HOSTS,
  TYPESAFE_DEFAULT_ENDPOINT,
  TYPESAFE_DEFAULT_MODEL,
  gateValue,
  shortCircuitReason,
  type ShortCircuitReason
} from './typesafe-questions.js';

/**
 * Secret shapes that are recognisable without knowing the value. A snapshot redactor removes the
 * values this process holds; these patterns catch a credential that arrived from somewhere else, such
 * as a key a user pasted into the prompt.
 */
const PATTERN_REDACTIONS: ReadonlyArray<{ pattern: RegExp; placeholder: string }> = [
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g, placeholder: '[REDACTED_BEARER]' },
  { pattern: /\b(?:sk|pk|ts|rk|ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}/g, placeholder: '[REDACTED_KEY]' },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, placeholder: '[REDACTED_JWT]' }
];

const TRUNCATION_MARKER = '\n[TRUNCATED]';

export type RosterEntry = {
  name: string;
  source: string;
  contentSha256: string;
  indexDescription: string;
  descriptionFull: string;
  bodyExcerpt: string;
};

/**
 * The wire shape, verified against the live endpoint rather than inferred.
 *
 * A call carries three top-level fields, `model`, `state`, and `questions`, and every question is a
 * tagged union whose `criteria` is a map. A choice's criteria map is keyed by option, and a noul's is
 * keyed by the two polar answers.
 */
export type TypesafeQuestion =
  | { type: 'choice'; question: string; criteria: Record<string, string> }
  | { type: 'noul'; question: string; criteria: Record<string, string> }
  | { type: 'score'; question: string; criteria: Record<string, string> };

export type TypesafeRequest = {
  model: string;
  state: string;
  questions: Record<string, TypesafeQuestion>;
};

export type TypesafeUsage = { inputTokens: number; outputTokens: number };

export type RedactionOutcome = {
  text: string;
  count: number;
  truncated: boolean;
};

/**
 * Redaction fails closed. It returns a result rather than throwing so the caller cannot accidentally
 * catch a redaction failure and carry on with an unredacted prompt: an unexpected shape produces
 * `ok: false`, and the engine turns that into `redaction_failed` with zero outbound calls.
 */
export function redactPrompt(input: {
  prompt: string;
  /** Either the snapshot or a thunk for it, so a failing snapshot read fails closed inside this call. */
  secrets?: Record<string, string> | (() => Record<string, string>) | undefined;
  maxBytes?: number | undefined;
}): { ok: true; outcome: RedactionOutcome } | { ok: false } {
  try {
    const limit = Math.min(input.maxBytes ?? MAX_EGRESS_BYTES, MAX_EGRESS_CEILING);
    const secrets = typeof input.secrets === 'function' ? input.secrets() : (input.secrets ?? {});
    const redactor = new SecretSnapshotRedactor(secrets);
    const snapshot = redactor.sanitizeString(input.prompt);
    if (typeof snapshot !== 'string') return { ok: false };

    // The snapshot redactor replaces values without reporting how many it replaced, and the count is
    // part of the audit record, so it is measured from the input before egress.
    let count = 0;
    for (const value of Object.values(secrets)) {
      if (typeof value === 'string' && value.length > 0 && input.prompt.includes(value)) {
        count += input.prompt.split(value).length - 1;
      }
    }

    let text = snapshot;
    for (const rule of PATTERN_REDACTIONS) {
      text = text.replace(rule.pattern, () => {
        count += 1;
        return rule.placeholder;
      });
    }

    const encoded = Buffer.from(text, 'utf8');
    let truncated = false;
    if (encoded.byteLength > limit) {
      const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
      text = `${encoded.subarray(0, Math.max(0, limit - markerBytes)).toString('utf8')}${TRUNCATION_MARKER}`;
      truncated = true;
    }
    return { ok: true, outcome: { text, count, truncated } };
  } catch {
    return { ok: false };
  }
}

export type SuggestionReason =
  | ShortCircuitReason
  | 'not_configured'
  | 'redaction_failed'
  | 'invalid_endpoint'
  | 'invalid_choice'
  | 'below_gate'
  | 'below_fit'
  | 'unexpected_response'
  | 'unauthorized'
  | 'unprocessable'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'timeout'
  | 'connection_error'
  | 'budget_exceeded';

export type SuggestionOutcome = {
  suggested: { name: string; gate: number; fit: number; confidence: number } | null;
  reason?: SuggestionReason;
  cached: boolean;
  latencyMs: number;
  outboundCalls: number;
  redactionCount: number;
  inputTokens: number;
  outputTokens: number;
  truncated: boolean;
};

type CacheEntry = { expiresAt: number; outcome: SuggestionOutcome };

type ParsedAnswer = {
  /** The chosen option of the `skill` question, when the model returned a string. */
  choice: string | undefined;
  /** Noul probabilities keyed by question name. */
  nouls: Record<string, number>;
  usage: TypesafeUsage;
};

/**
 * The response is a map of answers keyed by the question names this engine chose, plus usage. An
 * unexpected shape is reported rather than guessed at, because a guess here becomes a suggestion.
 */
export function parseAnswer(json: unknown): ParsedAnswer | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const answers = (json as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') return undefined;

  let choice: string | undefined;
  const nouls: Record<string, number> = {};
  for (const [name, value] of Object.entries(answers as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const answer = value as { type?: unknown; choice?: unknown; noul?: unknown };
    if (answer.type === 'choice' && typeof answer.choice === 'string') choice = answer.choice;
    if (answer.type === 'noul' && typeof answer.noul === 'number') nouls[name] = answer.noul;
  }

  const usage = (json as { usage?: unknown }).usage;
  const inputTokens = usage && typeof usage === 'object' && typeof (usage as { input_tokens?: unknown }).input_tokens === 'number'
    ? (usage as { input_tokens: number }).input_tokens : 0;
  const outputTokens = usage && typeof usage === 'object' && typeof (usage as { output_tokens?: unknown }).output_tokens === 'number'
    ? (usage as { output_tokens: number }).output_tokens : 0;

  return { choice, nouls, usage: { inputTokens, outputTokens } };
}

/**
 * The TypeSafe skill suggester.
 *
 * The suggestion path fails open: every upstream failure, timeout, and unexpected response degrades to
 * "no suggestion" so a third party's outage cannot break an operator's turn. Redaction is the opposite
 * and fails closed, because sending an unredacted prompt is the one outcome that must not happen while
 * degrading.
 */
export class TypesafeSkillSuggester {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly callTimestamps: number[] = [];

  constructor(private readonly config: {
    apiKey: () => string | undefined;
    secrets?: () => Record<string, string>;
    enabled?: () => boolean;
    endpoint?: string;
    model?: string;
    maxEgressBytes?: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
  }) {}

  private endpoint(): string | undefined {
    const endpoint = this.config.endpoint ?? TYPESAFE_DEFAULT_ENDPOINT;
    try {
      const url = new URL(endpoint);
      if (url.protocol !== 'https:') return undefined;
      if (!TYPESAFE_ALLOWED_HOSTS.includes(url.host as typeof TYPESAFE_ALLOWED_HOSTS[number])) return undefined;
      return url.toString();
    } catch {
      return undefined;
    }
  }

  private permitCall(now: number): boolean {
    const recent = this.callTimestamps.filter((stamp) => now - stamp < 60_000);
    this.callTimestamps.length = 0;
    this.callTimestamps.push(...recent);
    if (recent.length >= RATE_LIMIT_PER_MINUTE) return false;
    this.callTimestamps.push(now);
    return true;
  }

  private readCache(key: string, now: number): SuggestionOutcome | undefined {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= now) {
      this.cache.delete(key);
      return undefined;
    }
    // Refresh the recency order so the least recently used entry is evicted first.
    this.cache.delete(key);
    this.cache.set(key, hit);
    return { ...hit.outcome, cached: true };
  }

  private writeCache(key: string, outcome: SuggestionOutcome, now: number): void {
    this.cache.set(key, { expiresAt: now + CACHE_TTL_MS, outcome: { ...outcome, cached: false } });
    while (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async post(body: TypesafeRequest, signal: AbortSignal): Promise<{ ok: true; json: unknown } | { ok: false; status?: number; failure: 'timeout' | 'connection_error' }> {
    const endpoint = this.endpoint();
    const apiKey = this.config.apiKey();
    if (!endpoint || !apiKey) return { ok: false, failure: 'connection_error' };
    try {
      const response = await (this.config.fetchImpl ?? fetch)(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal
      });
      if (!response.ok) return { ok: false, status: response.status, failure: 'connection_error' };
      return { ok: true, json: await response.json() };
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      return { ok: false, failure: name === 'AbortError' ? 'timeout' : 'connection_error' };
    }
  }

  async suggest(input: {
    ownerId: string;
    workspaceId?: string;
    prompt: string;
    roster: RosterEntry[];
    rosterDigest: string;
  }): Promise<SuggestionOutcome> {
    const now = this.config.now ?? (() => Date.now());
    const startedAt = now();
    const base: SuggestionOutcome = {
      suggested: null, cached: false, latencyMs: 0, outboundCalls: 0, redactionCount: 0,
      inputTokens: 0, outputTokens: 0, truncated: false
    };

    const blocked = shortCircuitReason({
      enabled: this.config.enabled ? this.config.enabled() : true,
      rosterSize: input.roster.length,
      prompt: input.prompt
    });
    if (blocked) return { ...base, reason: blocked };
    if (!this.config.apiKey()) return { ...base, reason: 'not_configured' };
    if (!this.endpoint()) return { ...base, reason: 'invalid_endpoint' };

    const redaction = redactPrompt({
      prompt: input.prompt,
      secrets: this.config.secrets,
      maxBytes: this.config.maxEgressBytes
    });
    if (!redaction.ok) return { ...base, reason: 'redaction_failed' };

    const cacheKey = createHash('sha256')
      .update([input.ownerId, input.workspaceId ?? '', input.rosterDigest, redaction.outcome.text].join('\u0000'))
      .digest('hex');
    const cached = this.readCache(cacheKey, now());
    if (cached) return { ...cached, latencyMs: now() - startedAt, redactionCount: redaction.outcome.count };

    if (!this.permitCall(now())) return { ...base, reason: 'rate_limited' };

    const deadline = startedAt + TOTAL_BUDGET_MS;
    const spent = (partial: Partial<SuggestionOutcome>): SuggestionOutcome => ({
      ...base,
      redactionCount: redaction.outcome.count,
      truncated: redaction.outcome.truncated,
      latencyMs: now() - startedAt,
      ...partial
    });

    let first: ParsedAnswer | undefined;
    let outboundCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    // Call 1 ranks every roster name and asks the three gate questions in the same request.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (now() >= deadline) return spent({ reason: 'budget_exceeded', outboundCalls });
      outboundCalls += 1;
      const settled = await this.timedPost(this.rankBody(input.roster, redaction.outcome.text), deadline, now);
      if (settled.kind === 'threw') {
        const reason = settled.failure === 'timeout' ? 'timeout' : 'connection_error';
        return spent({ reason, outboundCalls });
      }
      if (settled.kind === 'http-error') {
        if (settled.status === 401) return spent({ reason: 'unauthorized', outboundCalls });
        if (settled.status === 422) return spent({ reason: 'unprocessable', outboundCalls });
        if ((settled.status === 429 || settled.status === 529) && attempt === 0) continue;
        if (settled.status === 429) return spent({ reason: 'rate_limited', outboundCalls });
        if (settled.status === 529) return spent({ reason: 'upstream_unavailable', outboundCalls });
        return spent({ reason: 'connection_error', outboundCalls });
      }
      const parsed = parseAnswer(settled.json);
      if (!parsed) return spent({ reason: 'unexpected_response', outboundCalls });
      first = parsed;
      inputTokens += parsed.usage.inputTokens;
      outputTokens += parsed.usage.outputTokens;
      break;
    }
    if (!first) return spent({ reason: 'budget_exceeded', outboundCalls, inputTokens, outputTokens });

    const gate = gateValue(first.nouls);
    if (gate < GATE_THRESHOLD) {
      const outcome = spent({ reason: 'below_gate', outboundCalls, inputTokens, outputTokens });
      this.writeCache(cacheKey, outcome, now());
      return outcome;
    }

    const shortlist = input.roster.slice(0, SHORTLIST);
    // A choice the roster does not contain is discarded and reported rather than quietly ignored: the
    // name came from the model, and using the fit ranking to paper over it would hide that the model
    // answered something outside the roster.
    if (first.choice !== undefined && !input.roster.some((entry) => entry.name === first.choice)) {
      return spent({ reason: 'invalid_choice', outboundCalls, inputTokens, outputTokens });
    }
    const ranked = first.choice !== undefined
      ? [shortlist.find((entry) => entry.name === first.choice)!, ...shortlist.filter((entry) => entry.name !== first.choice)]
      : shortlist;

    if (now() >= deadline) return spent({ reason: 'budget_exceeded', outboundCalls, inputTokens, outputTokens });
    outboundCalls += 1;
    const settled = await this.timedPost(this.rerankBody(ranked, redaction.outcome.text), deadline, now);
    if (settled.kind !== 'ok') {
      return spent({ reason: 'upstream_unavailable', outboundCalls, inputTokens, outputTokens });
    }
    const second = parseAnswer(settled.json);
    if (!second) return spent({ reason: 'unexpected_response', outboundCalls, inputTokens, outputTokens });
    inputTokens += second.usage.inputTokens;
    outputTokens += second.usage.outputTokens;

    const best = ranked
      .map((entry) => ({ name: entry.name, fit: numberOr(second.nouls[`fits::${entry.name}`], 0) }))
      .sort((a, b) => b.fit - a.fit)[0]!;
    if (best.fit < FITS_THRESHOLD) {
      return spent({ reason: 'below_fit', outboundCalls, inputTokens, outputTokens });
    }

    // The winning name is validated against the roster by exact match, so model prose cannot reach the
    // caller: an answer the roster does not contain is discarded rather than reported.
    const chosenName = best.name;
    if (!input.roster.some((entry) => entry.name === chosenName)) {
      return spent({ reason: 'invalid_choice', outboundCalls, inputTokens, outputTokens });
    }

    const outcome: SuggestionOutcome = {
      suggested: { name: chosenName, gate, fit: best.fit, confidence: Math.min(1, Math.max(0, gate * best.fit)) },
      cached: false,
      outboundCalls,
      redactionCount: redaction.outcome.count,
      truncated: redaction.outcome.truncated,
      latencyMs: now() - startedAt,
      inputTokens,
      outputTokens
    };
    this.writeCache(cacheKey, outcome, now());
    return outcome;
  }

  private async timedPost(body: TypesafeRequest, deadline: number, now: () => number):
  Promise<{ kind: 'ok'; json: unknown } | { kind: 'http-error'; status: number } | { kind: 'threw'; failure: 'timeout' | 'connection_error' }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(CALL_TIMEOUT_MS, Math.max(1, deadline - now())));
    try {
      const result = await this.post(body, controller.signal);
      if (result.ok) return { kind: 'ok', json: result.json };
      if (result.failure === 'timeout') return { kind: 'threw', failure: 'timeout' };
      return { kind: 'http-error', status: result.status ?? 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  private rankBody(roster: RosterEntry[], prompt: string): TypesafeRequest {
    const questions: Record<string, TypesafeQuestion> = {
      skill: {
        type: 'choice',
        question: 'Which skill, if any, should be used for this request?',
        criteria: Object.fromEntries(roster.map((entry) => [entry.name, entry.indexDescription]))
      }
    };
    for (const question of GATE_QUESTIONS) {
      questions[question.key] = { type: 'noul', question: question.text, criteria: { true: 'yes', false: 'no' } };
    }
    return { model: this.config.model ?? TYPESAFE_DEFAULT_MODEL, state: prompt, questions };
  }

  private rerankBody(shortlist: RosterEntry[], prompt: string): TypesafeRequest {
    const questions: Record<string, TypesafeQuestion> = {
      skill: {
        type: 'choice',
        question: 'Which of these skills fits the request best?',
        criteria: Object.fromEntries(shortlist.map((entry) => [entry.name, `${entry.descriptionFull}\n${entry.bodyExcerpt}`]))
      }
    };
    for (const entry of shortlist) {
      questions[`fits::${entry.name}`] = { type: 'noul', question: `Does the skill ${entry.name} fit this request?`, criteria: { true: 'fits', false: 'does not fit' } };
    }
    return { model: this.config.model ?? TYPESAFE_DEFAULT_MODEL, state: prompt, questions };
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
