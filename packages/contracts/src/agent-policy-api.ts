import { z } from 'zod';
import { RunnerPrincipalSelectorSchema } from './runner-api.js';

/**
 * Owner-authored execution policy for agent actions (#417). A principal owns one global policy and
 * at most one policy per Cloud Harness project. The runner resolves both into a snapshot and a pure
 * gate evaluator turns an `ActionDescriptor` into a `GateDecision` (ALLOW, REQUIRE_APPROVAL or DENY).
 *
 * Authority rules the schemas encode:
 * - Principal, project and policy never travel inside an action descriptor. The runner takes the
 *   principal from the authenticated request and the project from an owner-authored binding, so a
 *   webhook-shaped payload cannot select them (the descriptor schema is strict).
 * - A project policy can only narrow the global policy. Fields only the global owner may set
 *   (delegation, approver roles) do not exist on the project schema.
 * - An advisor answers `no_change` or `escalate`; there is no value that can lower a decision.
 *
 * The schemas below are the API <-> runner internal channel (`POST /v1/internal/agent-policies`,
 * service token) and the Dashboard BFF payloads. Version 1 of every document.
 */

export const AGENT_POLICY_CONTRACT_VERSION = 1 as const;

export const AGENT_POLICY_LIMITS = {
  /** Entries in any one list field (repositories, paths, commands, ...). */
  maxListEntries: 100,
  maxPathsPerAction: 50,
  maxCommandTokens: 64,
  maxNoteChars: 500,
  /** Free-form descriptor text. Stored nowhere and never evaluated. */
  maxReasonChars: 2_000,
  /** Revisions kept per scope; the oldest non-head revisions beyond this are pruned. */
  maxRevisionsPerScope: 200,
  maxHistoryLimit: 100,
  maxDetails: 50
} as const;

/** Action classes a policy governs. Order is stable; new classes are appended in a later version. */
export const AGENT_ACTION_CLASSES = ['read', 'edit', 'test', 'vcs_local', 'publish_branch', 'open_pr', 'network', 'package_install'] as const;
export const AgentActionClassSchema = z.enum(AGENT_ACTION_CLASSES);

/**
 * Invariant classes the platform always denies, whatever any policy says. The broker that builds a
 * descriptor marks them; the evaluator also derives some from the descriptor itself (paths, argv).
 */
export const AGENT_PLATFORM_EFFECTS = ['credential_access', 'docker_access', 'network_escalation', 'outside_workspace', 'privilege_escalation'] as const;
export const AgentPlatformEffectSchema = z.enum(AGENT_PLATFORM_EFFECTS);

/**
 * What an allowed class does when no stronger rule applies. `advisor_or_approval` is a discretionary
 * allow that an advisor must leave unchanged; without an advisor it resolves to REQUIRE_APPROVAL.
 * Strictness order: allow < advisor_or_approval < require_approval.
 */
export const PolicyRuleEffectSchema = z.enum(['allow', 'advisor_or_approval', 'require_approval']);
export const POLICY_RULE_EFFECT_RANK = { allow: 0, advisor_or_approval: 1, require_approval: 2 } as const;

export const GateDecisionValueSchema = z.enum(['ALLOW', 'REQUIRE_APPROVAL', 'DENY']);
export const GATE_DECISION_RANK = { ALLOW: 0, REQUIRE_APPROVAL: 1, DENY: 2 } as const;

/** The only answers an advisor can give. Neither can lower a decision. */
export const AdvisorEffectSchema = z.enum(['no_change', 'escalate']);

export const AgentPolicyRevisionIdSchema = z.string().regex(/^apr_[a-f0-9]{32}$/u);
export const AgentPolicyProjectIdSchema = z.string().regex(/^prj_[A-Za-z0-9_-]{20,80}$/u);
export const AgentPolicyScopeSchema = z.enum(['global', 'project']);

const noControl = (value: string) => ![...value].some((character) => {
  const code = character.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
});
/**
 * Duplicates are rejected using the same case rule the gate matches with: repositories, packages, registries
 * and hosts compare case-insensitively; paths, branch prefixes and commands are case-sensitive, so src/ and
 * Src/ are different entries.
 */
