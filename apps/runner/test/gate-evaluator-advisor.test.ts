import { describe, expect, it } from 'vitest';
import {
  ADVISOR_FALLBACK_REASONS,
  AGENT_ACTION_CLASSES,
  AgentActionDescriptorSchema,
  DEFAULT_GLOBAL_EXECUTION_POLICY,
  DEFAULT_POLICY_ADVISOR,
  GATE_DECISION_RANK,
  GateDecisionSchema,
  GlobalExecutionPolicySchema,
  ProjectExecutionPolicySchema,
  type AgentActionClass,
  type AgentActionDescriptorInput,
  type GlobalExecutionPolicy,
  type PolicyAdvisor,
  type PolicyRuleEffect,
  type ProjectExecutionPolicy
} from '@cloud-harness/contracts';
import { combineAdvisor, decide, evaluateGate, isAdvisorPending, type AdvisorAnswer, type PolicySnapshot } from '../src/agent-governance/gate-evaluator.js';
import { policyWeakenings, resolveEffectivePolicy } from '../src/agent-governance/policy-merge.js';

const PROJECT = `prj_${'p'.repeat(32)}`;
const ADVISOR: PolicyAdvisor = { enabled: true, riskThreshold: 0.5, minConfidence: 0.7, fallback: 'require_approval' };

const globalPolicy = (patch: Partial<GlobalExecutionPolicy> = {}): GlobalExecutionPolicy => GlobalExecutionPolicySchema.parse({
  version: 1,
  hardDeny: [],
  mandatoryApproval: [],
  allowedActionClasses: [...AGENT_ACTION_CLASSES],
  defaults: Object.fromEntries(AGENT_ACTION_CLASSES.map((value) => [value, { effect: 'advisor_or_approval', delegable: true }])),
  scope: {
    repositories: ['acme/*'], branchPrefixes: ['agent/'], pathScopes: ['*'], commands: ['*'],
    packages: ['npm:*'], registries: ['registry.npmjs.org'], networkHosts: ['*.github.com']
  },
  budget: { maxCostMicrosPerRun: 1_000_000, maxInputTokensPerRun: 100_000, maxOutputTokensPerRun: 10_000, maxRunSeconds: 600, maxConcurrentRuns: 2 },
  approval: { ttlSeconds: 3_600, approverRoles: ['owner'] },
  advisor: ADVISOR,
  ...patch
});

const project = (document: Omit<ProjectExecutionPolicy, 'version'>): ProjectExecutionPolicy => ProjectExecutionPolicySchema.parse({ version: 1, ...document });

const snapshot = (global: GlobalExecutionPolicy, projectDocument: ProjectExecutionPolicy | null = null): PolicySnapshot => ({
  global: { revisionId: null, document: global, source: 'stored' },
  project: projectDocument ? { projectId: PROJECT, state: 'active', revisionId: null, document: projectDocument, source: 'stored' } : null
});

function action(actionClass: AgentActionClass, extra: Partial<AgentActionDescriptorInput> = {}) {
  const defaults: Partial<Record<AgentActionClass, Partial<AgentActionDescriptorInput>>> = {
    edit: { paths: ['src/index.ts'] },
    test: { command: ['npm', 'test'] },
    publish_branch: { branch: 'agent/fix-1' },
    open_pr: { branch: 'agent/fix-1' },
    network: { host: 'api.github.com' },
    package_install: { package: { ecosystem: 'npm', name: 'zod', registry: 'registry.npmjs.org' } }
  };
  return AgentActionDescriptorSchema.parse({ version: 1, actionClass, repository: 'acme/widgets', ...defaults[actionClass], ...extra });
}

function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
  const subset = <T>(values: readonly T[]): T[] => values.filter(() => next() < 0.5);
  return { next, pick, subset };
}

const EFFECTS: PolicyRuleEffect[] = ['allow', 'advisor_or_approval', 'require_approval'];

