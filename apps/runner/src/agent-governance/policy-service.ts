import type { DatabaseSync } from 'node:sqlite';
import type { ZodError } from 'zod';
import {
  AGENT_POLICY_LIMITS,
  AgentPoliciesRunnerDataSchemas,
  AgentPoliciesRunnerRequestSchema,
  DEFAULT_GLOBAL_EXECUTION_POLICY,
  GlobalExecutionPolicySchema,
  ProjectExecutionPolicySchema,
  type AgentActionDescriptor,
  type AgentPoliciesRunnerErrorCode,
  type AgentPoliciesRunnerRequest,
  type AgentPoliciesRunnerResponse,
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
import { evaluateGate, type PolicySnapshot } from './gate-evaluator.js';
import { diffPolicyDocuments, policyWeakenings, resolveEffectivePolicy } from './policy-merge.js';
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
  audit: AgentPolicyAudit;
  now?: () => number;
};

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
  private readonly audit: AgentPolicyAudit;

  constructor(options: AgentPolicyServiceOptions) {
    this.database = options.database;
    this.enabled = options.enabled;
    this.resolvePrincipal = options.resolvePrincipal;
    this.projectState = options.projectState;
    this.audit = options.audit;
    this.store = new PolicyStore(options.database, options.now);
    this.resolver = new StorePolicyResolver(this.store, options.projectState);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** The decision path execution uses: resolve the current heads, then the pure evaluator. */
  evaluate(principalId: string, projectId: string | null, descriptor: AgentActionDescriptor, context?: GateContext, advisorAvailable = false): GateDecision {
    return evaluateGate({ descriptor, snapshot: this.resolver.resolve(principalId, projectId), context, advisorAvailable });
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
    return {
      global: this.store.headSummary(principalId, 'global', null),
      projects: this.store.projectHeads(principalId).map(({ projectId, head }) => ({ projectId, head, orphaned: this.projectState(principalId, projectId) !== 'active' })),
      defaultGlobal: DEFAULT_GLOBAL_EXECUTION_POLICY
    };
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
      effective: resolveEffectivePolicy(snapshot.global.document, project.document)
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
    if (!parsed.success) return { valid: false, errors: issues(parsed.error), widenings: [], weakenings: [], changes: [], effective: null };
    const assessment = this.assess(principalId, input.scope, projectId, parsed.data);
    return {
      valid: assessment.widenings.length === 0,
      errors: [],
      widenings: details(assessment.widenings),
      weakenings: details(assessment.weakenings),
      changes: assessment.changes,
      effective: assessment.effective
    };
  }

  // ---------------------------------------------------------------- writes

  /** Shared by save and rollback: widening is rejected, weakening needs explicit confirmation. */
  private write(
    principalId: string,
    scope: AgentPolicyScope,
    projectId: string | null,
    document: Document,
    expectedVersion: number,
    confirmWeakening: boolean,
    audit: { action: string; note: string | null; rollbackOf: string | null }
  ): { head: AgentPolicyRevision; weakenings: string[] } {
    return withEventSavepoint(this.database, () => {
      if (projectId !== null) this.requireActiveProject(principalId, projectId);
      const assessment = this.assess(principalId, scope, projectId, document);
      if (assessment.widenings.length > 0) throw new AgentPolicyError('POLICY_WIDENS', 'a project policy can only narrow the global policy', assessment.widenings);
      if (assessment.weakenings.length > 0 && !confirmWeakening) {
        throw new AgentPolicyError('CONFIRMATION_REQUIRED', 'this change weakens the effective policy; confirm it explicitly', assessment.weakenings);
      }
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
    return this.write(principalId, input.scope, input.projectId ?? null, document, input.expectedVersion, input.confirmWeakening, {
      action: 'agent_policy.updated', note: input.note ?? null, rollbackOf: null
    });
  }

  private rollback(principalId: string, input: Request<'policy_rollback'>) {
    const target = this.ownedRevision(principalId, input.revisionId);
    return this.write(principalId, target.scope, target.projectId, target.document, input.expectedVersion, input.confirmWeakening, {
      action: 'agent_policy.rolled_back', note: input.note ?? null, rollbackOf: target.revisionId
    });
  }

  /** Removing a project policy falls back to the global policy, which is a weakening when the project narrowed it. */
  private remove(principalId: string, input: Request<'policy_delete'>) {
    return withEventSavepoint(this.database, () => {
      const snapshot = this.resolver.resolve(principalId, input.projectId);
      const current = snapshot.project?.document;
      if (!current) throw new AgentPolicyError('NOT_FOUND', 'the project has no policy');
      // An orphaned policy no longer governs anything (the evaluator denies its project), so removing it weakens nothing.
      const weakenings = snapshot.project?.state === 'active'
        ? policyWeakenings(resolveEffectivePolicy(snapshot.global.document, current), resolveEffectivePolicy(snapshot.global.document, null))
        : [];
      if (weakenings.length > 0 && !input.confirmWeakening) {
        throw new AgentPolicyError('CONFIRMATION_REQUIRED', 'removing this policy weakens the effective policy; confirm it explicitly', weakenings);
      }
      this.store.deleteProjectHead(principalId, input.projectId, input.expectedVersion);
      this.audit(this.database, principalId, 'agent_policy.deleted', 'agent_policy', input.projectId, input.expectedVersion, {
        scope: 'project', weakened: weakenings.length > 0, weakenings: weakenings.length
      });
      return { deleted: true as const };
    });
  }

  // ---------------------------------------------------------------- simulation

  /**
   * Evaluates one descriptor with `evaluateGate`, the same function execution uses. A draft replaces
   * the stored document for its scope only; the other scope still comes from storage.
   */
  private simulate(principalId: string, input: Request<'policy_simulate'>): { decision: GateDecision; effective: EffectivePolicy } {
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
    const decision = evaluateGate({ descriptor: input.action, snapshot, context: input.context, advisorAvailable: false });
    const project = snapshot.project?.state === 'active' ? snapshot.project.document : null;
    const effective = resolveEffectivePolicy(snapshot.global.document, project);
    withEventSavepoint(this.database, () => this.audit(this.database, principalId, 'agent_policy.simulated', 'agent_policy', projectSubject(projectId ? 'project' : 'global', projectId), 1, {
      actionClass: decision.actionClass,
      decision: decision.decision,
      reasonCode: decision.reasonCode,
      inputFingerprint: decision.inputFingerprint,
      draft: input.draft !== undefined
    }));
    return { decision, effective };
  }
}
