import type { DatabaseSync } from 'node:sqlite';
import type { ZodError } from 'zod';
import {
  AGENT_POLICY_LIMITS,
  AgentActionDescriptorSchema,
  AgentPoliciesRunnerDataSchemas,
  AgentPoliciesRunnerRequestSchema,
  DEFAULT_GLOBAL_EXECUTION_POLICY,
  GlobalExecutionPolicySchema,
  ProjectExecutionPolicySchema,
  type AgentActionDescriptor,
  type AgentPoliciesRunnerErrorCode,
  type AgentPoliciesRunnerRequest,
  type AgentPoliciesRunnerResponse,
  type AgentPolicyIntent,
  type AgentPolicyRevision,
  type AgentPolicyScope,
  type EffectivePolicy,
  type GateContext,
  type GateDecision,
  type GlobalExecutionPolicy,
  type ProjectExecutionPolicy,
  type RunnerPrincipalSelector
} from '@cloud-harness/contracts';
import { withEventSavepoint } from '../event-outbox.js';
import { isAdvisorPending, PURE_GATE_EVALUATOR, type AdvisorAnswer, type GateInput, type PolicySnapshot } from './gate-evaluator.js';
import type { AdvisorAvailability, AdvisorFacts, DecisionAdvisor } from './ports.js';
import { canonicalJson, diffPolicyDocuments, policyWeakenings, resolveEffectivePolicy, sha256 } from './policy-merge.js';
import { StorePolicyResolver, type ProjectStateLookup } from './policy-resolver.js';
import { PolicyStore, PolicyStoreError } from './policy-store.js';

export type AgentPolicyAudit = (
  database: DatabaseSync,
  principalId: string,
  action: string,
  subjectType: string,
  subjectId: string,
  generation: number,
  details: Record<string, string | number | boolean>
) => void;

export type AgentPolicyServiceOptions = {
  database: DatabaseSync;
  enabled: boolean;
  resolvePrincipal: (selector: RunnerPrincipalSelector) => string;
  projectState: ProjectStateLookup;
  /** Every active project id of a principal, in one query (the overview marks orphaned policies with it). */
  activeProjectIds: (principalId: string) => ReadonlySet<string>;
  audit: AgentPolicyAudit;
  /**
   * The advisor for discretionary actions whose policy enables it. Execution and simulation read the same
   * per-principal availability, so a preview shows the same pending or fallback outcome execution starts
   * from. Without one, every advisor-enabled discretionary action takes the policy's fallback (`disabled`).
   */
  advisor?: DecisionAdvisor | undefined;
  now?: () => number;
};

export type AgentPolicyDecideOptions = {
  /** Typed counts and flags the broker knows about the action; never text. */
  facts?: AdvisorFacts | undefined;
  signal?: AbortSignal | undefined;
};

/** The overview lists at most this many project policies, most recently changed first. */
export const OVERVIEW_PROJECT_LIMIT = 1_000;

export class AgentPolicyError extends Error {
  constructor(readonly code: AgentPoliciesRunnerErrorCode, message: string, readonly details?: string[]) {
    super(message);
  }
}

type Request<O extends AgentPoliciesRunnerRequest['operation']> = Extract<AgentPoliciesRunnerRequest, { operation: O }>['input'];
type Document = GlobalExecutionPolicy | ProjectExecutionPolicy;