describe('advisor combination with the real gate evaluator', () => {
  it('is monotonic: only a confident no_change clears a pending decision, nothing else ever lowers one', () => {
    const random = generator(333);
    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      const hardDeny = random.subset(AGENT_ACTION_CLASSES).filter(() => random.next() < 0.25);
      const policy = globalPolicy({
        hardDeny,
        allowedActionClasses: random.subset(AGENT_ACTION_CLASSES).filter((value) => !hardDeny.includes(value)),
        mandatoryApproval: random.subset(AGENT_ACTION_CLASSES).filter((value) => !hardDeny.includes(value) && random.next() < 0.3),
        defaults: Object.fromEntries(random.subset(AGENT_ACTION_CLASSES).map((value) => [value, { effect: random.pick(EFFECTS), delegable: random.next() < 0.5 }])),
        advisor: { ...ADVISOR, enabled: random.next() < 0.8, fallback: random.pick(['require_approval', 'deny'] as const) }
      });
      const actionClass = random.pick(AGENT_ACTION_CLASSES);
      const command = random.pick([undefined, ['npm', 'test'], ['eval', 'npm test'], ['docker', 'ps']]);
      const descriptor = action(actionClass, command ? { command } : {});
      const input = { descriptor, snapshot: snapshot(policy), advisorAvailable: random.next() < 0.7, advisorUnavailableReason: random.pick(['disabled', 'unconfigured'] as const) };
      const decision = evaluateGate(input);
      expect(GateDecisionSchema.parse(decision)).toEqual(decision);
      const answer: AdvisorAnswer | null = random.next() < 0.1 ? null : {
        effect: random.pick(['no_change', 'escalate'] as const),
        decisionId: `dec_${iteration}`,
        risk: random.next(),
        confidence: random.next(),
        fallbackReason: random.next() < 0.5 ? null : random.pick(ADVISOR_FALLBACK_REASONS)
      };
      const combined = combineAdvisor(decision, answer);
      expect(GateDecisionSchema.parse(combined)).toEqual(combined);
      expect(decide(input, answer)).toEqual(isAdvisorPending(decision) ? combined : decision);
      if (isAdvisorPending(decision)) {
        const cleared = answer !== null && answer.effect === 'no_change' && answer.fallbackReason === null;
        const expected = cleared ? 'ALLOW' : answer?.fallbackReason !== null && policy.advisor?.fallback === 'deny' ? 'DENY' : 'REQUIRE_APPROVAL';
        expect(combined.decision, `iteration ${iteration}`).toBe(expected);
        continue;
      }
      // Everything else: final = max(deterministic, advisor), and a non-ALLOW decision is kept exactly.
      expect(GATE_DECISION_RANK[combined.decision]).toBeGreaterThanOrEqual(GATE_DECISION_RANK[decision.decision]);
      if (decision.decision !== 'ALLOW') {
        expect(combined.decision).toBe(decision.decision);
        expect(combined.reasonCode).toBe(decision.reasonCode);
      }
      // The advisor is never the source of a DENY outside the owner's own fallback setting.
      if (combined.decision === 'DENY' && decision.decision !== 'DENY') throw new Error(`advisor produced a DENY at iteration ${iteration}`);
    }
  });

  it('never lets an advisor answer lower a mandatory approval, hard deny or unanalyzable command, even at confidence 1', () => {
    const reassuring: AdvisorAnswer = { effect: 'no_change', decisionId: 'dec_x', risk: 0, confidence: 1, fallbackReason: null };
    const cases = [
      { policy: globalPolicy({ mandatoryApproval: ['edit'] }), descriptor: action('edit'), decision: 'REQUIRE_APPROVAL', reason: 'MANDATORY_APPROVAL' },
      { policy: globalPolicy({ hardDeny: ['edit'], allowedActionClasses: AGENT_ACTION_CLASSES.filter((value) => value !== 'edit') }), descriptor: action('edit'), decision: 'DENY', reason: 'GLOBAL_HARD_DENY' },
      { policy: globalPolicy(), descriptor: action('test', { command: ['eval', 'npm test'] }), decision: 'REQUIRE_APPROVAL', reason: 'PLATFORM_COMMAND_UNANALYZABLE' },
      { policy: globalPolicy(), descriptor: action('test', { command: ['sudo', 'npm', 'test'] }), decision: 'DENY', reason: 'PLATFORM_PRIVILEGE_ESCALATION' },
      { policy: globalPolicy(), descriptor: action('edit', { repository: 'evil/widgets' }), decision: 'DENY', reason: 'REPOSITORY_OUT_OF_SCOPE' }
    ] as const;
    for (const entry of cases) {
      const input = { descriptor: entry.descriptor, snapshot: snapshot(entry.policy), advisorAvailable: true };
      const evaluated = evaluateGate(input);
      expect(isAdvisorPending(evaluated)).toBe(false);
      for (const result of [decide(input, reassuring), combineAdvisor(evaluated, reassuring)]) {
        expect(result).toMatchObject({ decision: entry.decision, reasonCode: entry.reason });
      }
    }
  });

  it('records the advisor answer on the decision it settled', () => {
    const input = { descriptor: action('edit'), snapshot: snapshot(globalPolicy()), advisorAvailable: true };
    const escalated = decide(input, { effect: 'escalate', decisionId: 'dec_1', risk: 0.9, confidence: 0.8, fallbackReason: null });
    expect(escalated).toMatchObject({ decision: 'REQUIRE_APPROVAL', reasonCode: 'ADVISOR_ESCALATED' });
    expect(escalated.advisor).toEqual({ required: true, consulted: true, effect: 'escalate', decisionId: 'dec_1', risk: 0.9, confidence: 0.8, fallbackReason: null, fallback: 'require_approval' });
    // A value outside [0, 1] is not recorded, and an unknown fallback reason is treated as unavailable.
    const odd = decide(input, { effect: 'no_change', risk: 7, confidence: Number.NaN, fallbackReason: 'surprise' as never });
    expect(odd).toMatchObject({ decision: 'REQUIRE_APPROVAL', advisor: { risk: null, confidence: null, fallbackReason: 'unavailable', consulted: false } });
  });

  it('applies the fallback before any call when the advisor is unavailable', () => {
    const descriptor = action('edit');
    expect(evaluateGate({ descriptor, snapshot: snapshot(globalPolicy()), advisorAvailable: false, advisorUnavailableReason: 'unconfigured' }))
      .toMatchObject({ decision: 'REQUIRE_APPROVAL', reasonCode: 'ADVISOR_UNAVAILABLE', advisor: { required: false, fallbackReason: 'unconfigured', fallback: 'require_approval' } });
    expect(evaluateGate({ descriptor, snapshot: snapshot(globalPolicy({ advisor: { ...ADVISOR, fallback: 'deny' } })) }))
      .toMatchObject({ decision: 'DENY', reasonCode: 'ADVISOR_FALLBACK_DENY', advisor: { fallbackReason: 'disabled', fallback: 'deny' } });
    // Without the policy opt-in the advisor is not involved at all, available or not.
    for (const advisorAvailable of [true, false]) {
      expect(evaluateGate({ descriptor, snapshot: snapshot(globalPolicy({ advisor: undefined })), advisorAvailable }))
        .toMatchObject({ decision: 'REQUIRE_APPROVAL', reasonCode: 'ADVISOR_UNAVAILABLE', advisor: { required: false, fallbackReason: null, fallback: null } });
    }
  });
});