const uniqueList = <T extends z.ZodType<string>>(item: T, max: number = AGENT_POLICY_LIMITS.maxListEntries, caseInsensitive = false) => z.array(item).max(max)
  .refine((values) => new Set(values.map((value) => (caseInsensitive ? value.toLowerCase() : value))).size === values.length, 'entries must be unique');
const classList = uniqueList(AgentActionClassSchema, AGENT_ACTION_CLASSES.length);

const hostLabel = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const hostnamePattern = new RegExp(`^${hostLabel}(?:\\.${hostLabel})*$`, 'u');
const hostname = z.string().min(1).max(253).regex(hostnamePattern, 'must be a hostname');
const githubRepository = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u, 'repository must be owner/name')
  .refine((value) => !value.endsWith('.git') && !(value.split('/')[1] ?? '').startsWith('.'), 'repository must be owner/name');

/** `*`, `owner/*` or `owner/name`. */
export const PolicyRepositoryPatternSchema = z.string().max(141).refine(
  (value) => value === '*' || /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/\*$/u.test(value) || githubRepository.safeParse(value).success,
  'repository must be *, owner/* or owner/name'
);
/** `*` or a ref prefix such as `agent/`. */
export const PolicyBranchPrefixSchema = z.string().min(1).max(200).refine(
  (value) => value === '*' || (/^[A-Za-z0-9._/-]+$/u.test(value) && !value.startsWith('-') && !value.startsWith('/') && !value.includes('..')),
  'branch prefix must be * or a ref prefix'
);
/** `*` or a workspace-relative file or directory (`src`, `src/`, `package.json`). */
export const PolicyPathScopeSchema = z.string().min(1).max(512).refine(
  (value) => value === '*' || (noControl(value) && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some((segment) => segment === '..' || segment === '.')),
  'path scope must be * or a workspace-relative path'
);
/** `*` or a command prefix: whitespace-separated tokens such as `npm test` or `npx vitest run`. */
export const PolicyCommandSchema = z.string().min(1).max(512).refine(
  (value) => value === '*' || /^[A-Za-z0-9._:@/=+-]+(?: [A-Za-z0-9._:@/=+-]+)*$/u.test(value),
  'command must be * or space-separated tokens'
);
/** `*`, `ecosystem:*` or `ecosystem:name`. */
export const PolicyPackageSchema = z.string().min(1).max(220).refine(
  (value) => value === '*' || /^[a-z0-9]{1,20}:(?:\*|[@A-Za-z0-9._/-]{1,200})$/u.test(value),
  'package must be *, ecosystem:* or ecosystem:name'
);
/** `*` or an exact registry hostname. */
export const PolicyRegistrySchema = z.string().min(1).max(253).refine((value) => value === '*' || hostnamePattern.test(value), 'registry must be * or a hostname');
/** `*`, `*.example.com` or an exact hostname. */
export const PolicyNetworkHostSchema = z.string().min(1).max(255).refine(
  (value) => value === '*' || hostnamePattern.test(value.startsWith('*.') ? value.slice(2) : value),
  'host must be *, *.domain or a hostname'
);

export const PolicyScopeSchema = z.object({
  repositories: uniqueList(PolicyRepositoryPatternSchema, undefined, true).min(1),
  branchPrefixes: uniqueList(PolicyBranchPrefixSchema).min(1),
  pathScopes: uniqueList(PolicyPathScopeSchema).min(1),
  commands: uniqueList(PolicyCommandSchema),
  packages: uniqueList(PolicyPackageSchema, undefined, true),
  registries: uniqueList(PolicyRegistrySchema, undefined, true),
  networkHosts: uniqueList(PolicyNetworkHostSchema, undefined, true)
}).strict();

export const PolicyBudgetSchema = z.object({
  maxCostMicrosPerRun: z.number().int().min(0).max(1_000_000_000),
  maxInputTokensPerRun: z.number().int().min(1).max(100_000_000),
  maxOutputTokensPerRun: z.number().int().min(1).max(100_000_000),
  maxRunSeconds: z.number().int().min(60).max(86_400),
  maxConcurrentRuns: z.number().int().min(1).max(50)
}).strict();

/** Single-owner deployments have one approver role today; the enum grows with RBAC. */
export const PolicyApproverRoleSchema = z.enum(['owner']);
export const PolicyApprovalSchema = z.object({
  ttlSeconds: z.number().int().min(60).max(604_800),
  approverRoles: z.array(PolicyApproverRoleSchema).min(1).max(1)
}).strict();

