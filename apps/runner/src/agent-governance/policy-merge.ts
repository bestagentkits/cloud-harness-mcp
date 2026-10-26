import { createHash } from 'node:crypto';
import {
  AGENT_ACTION_CLASSES,
  DEFAULT_POLICY_ADVISOR,
  POLICY_RULE_EFFECT_RANK,
  type AgentActionClass,
  type AgentActionDescriptor,
  type EffectivePolicy,
  type GlobalExecutionPolicy,
  type PolicyAdvisor,
  type PolicyBudget,
  type PolicyChange,
  type PolicyRuleEffect,
  type PolicyScope,
  type ProjectExecutionPolicy
} from '@cloud-harness/contracts';

/**
 * Pure policy algebra shared by the gate evaluator, the policy service (save-time checks) and the
 * Dashboard preview: list matching, the global-and-project merge, widening and weakening detection,
 * and the canonical forms used for digests and fingerprints. Nothing here reads a clock, a database
 * or descriptor free text.
 */

const lower = (value: string) => value.toLowerCase();

type ListRule = {
  /** Does a policy entry admit this concrete value? */
  matches(entry: string, value: string): boolean;
  /** Is everything `inner` admits also admitted by `outer`? */
  covers(outer: string, inner: string): boolean;
};

function repositoryParts(value: string): [string, string] {
  const [owner = '', name = ''] = lower(value).split('/');
  return [owner, name];
}

const stripTrailingSlash = (value: string) => (value === '*' ? value : value.replace(/\/+$/u, ''));
/** `./src/a.ts` and `src/a.ts` name the same file. */
export const normalizeWorkspacePath = (value: string) => value.replace(/^(?:\.\/)+/u, '');

const commandTokens = (entry: string) => entry.split(' ');
const matchesArgv = (entry: string, argv: readonly string[]) => {
  if (entry === '*') return true;
  const tokens = commandTokens(entry);
  return tokens.length <= argv.length && tokens.every((token, index) => argv[index] === token);
};

const hostMatches = (entry: string, host: string) => {
  const value = lower(host);
  if (entry === '*') return true;
  if (entry.startsWith('*.')) {
    const suffix = lower(entry.slice(1));
    return value.endsWith(suffix) && value.length > suffix.length;
  }
  return lower(entry) === value;
};

export const LIST_RULES: Record<keyof PolicyScope, ListRule> = {
  repositories: {
    matches: (entry, value) => {
      if (entry === '*') return true;
      const [entryOwner, entryName] = repositoryParts(entry);
      const [owner, name] = repositoryParts(value);
      return entryOwner === owner && (entryName === '*' || entryName === name);
    },
    covers: (outer, inner) => {
      if (outer === '*') return true;
      if (inner === '*') return false;
      const [outerOwner, outerName] = repositoryParts(outer);
      const [innerOwner, innerName] = repositoryParts(inner);
      return outerOwner === innerOwner && (outerName === '*' || (innerName !== '*' && outerName === innerName));
    }
  },
  branchPrefixes: {
    matches: (entry, value) => entry === '*' || value.startsWith(entry),
    covers: (outer, inner) => outer === '*' || (inner !== '*' && inner.startsWith(outer))
  },
  pathScopes: {
    matches: (entry, value) => {
      const scope = stripTrailingSlash(entry);
      const path = normalizeWorkspacePath(value);
      return scope === '*' || path === scope || path.startsWith(`${scope}/`);
    },
    covers: (outer, inner) => outer === '*' || (inner !== '*' && LIST_RULES.pathScopes.matches(outer, stripTrailingSlash(inner)))
  },
  commands: {
    matches: (entry, value) => matchesArgv(entry, commandTokens(value)),
    covers: (outer, inner) => outer === '*' || (inner !== '*' && matchesArgv(outer, commandTokens(inner)))
  },
  packages: {
    matches: (entry, value) => {
      if (entry === '*') return true;
      const normalized = lower(entry);
      return normalized.endsWith(':*') ? lower(value).startsWith(normalized.slice(0, -1)) : normalized === lower(value);
    },
    covers: (outer, inner) => outer === '*' || (inner !== '*' && LIST_RULES.packages.matches(outer, inner))
  },
  registries: {
    matches: (entry, value) => entry === '*' || lower(entry) === lower(value),
    covers: (outer, inner) => outer === '*' || (inner !== '*' && lower(outer) === lower(inner))
  },
  networkHosts: {
    matches: hostMatches,
    covers: (outer, inner) => {
      if (outer === '*') return true;
      if (inner === '*') return false;
      if (outer.startsWith('*.')) return lower(inner.startsWith('*.') ? inner.slice(1) : inner).endsWith(lower(outer.slice(1)));
      return !inner.startsWith('*.') && lower(outer) === lower(inner);
    }
  }
};

export const SCOPE_KEYS = Object.keys(LIST_RULES) as (keyof PolicyScope)[];
const BUDGET_KEYS: (keyof PolicyBudget)[] = ['maxCostMicrosPerRun', 'maxInputTokensPerRun', 'maxOutputTokensPerRun', 'maxRunSeconds', 'maxConcurrentRuns'];

