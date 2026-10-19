import {
  EXECUTION_RISK_QUESTION_KEYS,
  type DecisionAnswer,
  type DecisionFallbackReason,
  type DecisionRequest,
  type ImplementedDecisionPurpose
} from '@cloud-harness/contracts';
import { DecisionPlane, type DecisionCallContext, type DecisionPlaneOptions, type DecisionProvider, type DecisionTrace, type ProviderEvaluation } from '../../src/decision-plane/decision-plane.js';

/**
 * A scripted stand-in for the TypeSafe Jev provider. It never touches the network: every call is
 * recorded (request and count) and answered from a script, so a test can prove exactly what would have
 * left the runner and how often. Steps are consumed in order; the last one repeats.
 *
 * - `risk`: a well-formed execution-risk answer.
 * - `answers`: raw answers, for malformed or partial payloads.
 * - `http`: an upstream HTTP status, mapped the way the real provider maps it (429 -> rate_limited).
 * - `fail`: a provider fallback reason as is.
 * - `hang`: no answer until the plane aborts the call (its timeout or the caller's signal).
 * - `throw`: the provider throws, which the plane reports as `connection_error`.
 */
export type FakeJevStep =
  | { kind: 'risk'; risk: number; confidence: number; uncertainSideEffects?: number; humanRequired?: number }
  | { kind: 'answers'; answers: Record<string, DecisionAnswer> }
  | { kind: 'http'; status: number }
  | { kind: 'fail'; reason: DecisionFallbackReason }
  | { kind: 'hang' }
  | { kind: 'throw' };

export const LOW_RISK_STEP: FakeJevStep = { kind: 'risk', risk: 0.1, confidence: 0.95, uncertainSideEffects: 0.05, humanRequired: 0.05 };

/** The provider-neutral answers a `risk` step stands for. */
export function executionRiskAnswers(step: Extract<FakeJevStep, { kind: 'risk' }>): Record<string, DecisionAnswer> {
  return {
    [EXECUTION_RISK_QUESTION_KEYS.risk]: { kind: 'score', value: step.risk, confidence: step.confidence },
    [EXECUTION_RISK_QUESTION_KEYS.uncertainSideEffects]: { kind: 'boolean', probability: step.uncertainSideEffects ?? 0 },
    [EXECUTION_RISK_QUESTION_KEYS.humanRequired]: { kind: 'boolean', probability: step.humanRequired ?? 0 }
  };
}

function httpReason(status: number): DecisionFallbackReason {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 422) return 'unprocessable';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_unavailable';
  return 'connection_error';
}

export class FakeJevProvider implements DecisionProvider {
  readonly name = 'fake-jev';
  /** Every request the plane handed over, in order. Assert on these to prove what would be sent. */
  readonly requests: DecisionRequest[] = [];
  private readonly steps: FakeJevStep[];

  constructor(steps: FakeJevStep | FakeJevStep[] = LOW_RISK_STEP, private readonly options: { latencyMs?: number } = {}) {
    this.steps = Array.isArray(steps) ? [...steps] : [steps];
    if (this.steps.length === 0) throw new Error('a fake Jev provider needs at least one step');
  }

  get calls(): number {
    return this.requests.length;
  }

  /** Replaces the remaining script. */
  script(...steps: FakeJevStep[]): this {
    if (steps.length === 0) throw new Error('a fake Jev provider needs at least one step');
    this.steps.splice(0, this.steps.length, ...steps);
    return this;
  }

  async evaluate(request: DecisionRequest, context: DecisionCallContext): Promise<ProviderEvaluation> {
    this.requests.push(structuredClone(request));
    const step = this.steps.length > 1 ? this.steps.shift() as FakeJevStep : this.steps[0] as FakeJevStep;
    const inputBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
    if (step.kind === 'hang') {
      return await new Promise<ProviderEvaluation>((resolve) => {
        context.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'timeout', inputBytes }), { once: true });
      });
    }
    if (this.options.latencyMs) await delay(this.options.latencyMs, context.signal);
    if (context.signal.aborted) return { ok: false, reason: 'timeout', inputBytes };
    switch (step.kind) {
      case 'throw': throw new Error('fake Jev provider failure');
      case 'fail': return { ok: false, reason: step.reason, inputBytes };
      case 'http': return { ok: false, reason: httpReason(step.status), inputBytes };
      case 'answers': return { ok: true, model: 'fake-jev', answers: step.answers, inputTokens: 40, outputTokens: 6, inputBytes, redactionCount: 0 };
      case 'risk': return { ok: true, model: 'fake-jev', answers: executionRiskAnswers(step), inputTokens: 40, outputTokens: 6, inputBytes, redactionCount: 0 };
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * A DecisionPlane wired to a fake provider the way `createRunnerDecisionPlane` wires Jev: no provider
 * means the owner has no TypeSafe credential. `traces` collects the scalar audit rows.
 */
export function fakeJevPlane<P extends DecisionProvider = FakeJevProvider>(options: {
  /** Usually a FakeJevProvider; a real JevDecisionProvider with a fake `fetchImpl` also fits. */
  provider?: P | undefined;
  purposes?: readonly ImplementedDecisionPurpose[];
} & Partial<Omit<DecisionPlaneOptions, 'purposes' | 'providerFor'>> = {}) {
  const { provider, purposes = ['execution-risk'], ...rest } = options;
  const traces: DecisionTrace[] = [];
  const plane = new DecisionPlane({
    purposes,
    providerFor: () => provider,
    record: (_owner, trace) => traces.push(trace),
    ...rest
  });
  return { plane, provider, traces };
}
