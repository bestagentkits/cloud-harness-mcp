import {
  AdvisorEffectSchema,
  type AdvisorEffect,
  type AgentActionClass,
  type AgentActionDescriptor,
  type AgentPlatformEffect,
  type EffectivePolicy,
  type GateContext,
  type GateDecision,
  type GateDecisionValue,
  type GateReason,
  type GateReasonCode,
  type GlobalExecutionPolicy,
  type PolicyScope,
  type ProjectExecutionPolicy
} from '@cloud-harness/contracts';
import { AGENT_GOVERNANCE_PORTS_VERSION, type GateEvaluator as GateEvaluatorPort } from './ports.js';
import { analyzeCommand, DATA_ONLY_PROGRAMS, DOCKER_PROGRAMS, isValidBranchName, PRIVILEGE_PROGRAMS, programName, type GitPush } from './command-analysis.js';
import { actionFingerprint, commandAdmitted, listAdmits, normalizeWorkspacePath, resolveEffectivePolicy } from './policy-merge.js';

/**
 * The single gate every agent action passes. `evaluateGate` is a pure function of the descriptor,
 * the policy snapshot and the runtime context: the Dashboard simulation, the effective-policy
 * preview and the execution broker all call it, so a preview cannot drift from enforcement.
 *
 * Precedence, evaluated in order (the first terminal outcome wins):
 *  1. Platform invariants (credentials, Docker, network escalation, paths outside the workspace, and a
 *     container runtime or privilege tool in program position after unwrapping launchers) -> DENY
 *  2. Runtime facts: orphaned/unknown project, revoked grant, stale generation, stale policy, budget -> DENY
 *  3. Global hard-deny -> DENY
 *  4. Repository, branch, path, command, package and host scope (deny on a miss) -> DENY
 *  5. Class not in the global allowed classes -> DENY
 *  6. Project narrowing (project hard-deny, class removed) -> DENY
 *  7. Global or project mandatory approval -> REQUIRE_APPROVAL
 *  8. Effective rule (global default, or a project rule the merge accepted) -> ALLOW / REQUIRE_APPROVAL
 *  9. `advisor_or_approval`: REQUIRE_APPROVAL (`ADVISOR_REQUIRED`, pending) when an advisor is configured,
 *     which only `combineAdvisor`/`decide` with a valid `no_change` answer turns into ALLOW;
 *     REQUIRE_APPROVAL (`ADVISOR_UNAVAILABLE`) with no advisor
 *
 * A command the analysis in `command-analysis.ts` cannot read completely is not a definite violation:
 * steps 2-9 still run, and anything short of DENY becomes a mandatory REQUIRE_APPROVAL with
 * `PLATFORM_COMMAND_UNANALYZABLE`, which no advisor answer and no project rule can lower.
 *
 * A command that runs `git push` is evaluated twice, as its declared class and as `publish_branch`, and
 * the stricter decision wins, so a push cannot escape a publish hard deny, approval or rule by being
 * declared as `test`, `read` or `vcs_local`.
 *
 * The descriptor's free-text `reason` is never read.
 */

export type GlobalPolicySnapshot = {
  revisionId: string | null;
  document: GlobalExecutionPolicy;
  source: 'stored' | 'default' | 'draft';
};

export type ProjectPolicySnapshot = {
  projectId: string;
  /** Whether Cloud Harness still knows this project for the principal. */
  state: 'active' | 'unknown';
  revisionId: string | null;
  document: ProjectExecutionPolicy | null;
  source: 'stored' | 'absent' | 'draft';
};

export type PolicySnapshot = {
  global: GlobalPolicySnapshot;
  /** `null` when the action has no project binding. */
  project: ProjectPolicySnapshot | null;
};

export type GateInput = {
  descriptor: AgentActionDescriptor;
  snapshot: PolicySnapshot;
  context?: GateContext | undefined;
  /** True only when an advisor is configured and will be consulted for this action. */
  advisorAvailable?: boolean | undefined;
};

export type AdvisorAnswer = { effect: AdvisorEffect; decisionId?: string | null | undefined };

type Verdict = { decision: GateDecisionValue; code: GateReasonCode; source: GateReason['source']; detail: string; rule?: string };


