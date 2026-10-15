import type { DecisionAnswer, DecisionRequest, DecisionRerankToolsInput, DecisionRerankToolsResult } from '@cloud-harness/contracts';
import type { DecisionPlane } from './decision-plane.js';

const DESCRIPTION_CHARS = 240;
/** When no candidate reaches this relevance, the plane abstains and lexical order stands. */
export const MIN_TOP_RELEVANCE = 0.2;
const FIT_WEIGHT = 0.7;
const CHOICE_WEIGHT = 0.3;

/**
 * Candidates are addressed by position (`t0`, `t1`, ...) on the wire, so a tool name never has to
 * satisfy the question-key charset and a returned key can only map back to a candidate it offered.
 */
export function rerankDecisionRequest(input: DecisionRerankToolsInput, redact: (text: string) => string | undefined = (text) => text): DecisionRequest | undefined {
  const options: Record<string, string> = {};
  for (const [index, candidate] of input.candidates.entries()) {
    // Upstream descriptions are redacted whole before they are shortened, so a cut cannot split a secret.
    const redacted = redact(candidate.description.trim());
    if (redacted === undefined) return undefined;
    const description = redacted.slice(0, DESCRIPTION_CHARS);
    options[`t${index}`] = `${candidate.tool}${description ? `: ${description}` : ''}`.slice(0, 400);
  }
  return {
    purpose: 'mcp-routing',
    state: `A user of an MCP tool gateway asked for: ${input.query}`,
    questions: [
      { kind: 'choice', key: 'best_tool', question: 'Which tool best does what the request asks?', options },
      ...input.candidates.map((candidate, index) => ({
        kind: 'boolean' as const,
        key: `fits_t${index}`,
        question: `Does the tool ${candidate.tool.slice(0, 190)} do what the request asks?`
      }))
    ]
  };
}

/**
 * Orders the candidates by semantic relevance, breaking ties by their lexical position. The result
 * is always a permutation of the input: the router can only reorder tools the deterministic policy
 * already made visible, never add one.
 */
export function rankFromAnswers(input: DecisionRerankToolsInput, answers: Record<string, DecisionAnswer>): { ordering: string[]; relevance: Record<string, number> } {
  const choice = answers.best_tool;
  if (!choice || choice.kind !== 'choice') throw new Error('best_tool answer is missing');
  const scored = input.candidates.map((candidate, index) => {
    const fit = answers[`fits_t${index}`];
    if (!fit || fit.kind !== 'boolean') throw new Error(`fits_t${index} answer is missing`);
    const chosen = choice.probabilities[`t${index}`] ?? (choice.value === `t${index}` ? choice.confidence : 0);
    const relevance = Math.round((FIT_WEIGHT * fit.probability + CHOICE_WEIGHT * chosen) * 1_000) / 1_000;
    return { tool: candidate.tool, index, relevance };
  });
  scored.sort((left, right) => right.relevance - left.relevance || left.index - right.index);
  return {
    ordering: scored.map((entry) => entry.tool),
    relevance: Object.fromEntries(scored.map((entry) => [entry.tool, entry.relevance]))
  };
}

export async function rerankTools(plane: DecisionPlane, ownerId: string, input: DecisionRerankToolsInput): Promise<DecisionRerankToolsResult> {
  const notApplied = (reason: DecisionRerankToolsResult['reason'], decisionId: string | null = null): DecisionRerankToolsResult =>
    ({ applied: false, decisionId, ordering: [], relevance: {}, ...(reason ? { reason } : {}) });
  if (!plane.enabled('mcp-routing')) return notApplied('purpose_disabled');
  // An owner with no provider key is the common case on every search; it is answered without an
  // evaluation, so it adds neither an audit row nor a fallback to the metrics.
  if (!plane.available(ownerId, 'mcp-routing')) return notApplied('not_configured');
  const request = rerankDecisionRequest(input, (text) => plane.redact(ownerId, text));
  if (!request) return notApplied('redaction_failed');

  let ranked: { ordering: string[]; relevance: Record<string, number> } | undefined;
  const outcome = await plane.evaluate(ownerId, request, (answers) => {
    ranked = rankFromAnswers(input, answers);
    const top = ranked.ordering[0] ?? '';
    const confidence = ranked.relevance[top] ?? 0;
    if (confidence < MIN_TOP_RELEVANCE) {
      ranked = undefined;
      return { selected: '', confidence, policyEffect: 'abstain' };
    }
    return { selected: top, confidence, policyEffect: 'rerank' };
  });
  if (!outcome.ok) return notApplied(outcome.reason, outcome.decisionId);
  if (!ranked) return notApplied('low_confidence', outcome.decisionId);
  return { applied: true, decisionId: outcome.decisionId, ordering: ranked.ordering, relevance: ranked.relevance };
}