const MAX_DETAILS = AGENT_POLICY_LIMITS.maxDetails * 4;
const bounded = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max - 1)}…`);
const details = (values: string[]) => values.slice(0, MAX_DETAILS).map((value) => bounded(value, 300));
/** A weakening list is confirmable only when the owner can see all of it: nothing cut by `details`. */
const reviewable = (weakenings: readonly string[]) => weakenings.length <= MAX_DETAILS && weakenings.every((value) => value.length <= 300);
const unreviewable = (weakenings: readonly string[]) =>
  `this change weakens the effective policy in ${weakenings.length} ways, more than one confirmation can show in full; save it in smaller steps`;
const issues = (error: ZodError) => error.issues.slice(0, AGENT_POLICY_LIMITS.maxDetails)
  .map((issue) => bounded(`${issue.path.length > 0 ? issue.path.join('.') : 'document'}: ${issue.message}`, 500));
const projectSubject = (scope: AgentPolicyScope, projectId: string | null) => (scope === 'global' ? 'global' : projectId ?? 'global');

/**
 * Owner-scoped CRUD, history, diff, rollback and simulation for agent execution policies. The
 * principal always comes from the authenticated request selector; the project id is checked against
 * the metadata projects table. Simulation calls the same `evaluateGate` the execution broker uses.
 */
export class AgentPolicyService {
  readonly store: PolicyStore;
  readonly resolver: StorePolicyResolver;
  private readonly database: DatabaseSync;
  private readonly enabled: boolean;
  private readonly resolvePrincipal: (selector: RunnerPrincipalSelector) => string;
  private readonly projectState: ProjectStateLookup;
  private readonly activeProjectIds: (principalId: string) => ReadonlySet<string>;
  private readonly audit: AgentPolicyAudit;
  private readonly advisor: DecisionAdvisor | undefined;

  constructor(options: AgentPolicyServiceOptions) {
    this.database = options.database;
    this.enabled = options.enabled;
    this.resolvePrincipal = options.resolvePrincipal;
    this.projectState = options.projectState;
    this.activeProjectIds = options.activeProjectIds;
    this.audit = options.audit;
    this.advisor = options.advisor;
    this.store = new PolicyStore(options.database, options.now);
    this.resolver = new StorePolicyResolver(this.store, options.projectState);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * The deterministic decision execution starts from: resolve the current heads, then the pure
   * evaluator. A discretionary action comes back pending (`ADVISOR_REQUIRED`) when the policy enables
   * the advisor and it is available; `decide` settles it.
   */
  evaluate(principalId: string, projectId: string | null, descriptor: AgentActionDescriptor, context?: GateContext): GateDecision {
    return PURE_GATE_EVALUATOR.evaluate(this.gateInput(principalId, this.resolver.resolve(principalId, projectId), descriptor, context));
  }

  /**
   * The execution decision: `evaluate`, then, only for a pending discretionary action, one advisor call
   * whose answer `combineAdvisor` applies. Every other decision (any DENY, mandatory or rule approval,
   * an unanalyzable command, a plain ALLOW) is returned without consulting the advisor, so nothing
   * leaves the runner for it. The advisor cannot lower a decision; a failure takes the policy fallback.
   * The advisor is told the subject the evaluator judged (for example `publish_branch` for a declared
   * `test` that runs `git push`), never only the declared class. The coding broker's execution-time
   * gate is the caller. A descriptor that does not match the contract is refused.
   */
  async decide(principalId: string, projectId: string | null, input: AgentActionDescriptor, context?: GateContext, options: AgentPolicyDecideOptions = {}): Promise<GateDecision> {
    const parsed = AgentActionDescriptorSchema.safeParse(input);
    if (!parsed.success) throw new AgentPolicyError('INVALID_INPUT', bounded(issues(parsed.error)[0] ?? 'invalid action descriptor', 500));
    const descriptor = parsed.data;
    const snapshot = this.resolver.resolve(principalId, projectId);
    const { decision, subject } = PURE_GATE_EVALUATOR.evaluateSubject(this.gateInput(principalId, snapshot, descriptor, context));
    if (!isAdvisorPending(decision) || !this.advisor) return decision;
    const settings = resolveEffectivePolicy(snapshot.global.document, snapshot.project?.state === 'active' ? snapshot.project.document : null).advisor;
    let answer: AdvisorAnswer | null;
    try {
      answer = await this.advisor.advise({ principalId, descriptor, decision, subject, settings, facts: options.facts, signal: options.signal });
    } catch {
      answer = null;
    }
    return PURE_GATE_EVALUATOR.combineAdvisor(decision, answer);
  }

  /** Execution and simulation build the gate input here, so both see the same advisor availability. */
  private gateInput(principalId: string, snapshot: PolicySnapshot, descriptor: AgentActionDescriptor, context: GateContext | undefined): GateInput {
    const availability = this.advisorAvailability(principalId);
    return {
      descriptor,
      snapshot,
      context,
      advisorAvailable: availability.available,
      ...(availability.available ? {} : { advisorUnavailableReason: availability.reason })
    };
  }

  private advisorAvailability(principalId: string): AdvisorAvailability {
    if (!this.advisor) return { available: false, reason: 'disabled' };
    try {
      return this.advisor.availability(principalId);
    } catch {
      return { available: false, reason: 'unavailable' };
    }
  }

  execute(request: unknown): AgentPoliciesRunnerResponse {
    const parsed = AgentPoliciesRunnerRequestSchema.safeParse(request);
    if (!parsed.success) return { ok: false, error: { code: 'INVALID_INPUT', message: bounded(issues(parsed.error)[0] ?? 'invalid agent policy request', 500) } };
    if (!this.enabled) return { ok: false, error: { code: 'FEATURE_DISABLED', message: 'agent policies are disabled on this instance' } };
    try {
      const data = this.dispatch(parsed.data);
      return { ok: true, data: AgentPoliciesRunnerDataSchemas[parsed.data.operation].parse(data) };
    } catch (error) {
      if (error instanceof AgentPolicyError) {
        return { ok: false, error: { code: error.code, message: bounded(error.message, 500), ...(error.details ? { details: details(error.details) } : {}) } };
      }
      if (error instanceof PolicyStoreError) return { ok: false, error: { code: error.code, message: bounded(error.message, 500) } };
      throw error;
    }
  }

  private dispatch(request: AgentPoliciesRunnerRequest): unknown {
    const principalId = this.resolvePrincipal(request.principal);
    switch (request.operation) {
      case 'policy_overview': return this.overview(principalId);
      case 'policy_get': return this.get(principalId, request.input.scope, request.input.projectId ?? null);
      case 'policy_validate': return this.validate(principalId, request.input);
      case 'policy_put': return this.put(principalId, request.input);
      case 'policy_delete': return this.remove(principalId, request.input);
      case 'policy_history': return this.history(principalId, request.input);
      case 'policy_revision_get': return { revision: this.ownedRevision(principalId, request.input.revisionId) };
      case 'policy_diff': return this.diff(principalId, request.input);
      case 'policy_rollback': return this.rollback(principalId, request.input);
      case 'policy_simulate': return this.simulate(principalId, request.input);
    }
  }

  // ---------------------------------------------------------------- reads

  private overview(principalId: string) {
    const heads = this.store.projectHeads(principalId, OVERVIEW_PROJECT_LIMIT + 1);
    const active = this.activeProjectIds(principalId);
    return {
      global: this.store.headSummary(principalId, 'global', null),
      projects: heads.slice(0, OVERVIEW_PROJECT_LIMIT).map(({ projectId, head }) => ({ projectId, head, orphaned: !active.has(projectId) })),
      projectsTruncated: heads.length > OVERVIEW_PROJECT_LIMIT,
      defaultGlobal: DEFAULT_GLOBAL_EXECUTION_POLICY
    };
  }

  /** What the snapshot permits, or `null` when an orphaned or unknown project denies every action. */
  private effectiveFor(snapshot: PolicySnapshot): EffectivePolicy | null {
    if (snapshot.project?.state === 'unknown') return null;
    return resolveEffectivePolicy(snapshot.global.document, snapshot.project?.document ?? null);
  }

  private get(principalId: string, scope: AgentPolicyScope, projectId: string | null) {
    const snapshot = this.resolver.resolve(principalId, scope === 'project' ? projectId : null);
    const global = { revision: this.store.head(principalId, 'global', null), document: snapshot.global.document, source: snapshot.global.source === 'stored' ? 'stored' as const : 'default' as const };
    if (scope === 'global') {
      return { scope, projectId: null, projectState: null, head: global.revision, global, effective: resolveEffectivePolicy(snapshot.global.document, null) };
    }
    const project = snapshot.project;
    if (!project) throw new AgentPolicyError('INVALID_INPUT', 'projectId is required for the project scope');
    if (project.state !== 'active' && !project.document) throw new AgentPolicyError('NOT_FOUND', 'project not found');
    return {
      scope,
      projectId,
      projectState: project.state,
      head: this.store.head(principalId, 'project', projectId),
      global,
      effective: this.effectiveFor(snapshot)
    };
  }

  private history(principalId: string, input: Request<'policy_history'>) {
    const projectId = input.projectId ?? null;
    const page = this.store.history(principalId, input.scope, projectId, input.beforeVersion, input.limit);
    return { ...page, headRevisionId: this.store.headSummary(principalId, input.scope, projectId)?.revisionId ?? null };
  }

  private ownedRevision(principalId: string, revisionId: string): AgentPolicyRevision {
    const revision = this.store.revision(principalId, revisionId);
    if (!revision) throw new AgentPolicyError('NOT_FOUND', 'policy revision not found');
    return revision;
  }

  private diff(principalId: string, input: Request<'policy_diff'>) {
    const from = this.ownedRevision(principalId, input.fromRevisionId);
    const to = this.ownedRevision(principalId, input.toRevisionId);
    if (from.scope !== to.scope || from.projectId !== to.projectId) throw new AgentPolicyError('INVALID_INPUT', 'revisions belong to different policies');
    return { changes: diffPolicyDocuments(from.document, to.document) };
  }

  // ---------------------------------------------------------------- validation

  private parseDocument(scope: AgentPolicyScope, document: unknown): Document {
    const parsed = scope === 'global' ? GlobalExecutionPolicySchema.safeParse(document) : ProjectExecutionPolicySchema.safeParse(document);
    if (!parsed.success) throw new AgentPolicyError('INVALID_INPUT', 'the policy document is invalid', issues(parsed.error));
    return parsed.data;
  }

  /**
   * What saving `document` at (scope, project) would do: the project fields that try to widen the
   * global policy (rejected on save), the effective-policy weakenings the owner must confirm, and the
   * document diff against the current head.
   */
  private assess(principalId: string, scope: AgentPolicyScope, projectId: string | null, document: Document) {
    const snapshot = this.resolver.resolve(principalId, projectId);
    if (scope === 'global') {
      const next = document as GlobalExecutionPolicy;
      const before = resolveEffectivePolicy(snapshot.global.document, null);
      const after = resolveEffectivePolicy(next, null);
      return { widenings: [] as string[], weakenings: policyWeakenings(before, after), changes: diffPolicyDocuments(snapshot.global.revisionId ? snapshot.global.document : null, next), effective: after, snapshot };
    }
    const next = document as ProjectExecutionPolicy;
    const before = resolveEffectivePolicy(snapshot.global.document, snapshot.project?.document ?? null);
    const after = resolveEffectivePolicy(snapshot.global.document, next);
    return {
      widenings: after.ignoredProjectFields,
      weakenings: policyWeakenings(before, after),
      changes: diffPolicyDocuments(snapshot.project?.document ?? null, next),
      effective: after,
      snapshot
    };
  }

  private requireActiveProject(principalId: string, projectId: string): void {
    if (this.projectState(principalId, projectId) !== 'active') throw new AgentPolicyError('NOT_FOUND', 'project not found');
  }

  private validate(principalId: string, input: Request<'policy_validate'>) {
    const projectId = input.projectId ?? null;
    if (projectId !== null) this.requireActiveProject(principalId, projectId);
    const parsed = input.scope === 'global' ? GlobalExecutionPolicySchema.safeParse(input.document) : ProjectExecutionPolicySchema.safeParse(input.document);
    if (!parsed.success) return { valid: false, errors: issues(parsed.error), widenings: [], weakenings: [], changes: [], effective: null, weakeningDigest: null };
    const assessment = this.assess(principalId, input.scope, projectId, parsed.data);
    const fits = reviewable(assessment.weakenings);
    return {
      valid: assessment.widenings.length === 0 && fits,
      errors: fits ? [] : [unreviewable(assessment.weakenings)],
      widenings: details(assessment.widenings),
      weakenings: details(assessment.weakenings),
      changes: assessment.changes,
      effective: assessment.effective,
      weakeningDigest: assessment.weakenings.length > 0 && fits
        ? this.weakeningDigest(principalId, input.scope, projectId, input.intent, assessment.snapshot, assessment.weakenings)
        : null
    };
  }

  /**
   * Identifies the confirmation the owner gave: the full weakening list (always shown in full, see
   * `reviewable`), the operation, this policy, the current global head, the target head version and the
   * highest version the policy ever had. A different list, operation or any save or delete changes it, so
   * a confirmation cannot be replayed after the policy was deleted and recreated.
   */
  private weakeningDigest(
    principalId: string,
    scope: AgentPolicyScope,
    projectId: string | null,
    intent: AgentPolicyIntent,
    snapshot: PolicySnapshot,
    weakenings: readonly string[]
  ): string {
    const headVersion = this.store.headSummary(principalId, scope, projectId)?.version ?? 0;
    const latestVersion = this.store.latestVersion(principalId, scope, projectId);
    return sha256(canonicalJson({ intent, scope, projectId, globalRevisionId: snapshot.global.revisionId, headVersion, latestVersion, weakenings: [...weakenings] }));
  }

  /** Stale clients get CONFLICT before any policy check, so they reload instead of answering a stale prompt. */
  private requireHeadVersion(principalId: string, scope: AgentPolicyScope, projectId: string | null, expectedVersion: number): void {
    const current = this.store.headSummary(principalId, scope, projectId)?.version ?? 0;
    if (current !== expectedVersion) throw new PolicyStoreError('CONFLICT', `the policy is at version ${current}, not ${expectedVersion}`);
  }

  /** A weakening needs `confirmWeakening` and the digest of exactly this weakening list, all of it reviewable. */
  private requireConfirmation(confirmed: { confirmWeakening: boolean; weakeningDigest?: string | undefined }, expected: string | null, weakenings: string[], message: string): void {
    if (expected === null) return;
    if (!reviewable(weakenings)) throw new AgentPolicyError('INVALID_INPUT', unreviewable(weakenings));
    if (!confirmed.confirmWeakening || confirmed.weakeningDigest !== expected) throw new AgentPolicyError('CONFIRMATION_REQUIRED', message, weakenings);
  }

  // ---------------------------------------------------------------- writes

  /** Shared by save and rollback: widening is rejected, weakening needs explicit confirmation. */
  private write(
    principalId: string,
    scope: AgentPolicyScope,
    projectId: string | null,
    document: Document,
    expectedVersion: number,
    confirmation: { confirmWeakening: boolean; weakeningDigest?: string | undefined },
    audit: { action: string; note: string | null; rollbackOf: string | null; intent: AgentPolicyIntent }
  ): { head: AgentPolicyRevision; weakenings: string[] } {
    return withEventSavepoint(this.database, () => {
      if (projectId !== null) this.requireActiveProject(principalId, projectId);
      this.requireHeadVersion(principalId, scope, projectId, expectedVersion);
      const assessment = this.assess(principalId, scope, projectId, document);
      if (assessment.widenings.length > 0) throw new AgentPolicyError('POLICY_WIDENS', 'a project policy can only narrow the global policy', assessment.widenings);
      const digest = assessment.weakenings.length > 0 ? this.weakeningDigest(principalId, scope, projectId, audit.intent, assessment.snapshot, assessment.weakenings) : null;
      this.requireConfirmation(confirmation, digest, assessment.weakenings, 'this change weakens the effective policy; confirm the listed weakenings explicitly');
      const head = this.store.put(principalId, scope, projectId, document, expectedVersion, { rollbackOf: audit.rollbackOf, note: audit.note });
      this.audit(this.database, principalId, audit.action, 'agent_policy', projectSubject(scope, projectId), head.version, {
        scope,
        revisionId: head.revisionId,
        digest: head.digest,
        weakened: assessment.weakenings.length > 0,
        weakenings: assessment.weakenings.length,
        ...(audit.rollbackOf ? { rollbackOf: audit.rollbackOf } : {})
      });
      return { head, weakenings: details(assessment.weakenings) };
    });
  }

  private put(principalId: string, input: Request<'policy_put'>) {
    const document = this.parseDocument(input.scope, input.document);
    return this.write(principalId, input.scope, input.projectId ?? null, document, input.expectedVersion, input, {
      action: 'agent_policy.updated', note: input.note ?? null, rollbackOf: null, intent: 'save'
    });
  }

  private rollback(principalId: string, input: Request<'policy_rollback'>) {
    const target = this.ownedRevision(principalId, input.revisionId);
    return this.write(principalId, target.scope, target.projectId, target.document, input.expectedVersion, input, {
      action: 'agent_policy.rolled_back', note: input.note ?? null, rollbackOf: target.revisionId, intent: 'rollback'
    });
  }

  /** Removing a project policy falls back to the global policy, which is a weakening when the project narrowed it. */
  private remove(principalId: string, input: Request<'policy_delete'>) {
    return withEventSavepoint(this.database, () => {
      const snapshot = this.resolver.resolve(principalId, input.projectId);
      const current = snapshot.project?.document;
      if (!current) throw new AgentPolicyError('NOT_FOUND', 'the project has no policy');
      this.requireHeadVersion(principalId, 'project', input.projectId, input.expectedVersion);
      // An orphaned policy no longer governs anything (the evaluator denies its project), so removing it weakens nothing.
      const weakenings = snapshot.project?.state === 'active'
        ? policyWeakenings(resolveEffectivePolicy(snapshot.global.document, current), resolveEffectivePolicy(snapshot.global.document, null))
        : [];
      const digest = weakenings.length > 0 ? this.weakeningDigest(principalId, 'project', input.projectId, 'delete', snapshot, weakenings) : null;
      this.requireConfirmation(input, digest, weakenings, 'removing this policy weakens the effective policy; confirm the listed weakenings explicitly');
      this.store.deleteProjectHead(principalId, input.projectId, input.expectedVersion);
      this.audit(this.database, principalId, 'agent_policy.deleted', 'agent_policy', input.projectId, input.expectedVersion, {
        scope: 'project', weakened: weakenings.length > 0, weakenings: weakenings.length
      });
      return { deleted: true as const };
    });
  }

  // ---------------------------------------------------------------- simulation

  /**
   * Evaluates one descriptor with the same evaluator and advisor availability execution uses. A draft
   * replaces the stored document for its scope only; the other scope still comes from storage. A
   * simulation never calls the advisor, so it sends nothing: a discretionary action shows as pending
   * (`ADVISOR_REQUIRED`) when the advisor would be consulted at execution, or with the fallback and its
   * reason (`disabled`, `unconfigured`) when it would not. Simulations are read-only and not audited.
   */
  private simulate(principalId: string, input: Request<'policy_simulate'>): { decision: GateDecision; effective: EffectivePolicy | null } {
    const projectId = input.projectId ?? null;
    let snapshot: PolicySnapshot = this.resolver.resolve(principalId, projectId);
    if (input.draft) {
      const document = this.parseDocument(input.draft.scope, input.draft.document);
      if (input.draft.scope === 'global') {
        snapshot = { ...snapshot, global: { revisionId: null, document: document as GlobalExecutionPolicy, source: 'draft' } };
      } else {
        if (!snapshot.project) throw new AgentPolicyError('INVALID_INPUT', 'a project draft needs a projectId');
        snapshot = { ...snapshot, project: { ...snapshot.project, revisionId: null, document: document as ProjectExecutionPolicy, source: 'draft' } };
      }
    }
    const decision = PURE_GATE_EVALUATOR.evaluate(this.gateInput(principalId, snapshot, input.action, input.context));
    return { decision, effective: this.effectiveFor(snapshot) };
  }
}