export const PolicyDefaultRuleSchema = z.object({
  effect: PolicyRuleEffectSchema,
  /** The owner explicitly lets a project choose any effect for this class (still below mandatory approval). */
  delegable: z.boolean()
}).strict();

const perClass = <T extends z.ZodType>(value: T) => z.object({
  read: value.optional(), edit: value.optional(), test: value.optional(), vcs_local: value.optional(),
  publish_branch: value.optional(), open_pr: value.optional(), network: value.optional(), package_install: value.optional()
}).strict();

const disjoint = (left: readonly string[], right: readonly string[]) => !left.some((value) => right.includes(value));

export const GlobalExecutionPolicySchema = z.object({
  version: z.literal(1),
  /** Never allowed, by any project or answer. */
  hardDeny: classList,
  /** Always held for a human, whatever a project or advisor says. */
  mandatoryApproval: classList,
  /** The ceiling of classes any project may use. */
  allowedActionClasses: classList,
  /** Effect per allowed class; a class without an entry requires approval and is not delegable. */
  defaults: perClass(PolicyDefaultRuleSchema),
  scope: PolicyScopeSchema,
  budget: PolicyBudgetSchema,
  approval: PolicyApprovalSchema
}).strict()
  .refine((policy) => disjoint(policy.hardDeny, policy.allowedActionClasses), 'a class cannot be both hard-denied and allowed')
  .refine((policy) => disjoint(policy.hardDeny, policy.mandatoryApproval), 'a class cannot be both hard-denied and mandatory-approval');

/** Every field is optional: an absent field inherits the global value. */
export const ProjectExecutionPolicySchema = z.object({
  version: z.literal(1),
  /** Adds denies for this project. */
  hardDeny: classList.optional(),
  /** Adds mandatory approvals for this project. */
  mandatoryApproval: classList.optional(),
  /** Must be a subset of the global allowed classes. */
  allowedActionClasses: classList.optional(),
  /** Effect overrides. Stricter than the global default unless the owner made that class delegable. */
  rules: perClass(PolicyRuleEffectSchema).optional(),
  /** Each list must be covered by the matching global list. */
  scope: PolicyScopeSchema.partial().strict().optional(),
  /** Each value must not exceed the global value. */
  budget: PolicyBudgetSchema.partial().strict().optional(),
  approval: z.object({ ttlSeconds: PolicyApprovalSchema.shape.ttlSeconds }).partial().strict().optional()
}).strict();

/**
 * The conservative policy that applies until the owner saves a global policy: read-only, which is
 * what webhook automations already allow today.
 */
export const DEFAULT_GLOBAL_EXECUTION_POLICY: GlobalExecutionPolicy = Object.freeze({
  version: 1,
  hardDeny: [],
  mandatoryApproval: [],
  allowedActionClasses: ['read'],
  defaults: { read: { effect: 'allow', delegable: false } },
  scope: { repositories: ['*'], branchPrefixes: ['agent/'], pathScopes: ['*'], commands: [], packages: [], registries: [], networkHosts: [] },
  budget: { maxCostMicrosPerRun: 2_000_000, maxInputTokensPerRun: 200_000, maxOutputTokensPerRun: 32_000, maxRunSeconds: 900, maxConcurrentRuns: 1 },
  approval: { ttlSeconds: 3_600, approverRoles: ['owner'] }
}) as GlobalExecutionPolicy;

/**
 * One proposed action, built by a trusted broker (or by the owner in a simulation). Strict: a field
 * that names a principal, project, policy or decision is rejected rather than ignored. `reason` is
 * free text for humans; the evaluator never reads it.
 */
