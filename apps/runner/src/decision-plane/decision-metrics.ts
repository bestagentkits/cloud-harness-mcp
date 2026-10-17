import type { DecisionTrace } from './decision-plane.js';

const LATENCY_WINDOW = 256;

type PurposeCounters = {
  decided: number;
  fallback: number;
  fallbackReasons: Record<string, number>;
  lowConfidence: number;
  inputTokens: number;
  outputTokens: number;
  latencies: number[];
};

export type DecisionMetricsSnapshot = Record<string, {
  evaluations: number;
  decided: number;
  fallback: number;
  fallbackRate: number;
  fallbackReasons: Record<string, number>;
  lowConfidence: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  inputTokens: number;
  outputTokens: number;
}>;

/** A decision below this confidence is counted as low-confidence even when it was used. */
export const LOW_CONFIDENCE = 0.5;

/**
 * Process-local Decision Plane metrics. They reset with the runner and hold only counters and a
 * bounded latency window per purpose, so they can be reported without touching any state text.
 */
export class DecisionMetrics {
  private readonly purposes = new Map<string, PurposeCounters>();

  observe(trace: DecisionTrace): void {
    let counters = this.purposes.get(trace.purpose);
    if (!counters) {
      counters = { decided: 0, fallback: 0, fallbackReasons: {}, lowConfidence: 0, inputTokens: 0, outputTokens: 0, latencies: [] };
      this.purposes.set(trace.purpose, counters);
    }
    if (trace.outcome === 'decided') {
      counters.decided += 1;
      if (trace.confidence < LOW_CONFIDENCE) counters.lowConfidence += 1;
    } else {
      counters.fallback += 1;
      const reason = trace.fallbackReason || 'unknown';
      counters.fallbackReasons[reason] = (counters.fallbackReasons[reason] ?? 0) + 1;
    }
    counters.inputTokens += trace.inputTokens;
    counters.outputTokens += trace.outputTokens;
    counters.latencies.push(trace.latencyMs);
    if (counters.latencies.length > LATENCY_WINDOW) counters.latencies.shift();
  }

  snapshot(): DecisionMetricsSnapshot {
    const result: DecisionMetricsSnapshot = {};
    for (const [purpose, counters] of this.purposes) {
      const evaluations = counters.decided + counters.fallback;
      result[purpose] = {
        evaluations,
        decided: counters.decided,
        fallback: counters.fallback,
        fallbackRate: evaluations === 0 ? 0 : Math.round((counters.fallback / evaluations) * 1_000) / 1_000,
        fallbackReasons: { ...counters.fallbackReasons },
        lowConfidence: counters.lowConfidence,
        latencyP50Ms: percentile(counters.latencies, 0.5),
        latencyP95Ms: percentile(counters.latencies, 0.95),
        inputTokens: counters.inputTokens,
        outputTokens: counters.outputTokens
      };
    }
    return result;
  }
}

/** Nearest-rank percentile over the latency window. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)));
  return sorted[rank - 1]!;
}