const PLATFORM_EFFECT_CODES: Record<AgentPlatformEffect, GateReasonCode> = {
  credential_access: 'PLATFORM_CREDENTIAL_ACCESS',
  docker_access: 'PLATFORM_DOCKER_ACCESS',
  network_escalation: 'PLATFORM_NETWORK_ESCALATION',
  outside_workspace: 'PLATFORM_OUTSIDE_WORKSPACE',
  privilege_escalation: 'PLATFORM_PRIVILEGE_ESCALATION'
};
const BRANCH_CLASSES = new Set<AgentActionClass>(['publish_branch', 'open_pr']);
const BRANCH_CHECKED_CLASSES = new Set<AgentActionClass>(['publish_branch', 'open_pr', 'vcs_local']);

function escapesWorkspace(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:/u.test(path) || path.includes('\\') || path.split('/').includes('..');
}

/** `verdict` is a definite platform DENY; `unanalyzable` (the reason) forces a mandatory approval. */
type Inspection = { verdict?: Verdict | undefined; unanalyzable?: string | undefined; pushes: GitPush[] };

const unanalyzable = (detail: string): Verdict => ({ decision: 'REQUIRE_APPROVAL', code: 'PLATFORM_COMMAND_UNANALYZABLE', source: 'platform', detail });

/** Step 1, plus the `git push` invocations the command runs. A failure here is unanalyzable, never a crash. */
function inspect(descriptor: AgentActionDescriptor): Inspection {
  try {
    return inspectUnchecked(descriptor);
  } catch {
    return { unanalyzable: 'the command could not be analysed', pushes: [] };
  }
}

/**
 * Step 1. The broker's own classification, plus what the descriptor itself proves: a definite DENY,
 * or the mandatory REQUIRE_APPROVAL of a command that cannot be analysed.
 */
export function platformViolation(descriptor: AgentActionDescriptor): Verdict | undefined {
  const inspection = inspect(descriptor);
  return inspection.verdict ?? (inspection.unanalyzable ? unanalyzable(inspection.unanalyzable) : undefined);
}

function inspectUnchecked(descriptor: AgentActionDescriptor): Inspection {
  const effect = descriptor.platformEffects[0];
  if (effect) {
    return { verdict: { decision: 'DENY', code: PLATFORM_EFFECT_CODES[effect], source: 'platform', detail: `the platform never permits ${effect.replaceAll('_', ' ')}` }, pushes: [] };
  }
  for (const path of descriptor.paths ?? []) {
    if (escapesWorkspace(path)) return { verdict: { decision: 'DENY', code: 'PLATFORM_OUTSIDE_WORKSPACE', source: 'platform', detail: 'a path leaves the workspace' }, pushes: [] };
    if (descriptor.actionClass !== 'read' && normalizeWorkspacePath(path).split('/').includes('.git')) {
      return { verdict: { decision: 'DENY', code: 'PLATFORM_PROTECTED_PATH', source: 'platform', detail: 'repository metadata (.git) is runner-owned' }, pushes: [] };
    }
  }
  const argv = descriptor.command ?? [];
  if (argv.length === 0) return { pushes: [] };
  // Every program the argv runs, looking through launchers; a shell string is never read. The segments
  // read before an analysis failure still count, so a definite match denies even then.
  const analysis = analyzeCommand(argv);
  const definite = definitePlatformAccess(analysis.segments);
  if (definite) return { verdict: definite, pushes: analysis.pushes };
  return analysis.ok ? { pushes: analysis.pushes } : { unanalyzable: `the command cannot be analysed: ${analysis.reason}`, pushes: analysis.pushes };
}

/**
 * A container runtime or privilege tool in program position, or the Docker socket handed to a
 * program that is not data-only (`curl --unix-socket .../docker.sock`). A name elsewhere in the
 * arguments is not definite; the analysis reports it as unanalyzable instead.
 */
function definitePlatformAccess(segments: readonly string[][]): Verdict | undefined {
  const programs = segments.map((segment) => programName(segment[0] ?? ''));
  // The exemption for data-only programs (`grep docker.sock docs/`) is safe only because that list
  // holds no tool that can run another program; `runsAnotherProgram` gates every such option.
  const socket = segments.some((segment) => !DATA_ONLY_PROGRAMS.has(programName(segment[0] ?? '')) && segment.some((word) => word.includes('docker.sock')));
  if (socket || programs.some((program) => DOCKER_PROGRAMS.has(program))) {
    return { decision: 'DENY', code: 'PLATFORM_DOCKER_ACCESS', source: 'platform', detail: 'container runtimes are never reachable from an agent' };
  }
  if (programs.some((program) => PRIVILEGE_PROGRAMS.has(program))) {
    return { decision: 'DENY', code: 'PLATFORM_PRIVILEGE_ESCALATION', source: 'platform', detail: 'privilege changes are never permitted' };
  }
  return undefined;
}