export const AgentActionDescriptorSchema = z.object({
  version: z.literal(1),
  actionClass: AgentActionClassSchema,
  repository: githubRepository,
  branch: z.string().min(1).max(255).refine(noControl, 'branch cannot contain control characters').optional(),
  /** Workspace-relative paths the action touches. Unsafe paths are accepted here and denied by the platform rule. */
  paths: z.array(z.string().min(1).max(1_024).refine((value) => !value.includes('\0'), 'path cannot contain null bytes')).max(AGENT_POLICY_LIMITS.maxPathsPerAction).optional(),
  /** Program and arguments, as argv. */
  command: z.array(z.string().min(1).max(512).refine((value) => !value.includes('\0'), 'argument cannot contain null bytes')).min(1).max(AGENT_POLICY_LIMITS.maxCommandTokens).optional(),
  package: z.object({
    ecosystem: z.string().regex(/^[a-z0-9]{1,20}$/u),
    name: z.string().regex(/^[@A-Za-z0-9._/-]{1,200}$/u),
    registry: hostname
  }).strict().optional(),
  host: hostname.optional(),
  platformEffects: z.array(AgentPlatformEffectSchema).max(AGENT_PLATFORM_EFFECTS.length).default([]),
  reason: z.string().max(AGENT_POLICY_LIMITS.maxReasonChars).optional()
}).strict();

const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * Runtime facts the gate re-checks at execution time. `pinned` holds the revisions a run was
 * admitted under; any difference from the current heads makes the policy stale.
 */
export const GateContextSchema = z.object({
  usage: z.object({
    costMicros: counter.optional(),
    inputTokens: counter.optional(),
    outputTokens: counter.optional(),
    elapsedSeconds: counter.optional(),
    /** Other runs of this principal holding a workspace now, excluding this one. */
    concurrentRuns: counter.optional()
  }).strict().optional(),
  pinned: z.object({
    globalRevisionId: AgentPolicyRevisionIdSchema.nullable(),
    projectRevisionId: AgentPolicyRevisionIdSchema.nullable()
  }).strict().optional(),
  workspaceGeneration: z.object({ pinned: z.number().int().positive(), current: z.number().int().positive() }).strict().optional(),
  revoked: z.boolean().optional()
}).strict();

export const GATE_REASON_CODES = [
  'PLATFORM_CREDENTIAL_ACCESS', 'PLATFORM_DOCKER_ACCESS', 'PLATFORM_NETWORK_ESCALATION', 'PLATFORM_OUTSIDE_WORKSPACE',
  'PLATFORM_PRIVILEGE_ESCALATION', 'PLATFORM_PROTECTED_PATH', 'PLATFORM_COMMAND_UNANALYZABLE',
  'POLICY_STALE', 'GENERATION_STALE', 'GRANT_REVOKED', 'BUDGET_EXHAUSTED', 'PROJECT_POLICY_ORPHANED', 'PROJECT_UNKNOWN',
  'GLOBAL_HARD_DENY',
  'REPOSITORY_OUT_OF_SCOPE', 'BRANCH_REQUIRED', 'BRANCH_INVALID', 'BRANCH_OUT_OF_SCOPE', 'PATH_REQUIRED', 'PATH_OUT_OF_SCOPE',
  'COMMAND_REQUIRED', 'COMMAND_NOT_ALLOWED', 'PACKAGE_REQUIRED', 'PACKAGE_NOT_ALLOWED', 'REGISTRY_NOT_ALLOWED',
  'HOST_REQUIRED', 'HOST_NOT_ALLOWED',
  'ACTION_CLASS_NOT_ALLOWED', 'PROJECT_HARD_DENY', 'PROJECT_CLASS_REMOVED',
  'MANDATORY_APPROVAL', 'PROJECT_MANDATORY_APPROVAL',
  'RULE_ALLOW', 'RULE_REQUIRE_APPROVAL', 'ADVISOR_REQUIRED', 'ADVISOR_UNAVAILABLE', 'ADVISOR_ESCALATED', 'ADVISOR_NO_CHANGE',
  'GLOBAL_POLICY_DEFAULT', 'PROJECT_POLICY_ABSENT', 'PROJECT_WIDENING_IGNORED'
] as const;
export const GateReasonCodeSchema = z.enum(GATE_REASON_CODES);

export const GateReasonSchema = z.object({
  code: GateReasonCodeSchema,
  source: z.enum(['platform', 'runtime', 'global', 'project', 'default', 'advisor']),
  /** Generated by the evaluator from policy values only; never echoes descriptor free text. */
  detail: z.string().max(300)
}).strict();