/** Does any entry of the list admit the value? */
export function listAdmits(key: keyof PolicyScope, entries: readonly string[], value: string): boolean {
  return entries.some((entry) => LIST_RULES[key].matches(entry, value));
}

/** Matches an argv against a command list without joining it, so a space inside one argument cannot forge a token. */
export function commandAdmitted(entries: readonly string[], argv: readonly string[]): boolean {
  return entries.some((entry) => matchesArgv(entry, argv));
}

const canonicalOrder = (values: Iterable<AgentActionClass>): AgentActionClass[] => {
  const set = new Set(values);
  return AGENT_ACTION_CLASSES.filter((value) => set.has(value));
};

const rank = (effect: PolicyRuleEffect) => POLICY_RULE_EFFECT_RANK[effect];

/** The global default for a class; a class without one requires approval and is not delegable. */
export function globalDefaultFor(global: GlobalExecutionPolicy, actionClass: AgentActionClass): { effect: PolicyRuleEffect; delegable: boolean; explicit: boolean } {
  const rule = global.defaults[actionClass];
  return rule ? { ...rule, explicit: true } : { effect: 'require_approval', delegable: false, explicit: false };
}

/**
 * Merges a project policy into the global one. The project can only narrow: it adds denies and
 * mandatory approvals, removes classes, tightens lists and lowers numbers. Anything that would
 * loosen the global policy is dropped and listed in `ignoredProjectFields`, so a widening document
 * that reached storage (or a draft) still cannot widen an evaluation.
 */
export function resolveEffectivePolicy(global: GlobalExecutionPolicy, project: ProjectExecutionPolicy | null): EffectivePolicy {
  const ignored: string[] = [];
  const hardDeny = canonicalOrder([...global.hardDeny, ...(project?.hardDeny ?? [])]);
  const mandatoryApproval = canonicalOrder([...global.mandatoryApproval, ...(project?.mandatoryApproval ?? [])]);
  let allowed = global.allowedActionClasses.filter((actionClass) => !hardDeny.includes(actionClass));
  if (project?.allowedActionClasses) {
    for (const actionClass of project.allowedActionClasses) {
      if (!global.allowedActionClasses.includes(actionClass)) ignored.push(`allowedActionClasses: ${actionClass} is not allowed globally`);
    }
    const projectAllowed = project.allowedActionClasses;
    allowed = allowed.filter((actionClass) => projectAllowed.includes(actionClass));
  }
  const allowedActionClasses = canonicalOrder(allowed);
  const effects = allowedActionClasses.map((actionClass) => {
    const fallback = globalDefaultFor(global, actionClass);
    const override = project?.rules?.[actionClass];
    let effect = fallback.effect;
    let source: 'global' | 'project' | 'default' = fallback.explicit ? 'global' : 'default';
    if (override !== undefined) {
      if (fallback.delegable || rank(override) >= rank(fallback.effect)) {
        effect = override;
        source = 'project';
      } else {
        ignored.push(`rules.${actionClass}: ${override} is weaker than the global ${fallback.effect}, which is not delegable`);
      }
    }
    return { actionClass, effect, source, delegable: fallback.delegable, mandatoryApproval: mandatoryApproval.includes(actionClass) };
  });
  const scope = {} as PolicyScope;
  for (const key of SCOPE_KEYS) {
    const outer = global.scope[key];
    const inner = project?.scope?.[key];
    if (inner === undefined) {
      scope[key] = [...outer];
      continue;
    }
    scope[key] = inner.filter((entry) => {
      const covered = outer.some((candidate) => LIST_RULES[key].covers(candidate, entry));
      if (!covered) ignored.push(`scope.${key}: ${entry} is outside the global scope`);
      return covered;
    });
  }
  const budget = { ...global.budget };
  for (const key of BUDGET_KEYS) {
    const value = project?.budget?.[key];
    if (value === undefined) continue;
    if (value > global.budget[key]) ignored.push(`budget.${key}: ${value} exceeds the global ${global.budget[key]}`);
    else budget[key] = value;
  }
  const approval = { ttlSeconds: global.approval.ttlSeconds, approverRoles: [...global.approval.approverRoles] };
  const ttl = project?.approval?.ttlSeconds;
  if (ttl !== undefined) {
    if (ttl > global.approval.ttlSeconds) ignored.push(`approval.ttlSeconds: ${ttl} exceeds the global ${global.approval.ttlSeconds}`);
    else approval.ttlSeconds = ttl;
  }
  const advisor = resolveAdvisor(global.advisor ?? DEFAULT_POLICY_ADVISOR, project?.advisor, ignored);
  return { hardDeny, mandatoryApproval, allowedActionClasses, effects, scope, budget, approval, advisor, ignoredProjectFields: ignored };
}

const FALLBACK_RANK = { require_approval: 0, deny: 1 } as const;

/**
 * A project can only make the advisor stricter. Enabling it would let a discretionary action clear
 * without a human, so that is a widening; so are a higher risk threshold, a lower minimum confidence
 * and a softer fallback.
 */
