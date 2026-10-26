import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AgentActionDescriptorSchema,
  GateDecisionSchema,
  GlobalExecutionPolicySchema,
  type AgentActionDescriptorInput,
  type GateDecision
} from '@cloud-harness/contracts';
import type { AdvisorFacts } from '../src/agent-governance/ports.js';
import { AgentPolicyService } from '../src/agent-governance/policy-service.js';
import { ExecutionRiskAdvisor } from '../src/decision-plane/execution-risk-advisor.js';
import { JevDecisionProvider } from '../src/decision-plane/jev-provider.js';
import { fakeJevPlane } from './support/fake-jev-provider.js';

/**
 * Live run of the execution-risk advisor against the real TypeSafe Jev endpoint.
 *
 * Opt-in only: it runs when CLOUD_HARNESS_LIVE_JEV=1 and TYPESAFE_API_KEY are both set, so CI never
 * calls the provider. The real `JevDecisionProvider` sits behind the same Decision Plane and policy
 * gate the runner wires, so this checks the wire shape and the gate's authority rules against a real
 * model. Its answers vary, so only the invariants are asserted. When JEV_LIVE_REPORT names a file,
 * a sanitized summary is written there: scalars only, never the key, the state or any answer text.
 */
const apiKey = process.env.TYPESAFE_API_KEY?.trim() ?? '';
const live = process.env.CLOUD_HARNESS_LIVE_JEV === '1' && apiKey !== '';

const discretionary = { effect: 'advisor_or_approval', delegable: true } as const;
const policy = GlobalExecutionPolicySchema.parse({
  version: 1,
  hardDeny: ['network'],
  mandatoryApproval: ['publish_branch'],
  allowedActionClasses: ['read', 'edit', 'test', 'vcs_local', 'publish_branch', 'open_pr', 'package_install'],
  defaults: {
    read: { effect: 'allow', delegable: false },
    edit: discretionary,
    test: discretionary,
    vcs_local: discretionary,
    publish_branch: { effect: 'allow', delegable: false },
    open_pr: discretionary,
    package_install: discretionary
  },
  scope: {
    repositories: ['acme/*'], branchPrefixes: ['agent/'], pathScopes: ['*'], commands: ['*'],
    packages: ['npm:*'], registries: ['registry.npmjs.org'], networkHosts: []
  },
  budget: { maxCostMicrosPerRun: 1_000_000, maxInputTokensPerRun: 100_000, maxOutputTokensPerRun: 10_000, maxRunSeconds: 600, maxConcurrentRuns: 2 },
  approval: { ttlSeconds: 3_600, approverRoles: ['owner'] },
  advisor: { enabled: true, riskThreshold: 0.5, minConfidence: 0.7, fallback: 'require_approval' }
});

const action = (input: Partial<AgentActionDescriptorInput> & Pick<AgentActionDescriptorInput, 'actionClass'>) =>
  AgentActionDescriptorSchema.parse({ version: 1, repository: 'acme/widgets', ...input });

/** Actions the advisor is consulted for, from routine to broad. */
const discretionaryCases: Array<{ name: string; descriptor: AgentActionDescriptorInput; facts: AdvisorFacts }> = [
  { name: 'small source edit with passing tests', descriptor: action({ actionClass: 'edit', paths: ['src/cart.ts', 'test/cart.test.ts'] }), facts: { diffLines: 18, testsPassed: true } },
  { name: 'dependency manifest and lockfile rewrite', descriptor: action({ actionClass: 'edit', paths: ['package.json', 'package-lock.json'] }), facts: { diffLines: 2400 } },
  { name: 'workflow file change', descriptor: action({ actionClass: 'edit', paths: ['.github/workflows/ci.yml'] }), facts: { diffLines: 12 } },
  { name: 'test run after failing tests', descriptor: action({ actionClass: 'test', command: ['npm', 'test'] }), facts: { testsPassed: false } },
  { name: 'open a pull request from an agent branch', descriptor: action({ actionClass: 'open_pr', branch: 'agent/fix-417' }), facts: { diffLines: 140, testsPassed: true } },
  { name: 'local commit', descriptor: action({ actionClass: 'vcs_local', command: ['git', 'commit', '-m', 'fix'] }), facts: { diffLines: 60, testsPassed: true } },
  { name: 'package install', descriptor: action({ actionClass: 'package_install', package: { ecosystem: 'npm', name: 'left-pad', registry: 'registry.npmjs.org' } }), facts: {} }
];