/** Step 2. Facts that only exist at execution time. */
function runtimeViolation(input: GateInput, effective: EffectivePolicy): Verdict | undefined {
  const { snapshot, context } = input;
  const project = snapshot.project;
  if (project && project.state === 'unknown') {
    return project.document
      ? { decision: 'DENY', code: 'PROJECT_POLICY_ORPHANED', source: 'runtime', detail: 'the project this policy belongs to no longer exists' }
      : { decision: 'DENY', code: 'PROJECT_UNKNOWN', source: 'runtime', detail: 'the bound project is not known to Cloud Harness' };
  }
  if (context?.revoked) return { decision: 'DENY', code: 'GRANT_REVOKED', source: 'runtime', detail: 'the grant for this run was revoked' };
  const generation = context?.workspaceGeneration;
  if (generation && generation.pinned !== generation.current) {
    return { decision: 'DENY', code: 'GENERATION_STALE', source: 'runtime', detail: `workspace generation ${generation.pinned} is no longer current` };
  }
  const pinned = context?.pinned;
  if (pinned && (pinned.globalRevisionId !== snapshot.global.revisionId || pinned.projectRevisionId !== (project?.revisionId ?? null))) {
    return { decision: 'DENY', code: 'POLICY_STALE', source: 'runtime', detail: 'the policy changed after this run was admitted' };
  }
  const usage = context?.usage;
  if (usage) {
    const limits: Array<[number | undefined, number, string]> = [
      [usage.costMicros, effective.budget.maxCostMicrosPerRun, 'cost'],
      [usage.inputTokens, effective.budget.maxInputTokensPerRun, 'input tokens'],
      [usage.outputTokens, effective.budget.maxOutputTokensPerRun, 'output tokens'],
      [usage.elapsedSeconds, effective.budget.maxRunSeconds, 'run time'],
      [usage.concurrentRuns, effective.budget.maxConcurrentRuns, 'concurrent runs']
    ];
    for (const [used, limit, label] of limits) {
      if (used !== undefined && used >= limit) return { decision: 'DENY', code: 'BUDGET_EXHAUSTED', source: 'runtime', detail: `${label} reached the limit of ${limit}` };
    }
  }
  return undefined;
}

/** Step 4. Deny on any miss; a class that needs a target and has none is denied too. */
function scopeViolation(
  descriptor: AgentActionDescriptor,
  actionClass: AgentActionClass,
  pushes: readonly GitPush[],
  scope: PolicyScope,
  source: 'global' | 'project'
): Verdict | undefined {
  const deny = (code: GateReasonCode, detail: string): Verdict => ({ decision: 'DENY', code, source, detail, rule: `${source}.scope` });
  if (!listAdmits('repositories', scope.repositories, descriptor.repository)) return deny('REPOSITORY_OUT_OF_SCOPE', `${source} repositories do not include this repository`);
  if ((BRANCH_CLASSES.has(actionClass) || pushes.length > 0) && !descriptor.branch) return deny('BRANCH_REQUIRED', `${pushes.length > 0 ? 'git push' : actionClass} must name its branch`);
  if (descriptor.branch && !isValidBranchName(descriptor.branch)) return deny('BRANCH_INVALID', 'the branch is not a valid git branch name');
  if (descriptor.branch && (BRANCH_CHECKED_CLASSES.has(actionClass) || pushes.length > 0) && !listAdmits('branchPrefixes', scope.branchPrefixes, descriptor.branch)) {
    return deny('BRANCH_OUT_OF_SCOPE', `${source} branch prefixes do not include this branch`);
  }
  for (const push of pushes) {
    if (push.implicit) return deny('BRANCH_REQUIRED', 'git push must name its refspec; without one git configuration decides what is pushed');
    if (push.broad) return deny('BRANCH_OUT_OF_SCOPE', 'git push may only update named branches (no --all, --mirror, --tags or deletions)');
    for (const destination of push.destinations) {
      if (!isValidBranchName(destination)) return deny('BRANCH_INVALID', 'a git push destination is not a valid branch name');
      if (destination !== descriptor.branch || !listAdmits('branchPrefixes', scope.branchPrefixes, destination)) {
        return deny('BRANCH_OUT_OF_SCOPE', `git push must target the declared branch inside the ${source} branch prefixes`);
      }
    }
  }
  if (actionClass === 'edit' && !(descriptor.paths?.length)) return deny('PATH_REQUIRED', 'edit must name the paths it changes');
  for (const path of descriptor.paths ?? []) {
    if (!listAdmits('pathScopes', scope.pathScopes, path)) return deny('PATH_OUT_OF_SCOPE', `${source} path scopes do not include a requested path`);
  }
  if (actionClass === 'test' && !descriptor.command) return deny('COMMAND_REQUIRED', 'test must name its command');
  if (descriptor.command && !commandAdmitted(scope.commands, descriptor.command)) return deny('COMMAND_NOT_ALLOWED', `${source} commands do not include this command`);
  if (actionClass === 'package_install') {
    const requested = descriptor.package;
    if (!requested) return deny('PACKAGE_REQUIRED', 'package_install must name its package');
    if (!listAdmits('packages', scope.packages, `${requested.ecosystem}:${requested.name}`)) return deny('PACKAGE_NOT_ALLOWED', `${source} packages do not include this package`);
    if (!listAdmits('registries', scope.registries, requested.registry)) return deny('REGISTRY_NOT_ALLOWED', `${source} registries do not include this registry`);
  }
  if (actionClass === 'network') {
    if (!descriptor.host) return deny('HOST_REQUIRED', 'network must name its host');
    if (!listAdmits('networkHosts', scope.networkHosts, descriptor.host)) return deny('HOST_NOT_ALLOWED', `${source} network hosts do not include this host`);
  }
  return undefined;
}