export const GateDecisionSchema = z.object({
  version: z.literal(1),
  decision: GateDecisionValueSchema,
  /** The reason that decided the outcome. */
  reasonCode: GateReasonCodeSchema,
  reasons: z.array(GateReasonSchema).max(AGENT_POLICY_LIMITS.maxDetails),
  matchedRules: z.array(z.string().max(200)).max(AGENT_POLICY_LIMITS.maxDetails),
  actionClass: AgentActionClassSchema,
  policy: z.object({
    globalRevisionId: AgentPolicyRevisionIdSchema.nullable(),
    globalSource: z.enum(['stored', 'default', 'draft']),
    projectId: AgentPolicyProjectIdSchema.nullable(),
    projectRevisionId: AgentPolicyRevisionIdSchema.nullable(),
    projectSource: z.enum(['none', 'stored', 'absent', 'draft', 'orphaned', 'unknown'])
  }).strict(),
  /** sha256 of the canonical descriptor without its free-text `reason`. */
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  advisor: z.object({
    required: z.boolean(),
    consulted: z.boolean(),
    effect: AdvisorEffectSchema.nullable(),
    decisionId: z.string().max(200).nullable()
  }).strict(),
  /** The approval terms that apply when this decision (or an advisor escalation of it) holds the action for a human. */
  approval: z.object({ ttlSeconds: z.number().int().positive(), approverRoles: z.array(PolicyApproverRoleSchema) }).strict()
}).strict();

const effectSource = z.enum(['global', 'project', 'default']);
export const EffectivePolicySchema = z.object({
  hardDeny: classList,
  mandatoryApproval: classList,
  allowedActionClasses: classList,
  effects: z.array(z.object({
    actionClass: AgentActionClassSchema,
    effect: PolicyRuleEffectSchema,
    source: effectSource,
    delegable: z.boolean(),
    mandatoryApproval: z.boolean()
  }).strict()).max(AGENT_ACTION_CLASSES.length),
  scope: PolicyScopeSchema.extend({
    repositories: z.array(z.string()).max(AGENT_POLICY_LIMITS.maxListEntries),
    branchPrefixes: z.array(z.string()).max(AGENT_POLICY_LIMITS.maxListEntries),
    pathScopes: z.array(z.string()).max(AGENT_POLICY_LIMITS.maxListEntries)
  }),
  budget: PolicyBudgetSchema,
  approval: PolicyApprovalSchema,
  /** Project fields that would widen the global policy; the evaluator ignores them. */
  ignoredProjectFields: z.array(z.string().max(300)).max(AGENT_POLICY_LIMITS.maxDetails * 4)
}).strict();

const instant = z.string();
export const AgentPolicyRevisionSummarySchema = z.object({
  revisionId: AgentPolicyRevisionIdSchema,
  scope: AgentPolicyScopeSchema,
  projectId: AgentPolicyProjectIdSchema.nullable(),
  version: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: instant,
  createdBy: z.enum(['owner']),
  rollbackOf: AgentPolicyRevisionIdSchema.nullable(),
  note: z.string().max(AGENT_POLICY_LIMITS.maxNoteChars).nullable()
}).strict();
export const AgentPolicyRevisionSchema = AgentPolicyRevisionSummarySchema.extend({
  document: z.union([GlobalExecutionPolicySchema, ProjectExecutionPolicySchema])
}).strict();

export const PolicyChangeSchema = z.object({
  path: z.string().max(200),
  before: z.string().max(4_000).nullable(),
  after: z.string().max(4_000).nullable()
}).strict();

const principalScoped = { version: z.literal(1), principal: RunnerPrincipalSelectorSchema };
const owner = <O extends string, I extends z.ZodType>(operation: O, input: I) =>
  z.object({ ...principalScoped, operation: z.literal(operation), input }).strict();
const expectedVersion = z.number().int().min(0);
const target = {
  scope: AgentPolicyScopeSchema,
  projectId: AgentPolicyProjectIdSchema.optional()
};
const targetRefine = (value: { scope: 'global' | 'project'; projectId?: string | undefined }) => (value.scope === 'project') === (value.projectId !== undefined);
const targetMessage = 'projectId is required for the project scope and not allowed for the global scope';
/**
 * Binds a confirmation to the exact weakening list the owner was shown (policy_validate returns it), to
 * the operation it was shown for, and to the policy's version history. A write that weakens the effective
 * policy needs confirmWeakening and this digest; any change underneath (another weakening, a new global
 * head, a save or delete of this policy) changes the digest and the write is refused again.
 */
export const AgentPolicyWeakeningDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
/** The write a validation previews; its digest only confirms that operation. */
export const AgentPolicyIntentSchema = z.enum(['save', 'rollback', 'delete']);
export type AgentPolicyIntent = z.infer<typeof AgentPolicyIntentSchema>;
const weakeningDigest = AgentPolicyWeakeningDigestSchema.optional();
const note = z.string().max(AGENT_POLICY_LIMITS.maxNoteChars).refine(noControl, 'note cannot contain control characters').optional();

export const AgentPoliciesRunnerRequestSchema = z.discriminatedUnion('operation', [
  owner('policy_overview', z.object({}).strict()),
  owner('policy_get', z.object(target).strict().refine(targetRefine, targetMessage)),
  owner('policy_validate', z.object({ ...target, document: z.unknown(), intent: AgentPolicyIntentSchema.default('save') }).strict().refine(targetRefine, targetMessage)),
  owner('policy_put', z.object({
    ...target, document: z.unknown(), expectedVersion, confirmWeakening: z.boolean().default(false), weakeningDigest, note
  }).strict().refine(targetRefine, targetMessage)),
  owner('policy_delete', z.object({ projectId: AgentPolicyProjectIdSchema, expectedVersion: z.number().int().positive(), confirmWeakening: z.boolean().default(false), weakeningDigest }).strict()),
  owner('policy_history', z.object({
    ...target,
    beforeVersion: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(AGENT_POLICY_LIMITS.maxHistoryLimit).default(20)
  }).strict().refine(targetRefine, targetMessage)),
  owner('policy_revision_get', z.object({ revisionId: AgentPolicyRevisionIdSchema }).strict()),
  owner('policy_diff', z.object({ fromRevisionId: AgentPolicyRevisionIdSchema, toRevisionId: AgentPolicyRevisionIdSchema }).strict()),
  owner('policy_rollback', z.object({
    revisionId: AgentPolicyRevisionIdSchema, expectedVersion, confirmWeakening: z.boolean().default(false), weakeningDigest, note
  }).strict()),
  owner('policy_simulate', z.object({
    projectId: AgentPolicyProjectIdSchema.optional(),
    action: AgentActionDescriptorSchema,
    context: GateContextSchema.optional(),
    /** Evaluate an unsaved document in place of the stored one, with the same evaluator. */
    draft: z.object({ scope: AgentPolicyScopeSchema, document: z.unknown() }).strict().optional()
  }).strict())
]);

const head = AgentPolicyRevisionSchema.nullable();
const headSummary = z.object({
  revisionId: AgentPolicyRevisionIdSchema, version: z.number().int().positive(), digest: z.string(), updatedAt: instant
}).strict();

export const AgentPoliciesRunnerDataSchemas = {
  policy_overview: z.object({
    global: headSummary.nullable(),
    projects: z.array(z.object({ projectId: AgentPolicyProjectIdSchema, head: headSummary, orphaned: z.boolean() }).strict()),
    /** True when more project policies exist than the overview lists (most recently changed first). */
    projectsTruncated: z.boolean(),
    defaultGlobal: GlobalExecutionPolicySchema
  }).strict(),
  policy_get: z.object({
    scope: AgentPolicyScopeSchema,
    projectId: AgentPolicyProjectIdSchema.nullable(),
    projectState: z.enum(['active', 'unknown']).nullable(),
    head,
    /** The global policy a project inherits from (stored or default). */
    global: z.object({ revision: head, document: GlobalExecutionPolicySchema, source: z.enum(['stored', 'default']) }).strict(),
    /** 
ull when nothing is permitted because the project no longer exists (PROJECT_POLICY_ORPHANED). */
    effective: EffectivePolicySchema.nullable()
  }).strict(),
  policy_validate: z.object({
    valid: z.boolean(),
    errors: z.array(z.string().max(500)).max(AGENT_POLICY_LIMITS.maxDetails),
    widenings: z.array(z.string().max(300)).max(AGENT_POLICY_LIMITS.maxDetails * 4),
    weakenings: z.array(z.string().max(300)).max(AGENT_POLICY_LIMITS.maxDetails * 4),
    changes: z.array(PolicyChangeSchema).max(500),
    effective: EffectivePolicySchema.nullable(),
    /** Present when the change weakens the effective policy; send it back with confirmWeakening. */
    weakeningDigest: AgentPolicyWeakeningDigestSchema.nullable()
  }).strict(),
  policy_put: z.object({ head: AgentPolicyRevisionSchema, weakenings: z.array(z.string().max(300)) }).strict(),
  policy_delete: z.object({ deleted: z.literal(true) }).strict(),
  policy_history: z.object({
    revisions: z.array(AgentPolicyRevisionSummarySchema),
    headRevisionId: AgentPolicyRevisionIdSchema.nullable(),
    nextBeforeVersion: z.number().int().positive().nullable()
  }).strict(),
  policy_revision_get: z.object({ revision: AgentPolicyRevisionSchema }).strict(),
  policy_diff: z.object({ changes: z.array(PolicyChangeSchema).max(500) }).strict(),
  policy_rollback: z.object({ head: AgentPolicyRevisionSchema, weakenings: z.array(z.string().max(300)) }).strict(),
  policy_simulate: z.object({ decision: GateDecisionSchema, effective: EffectivePolicySchema.nullable() }).strict()
} as const;