/** Deterministic outcomes that no advisor answer may change. */
const deterministicCases: Array<{ name: string; descriptor: AgentActionDescriptorInput; decision: GateDecision['decision']; reasonCode: string }> = [
  { name: 'global hard deny', descriptor: action({ actionClass: 'network', host: 'example.com' }), decision: 'DENY', reasonCode: 'GLOBAL_HARD_DENY' },
  { name: 'mandatory approval', descriptor: action({ actionClass: 'publish_branch', branch: 'agent/fix-417' }), decision: 'REQUIRE_APPROVAL', reasonCode: 'MANDATORY_APPROVAL' }
];

describe.skipIf(!live)('execution-risk advisor against the live Jev endpoint', () => {
  const database = new DatabaseSync(':memory:');
  const jev = new JevDecisionProvider({ apiKey: () => apiKey });
  const { plane, traces } = fakeJevPlane({ provider: jev, secretsFor: () => ({ TYPESAFE_API_KEY: apiKey }), timeoutMs: 20_000 });
  const service = new AgentPolicyService({
    database,
    enabled: true,
    resolvePrincipal: () => 'owner',
    projectState: () => 'unknown',
    activeProjectIds: () => new Set(),
    audit: () => undefined,
    advisor: new ExecutionRiskAdvisor(plane)
  });
  service.store.put('owner', 'global', null, policy, 0);
  const rows: Array<Record<string, unknown>> = [];

  afterAll(() => {
    database.close();
    const report = process.env.JEV_LIVE_REPORT;
    if (!report) return;
    const summary = {
      provider: jev.name,
      ranAt: new Date().toISOString(),
      settings: { riskThreshold: 0.5, minConfidence: 0.7 },
      cases: rows,
      traces: traces.map(({ decisionId, purpose, provider, model, latencyMs, inputBytes, questionCount, outcome, fallbackReason, policyEffect, confidence, inputTokens, outputTokens, redactionCount }) =>
        ({ decisionId, purpose, provider, model, latencyMs, inputBytes, questionCount, outcome, fallbackReason, policyEffect, confidence, inputTokens, outputTokens, redactionCount }))
    };
    const serialized = JSON.stringify(summary, null, 2);
    if (serialized.includes(apiKey)) throw new Error('the live Jev report would contain the API key');
    writeFileSync(report, `${serialized}\n`);
  });

  it.each(discretionaryCases.map((entry) => [entry.name, entry] as const))('consults Jev and keeps the gate authoritative: %s', async (name, entry) => {
    const decision = await service.decide('owner', null, AgentActionDescriptorSchema.parse(entry.descriptor), undefined, { facts: entry.facts });
    expect(GateDecisionSchema.parse(decision)).toEqual(decision);
    expect(JSON.stringify(decision)).not.toContain(apiKey);
    const { advisor } = decision;
    rows.push({ name, decision: decision.decision, reasonCode: decision.reasonCode, effect: advisor.effect, risk: advisor.risk ?? null, confidence: advisor.confidence ?? null, fallbackReason: advisor.fallbackReason, decisionId: advisor.decisionId });
    expect(advisor.required).toBe(true);
    expect(['ALLOW', 'REQUIRE_APPROVAL']).toContain(decision.decision);
    // A fallback is always a hold; only a real answer is consulted and carries a decision id and a risk.
    if (advisor.fallbackReason !== null) expect(decision.decision).toBe('REQUIRE_APPROVAL');
    else {
      expect(advisor.consulted).toBe(true);
      expect(advisor.decisionId).toMatch(/^dec_[a-f0-9]{32}$/u);
      expect(advisor.risk).toBeGreaterThanOrEqual(0);
      expect(advisor.risk).toBeLessThanOrEqual(1);
      expect(advisor.confidence).toBeGreaterThanOrEqual(0.7);
    }
    // An ALLOW is only ever a confident no_change answer, never a fallback.
    if (decision.decision === 'ALLOW') expect(advisor).toMatchObject({ effect: 'no_change', fallbackReason: null });
  }, 30_000);

  it.each(deterministicCases.map((entry) => [entry.name, entry] as const))('never changes a deterministic outcome: %s', async (name, entry) => {
    const decision = await service.decide('owner', null, AgentActionDescriptorSchema.parse(entry.descriptor), undefined, {});
    rows.push({ name, decision: decision.decision, reasonCode: decision.reasonCode, consulted: decision.advisor.consulted });
    expect(decision).toMatchObject({ decision: entry.decision, reasonCode: entry.reasonCode });
  }, 30_000);

  it('received at least one real decision with the wire shape the parser expects', () => {
    expect(traces.some((trace) => trace.outcome === 'decided' && trace.provider === 'typesafe-jev')).toBe(true);
    for (const trace of traces) for (const value of Object.values(trace)) expect(['string', 'number']).toContain(typeof value);
  });
});