function projectSource(snapshot: PolicySnapshot): GateDecision['policy']['projectSource'] {
  const project = snapshot.project;
  if (!project) return 'none';
  if (project.state === 'unknown') return project.document ? 'orphaned' : 'unknown';
  return project.source;
}

/** Orders decisions by strictness; a pending advisor decision is weaker than a plain approval because it can clear. */
function strictness(decision: GateDecision): number {
  if (decision.decision === 'DENY') return 4;
  if (decision.decision === 'REQUIRE_APPROVAL') return isAdvisorPending(decision) ? 2 : 3;
  return 0;
}

export function evaluateGate(input: GateInput): GateDecision {
  const inspection = inspect(input.descriptor);
  const declared = evaluateAs(input, input.descriptor.actionClass, inspection);
  const decision = inspection.verdict || inspection.pushes.length === 0 || input.descriptor.actionClass === 'publish_branch'
    ? declared
    : [evaluateAs(input, 'publish_branch', inspection), declared].reduce((stricter, next) => (strictness(next) > strictness(stricter) ? next : stricter));
  return inspection.unanalyzable ? requireUnanalyzableApproval(decision, inspection.unanalyzable) : decision;
}

/**
 * An unanalyzable command needs a human: anything short of DENY (a hard deny, a scope deny or the
 * publish evaluation of a detected push) becomes REQUIRE_APPROVAL. It is not advisor-pending, so
 * `combineAdvisor` keeps it, and it is applied after the merge, so no project rule lowers it.
 */
function requireUnanalyzableApproval(decision: GateDecision, reason: string): GateDecision {
  if (decision.decision === 'DENY') return decision;
  return {
    ...decision,
    decision: 'REQUIRE_APPROVAL',
    reasonCode: 'PLATFORM_COMMAND_UNANALYZABLE',
    reasons: [{ code: 'PLATFORM_COMMAND_UNANALYZABLE' as const, source: 'platform' as const, detail: reason.slice(0, 300) }, ...decision.reasons].slice(0, 50),
    matchedRules: ['platform', ...decision.matchedRules].slice(0, 50),
    advisor: { ...decision.advisor, required: false }
  };
}