/**
 * `FEATURE_DISABLED` while `AGENT_POLICIES_ENABLED` is off. `POLICY_WIDENS` rejects a project
 * document that would loosen the global policy; `CONFIRMATION_REQUIRED` asks the owner to confirm a
 * save that weakens the current effective policy. Both carry the offending items in `details`.
 */
export const AgentPoliciesRunnerErrorCodeSchema = z.enum([
  'INVALID_INPUT', 'NOT_FOUND', 'CONFLICT', 'POLICY_WIDENS', 'CONFIRMATION_REQUIRED', 'RESOURCE_EXHAUSTED', 'FEATURE_DISABLED', 'UNAVAILABLE', 'INTERNAL'
]);

export const AgentPoliciesRunnerResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: AgentPoliciesRunnerErrorCodeSchema,
      message: z.string().max(500),
      details: z.array(z.string().max(300)).max(AGENT_POLICY_LIMITS.maxDetails * 4).optional()
    }).strict()
  }).strict()
]);

export type AgentActionClass = z.infer<typeof AgentActionClassSchema>;
export type AgentPlatformEffect = z.infer<typeof AgentPlatformEffectSchema>;
export type PolicyRuleEffect = z.infer<typeof PolicyRuleEffectSchema>;
export type GateDecisionValue = z.infer<typeof GateDecisionValueSchema>;
export type AdvisorEffect = z.infer<typeof AdvisorEffectSchema>;
export type PolicyScope = z.infer<typeof PolicyScopeSchema>;
export type PolicyBudget = z.infer<typeof PolicyBudgetSchema>;
export type GlobalExecutionPolicy = z.infer<typeof GlobalExecutionPolicySchema>;
export type ProjectExecutionPolicy = z.infer<typeof ProjectExecutionPolicySchema>;
export type AgentActionDescriptor = z.infer<typeof AgentActionDescriptorSchema>;
export type AgentActionDescriptorInput = z.input<typeof AgentActionDescriptorSchema>;
export type GateContext = z.infer<typeof GateContextSchema>;
export type GateReasonCode = z.infer<typeof GateReasonCodeSchema>;
export type GateReason = z.infer<typeof GateReasonSchema>;
export type GateDecision = z.infer<typeof GateDecisionSchema>;
export type EffectivePolicy = z.infer<typeof EffectivePolicySchema>;
export type AgentPolicyScope = z.infer<typeof AgentPolicyScopeSchema>;
export type AgentPolicyRevision = z.infer<typeof AgentPolicyRevisionSchema>;
export type AgentPolicyRevisionSummary = z.infer<typeof AgentPolicyRevisionSummarySchema>;
export type PolicyChange = z.infer<typeof PolicyChangeSchema>;
export type AgentPoliciesRunnerRequest = z.infer<typeof AgentPoliciesRunnerRequestSchema>;
export type AgentPoliciesRunnerOperation = AgentPoliciesRunnerRequest['operation'];
export type AgentPoliciesRunnerResponse = z.infer<typeof AgentPoliciesRunnerResponseSchema>;
export type AgentPoliciesRunnerErrorCode = z.infer<typeof AgentPoliciesRunnerErrorCodeSchema>;
