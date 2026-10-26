import { createHash } from 'node:crypto';
import {
  AGENT_ACTION_CLASSES,
  EXECUTION_RISK_QUESTION_KEYS,
  type AdvisorFallbackReason,
  type AgentActionDescriptor,
  type DecisionAnswer,
  type DecisionFallbackReason,
  type DecisionRequest,
  type ExecutionRiskAssessment,
  type PolicyAdvisor
} from '@cloud-harness/contracts';
import type { AdvisorAnswer, GateSubject } from '../agent-governance/gate-evaluator.js';
import { AGENT_GOVERNANCE_PORTS_VERSION, type AdvisorAvailability, type AdvisorFacts, type DecisionAdvisor } from '../agent-governance/ports.js';
import { isCiConfiguration, isDependencyManifest, pathSegments, touchesSensitivePaths } from '../agent-governance/sensitive-paths.js';
import type { DecisionPlane } from './decision-plane.js';

/**
 * The `execution-risk` Decision Plane purpose as a `DecisionAdvisor` (ADR 0006, #333).
 *
 * It sees only a typed summary built from the trusted action descriptor: counts, flags, a command
 * category and a digest. No path, argument, branch, repository name or free-text reason is sent, so
 * nothing an agent, an issue author or a webhook wrote can reach the provider or steer it. The answer
 * is a typed risk score and two flags; the policy's thresholds turn it into `no_change` or `escalate`,
 * and every failure is an `escalate` with a fallback reason. An action touching a CI/workflow file or a
 * dependency manifest or lockfile is escalated (`sensitive_paths`) before anything is sent: those are
 * execution-surface and supply-chain changes no model answer may clear, so they take the policy's
 * advisor fallback like any other unanswered action. The advisor never authorizes
 * anything: the gate only consults it for a discretionary action that would otherwise need approval.
 */

const PURPOSE = 'execution-risk' as const;
const FLAG_THRESHOLD = 0.5;

/** Programs the summary names by category, so the provider learns what kind of tool runs but no argument text. */
const PROGRAM_CATEGORIES: Readonly<Record<string, string>> = Object.freeze({
  npm: 'package_manager', pnpm: 'package_manager', yarn: 'package_manager', bun: 'package_manager', pip: 'package_manager',
  pip3: 'package_manager', poetry: 'package_manager', uv: 'package_manager', cargo: 'package_manager', gem: 'package_manager',
  bundle: 'package_manager', composer: 'package_manager', go: 'toolchain', mvn: 'toolchain', gradle: 'toolchain', dotnet: 'toolchain',
  npx: 'package_runner', pnpx: 'package_runner', uvx: 'package_runner',
  vitest: 'test_runner', jest: 'test_runner', mocha: 'test_runner', pytest: 'test_runner', playwright: 'test_runner',
  make: 'build_tool', tsc: 'build_tool', vite: 'build_tool', webpack: 'build_tool', esbuild: 'build_tool', eslint: 'linter', prettier: 'formatter',
  git: 'version_control', gh: 'version_control',
  sh: 'shell', bash: 'shell', zsh: 'shell', dash: 'shell', env: 'launcher', timeout: 'launcher', xargs: 'launcher', nice: 'launcher',
  node: 'interpreter', python: 'interpreter', python3: 'interpreter', ruby: 'interpreter', deno: 'interpreter', perl: 'interpreter',
  rm: 'file_mutation', mv: 'file_mutation', cp: 'file_mutation', chmod: 'file_mutation', ln: 'file_mutation', truncate: 'file_mutation',
  curl: 'network_client', wget: 'network_client', ssh: 'network_client', scp: 'network_client', rsync: 'network_client',
  cat: 'read_only', ls: 'read_only', grep: 'read_only', rg: 'read_only', find: 'read_only', head: 'read_only', tail: 'read_only', echo: 'read_only'
});

/** Package ecosystems the summary may name. The descriptor's ecosystem is agent-chosen text, so anything else is `other`. */
const PACKAGE_ECOSYSTEMS: ReadonlySet<string> = new Set(['npm', 'pypi', 'cargo', 'go', 'maven', 'nuget', 'rubygems', 'composer']);
const packageEcosystem = (ecosystem: string): string => (PACKAGE_ECOSYSTEMS.has(ecosystem) ? ecosystem : 'other');