/** Steps 1-9 for one action class. The decision always reports the descriptor's declared class. */
function evaluateAs(input: GateInput, actionClass: AgentActionClass, inspection: Inspection): GateDecision {
  const { descriptor, snapshot } = input;
  const global = snapshot.global.document;
  const project = snapshot.project?.state === 'active' ? snapshot.project.document : null;
  const effective = resolveEffectivePolicy(global, project);
  const reasons: GateReason[] = [];
  const matchedRules: string[] = [];
  if (snapshot.global.source === 'default') reasons.push({ code: 'GLOBAL_POLICY_DEFAULT', source: 'default', detail: 'no global policy is saved; the read-only default applies' });
  if (snapshot.project?.state === 'active' && !snapshot.project.document) reasons.push({ code: 'PROJECT_POLICY_ABSENT', source: 'default', detail: 'the project has no policy; the global policy applies alone' });
  if (effective.ignoredProjectFields.length > 0) {
    reasons.push({ code: 'PROJECT_WIDENING_IGNORED', source: 'project', detail: `${effective.ignoredProjectFields.length} project field(s) would widen the global policy and were ignored` });
  }

  const finish = (verdict: Verdict, advisorRequired = false): GateDecision => {
    reasons.unshift({ code: verdict.code, source: verdict.source, detail: verdict.detail.slice(0, 300) });
    if (verdict.rule) matchedRules.unshift(verdict.rule);
    return {
      version: 1,
      decision: verdict.decision,
      reasonCode: verdict.code,
      reasons: reasons.slice(0, 50),
      matchedRules: matchedRules.slice(0, 50),
      actionClass: descriptor.actionClass,
      policy: {
        globalRevisionId: snapshot.global.revisionId,
        globalSource: snapshot.global.source,
        projectId: snapshot.project?.projectId ?? null,
        projectRevisionId: snapshot.project?.revisionId ?? null,
        projectSource: projectSource(snapshot)
      },
      inputFingerprint: actionFingerprint(descriptor),
      advisor: { required: advisorRequired, consulted: false, effect: null, decisionId: null },
      approval: { ttlSeconds: effective.approval.ttlSeconds, approverRoles: [...effective.approval.approverRoles] }
    };
  };

  if (inspection.verdict) return finish({ ...inspection.verdict, rule: 'platform' });
  const runtime = runtimeViolation(input, effective);
  if (runtime) return finish({ ...runtime, rule: 'runtime' });
  if (global.hardDeny.includes(actionClass)) {
    return finish({ decision: 'DENY', code: 'GLOBAL_HARD_DENY', source: 'global', detail: `the global policy hard-denies ${actionClass}`, rule: `global.hardDeny.${actionClass}` });
  }
  const scope = scopeViolation(descriptor, actionClass, inspection.pushes, global.scope, 'global') ?? scopeViolation(descriptor, actionClass, inspection.pushes, effective.scope, 'project');
  if (scope) return finish(scope);
  if (!global.allowedActionClasses.includes(actionClass)) {
    return finish({ decision: 'DENY', code: 'ACTION_CLASS_NOT_ALLOWED', source: snapshot.global.source === 'default' ? 'default' : 'global', detail: `the global policy does not allow ${actionClass}`, rule: 'global.allowedActionClasses' });
  }
  if (project?.hardDeny?.includes(actionClass)) {
    return finish({ decision: 'DENY', code: 'PROJECT_HARD_DENY', source: 'project', detail: `the project policy denies ${actionClass}`, rule: `project.hardDeny.${actionClass}` });
  }
  if (!effective.allowedActionClasses.includes(actionClass)) {
    return finish({ decision: 'DENY', code: 'PROJECT_CLASS_REMOVED', source: 'project', detail: `the project policy does not allow ${actionClass}`, rule: 'project.allowedActionClasses' });
  }
  if (global.mandatoryApproval.includes(actionClass)) {
    return finish({ decision: 'REQUIRE_APPROVAL', code: 'MANDATORY_APPROVAL', source: 'global', detail: `the global policy always requires approval for ${actionClass}`, rule: `global.mandatoryApproval.${actionClass}` });
  }
  if (effective.mandatoryApproval.includes(actionClass)) {
    return finish({ decision: 'REQUIRE_APPROVAL', code: 'PROJECT_MANDATORY_APPROVAL', source: 'project', detail: `the project policy always requires approval for ${actionClass}`, rule: `project.mandatoryApproval.${actionClass}` });
  }
  const rule = effective.effects.find((entry) => entry.actionClass === actionClass);
  // The merge returns an effect for every allowed class; a missing one would be a merge defect, so fail closed.
  if (!rule) return finish({ decision: 'DENY', code: 'ACTION_CLASS_NOT_ALLOWED', source: 'global', detail: `no effect resolved for ${actionClass}` });
  const ruleName = `${rule.source}.${rule.source === 'project' ? 'rules' : 'defaults'}.${actionClass}`;
  if (rule.effect === 'allow') return finish({ decision: 'ALLOW', code: 'RULE_ALLOW', source: rule.source, detail: `${actionClass} is allowed by the ${rule.source} policy`, rule: ruleName });
  if (rule.effect === 'require_approval') {
    return finish({ decision: 'REQUIRE_APPROVAL', code: 'RULE_REQUIRE_APPROVAL', source: rule.source, detail: `${actionClass} requires approval under the ${rule.source} policy`, rule: ruleName });
  }
  if (input.advisorAvailable) {
    return finish({ decision: 'REQUIRE_APPROVAL', code: 'ADVISOR_REQUIRED', source: rule.source, detail: `${actionClass} is discretionary and must be cleared by the advisor`, rule: ruleName }, true);
  }
  return finish({ decision: 'REQUIRE_APPROVAL', code: 'ADVISOR_UNAVAILABLE', source: rule.source, detail: `${actionClass} is discretionary and no advisor is available`, rule: ruleName });
}