function resolveAdvisor(global: PolicyAdvisor, project: ProjectExecutionPolicy['advisor'], ignored: string[]): PolicyAdvisor {
  const advisor = { ...global };
  if (!project) return advisor;
  if (project.enabled !== undefined) {
    if (project.enabled && !global.enabled) ignored.push('advisor.enabled: the global policy does not enable the advisor');
    else advisor.enabled = project.enabled;
  }
  if (project.riskThreshold !== undefined) {
    if (project.riskThreshold > global.riskThreshold) ignored.push(`advisor.riskThreshold: ${project.riskThreshold} exceeds the global ${global.riskThreshold}`);
    else advisor.riskThreshold = project.riskThreshold;
  }
  if (project.minConfidence !== undefined) {
    if (project.minConfidence < global.minConfidence) ignored.push(`advisor.minConfidence: ${project.minConfidence} is below the global ${global.minConfidence}`);
    else advisor.minConfidence = project.minConfidence;
  }
  if (project.fallback !== undefined) {
    if (FALLBACK_RANK[project.fallback] < FALLBACK_RANK[global.fallback]) ignored.push(`advisor.fallback: ${project.fallback} is softer than the global ${global.fallback}`);
    else advisor.fallback = project.fallback;
  }
  return advisor;
}

function advisorWeakenings(before: PolicyAdvisor, after: PolicyAdvisor): string[] {
  if (!after.enabled) return [];
  if (!before.enabled) return ['advisor: may now clear advisor_or_approval actions without a human'];
  const changes: string[] = [];
  if (after.riskThreshold > before.riskThreshold) changes.push(`advisor.riskThreshold: ${before.riskThreshold} becomes ${after.riskThreshold}`);
  if (after.minConfidence < before.minConfidence) changes.push(`advisor.minConfidence: ${before.minConfidence} becomes ${after.minConfidence}`);
  if (FALLBACK_RANK[after.fallback] < FALLBACK_RANK[before.fallback]) changes.push(`advisor.fallback: ${before.fallback} becomes ${after.fallback}`);
  return changes;
}

/**
 * Everything `after` permits that `before` did not. A non-empty result means the change loosens
 * the effective policy, which the owner must confirm explicitly.
 */
export function policyWeakenings(before: EffectivePolicy, after: EffectivePolicy): string[] {
  const changes: string[] = [];
  for (const actionClass of after.allowedActionClasses) {
    if (!before.allowedActionClasses.includes(actionClass)) changes.push(`allows ${actionClass}`);
  }
  for (const actionClass of before.hardDeny) {
    if (!after.hardDeny.includes(actionClass)) changes.push(`no longer hard-denies ${actionClass}`);
  }
  for (const actionClass of before.mandatoryApproval) {
    if (!after.mandatoryApproval.includes(actionClass)) changes.push(`no longer requires approval for ${actionClass}`);
  }
  for (const entry of after.effects) {
    const previous = before.effects.find((candidate) => candidate.actionClass === entry.actionClass);
    if (!previous) continue;
    if (rank(entry.effect) < rank(previous.effect)) changes.push(`${entry.actionClass}: ${previous.effect} becomes ${entry.effect}`);
    if (entry.delegable && !previous.delegable) changes.push(`${entry.actionClass}: projects may now choose its effect`);
  }
  for (const key of SCOPE_KEYS) {
    for (const entry of after.scope[key]) {
      if (!before.scope[key].some((candidate) => LIST_RULES[key].covers(candidate, entry))) changes.push(`scope.${key}: adds ${entry}`);
    }
  }
  for (const key of BUDGET_KEYS) {
    if (after.budget[key] > before.budget[key]) changes.push(`budget.${key}: ${before.budget[key]} becomes ${after.budget[key]}`);
  }
  if (after.approval.ttlSeconds > before.approval.ttlSeconds) changes.push(`approval.ttlSeconds: ${before.approval.ttlSeconds} becomes ${after.approval.ttlSeconds}`);
  changes.push(...advisorWeakenings(before.advisor, after.advisor));
  return changes;
}

/** JSON with object keys sorted at every level, so equal documents serialize identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Identity of an action for audit and approval binding. The free-text `reason` is excluded. */
export function actionFingerprint(descriptor: AgentActionDescriptor): string {
  return sha256(canonicalJson({ ...descriptor, reason: undefined }));
}

const MAX_CHANGE_VALUE = 4_000;
const bounded = (value: string | undefined) => (value === undefined ? null : value.length <= MAX_CHANGE_VALUE ? value : `${value.slice(0, MAX_CHANGE_VALUE - 1)}…`);

function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  out.set(prefix, canonicalJson(value));
}

/** A field-level diff of two policy documents; arrays compare as whole values. */
export function diffPolicyDocuments(before: unknown, after: unknown): PolicyChange[] {
  const left = new Map<string, string>();
  const right = new Map<string, string>();
  if (before !== null && before !== undefined) flatten(before, '', left);
  if (after !== null && after !== undefined) flatten(after, '', right);
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  return paths
    .filter((path) => left.get(path) !== right.get(path))
    .slice(0, 500)
    .map((path) => ({ path: path.slice(0, 200), before: bounded(left.get(path)), after: bounded(right.get(path)) }));
}