const programCategory = (program: string | undefined): string => {
  const name = (program ?? '').split(/[\\/]/u).pop()?.toLowerCase() ?? '';
  return Object.hasOwn(PROGRAM_CATEGORIES, name) ? PROGRAM_CATEGORIES[name] as string : 'other';
};

const count = (paths: readonly string[], test: (parts: string[]) => boolean) => paths.filter((path) => test(pathSegments(path))).length;
const bounded = (value: number) => Math.min(Math.max(Math.trunc(value), 0), 10_000_000);

/**
 * The provider-facing state: typed, bounded, and free of any text the descriptor carries. Exported so
 * tests can assert exactly what would leave the runner.
 */
export function executionRiskState(descriptor: AgentActionDescriptor, subject: GateSubject, facts: AdvisorFacts = {}): string {
  if (!(AGENT_ACTION_CLASSES as readonly string[]).includes(subject.actionClass)) throw new Error('the gate subject has no known action class');
  const paths = descriptor.paths ?? [];
  const command = descriptor.command;
  const lines = [
    'Cloud Harness execution-risk summary. Every field is computed by the runner; none is agent or issue text.',
    // The class the gate judged, which is `publish_branch` for a declared `test` that runs `git push`.
    `action class: ${subject.actionClass}`,
    `git push in the command: ${subject.gitPush ? 'yes' : 'no'}`,
    'repository, branch, paths and command are inside the owner policy scope (checked by the deterministic gate)',
    `branch named: ${descriptor.branch ? 'yes' : 'no'}`,
    `paths touched: ${paths.length}`,
    `paths under test directories or named as tests: ${count(paths, (parts) => parts.some((part) => part === 'test' || part === 'tests' || part === '__tests__' || /\.(?:test|spec)\.[a-z0-9]+$/u.test(part)))}`,
    `dependency manifests or lockfiles touched: ${count(paths, isDependencyManifest)}`,
    `CI or workflow files touched: ${count(paths, isCiConfiguration)}`,
    `hidden files or directories touched: ${count(paths, (parts) => parts.some((part) => part.startsWith('.')))}`,
    command
      ? `command: category ${programCategory(command[0])}, ${command.length} argument(s), digest ${createHash('sha256').update(JSON.stringify(command)).digest('hex').slice(0, 16)}`
      : 'command: none',
    `network host requested: ${descriptor.host ? 'yes' : 'no'}`,
    descriptor.package ? `package change: one package from the ${packageEcosystem(descriptor.package.ecosystem)} ecosystem` : 'package change: none',
    `changed lines in the diff: ${facts.diffLines === undefined ? 'unknown' : bounded(facts.diffLines)}`,
    `tests passed in this run: ${facts.testsPassed === undefined ? 'unknown' : facts.testsPassed ? 'yes' : 'no'}`
  ];
  return lines.join('\n');
}

export function executionRiskDecisionRequest(state: string): DecisionRequest {
  return {
    purpose: PURPOSE,
    state,
    questions: [
      {
        kind: 'score',
        key: EXECUTION_RISK_QUESTION_KEYS.risk,
        question: 'How risky is it to let a coding agent run this action without a human reviewing it first?',
        low: 'routine, reversible and narrowly scoped',
        high: 'destructive, irreversible, or broad in effect'
      },
      { kind: 'boolean', key: EXECUTION_RISK_QUESTION_KEYS.uncertainSideEffects, question: 'Could this action have side effects that this summary does not let you predict?' },
      { kind: 'boolean', key: EXECUTION_RISK_QUESTION_KEYS.humanRequired, question: 'Should a human review this action before it runs?' }
    ]
  };
}

/** The assessment from answers the plane already validated. Throws when one is missing, which the plane reports as `invalid_answer`. */
export function assessmentFromAnswers(answers: Record<string, DecisionAnswer>, decisionId: string): ExecutionRiskAssessment {
  const risk = answers[EXECUTION_RISK_QUESTION_KEYS.risk];
  if (!risk || risk.kind !== 'score') throw new Error('risk answer is missing');
  const probability = (key: string): number => {
    const answer = answers[key];
    if (!answer || answer.kind !== 'boolean') throw new Error(`${key} answer is missing`);
    return answer.probability;
  };
  // Raw values, never rounded: a threshold compared against a rounded confidence could clear an action
  // whose real confidence is just below the floor.
  return {
    decisionId,
    risk: risk.value,
    confidence: risk.confidence,
    uncertainSideEffects: probability(EXECUTION_RISK_QUESTION_KEYS.uncertainSideEffects),
    humanRequired: probability(EXECUTION_RISK_QUESTION_KEYS.humanRequired)
  };
}

