import { FAILURE_TYPES, type DecisionAnswer, type DecisionRequest, type FailureDiagnosis, type FailureType } from '@cloud-harness/contracts';
import { LOW_CONFIDENCE } from './decision-metrics.js';
import type { DecisionPlane } from './decision-plane.js';

const STDERR_TAIL_CHARS = 1_500;
const STDOUT_TAIL_CHARS = 600;
const REPEAT_WINDOW_MS = 15 * 60_000;
const REPEAT_KEYS_MAX = 1_000;

const FAILURE_TYPE_CRITERIA: Record<FailureType, string> = {
  auth: 'credentials were missing, expired, or rejected',
  permission: 'the credential is valid but lacks permission for this action',
  rate_limit: 'a rate limit, quota, or abuse throttle was hit',
  transient_network: 'a temporary network, DNS, TLS, or upstream availability problem',
  dependency: 'a package, tool, or dependency is missing, incompatible, or failed to install',
  test_failure: 'tests or checks ran and reported failures',
  flaky_test: 'a test that fails intermittently for reasons unrelated to the change',
  code_error: 'a bug, syntax, type, or usage error in the code or command',
  resource_exhaustion: 'memory, disk, process, file handle, or time limits were exhausted',
  unknown: 'none of the other kinds clearly applies'
};

const SIGNALS = [
  { key: 'retry_succeeds', question: 'Would retrying exactly the same operation, unchanged, likely succeed?' },
  { key: 'credential_refresh', question: 'Would refreshing or re-issuing the credential likely fix this failure?' },
  { key: 'workspace_recreate', question: 'Is the workspace itself broken so that it must be recreated to continue?' },
  { key: 'agent_needed', question: 'Does fixing this need code or configuration changes by a coding agent?' },
  { key: 'human_needed', question: 'Does fixing this need a human decision, approval, or account change?' }
] as const;

export type FailureContext = {
  ownerId: string;
  workspaceId: string;
  /** A stable operation label such as `github pr_create`. */
  operation: string;
  deterministicCode: string;
  exitCode: number | null;
  stderr: string;
  stdout: string;
  networkProfile?: string;
  secrets?: () => Record<string, string>;
};

function tail(text: string, chars: number): string {
  return text.length <= chars ? text : `[...]${text.slice(text.length - chars)}`;
}

/**
 * Semantic enrichment for failures the deterministic classifier could only call generic.
 *
 * Known errors stay authoritative: callers invoke this only for the classifier's generic fallback,
 * and the result is an advisory diagnosis beside the deterministic `code` and `retryable`, never a
 * replacement for them. Repeated failures of the same operation are counted into the state so a
 * persistent failure reads differently from a first transient one.
 */
export class FailureIntelligence {
  private readonly recent = new Map<string, number[]>();

  constructor(private readonly plane: DecisionPlane, private readonly now: () => number = () => Date.now()) {}

  async diagnose(context: FailureContext): Promise<FailureDiagnosis | undefined> {
    if (!this.plane.available(context.ownerId, 'failure-classification')) return undefined;
    const priorFailures = this.notePriorFailures(`${context.workspaceId}\u0000${context.operation}`);
    const request = failureDecisionRequest(context, priorFailures);
    let diagnosis: FailureDiagnosis | undefined;
    const outcome = await this.plane.evaluate(context.ownerId, request, (answers) => {
      diagnosis = diagnosisFromAnswers(answers, priorFailures, '');
      return { selected: diagnosis.failureType, confidence: diagnosis.confidence, policyEffect: 'advisory' };
    }, context.secrets);
    if (!outcome.ok || !diagnosis) return undefined;
    return { ...diagnosis, decisionId: outcome.decisionId };
  }

  /** Returns how many failures of this key happened inside the window before this one. */
  private notePriorFailures(key: string): number {
    const now = this.now();
    const stamps = (this.recent.get(key) ?? []).filter((stamp) => now - stamp < REPEAT_WINDOW_MS);
    const prior = stamps.length;
    stamps.push(now);
    this.recent.delete(key);
    this.recent.set(key, stamps);
    while (this.recent.size > REPEAT_KEYS_MAX) {
      const oldest = this.recent.keys().next().value;
      if (oldest === undefined) break;
      this.recent.delete(oldest);
    }
    return prior;
  }
}

export function failureDecisionRequest(context: Omit<FailureContext, 'ownerId' | 'workspaceId' | 'secrets'>, priorFailures: number): DecisionRequest {
  const state = [
    `operation: ${context.operation}`,
    `deterministic classification: ${context.deterministicCode} (no known rule matched)`,
    `exit code: ${context.exitCode ?? 'none'}`,
    `prior failures of this operation in the last 15 minutes: ${priorFailures}`,
    ...(context.networkProfile ? [`network profile: ${context.networkProfile}`] : []),
    `stderr (tail):\n${tail(context.stderr.trim(), STDERR_TAIL_CHARS) || '(empty)'}`,
    `stdout (tail):\n${tail(context.stdout.trim(), STDOUT_TAIL_CHARS) || '(empty)'}`
  ].join('\n');
  return {
    purpose: 'failure-classification',
    state,
    questions: [
      { kind: 'choice', key: 'failure_type', question: 'What kind of failure is this?', options: { ...FAILURE_TYPE_CRITERIA } },
      ...SIGNALS.map((signal) => ({ kind: 'boolean' as const, key: signal.key, question: signal.question }))
    ]
  };
}

/**
 * The diagnosis from validated answers. A failure type below the low-confidence bar is reported as
 * `unknown` with its real confidence, so a guess is never presented as a classification.
 */
export function diagnosisFromAnswers(answers: Record<string, DecisionAnswer>, priorFailures: number, decisionId: string): FailureDiagnosis {
  const choice = answers.failure_type;
  if (!choice || choice.kind !== 'choice' || !(FAILURE_TYPES as readonly string[]).includes(choice.value)) {
    throw new Error('failure_type answer is missing');
  }
  const probability = (key: string): number => {
    const answer = answers[key];
    if (!answer || answer.kind !== 'boolean') throw new Error(`${key} answer is missing`);
    return answer.probability;
  };
  const confidence = choice.confidence;
  return {
    advisory: true,
    source: 'decision-plane',
    decisionId,
    failureType: confidence >= LOW_CONFIDENCE ? choice.value as FailureType : 'unknown',
    confidence: Math.round(confidence * 1_000) / 1_000,
    retryLikelyToSucceed: Math.round(probability('retry_succeeds') * 1_000) / 1_000,
    credentialRefreshNeeded: probability('credential_refresh') >= 0.5,
    workspaceRecreateNeeded: probability('workspace_recreate') >= 0.5,
    agentNeeded: probability('agent_needed') >= 0.5,
    humanNeeded: probability('human_needed') >= 0.5,
    priorFailures
  };
}
