import type { DecisionAnswer, DecisionRequest } from '@cloud-harness/contracts';
import { TYPESAFE_ALLOWED_HOSTS, TYPESAFE_DEFAULT_ENDPOINT, TYPESAFE_DEFAULT_MODEL } from '../typesafe-questions.js';
import { redactPrompt, type TypesafeQuestion, type TypesafeRequest } from '../typesafe-skill-suggester.js';
import type { DecisionCallContext, DecisionProvider, ProviderEvaluation } from './decision-plane.js';

/** The hard ceiling on one request body, so a large candidate set cannot become a large upload. */
export const JEV_MAX_BODY_BYTES = 16_384;
const CRITERION_MAX_BYTES = 400;

/**
 * The TypeSafe Jev (System One) decision provider.
 *
 * It reuses the TypeSafe endpoint allowlist and the fail-closed redaction of the skill suggester:
 * the state and every criterion leave the runner only after the owner's secret snapshot and the
 * known credential shapes are removed, and a redaction failure sends nothing. The wire shape was
 * verified against the live endpoint: a `choice` criteria map is keyed by option, a `noul` by its
 * polar answers, and a `score` takes a two-item list of its low and high anchors.
 */
export class JevDecisionProvider implements DecisionProvider {
  readonly name = 'typesafe-jev';

  constructor(private readonly config: {
    apiKey: () => string | undefined;
    secrets?: () => Record<string, string>;
    endpoint?: string;
    model?: string;
    fetchImpl?: typeof fetch;
  }) {}

  private endpoint(): string | undefined {
    try {
      const url = new URL(this.config.endpoint ?? TYPESAFE_DEFAULT_ENDPOINT);
      if (url.protocol !== 'https:') return undefined;
      if (!TYPESAFE_ALLOWED_HOSTS.includes(url.host as typeof TYPESAFE_ALLOWED_HOSTS[number])) return undefined;
      return url.toString();
    } catch {
      return undefined;
    }
  }

  async evaluate(request: DecisionRequest, context: DecisionCallContext): Promise<ProviderEvaluation> {
    const endpoint = this.endpoint();
    if (!endpoint) return { ok: false, reason: 'invalid_endpoint' };
    const apiKey = this.config.apiKey();
    if (!apiKey) return { ok: false, reason: 'not_configured' };

    // The snapshot is read inside redaction, so a failing secret read fails the call closed.
    const secrets = (): Record<string, string> => ({ ...(this.config.secrets?.() ?? {}), ...(context.secrets?.() ?? {}) });
    let redactionCount = 0;
    let failed = false;
    const redact = (text: string, maxBytes?: number): string => {
      const outcome = redactPrompt({ prompt: text, secrets, ...(maxBytes ? { maxBytes } : {}) });
      if (!outcome.ok) {
        failed = true;
        return '';
      }
      redactionCount += outcome.outcome.count;
      return outcome.outcome.text;
    };

    const questions: Record<string, TypesafeQuestion> = {};
    for (const question of request.questions) {
      if (question.kind === 'choice') {
        questions[question.key] = {
          type: 'choice',
          question: question.question,
          criteria: Object.fromEntries(Object.entries(question.options).map(([option, text]) => [option, redact(text, CRITERION_MAX_BYTES)]))
        };
      } else if (question.kind === 'boolean') {
        questions[question.key] = { type: 'noul', question: question.question, criteria: { true: 'yes', false: 'no' } };
      } else {
        questions[question.key] = {
          type: 'score',
          question: question.question,
          criteria: [redact(question.low, CRITERION_MAX_BYTES), redact(question.high, CRITERION_MAX_BYTES)]
        };
      }
    }
    const state = redact(request.state);
    if (failed) return { ok: false, reason: 'redaction_failed' };

    const body: TypesafeRequest = { model: this.config.model ?? TYPESAFE_DEFAULT_MODEL, state, questions };
    const serialized = JSON.stringify(body);
    const inputBytes = Buffer.byteLength(serialized, 'utf8');
    if (inputBytes > JEV_MAX_BODY_BYTES) return { ok: false, reason: 'invalid_request', inputBytes };

    let response: Response;
    try {
      response = await (this.config.fetchImpl ?? fetch)(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: serialized,
        signal: context.signal
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      return { ok: false, reason: name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'connection_error', inputBytes };
    }
    if (!response.ok) return { ok: false, reason: httpReason(response.status), inputBytes };

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, reason: 'unexpected_response', inputBytes };
    }
    const parsed = parseJevAnswers(json, request);
    if (!parsed) return { ok: false, reason: 'unexpected_response', inputBytes };
    return { ok: true, ...parsed, inputBytes, redactionCount };
  }
}

function httpReason(status: number): 'unauthorized' | 'unprocessable' | 'rate_limited' | 'upstream_unavailable' | 'connection_error' {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 422) return 'unprocessable';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_unavailable';
  return 'connection_error';
}

/**
 * Maps the Jev answers onto the neutral answer shape. Only the questions the request asked are read,
 * so an extra key in the response cannot introduce an answer; a missing or malformed one is left out
 * and the plane rejects the whole decision.
 */
export function parseJevAnswers(json: unknown, request: DecisionRequest):
{ model: string; answers: Record<string, DecisionAnswer>; inputTokens: number; outputTokens: number } | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const record = json as { model?: unknown; answers?: unknown; usage?: unknown };
  if (!record.answers || typeof record.answers !== 'object') return undefined;
  const raw = record.answers as Record<string, unknown>;
  const answers: Record<string, DecisionAnswer> = {};
  for (const question of request.questions) {
    const value = Object.hasOwn(raw, question.key) ? raw[question.key] : undefined;
    if (!value || typeof value !== 'object') continue;
    const answer = value as Record<string, unknown>;
    if (question.kind === 'choice' && answer.type === 'choice' && typeof answer.choice === 'string') {
      const probabilities: Record<string, number> = {};
      if (answer.probabilities && typeof answer.probabilities === 'object') {
        for (const option of Object.keys(question.options)) {
          const probability = (answer.probabilities as Record<string, unknown>)[option];
          if (typeof probability === 'number' && Number.isFinite(probability)) probabilities[option] = probability;
        }
      }
      const confidence = typeof answer.confidence === 'number' ? answer.confidence : probabilities[answer.choice] ?? Number.NaN;
      answers[question.key] = { kind: 'choice', value: answer.choice, confidence, probabilities };
    } else if (question.kind === 'boolean' && answer.type === 'noul' && typeof answer.noul === 'number') {
      answers[question.key] = { kind: 'boolean', probability: answer.noul };
    } else if (question.kind === 'score' && answer.type === 'score' && typeof answer.score === 'number') {
      answers[question.key] = { kind: 'score', value: answer.score, confidence: typeof answer.confidence === 'number' ? answer.confidence : Number.NaN };
    }
  }
  const usage = record.usage && typeof record.usage === 'object' ? record.usage as Record<string, unknown> : {};
  return {
    model: typeof record.model === 'string' ? record.model.slice(0, 64) : TYPESAFE_DEFAULT_MODEL,
    answers,
    inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
    outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
  };
}