/** The policy decides what an assessment means. Low confidence is a fallback, never a clearance. */
export function adviceFor(assessment: ExecutionRiskAssessment, settings: Pick<PolicyAdvisor, 'riskThreshold' | 'minConfidence'>): Pick<AdvisorAnswer, 'effect' | 'fallbackReason'> {
  if (assessment.confidence < settings.minConfidence) return { effect: 'escalate', fallbackReason: 'low_confidence' };
  const escalate = assessment.risk >= settings.riskThreshold
    || assessment.uncertainSideEffects >= FLAG_THRESHOLD
    || assessment.humanRequired >= FLAG_THRESHOLD;
  return { effect: escalate ? 'escalate' : 'no_change', fallbackReason: null };
}

/** The Decision Plane's fallback reasons, folded into the advisor's smaller vocabulary. */
export function advisorFallbackReason(reason: DecisionFallbackReason): AdvisorFallbackReason {
  switch (reason) {
    case 'purpose_disabled': return 'disabled';
    case 'not_configured': return 'unconfigured';
    case 'timeout': return 'timeout';
    case 'rate_limited': return 'rate_limited';
    case 'redaction_failed': return 'redaction_failed';
    case 'low_confidence': return 'low_confidence';
    case 'invalid_answer':
    case 'unexpected_response': return 'invalid_answer';
    default: return 'unavailable';
  }
}

export class ExecutionRiskAdvisor implements DecisionAdvisor {
  readonly contractVersion = AGENT_GOVERNANCE_PORTS_VERSION;

  constructor(private readonly plane: DecisionPlane) {}

  /**
   * `disabled` when the operator has not enabled the purpose (or TypeSafe egress is off),
   * `unconfigured` when the owner has no TypeSafe credential. Neither makes a call.
   */
  availability(principalId: string): AdvisorAvailability {
    if (!this.plane.enabled(PURPOSE)) return { available: false, reason: 'disabled' };
    if (!this.plane.available(principalId, PURPOSE)) return { available: false, reason: 'unconfigured' };
    return { available: true };
  }

  async advise(request: Parameters<DecisionAdvisor['advise']>[0]): Promise<AdvisorAnswer> {
    const fallback = (reason: AdvisorFallbackReason, decisionId: string | null = null): AdvisorAnswer => ({ effect: 'escalate', decisionId, fallbackReason: reason });
    try {
      const availability = this.availability(request.principalId);
      if (!availability.available) return fallback(availability.reason);
      // CI and dependency changes always go to a human, decided here with no egress.
      if (touchesSensitivePaths(request.descriptor.paths)) return fallback('sensitive_paths');
      // A summary that cannot be built (an unknown subject class) is not sent; the policy fallback applies.
      let summary: string;
      try {
        summary = executionRiskState(request.descriptor, request.subject, request.facts);
      } catch {
        return fallback('invalid_answer');
      }
      // The summary holds no free text, but it is still redacted whole before anything is sent; when
      // redaction cannot complete nothing is sent at all.
      const redacted = this.plane.redact(request.principalId, [summary]);
      const state = redacted?.texts[0];
      if (!redacted || state === undefined) return fallback('redaction_failed');
      let assessment: ExecutionRiskAssessment | undefined;
      const outcome = await this.plane.evaluate(request.principalId, executionRiskDecisionRequest(state), (answers) => {
        assessment = assessmentFromAnswers(answers, '');
        const advice = adviceFor(assessment, request.settings);
        return { selected: advice.fallbackReason ?? advice.effect, confidence: assessment.confidence, policyEffect: advice.effect };
      }, { ...(request.signal ? { signal: request.signal } : {}), redactionCount: redacted.count });
      if (!outcome.ok) return fallback(advisorFallbackReason(outcome.reason), outcome.reason === 'purpose_disabled' ? null : outcome.decisionId);
      if (!assessment) return fallback('invalid_answer', outcome.decisionId);
      return { ...adviceFor(assessment, request.settings), decisionId: outcome.decisionId, risk: assessment.risk, confidence: assessment.confidence };
    } catch {
      // The port never throws: an unexpected failure is a conservative fallback.
      return fallback('unavailable');
    }
  }
}
