import { randomUUID } from 'node:crypto';
import {
  DecisionRequestSchema,
  type DecisionAnswer,
  type DecisionFallbackReason,
  type DecisionPurpose,
  type DecisionRequest,
  type ImplementedDecisionPurpose
} from '@cloud-harness/contracts';
import { redactSecrets } from '../typesafe-skill-suggester.js';
import { DecisionMetrics, type DecisionMetricsSnapshot } from './decision-metrics.js';

/** The bounds a human reviews in one place: they decide how long and how often a decision may run. */
export const DECISION_CALL_TIMEOUT_MS = 1_500;
export const DECISION_RATE_LIMIT_PER_MINUTE = 120;

export type ProviderEvaluation =
  | {
    ok: true;
    model: string;
    answers: Record<string, DecisionAnswer>;
    inputTokens: number;
    outputTokens: number;
    inputBytes: number;
    redactionCount: number;
  }
  | { ok: false; reason: DecisionFallbackReason; inputBytes?: number };

/**
 * A provider answers typed questions about bounded state. It must not throw for an upstream
 * failure: it reports a fallback reason so the plane can record it and the caller can fall back.
 */
export interface DecisionProvider {
  readonly name: string;
  evaluate(request: DecisionRequest, context: DecisionCallContext): Promise<ProviderEvaluation>;
}

export type DecisionCallContext = {
  signal: AbortSignal;
  /** Extra values to redact for this call, such as the secrets of the workspace a failure came from. */
  secrets?: () => Record<string, string>;
};

export type DecisionEvaluateOptions = {
  /** Extra values to redact for this call. */
  secrets?: () => Record<string, string>;
  /** The caller's own cancellation. Aborting it aborts the provider call and answers `cancelled`. */
  signal?: AbortSignal;
};

export type DecisionOutcome =
  | {
    ok: true;
    decisionId: string;
    provider: string;
    model: string;
    answers: Record<string, DecisionAnswer>;
    latencyMs: number;
  }
  | { ok: false; decisionId: string; reason: DecisionFallbackReason; latencyMs: number };

/** One metadata-only trace per evaluation. It never carries the state or any answer text. */
export type DecisionTrace = {
  decisionId: string;
  purpose: DecisionPurpose;
  provider: string;
  model: string;
  latencyMs: number;
  inputBytes: number;
  questionCount: number;
  outcome: 'decided' | 'fallback';
  fallbackReason: DecisionFallbackReason | '';
  selected: string;
  confidence: number;
  policyEffect: string;
  inputTokens: number;
  outputTokens: number;
  redactionCount: number;
};

export type DecisionPlaneOptions = {
  /** Purposes the operator enabled. Anything else answers `purpose_disabled` with zero egress. */
  purposes: readonly ImplementedDecisionPurpose[];
  /** Resolves the owner's provider, or undefined when the owner has none configured. */
  providerFor: (ownerId: string) => DecisionProvider | undefined;
  /**
   * Values the plane itself must never send for this owner, such as its own provider key and model
   * provider credentials. Callers add their own per-call secrets on top.
   */
  secretsFor?: (ownerId: string) => Record<string, string>;
  /** Best-effort audit sink. A failing sink never fails a decision. */
  record?: (ownerId: string, trace: DecisionTrace) => void;
  now?: () => number;
  timeoutMs?: number;
};

/**
 * The Decision Plane: a bounded, advisory judgment layer around deterministic control paths.
 *
 * `evaluate` never throws and never decides policy. Every non-decision is a typed fallback
 * reason, so each integration keeps its deterministic behaviour whenever the plane is disabled,
 * unconfigured, slow, rate limited, or answers something it did not ask for.
 */
export class DecisionPlane {
  readonly metrics = new DecisionMetrics();
  private readonly callTimestamps = new Map<string, number[]>();
  private readonly rateLimitAudited = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly options: DecisionPlaneOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  enabled(purpose: DecisionPurpose): boolean {
    return (this.options.purposes as readonly string[]).includes(purpose);
  }

