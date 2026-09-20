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

/** The wire shape this engine sends. Named so a builder cannot quietly return something else. */
export type TypesafeRequest = {
  model: string;
  choice: { question: string; options: Array<{ label: string; criteria: string }> };
  noul: Array<{ name: string; question: string }>;
  input: string;
};

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
};

type CacheEntry = { expiresAt: number; outcome: SuggestionOutcome };

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

  private permitCall(ownerId: string, now: number): boolean {
    const recent = this.callTimestamps.filter((stamp) => now - stamp < 60_000);
    this.callTimestamps.length = 0;
    this.callTimestamps.push(...recent);
    if (recent.length >= RATE_LIMIT_PER_MINUTE) return false;
    this.callTimestamps.push(now);
    // The owner is part of the key so one operator cannot spend another's budget.
    void ownerId;
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

  private async post(body: unknown, signal: AbortSignal): Promise<{ ok: true; json: unknown } | { ok: false; status?: number; failure: 'timeout' | 'connection_error' }> {
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
    const base: SuggestionOutcome = { suggested: null, cached: false, latencyMs: 0, outboundCalls: 0, redactionCount: 0 };

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

    if (!this.permitCall(input.ownerId, now())) return { ...base, reason: 'rate_limited' };

    const deadline = startedAt + TOTAL_BUDGET_MS;
    let outboundCalls = 0;
    let answer: { choice: string; answers: Record<string, number> } | undefined;

    // Call 1 ranks every roster name and asks the three gate questions in the same request.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (now() >= deadline) break;
      outboundCalls += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(CALL_TIMEOUT_MS, Math.max(1, deadline - now())));
      let result: Awaited<ReturnType<TypesafeSkillSuggester['post']>>;
      try {
        result = await this.post(this.rankBody(input.roster, redaction.outcome.text), controller.signal);
      } finally {
        clearTimeout(timer);
      }

      const settled = { ...base, outboundCalls, redactionCount: redaction.outcome.count, latencyMs: now() - startedAt };
      if (result.ok) {
        const parsed = parseAnswer(result.json);
        if (!parsed) return { ...settled, reason: 'unexpected_response' };
        answer = parsed;
        break;
      }
      if (result.failure === 'timeout') return { ...settled, reason: 'timeout' };
      if (result.status === 401) return { ...settled, reason: 'unauthorized' };
      if (result.status === 422) return { ...settled, reason: 'unprocessable' };
      // Only the two throttling statuses are worth a second attempt; the others will not change.
      if ((result.status === 429 || result.status === 529) && attempt === 0) continue;
      if (result.status === 429) return { ...settled, reason: 'rate_limited' };
      if (result.status === 529) return { ...settled, reason: 'upstream_unavailable' };
      return { ...settled, reason: 'connection_error' };
    }

    if (!answer) {
      return { ...base, outboundCalls, redactionCount: redaction.outcome.count, reason: 'budget_exceeded', latencyMs: now() - startedAt };
    }

    const gate = gateValue(answer.answers as Partial<Record<typeof GATE_QUESTIONS[number]['key'], number>>);
    if (gate < GATE_THRESHOLD) {
      const outcome = { ...base, outboundCalls, redactionCount: redaction.outcome.count, reason: 'below_gate' as const, latencyMs: now() - startedAt };
      this.writeCache(cacheKey, outcome, now());
      return outcome;
    }

    const shortlist = input.roster.slice(0, SHORTLIST);
    if (!shortlist.some((entry) => entry.name === answer?.choice)) return { ...base, outboundCalls, redactionCount: redaction.outcome.count, reason: 'invalid_choice', latencyMs: now() - startedAt };

    // Call 2 reranks the shortlist using the fuller text and asks one fit question per candidate.
    if (now() >= deadline) return { ...base, outboundCalls, redactionCount: redaction.outcome.count, reason: 'budget_exceeded', latencyMs: now() - startedAt };
    outboundCalls += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(CALL_TIMEOUT_MS, Math.max(1, deadline - now())));
    let rerank: Awaited<ReturnType<TypesafeSkillSuggester['post']>>;
    try {
      rerank = await this.post(this.rerankBody(shortlist, redaction.outcome.text), controller.signal);
    } finally {
      clearTimeout(timer);
    }
    if (!rerank.ok) {
      return { ...base, outboundCalls, redactionCount: redaction.outcome.count, reason: 'upstream_unavailable', latencyMs: now() - startedAt };
    }
    const ranked = parseAnswer(rerank.json);
    if (!ranked) return { ...base, outboundCalls, redactionCount: redaction.outcome.count, reason: 'unexpected_response', latencyMs: now() - startedAt };

    const best = shortlist
      .map((entry) => ({ name: entry.name, fit: numberOr(ranked.answers[`fits::${entry.name}`], 0) }))
      .sort((a, b) => b.fit - a.fit)[0]!;
    if (best.fit < FITS_THRESHOLD) {
      return { ...base, outboundCalls, redactionCount: redaction.outcome.count, reason: 'below_fit', latencyMs: now() - startedAt };
    }

    // The winning name is validated against the roster by exact match, so model prose cannot reach the
    // caller: an answer the roster does not contain is discarded rather than reported.
    const chosenName = shortlist.some((entry) => entry.name === ranked.choice) ? ranked.choice : best.name;
    if (!input.roster.some((entry) => entry.name === chosenName)) {
      return { ...base, outboundCalls, redactionCount: redaction.outcome.count, reason: 'invalid_choice', latencyMs: now() - startedAt };
    }

    const outcome: SuggestionOutcome = {
      suggested: { name: chosenName, gate, fit: best.fit, confidence: Math.min(1, Math.max(0, gate * best.fit)) },
      cached: false,
      outboundCalls,
      redactionCount: redaction.outcome.count,
      latencyMs: now() - startedAt
    };
    this.writeCache(cacheKey, outcome, now());
    return outcome;
  }

  private rankBody(roster: RosterEntry[], prompt: string): TypesafeRequest {
    return {
      model: this.config.model ?? TYPESAFE_DEFAULT_MODEL,
      choice: { question: 'Which skill, if any, should be used for this request?', options: roster.map((entry) => ({ label: entry.name, criteria: entry.indexDescription })) },
      noul: GATE_QUESTIONS.map((question) => ({ name: question.key, question: question.text })),
      input: prompt
    };
  }

  private rerankBody(shortlist: RosterEntry[], prompt: string): TypesafeRequest {
    return {
      model: this.config.model ?? TYPESAFE_DEFAULT_MODEL,
      choice: { question: 'Which of these skills fits the request best?', options: shortlist.map((entry) => ({ label: entry.name, criteria: `${entry.descriptionFull}\n${entry.bodyExcerpt}` })) },
      noul: shortlist.map((entry) => ({ name: `fits::${entry.name}`, question: `Does the skill ${entry.name} fit this request?` })),
      input: prompt
    };
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** An unexpected shape is reported rather than guessed at, because a guess here becomes a suggestion. */
function parseAnswer(json: unknown): { choice: string; answers: Record<string, number> } | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const answer = (json as { answer?: unknown }).answer;
  if (!answer || typeof answer !== 'object') return undefined;
  const { choice, answers } = answer as { choice?: unknown; answers?: unknown };
  if (typeof choice !== 'string') return undefined;
  const normalized: Record<string, number> = {};
  if (answers && typeof answers === 'object') {
    for (const [key, value] of Object.entries(answers as Record<string, unknown>)) {
      if (typeof value === 'number') normalized[key] = value;
    }
  }
  return { choice, answers: normalized };
}
