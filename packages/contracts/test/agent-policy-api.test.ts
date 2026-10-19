import { describe, expect, it } from 'vitest';
import {
  AGENT_ACTION_CLASSES,
  AGENT_PLATFORM_EFFECTS,
  AGENT_POLICY_LIMITS,
  AdvisorEffectSchema,
  AgentActionDescriptorSchema,
  AgentPoliciesRunnerErrorCodeSchema,
  AgentPoliciesRunnerRequestSchema,
  DEFAULT_GLOBAL_EXECUTION_POLICY,
  GATE_DECISION_RANK,
  GATE_REASON_CODES,
  GateContextSchema,
  GateDecisionValueSchema,
  GlobalExecutionPolicySchema,
  POLICY_RULE_EFFECT_RANK,
  PolicyRuleEffectSchema,
  ProjectExecutionPolicySchema
} from '../src/index.js';

const PROJECT = `prj_${'p'.repeat(32)}`;
const owner = { kind: 'owner', ownerId: 'owner' } as const;
const action = { version: 1, actionClass: 'edit', repository: 'acme/widgets', paths: ['src/a.ts'] };

describe('agent policy contract', () => {
  it('keeps the enums stable', () => {
    expect(AGENT_ACTION_CLASSES).toEqual(['read', 'edit', 'test', 'vcs_local', 'publish_branch', 'open_pr', 'network', 'package_install']);
    expect(AGENT_PLATFORM_EFFECTS).toEqual(['credential_access', 'docker_access', 'network_escalation', 'outside_workspace', 'privilege_escalation']);
    expect(PolicyRuleEffectSchema.options).toEqual(['allow', 'advisor_or_approval', 'require_approval']);
    expect(GateDecisionValueSchema.options).toEqual(['ALLOW', 'REQUIRE_APPROVAL', 'DENY']);
    expect(GATE_DECISION_RANK).toEqual({ ALLOW: 0, REQUIRE_APPROVAL: 1, DENY: 2 });
    expect(POLICY_RULE_EFFECT_RANK).toEqual({ allow: 0, advisor_or_approval: 1, require_approval: 2 });
    expect(new Set(GATE_REASON_CODES).size).toBe(GATE_REASON_CODES.length);
    expect(AgentPoliciesRunnerErrorCodeSchema.options).toContain('FEATURE_DISABLED');
  });

  it('gives an advisor no value that could lower a decision', () => {
    expect(AdvisorEffectSchema.options).toEqual(['no_change', 'escalate']);
    for (const value of ['allow', 'ALLOW', 'downgrade', 'approve', 'deny']) expect(AdvisorEffectSchema.safeParse(value).success).toBe(false);
  });

  it('ships a read-only default global policy', () => {
    const parsed = GlobalExecutionPolicySchema.parse(DEFAULT_GLOBAL_EXECUTION_POLICY);
    expect(parsed.allowedActionClasses).toEqual(['read']);
    expect(parsed.defaults.read).toEqual({ effect: 'allow', delegable: false });
    expect(parsed.scope.branchPrefixes).toEqual(['agent/']);
  });

  it('rejects contradictory or out-of-bounds global policies', () => {
    const base = structuredClone(DEFAULT_GLOBAL_EXECUTION_POLICY);
    expect(GlobalExecutionPolicySchema.safeParse({ ...base, hardDeny: ['read'] }).success).toBe(false);
    expect(GlobalExecutionPolicySchema.safeParse({ ...base, hardDeny: ['edit'], mandatoryApproval: ['edit'] }).success).toBe(false);
    expect(GlobalExecutionPolicySchema.safeParse({ ...base, allowedActionClasses: ['read', 'read'] }).success).toBe(false);
    expect(GlobalExecutionPolicySchema.safeParse({ ...base, allowedActionClasses: ['shell'] }).success).toBe(false);
    expect(GlobalExecutionPolicySchema.safeParse({ ...base, budget: { ...base.budget, maxRunSeconds: 10 } }).success).toBe(false);
    expect(GlobalExecutionPolicySchema.safeParse({ ...base, budget: { ...base.budget, maxConcurrentRuns: 51 } }).success).toBe(false);
    expect(GlobalExecutionPolicySchema.safeParse({ ...base, approval: { ttlSeconds: 10, approverRoles: ['owner'] } }).success).toBe(false);
    expect(GlobalExecutionPolicySchema.safeParse({ ...base, approval: { ttlSeconds: 600, approverRoles: ['anyone'] } }).success).toBe(false);
    expect(GlobalExecutionPolicySchema.safeParse({ ...base, scope: { ...base.scope, repositories: [] } }).success).toBe(false);
    expect(GlobalExecutionPolicySchema.safeParse({ ...base, scope: { ...base.scope, pathScopes: ['../etc'] } }).success).toBe(false);
    expect(GlobalExecutionPolicySchema.safeParse({ ...base, scope: { ...base.scope, pathScopes: ['/etc'] } }).success).toBe(false);
    expect(GlobalExecutionPolicySchema.safeParse({ ...base, scope: { ...base.scope, commands: ['npm test; rm -rf /'] } }).success).toBe(false);
    expect(GlobalExecutionPolicySchema.safeParse({ ...base, scope: { ...base.scope, commands: Array.from({ length: AGENT_POLICY_LIMITS.maxListEntries + 1 }, (_, index) => `cmd${index}`) } }).success).toBe(false);
    expect(GlobalExecutionPolicySchema.safeParse({ ...base, version: 2 }).success).toBe(false);
    expect(GlobalExecutionPolicySchema.safeParse({ ...base, extra: true }).success).toBe(false);
  });

  it('has no project field that could widen or delegate', () => {
    expect(ProjectExecutionPolicySchema.parse({ version: 1 })).toEqual({ version: 1 });
    for (const field of [
      { defaults: { edit: { effect: 'allow', delegable: true } } },
      { delegable: true },
      { approval: { ttlSeconds: 600, approverRoles: ['owner'] } },
      { approverRoles: ['owner'] },
      { principal: 'other' },
      { projectId: PROJECT }
    ]) {
      expect(ProjectExecutionPolicySchema.safeParse({ version: 1, ...field }).success, JSON.stringify(field)).toBe(false);
    }
    expect(ProjectExecutionPolicySchema.safeParse({ version: 1, rules: { edit: 'allow', shell: 'allow' } }).success).toBe(false);
  });

  it('accepts only a strict action descriptor', () => {
    expect(AgentActionDescriptorSchema.parse(action).platformEffects).toEqual([]);
    for (const field of [{ principal: owner }, { principalId: 'owner' }, { projectId: PROJECT }, { policy: {} }, { decision: 'ALLOW' }, { approved: true }]) {
      expect(AgentActionDescriptorSchema.safeParse({ ...action, ...field }).success, JSON.stringify(field)).toBe(false);
    }
    expect(AgentActionDescriptorSchema.safeParse({ ...action, repository: 'https://github.com/acme/widgets' }).success).toBe(false);
    expect(AgentActionDescriptorSchema.safeParse({ ...action, paths: Array.from({ length: AGENT_POLICY_LIMITS.maxPathsPerAction + 1 }, () => 'a') }).success).toBe(false);
    expect(AgentActionDescriptorSchema.safeParse({ ...action, reason: 'x'.repeat(AGENT_POLICY_LIMITS.maxReasonChars + 1) }).success).toBe(false);
    expect(GateContextSchema.safeParse({ approvedBy: 'owner' }).success).toBe(false);
  });

  it('binds project-scoped operations to a project id and nothing else', () => {
    const request = (input: Record<string, unknown>, operation = 'policy_get') => AgentPoliciesRunnerRequestSchema.safeParse({ version: 1, principal: owner, operation, input });
    expect(request({ scope: 'global' }).success).toBe(true);
    expect(request({ scope: 'project', projectId: PROJECT }).success).toBe(true);
    expect(request({ scope: 'project' }).success).toBe(false);
    expect(request({ scope: 'global', projectId: PROJECT }).success).toBe(false);
    expect(request({ scope: 'project', projectId: 'my-project' }).success).toBe(false);
    expect(request({ scope: 'global', document: {}, expectedVersion: -1 }, 'policy_put').success).toBe(false);
    expect(request({ action, principal: owner }, 'policy_simulate').success).toBe(false);
    expect(AgentPoliciesRunnerRequestSchema.safeParse({ version: 1, operation: 'policy_overview', input: {} }).success).toBe(false);
  });

  it('dedupes case-sensitive lists exactly and host-like lists case-insensitively', () => {
    const base = structuredClone(DEFAULT_GLOBAL_EXECUTION_POLICY);
    const withScope = (scope: Record<string, string[]>) => GlobalExecutionPolicySchema.safeParse({ ...base, scope: { ...base.scope, ...scope } }).success;
    // Paths, branches and commands are case-sensitive on the executor, so `src/` and `Src/` are distinct.
    expect(withScope({ pathScopes: ['src/', 'Src/'] })).toBe(true);
    expect(withScope({ pathScopes: ['src/', 'src/'] })).toBe(false);
    expect(withScope({ branchPrefixes: ['agent/', 'Agent/'] })).toBe(true);
    expect(withScope({ commands: ['npm test', 'NPM test'] })).toBe(true);
    // Repositories and hosts compare case-insensitively.
    expect(withScope({ repositories: ['acme/*', 'ACME/*'] })).toBe(false);
    expect(withScope({ networkHosts: ['api.github.com', 'API.github.com'] })).toBe(false);
  });

  it('binds a weakening confirmation to a digest', () => {
    const put = (input: Record<string, unknown>) => AgentPoliciesRunnerRequestSchema.safeParse({ version: 1, principal: owner, operation: 'policy_put', input: { scope: 'global', document: {}, expectedVersion: 0, confirmWeakening: true, ...input } }).success;
    expect(put({ weakeningDigest: 'a'.repeat(64) })).toBe(true);
    expect(put({})).toBe(true);
    expect(put({ weakeningDigest: 'not-a-digest' })).toBe(false);
    expect(put({ weakeningDigest: 'A'.repeat(64) })).toBe(false);
  });
});