  /** True when a call for this owner and purpose could leave the runner at all. */
  available(ownerId: string, purpose: DecisionPurpose): boolean {
    if (!this.enabled(purpose)) return false;
    try {
      return this.options.providerFor(ownerId) !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Fully redacts a text with the owner's plane secrets and the caller's secrets, before the caller
   * cuts it down. Returns undefined when redaction cannot complete, so the caller sends nothing.
   */
  redact(ownerId: string, text: string, secrets?: () => Record<string, string>): string | undefined {
    const result = redactSecrets({
      text,
      secrets: () => ({ ...(this.options.secretsFor?.(ownerId) ?? {}), ...(secrets?.() ?? {}) })
    });
    return result.ok ? result.text : undefined;
  }

  status(): { purposes: string[]; metrics: DecisionMetricsSnapshot } {
    return { purposes: [...this.options.purposes], metrics: this.metrics.snapshot() };
  }

  async evaluate(
    ownerId: string,
    request: DecisionRequest,
    describe: (answers: Record<string, DecisionAnswer>) => { selected: string; confidence: number; policyEffect: string },
    options: DecisionEvaluateOptions = {}
  ): Promise<DecisionOutcome> {
    const decisionId = `dec_${randomUUID().replace(/-/g, '')}`;
    const startedAt = this.now();
    const trace: DecisionTrace = {
      decisionId,
      purpose: request.purpose,
      provider: 'none',
      model: '',
      latencyMs: 0,
      inputBytes: 0,
      questionCount: Array.isArray(request.questions) ? request.questions.length : 0,
      outcome: 'fallback',
      fallbackReason: '',
      selected: '',
      confidence: 0,
      policyEffect: 'none',
      inputTokens: 0,
      outputTokens: 0,
      redactionCount: 0
    };
    const fallback = (reason: DecisionFallbackReason): DecisionOutcome => {
      const latencyMs = Math.max(0, this.now() - startedAt);
      this.finish(ownerId, { ...trace, latencyMs, fallbackReason: reason });
      return { ok: false, decisionId, reason, latencyMs };
    };

    // A disabled purpose is not counted as a fallback: nothing was attempted.
    if (!this.enabled(request.purpose)) return { ok: false, decisionId, reason: 'purpose_disabled', latencyMs: 0 };
    const parsed = DecisionRequestSchema.safeParse(request);
    if (!parsed.success) return fallback('invalid_request');

    let provider: DecisionProvider | undefined;
    try {
      provider = this.options.providerFor(ownerId);
    } catch {
      provider = undefined;
    }
    if (!provider) return fallback('not_configured');
    trace.provider = provider.name;
    if (options.signal?.aborted) return fallback('cancelled');
    if (!this.permitCall(ownerId)) return this.rateLimited(ownerId, trace, decisionId, startedAt);

    const controller = new AbortController();
    const secrets = this.callSecrets(ownerId, options.secrets);
    let cancel: (() => void) | undefined;
    const cancelled = new Promise<ProviderEvaluation>((resolve) => {
      if (!options.signal) return;
      cancel = () => {
        controller.abort();
        resolve({ ok: false, reason: 'cancelled' });
      };
      options.signal.addEventListener('abort', cancel, { once: true });
    });
    const timeoutMs = this.options.timeoutMs ?? DECISION_CALL_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ProviderEvaluation>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, reason: 'timeout' });
      }, timeoutMs);
    });
    let evaluation: ProviderEvaluation;
    try {
      evaluation = await Promise.race([
        provider.evaluate(parsed.data, { signal: controller.signal, secrets }).catch((): ProviderEvaluation => ({ ok: false, reason: 'connection_error' })),
        timeout,
        cancelled
      ]);
    } finally {
      clearTimeout(timer);
      if (cancel) options.signal?.removeEventListener('abort', cancel);
    }
    trace.inputBytes = evaluation.inputBytes ?? 0;
    if (!evaluation.ok) return fallback(evaluation.reason);

    const invalid = invalidAnswer(parsed.data, evaluation.answers);
    trace.model = evaluation.model;
    trace.inputTokens = evaluation.inputTokens;
    trace.outputTokens = evaluation.outputTokens;
    trace.redactionCount = evaluation.redactionCount;
    if (invalid) return fallback('invalid_answer');

    let described: { selected: string; confidence: number; policyEffect: string };
    try {
      described = describe(evaluation.answers);
    } catch {
      return fallback('invalid_answer');
    }
    const latencyMs = Math.max(0, this.now() - startedAt);
    this.finish(ownerId, {
      ...trace,
      latencyMs,
      outcome: 'decided',
      selected: described.selected.slice(0, 190),
      confidence: clamp(described.confidence),
      policyEffect: described.policyEffect
    });
    return { ok: true, decisionId, provider: provider.name, model: evaluation.model, answers: evaluation.answers, latencyMs };
  }

  /** The plane's own secrets for this owner merged with the caller's, read lazily by the provider. */
  private callSecrets(ownerId: string, extra?: () => Record<string, string>): () => Record<string, string> {
    return () => ({ ...(this.options.secretsFor?.(ownerId) ?? {}), ...(extra?.() ?? {}) });
  }

  /**
   * A refused call is counted in metrics every time but audited at most once per owner per window, so
   * a burst against the egress bound cannot turn into an equally large burst of audit rows.
   */
  private rateLimited(ownerId: string, trace: DecisionTrace, decisionId: string, startedAt: number): DecisionOutcome {
    const latencyMs = Math.max(0, this.now() - startedAt);
    const finished = { ...trace, latencyMs, fallbackReason: 'rate_limited' as const };
    const now = this.now();
    const last = this.rateLimitAudited.get(ownerId);
    if (last === undefined || now - last >= 60_000) {
      this.rateLimitAudited.set(ownerId, now);
      this.finish(ownerId, finished);
    } else {
      this.metrics.observe(finished);
    }
    return { ok: false, decisionId, reason: 'rate_limited', latencyMs };
  }

  private finish(ownerId: string, trace: DecisionTrace): void {
    this.metrics.observe(trace);
    try {
      this.options.record?.(ownerId, trace);
    } catch {
      // The audit sink is best-effort: an audit outage must not change a decision.
    }
  }

  /** Per-owner egress bound. This is a volume control on what leaves the runner, not fairness. */
  private permitCall(ownerId: string): boolean {
    const now = this.now();
    const recent = (this.callTimestamps.get(ownerId) ?? []).filter((stamp) => now - stamp < 60_000);
    if (recent.length >= DECISION_RATE_LIMIT_PER_MINUTE) {
      this.callTimestamps.set(ownerId, recent);
      return false;
    }
    recent.push(now);
    this.callTimestamps.set(ownerId, recent);
    return true;
  }
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * Every question must be answered with its own kind, every number must be a probability, and a
 * choice must name one of the offered options. Anything else is discarded as a whole rather than
 * partially trusted, because a partial answer would let the caller act on a guess.
 */
function invalidAnswer(request: DecisionRequest, answers: Record<string, DecisionAnswer>): boolean {
  for (const question of request.questions) {
    const answer = answers[question.key];
    if (!answer || answer.kind !== question.kind) return true;
    if (answer.kind === 'choice') {
      if (question.kind !== 'choice' || !Object.hasOwn(question.options, answer.value)) return true;
      if (!isProbability(answer.confidence)) return true;
      if (Object.values(answer.probabilities ?? {}).some((value) => !isProbability(value))) return true;
    } else if (answer.kind === 'boolean') {
      if (!isProbability(answer.probability)) return true;
    } else if (!isProbability(answer.value) || !isProbability(answer.confidence)) {
      return true;
    }
  }
  return false;
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
