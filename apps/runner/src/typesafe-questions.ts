/**
 * The one reviewable module for the TypeSafe suggestion engine.
 *
 * The questions, the thresholds, and the bounds are the parts a human has to be able to review in a
 * single place, because they decide when a prompt leaves the control plane and when it does not. Every
 * other module reads them from here rather than carrying its own copy.
 */
export const TYPESAFE_DEFAULT_MODEL = 'jev-latest';
export const TYPESAFE_DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** The endpoint host must be on this list before any request is made, and the URL must be HTTPS. */
export const TYPESAFE_ALLOWED_HOSTS = ['api.typesafe.ai'] as const;

export const GATE_THRESHOLD = 0.6;
export const FITS_THRESHOLD = 0.6;

/** How many candidates survive the first call and are reranked by the second. */
export const SHORTLIST = 3;

/**
 * Payload minimization is the control that bounds residual unknown-shape content: redaction removes
 * the shapes it knows, and a smaller payload limits what is left. The ceiling is the hard maximum the
 * configuration may never exceed.
 */
export const MAX_EGRESS_BYTES = 4_096;
export const MAX_EGRESS_CEILING = 8_192;
export const MIN_PROMPT_CHARS = 24;

export const INDEX_DESCRIPTION_MAX = 60;
export const DESCRIPTION_FULL_MAX = 400;
export const BODY_EXCERPT_MAX = 700;

export const CALL_TIMEOUT_MS = 1_500;
export const TOTAL_BUDGET_MS = 2_500;

export const CACHE_TTL_MS = 15 * 60_000;
export const CACHE_MAX_ENTRIES = 500;

/** This is an egress-volume security control, not a fairness knob. */
export const RATE_LIMIT_PER_MINUTE = 60;

export const GATE_QUESTIONS = [
  {
    key: 'acts_on_user_system',
    text: 'Does this request have to act on the user\'s system to be satisfied, rather than produce text?',
    inverted: false
  },
  {
    key: 'would_follow_documented_procedure',
    text: 'Would a documented, repeatable procedure answer this request better than free prose?',
    inverted: false
  },
  {
    key: 'prose_suffices',
    text: 'Is ordinary prose sufficient to answer this request?',
    inverted: true
  }
] as const;

export type GateQuestionKey = typeof GATE_QUESTIONS[number]['key'];

/**
 * Short-circuit reasons, reviewed as a constant rather than derived inline. Each one means the
 * suggestion cannot help or is not permitted, so the engine answers locally with zero outbound calls.
 */
export const SHORT_CIRCUIT_REASONS = ['disabled', 'empty_roster', 'prompt_too_short', 'slash_command'] as const;
export type ShortCircuitReason = typeof SHORT_CIRCUIT_REASONS[number];

/**
 * The gate value. An inverted question contributes `1 - answer`, so agreement with "prose suffices"
 * lowers the gate. A missing answer counts as zero rather than as neutral: an unanswered gate is not a
 * pass, and the conservative direction for a suggestion is to make one.
 */
export function gateValue(answers: Partial<Record<GateQuestionKey, number>>): number {
  let total = 0;
  for (const question of GATE_QUESTIONS) {
    const answer = answers[question.key];
    if (typeof answer !== 'number' || Number.isNaN(answer)) continue;
    const bounded = Math.min(1, Math.max(0, answer));
    total += question.inverted ? 1 - bounded : bounded;
  }
  return total / GATE_QUESTIONS.length;
}

/** True when the answer is a bare slash command, which asks the client for something, not the engine. */
function isBareSlashCommand(prompt: string): boolean {
  return /^\/\S+$/.test(prompt.trim());
}

/**
 * The local decision. Returning a reason here means no request is sent, and the order is deliberate:
 * an operator's kill switch is reported as such even when the roster is also empty, so the reason
 * always names the first condition that applies.
 */
export function shortCircuitReason(input: {
  enabled: boolean;
  rosterSize: number;
  prompt: string;
}): ShortCircuitReason | null {
  if (!input.enabled) return 'disabled';
  if (input.rosterSize <= 0) return 'empty_roster';
  const prompt = input.prompt.trim();
  if (isBareSlashCommand(prompt)) return 'slash_command';
  if (prompt.length < MIN_PROMPT_CHARS) return 'prompt_too_short';
  return null;
}