/** True for the one decision an advisor may clear: discretionary, advisor required, not yet consulted. */
export function isAdvisorPending(decision: GateDecision): boolean {
  return decision.decision === 'REQUIRE_APPROVAL' && decision.reasonCode === 'ADVISOR_REQUIRED' && decision.advisor.required && !decision.advisor.consulted;
}

/**
 * Applies an advisor answer.
 *
 * - A pending discretionary decision (`ADVISOR_REQUIRED`) becomes ALLOW only on a valid `no_change`.
 *   Any other answer, no answer, or a malformed one leaves it at REQUIRE_APPROVAL (`ADVISOR_ESCALATED`).
 * - Every other decision is monotonic: `final = max(decision, advisor)` over ALLOW < REQUIRE_APPROVAL < DENY,
 *   so a hard deny, a scope deny, a mandatory approval or a rule approval is never lowered.
 */
export function combineAdvisor(decision: GateDecision, answer: AdvisorAnswer | null): GateDecision {
  const parsed = AdvisorEffectSchema.safeParse(answer?.effect);
  const consulted = answer !== null && parsed.success;
  const decisionId = consulted && typeof answer?.decisionId === 'string' ? answer.decisionId.slice(0, 200) : null;
  const advisor = { required: decision.advisor.required, consulted, effect: consulted ? parsed.data : null, decisionId };
  const escalate = (detail: string): GateDecision => ({
    ...decision,
    decision: 'REQUIRE_APPROVAL',
    reasonCode: 'ADVISOR_ESCALATED',
    advisor,
    reasons: [{ code: 'ADVISOR_ESCALATED' as const, source: 'advisor' as const, detail }, ...decision.reasons].slice(0, 50),
    matchedRules: ['advisor', ...decision.matchedRules].slice(0, 50)
  });
  if (isAdvisorPending(decision)) {
    if (consulted && parsed.data === 'no_change') {
      return {
        ...decision,
        decision: 'ALLOW',
        reasonCode: 'ADVISOR_NO_CHANGE',
        advisor,
        reasons: [{ code: 'ADVISOR_NO_CHANGE' as const, source: 'advisor' as const, detail: 'the advisor cleared the discretionary action' }, ...decision.reasons].slice(0, 50),
        matchedRules: ['advisor', ...decision.matchedRules].slice(0, 50)
      };
    }
    return escalate(consulted ? 'the advisor asked for human approval' : 'the advisor did not answer; approval is required');
  }
  if (!consulted) return decision;
  if (parsed.data === 'escalate' && decision.decision === 'ALLOW') return escalate('the advisor asked for human approval');
  return { ...decision, advisor };
}

/**
 * The whole gate in one call: evaluate, then apply the advisor when the decision is waiting for one.
 * `answer` is ignored for decisions that do not need an advisor and treated as no answer when absent,
 * so a caller that forgets to ask can never turn a pending decision into ALLOW.
 */
export function decide(input: GateInput, answer: AdvisorAnswer | null = null): GateDecision {
  const decision = evaluateGate(input);
  return isAdvisorPending(decision) ? combineAdvisor(decision, answer) : decision;
}

/** The pure evaluator behind the `GateEvaluator` port; simulation and the broker share this instance. */
export const PURE_GATE_EVALUATOR: GateEvaluatorPort = Object.freeze({
  contractVersion: AGENT_GOVERNANCE_PORTS_VERSION,
  evaluate: (input: GateInput) => evaluateGate(input),
  combineAdvisor,
  decide
});