describe('advisor settings in the policy merge', () => {
  it('defaults to a disabled advisor, including for the read-only default policy', () => {
    expect(resolveEffectivePolicy(DEFAULT_GLOBAL_EXECUTION_POLICY, null).advisor).toEqual(DEFAULT_POLICY_ADVISOR);
    expect(DEFAULT_POLICY_ADVISOR).toEqual({ enabled: false, riskThreshold: 0.5, minConfidence: 0.7, fallback: 'require_approval' });
  });

  it('lets a project only tighten the advisor', () => {
    const global = globalPolicy();
    const tightened = resolveEffectivePolicy(global, project({ advisor: { enabled: false, riskThreshold: 0.2, minConfidence: 0.9, fallback: 'deny' } }));
    expect(tightened.advisor).toEqual({ enabled: false, riskThreshold: 0.2, minConfidence: 0.9, fallback: 'deny' });
    expect(tightened.ignoredProjectFields).toEqual([]);

    const widened = resolveEffectivePolicy(globalPolicy({ advisor: { ...ADVISOR, enabled: false, fallback: 'deny' } }), project({ advisor: { enabled: true, riskThreshold: 0.9, minConfidence: 0.1, fallback: 'require_approval' } }));
    expect(widened.advisor).toEqual({ ...ADVISOR, enabled: false, fallback: 'deny' });
    expect(widened.ignoredProjectFields).toEqual([
      'advisor.enabled: the global policy does not enable the advisor',
      'advisor.riskThreshold: 0.9 exceeds the global 0.5',
      'advisor.minConfidence: 0.1 is below the global 0.7',
      'advisor.fallback: require_approval is softer than the global deny'
    ]);
  });

  it('treats a project that enables a globally disabled advisor as a widening the gate ignores', () => {
    const global = globalPolicy({ advisor: { ...ADVISOR, enabled: false } });
    const decision = evaluateGate({ descriptor: action('edit'), snapshot: snapshot(global, project({ advisor: { enabled: true } })), advisorAvailable: true });
    expect(decision).toMatchObject({ decision: 'REQUIRE_APPROVAL', reasonCode: 'ADVISOR_UNAVAILABLE', advisor: { required: false } });
    expect(decision.reasons.map((reason) => reason.code)).toContain('PROJECT_WIDENING_IGNORED');
  });

  it('lists every advisor loosening as a weakening the owner must confirm', () => {
    const off = resolveEffectivePolicy(globalPolicy({ advisor: { ...ADVISOR, enabled: false } }), null);
    const on = resolveEffectivePolicy(globalPolicy(), null);
    expect(policyWeakenings(off, on)).toEqual(['advisor: may now clear advisor_or_approval actions without a human']);
    expect(policyWeakenings(on, off)).toEqual([]);
    const strict = resolveEffectivePolicy(globalPolicy({ advisor: { enabled: true, riskThreshold: 0.3, minConfidence: 0.9, fallback: 'deny' } }), null);
    expect(policyWeakenings(strict, on)).toEqual([
      'advisor.riskThreshold: 0.3 becomes 0.5',
      'advisor.minConfidence: 0.9 becomes 0.7',
      'advisor.fallback: deny becomes require_approval'
    ]);
    expect(policyWeakenings(on, strict)).toEqual([]);
  });

  it('rejects advisor settings outside their ranges', () => {
    for (const advisor of [{ ...ADVISOR, riskThreshold: 1.5 }, { ...ADVISOR, minConfidence: -0.1 }, { ...ADVISOR, fallback: 'allow' }, { ...ADVISOR, extra: true }]) {
      expect(GlobalExecutionPolicySchema.safeParse({ ...globalPolicy(), advisor }).success, JSON.stringify(advisor)).toBe(false);
    }
    expect(ProjectExecutionPolicySchema.safeParse({ version: 1, advisor: { fallback: 'allow' } }).success).toBe(false);
    expect(ProjectExecutionPolicySchema.safeParse({ version: 1, advisor: { enabled: false } }).success).toBe(true);
  });
});
