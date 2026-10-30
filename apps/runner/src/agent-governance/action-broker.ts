import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  AGENT_POLICY_LIMITS,
  AgentActionDescriptorSchema,
  BROKERED_ONLY_PROXY_OPERATIONS,
  CODING_PROXY_OPERATIONS,
  CodingRuleActionSchema,
  type AgentActionDescriptor,
  type AgentActionDescriptorInput,
  type AgentProxyOperation,
  type CodingActionOrigin,
  type CodingActionOutcome,
  type CodingActionState,
  type CodingActionStep,
  type CodingErrorCode,
  type CodingRuleAction,
  type GateContext,
  type GateDecision,
  type RunnerResponse
} from '@cloud-harness/contracts';
import type { AgentActionTraceSink } from '../agent-trace-recorder.js';
import { traceInputDigest } from '../agent-trace-recorder.js';
import { CodingActionStore, type CodingActionRecord } from './action-store.js';
import type { AgentPolicyService } from './policy-service.js';
import { AGENT_GOVERNANCE_PORTS_VERSION, type ActionBroker } from './ports.js';
import { PACKAGE_MANIFESTS } from './sensitive-paths.js';

/** Token shape the policy command scope uses; anything else is shell syntax the gate cannot analyze. */
const PLAIN_COMMAND = /^[A-Za-z0-9._:@/=+-]+(?: [A-Za-z0-9._:@/=+-]+)*$/u;

const EDIT_OPERATIONS = new Set<AgentProxyOperation>(['files_write', 'files_apply_patch', 'files_move', 'files_mkdir', 'files_delete']);
const BROKERED_ONLY = new Set<AgentProxyOperation>(BROKERED_ONLY_PROXY_OPERATIONS);
const ACTIVE_STATES = new Set(['STARTING', 'RUNNING']);

export type CodingUsage = { inputTokens: number; outputTokens: number; costMicros: number };

/** The coding workflow a workspace belongs to, read from the owner-authored rule snapshot and the workflow row. */
export type CodingBinding = {
  workflowId: string;
  principalId: string;
  /** The rule's repository, never the webhook payload's. */
  repository: string;
  projectId: string;
  coding: CodingRuleAction;
  state: string;
  workspaceId: string | null;
  workspaceGeneration: number | null;
  agentId: string | null;
  agentGeneration: number | null;
  startedAt: number;
  /** Time the workflow spent waiting for an owner decision; it does not count against the run's time budget. */
  pausedMs: number;
  pinned: { globalRevisionId: string | null; projectRevisionId: string | null } | null;
  usage: CodingUsage | null;
};

type BindingRow = {
  id: string; owner_id: string; rule_snapshot_json: string; state: string; workspace_id: string | null; project_id: string;
  workspace_generation: number | null; agent_id: string | null; agent_generation: number | null; coding_started_at: number | null;
  created_at: number; policy_revision_json: string | null; usage_json: string | null; paused_ms: number | null;
};

export type CodingWorkspaceFacts = {
  /** The workspace's current generation, or null when it no longer exists or is not active. */
  generation(workspaceId: string): number | null;
  /** Repositories checked out in the workspace. */
  repositoryCount(workspaceId: string): number;
};

export type CodingActionBrokerOptions = {
  database: DatabaseSync;
  /** `AGENT_CODING_ENABLED`, read on every action so turning it off stops running workflows. */
  enabled: () => boolean;
  /**
   * The execution-time gate: the policy service's `decide`, which consults the advisor only for a pending
   * discretionary action. `evaluate` (pure, no advisor) pre-checks the packages of a lockfile install.
   */
  policies: Pick<AgentPolicyService, 'decide' | 'evaluate'>;
  workspaces: CodingWorkspaceFacts;
  traces?: AgentActionTraceSink | undefined;
  now?: () => number;
};

export type AgentToolRequest = {
  ownerId: string;
  workspaceId: string;
  workspaceGeneration: number;
  agentId: string;
  agentGeneration: number;
  requestId: string;
  operation: AgentProxyOperation;
  toolInput: Record<string, unknown>;
  usage: CodingUsage;
  signal: AbortSignal;
};

export type BrokeredStep = {
  binding: CodingBinding;
  origin: CodingActionOrigin;
  step: CodingActionStep;
  idempotencyKey: string;
  descriptor: AgentActionDescriptorInput;
  usage?: CodingUsage | undefined;
  agent?: { agentId: string; generation: number; requestId: string } | undefined;
  /** Aborts an advisor call the gate makes for this step. */
  signal?: AbortSignal | undefined;
  /**
   * For a runner step only: the id of an owner approval covering exactly this input fingerprint, or null.
   * It lifts a REQUIRE_APPROVAL decision to a dispatchable one; it never lifts a DENY.
   */
  approvedFor?: ((inputFingerprint: string) => string | null) | undefined;
};

export type BrokeredAdmission = {
  record: CodingActionRecord;
  /** True when the key already had a record (a replayed step). */
  replayed: boolean;
  /** The decision taken now: on a replay the gate is evaluated again, so a revocation still stops it. */
  decision: GateDecision | null;
  /** Whether the action may be dispatched now. */
  allowed: boolean;
  /** Why a replay was refused outside the gate (its input differs from the recorded one); null otherwise. */
  refusal: string | null;
};

function refusal(code: string, message: string, data?: Record<string, unknown>): RunnerResponse {
  return {
    ok: false,
    message: `${code}: ${message}`.slice(0, 2_000),
    ...(data ? { data } : {}),
    error: { code: 'FORBIDDEN', message: `${code}: ${message}`.slice(0, 2_000), retryable: false },
    truncated: false
  };
}

/** Splits a plain command into argv; null when it contains anything but plain tokens. */
export function plainArgv(command: string): string[] | null {
  const trimmed = command.trim();
  if (!PLAIN_COMMAND.test(trimmed)) return null;
  const argv = trimmed.split(' ');
  return argv.length <= AGENT_POLICY_LIMITS.maxCommandTokens && argv.every((token) => token.length <= 512) ? argv : null;
}

/** An edit that touches a dependency manifest or lockfile is a package install. */
export function editActionClass(paths: readonly string[]): 'edit' | 'package_install' {
  return paths.some((path) => PACKAGE_MANIFESTS.has(path.split('/').at(-1) ?? '')) ? 'package_install' : 'edit';
}

function pathsOf(operation: AgentProxyOperation, input: Record<string, unknown>): string[] {
  if (operation === 'files_move') return [input.source, input.destination].filter((value): value is string => typeof value === 'string');
  return typeof input.path === 'string' ? [input.path] : [];
}

/**
 * The runner-side capability broker for coding workflows. Every brokered action is described, decided
 * by the pure gate against the live policy heads (with the revisions the run was admitted under pinned,
 * so an edited or rolled-back policy stops it), re-checked against revocation, workspace generation and
 * budget right before dispatch, recorded as a receipt, and traced. Nothing it decides comes from the
 * agent or the webhook payload: the principal is the workspace owner, the repository and project come
 * from the owner's rule.
 */
export class CodingActionBroker implements ActionBroker {
  readonly contractVersion = AGENT_GOVERNANCE_PORTS_VERSION;
  readonly actions: CodingActionStore;
  private readonly database: DatabaseSync;
  private readonly enabled: () => boolean;
  private readonly policies: Pick<AgentPolicyService, 'decide' | 'evaluate'>;
  readonly workspaces: CodingWorkspaceFacts;
  private readonly traces: AgentActionTraceSink | undefined;
  private readonly now: () => number;

  constructor(options: CodingActionBrokerOptions) {
    this.database = options.database;
    this.enabled = options.enabled;
    this.policies = options.policies;
    this.workspaces = options.workspaces;
    this.traces = options.traces;
    this.now = options.now ?? Date.now;
    this.actions = new CodingActionStore(options.database, this.now);
  }

  get isEnabled(): boolean {
    return this.enabled();
  }

  /** The ActionBroker port: one decision with no receipt, for callers that hold their own context. */
  authorize(request: { principalId: string; projectId: string | null; runId: string; descriptor: AgentActionDescriptor; context: GateContext }): Promise<GateDecision> {
    return this.executionDecision(request.principalId, request.projectId, request.descriptor, request.context);
  }

  /**
   * The policy decision a run is admitted under; the caller pins its revisions on the workflow. The run
   * budget's concurrency limit is enforced here, against the coding runs already admitted, so a run that
   * is already working is never stopped because another one started after it.
   */
  admit(principalId: string, projectId: string, descriptor: AgentActionDescriptorInput, concurrentRuns: number): Promise<GateDecision> {
    return this.executionDecision(principalId, projectId, AgentActionDescriptorSchema.parse(descriptor), { usage: { concurrentRuns } });
  }

  /** Coding runs of the principal that were admitted and still hold, or are acquiring, a workspace. */
  activeCodingRuns(principalId: string): number {
    const row = this.database.prepare(`SELECT COUNT(*) AS count FROM automation_workflows WHERE owner_id = ? AND project_id IS NOT NULL
      AND state IN ('STARTING', 'RUNNING', 'WAITING_FOR_HUMAN')`).get(principalId) as { count: number };
    return row.count;
  }

  /**
   * Records a step the gate already refused with that decision, so the receipt names the gate's reason.
   * A step recorded earlier but not yet dispatched is moved to REJECTED.
   */
  private reject(step: BrokeredStep, decision: GateDecision): CodingActionRecord {
    const descriptor = AgentActionDescriptorSchema.parse(step.descriptor);
    const recorded = this.actions.record({
      principalId: step.binding.principalId, workflowId: step.binding.workflowId, workspaceId: step.binding.workspaceId,
      agentId: step.binding.agentId, agentGeneration: step.binding.agentGeneration,
      idempotencyKey: step.idempotencyKey, origin: step.origin, step: step.step, descriptor, projectId: step.binding.projectId,
      decision, state: 'REJECTED'
    });
    if (recorded.replayed) this.actions.transition(recorded.record.actionId, ['INTENT'], 'REJECTED', { errorCode: decision.reasonCode });
    const record = this.actions.get(recorded.record.actionId) ?? recorded.record;
    this.trace(step.binding, record, undefined, this.now(), this.now());
    return record;
  }

  /**
   * Records and decides a lockfile install as one action. Every locked package is decided by the pure
   * gate under the run's live context; there is no advisor call, so a package that would need advisor
   * clearance is refused, never cleared in bulk. A refusal is recorded with the refused package's
   * descriptor and decision, so the receipt names it. Otherwise the receipt describes the install
   * itself (`step.descriptor`: the lockfile, with a reason naming the package count and digest) under
   * the gate's ALLOW, whose input fingerprint covers every package's, so a replay of the key over a
   * different package set is refused as IDEMPOTENCY_KEY_REUSED.
   */
  beginLockfileInstall(step: BrokeredStep, packages: readonly AgentActionDescriptorInput[]): BrokeredAdmission {
    const binding = step.binding;
    const replayed = this.actions.byKey(binding.principalId, binding.workflowId, step.idempotencyKey) !== undefined;
    const summary = AgentActionDescriptorSchema.parse(step.descriptor);
    const base = {
      principalId: binding.principalId, workflowId: binding.workflowId, workspaceId: binding.workspaceId,
      agentId: binding.agentId, agentGeneration: binding.agentGeneration,
      idempotencyKey: step.idempotencyKey, origin: step.origin, step: step.step, descriptor: summary, projectId: binding.projectId
    };
    if (!this.enabled()) {
      const recorded = this.actions.record({ ...base, decision: null, refusal: { reasonCode: 'CODING_DISABLED' }, state: 'REJECTED' });
      if (recorded.replayed) this.actions.transition(recorded.record.actionId, ['INTENT'], 'REJECTED', { errorCode: 'CODING_DISABLED' });
      return { record: this.actions.get(recorded.record.actionId) ?? recorded.record, replayed: recorded.replayed, decision: null, allowed: false, refusal: null };
    }
    if (packages.length === 0) throw new Error('a lockfile install covers at least one package');
    const context = this.context(binding, step.usage ?? binding.usage);
    const fingerprints: string[] = [];
    let allowed: GateDecision | undefined;
    for (const input of packages) {
      const decision = this.policies.evaluate(binding.principalId, binding.projectId, AgentActionDescriptorSchema.parse(input), context);
      if (decision.decision !== 'ALLOW') {
        const record = this.reject({ ...step, descriptor: { ...input, ...(summary.reason ? { reason: summary.reason } : {}) } }, decision);
        return { record, replayed, decision, allowed: false, refusal: null };
      }
      fingerprints.push(decision.inputFingerprint);
      allowed = decision;
    }
    // The free-text reason is a description, not part of what is decided.
    const install = { ...summary, reason: undefined };
    const inputFingerprint = createHash('sha256').update(JSON.stringify({ install, packages: fingerprints.sort() })).digest('hex');
    const decision: GateDecision = { ...allowed!, inputFingerprint };
    const recorded = this.actions.record({ ...base, decision, state: 'INTENT' });
    if (recorded.replayed && recorded.record.inputFingerprint !== null && recorded.record.inputFingerprint !== inputFingerprint) {
      return { record: recorded.record, replayed: true, decision, allowed: false, refusal: 'IDEMPOTENCY_KEY_REUSED' };
    }
    return { record: this.actions.get(recorded.record.actionId) ?? recorded.record, replayed: recorded.replayed, decision, allowed: true, refusal: null };
  }

  /**
   * The single execution-time gate call every brokered action goes through: the policy service's
   * `decide` on the evaluated descriptor. It consults the advisor only for a pending discretionary
   * action and takes the policy fallback when the advisor fails, so nothing here can lower a decision.
   * The stored decision carries the advisor's Decision Plane id, which the receipt reports.
   */
  private executionDecision(principalId: string, projectId: string | null, descriptor: AgentActionDescriptor, context: GateContext | undefined, signal?: AbortSignal): Promise<GateDecision> {
    return this.policies.decide(principalId, projectId, descriptor, context, signal ? { signal } : {});
  }

  /** The automation workflow that holds this workspace, coding or not; used to label agent traces. */
  workflowFor(principalId: string, workspaceId: string): string | null {
    const row = this.database.prepare(`SELECT id FROM automation_workflows WHERE owner_id = ? AND workspace_id = ?
      ORDER BY created_at DESC, id LIMIT 1`).get(principalId, workspaceId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** The coding workflow bound to a workspace, if any. */
  bindingForWorkspace(principalId: string, workspaceId: string): CodingBinding | undefined {
    const row = this.database.prepare(`SELECT * FROM automation_workflows WHERE owner_id = ? AND workspace_id = ? AND project_id IS NOT NULL
      ORDER BY created_at DESC, id LIMIT 1`).get(principalId, workspaceId) as BindingRow | undefined;
    return row ? this.bindingOf(row) : undefined;
  }

  binding(principalId: string, workflowId: string): CodingBinding | undefined {
    const row = this.database.prepare('SELECT * FROM automation_workflows WHERE owner_id = ? AND id = ? AND project_id IS NOT NULL')
      .get(principalId, workflowId) as BindingRow | undefined;
    return row ? this.bindingOf(row) : undefined;
  }

  /**
   * Whether an agent spawn may be granted the brokered-only operations: only a running coding workflow's
   * own workspace, and only while coding is enabled.
   */
  permitsBrokeredSpawn(principalId: string, workspaceId: string): boolean {
    if (!this.enabled()) return false;
    const binding = this.bindingForWorkspace(principalId, workspaceId);
    return binding !== undefined && ACTIVE_STATES.has(binding.state);
  }

  /**
   * Records a brokered step and decides whether it may run now. A first call evaluates the gate and
   * stores INTENT (allowed) or REJECTED (refused). A replay returns the stored record and evaluates the
   * gate again, so a step that has not finished cannot outlive a revocation or a policy change; an
   * undispatched replay that is now refused is moved to REJECTED.
   */
  async begin(step: BrokeredStep): Promise<BrokeredAdmission> {
    const descriptor = AgentActionDescriptorSchema.parse(step.descriptor);
    const base = {
      principalId: step.binding.principalId, workflowId: step.binding.workflowId, workspaceId: step.binding.workspaceId,
      agentId: step.agent?.agentId ?? step.binding.agentId, agentGeneration: step.agent?.generation ?? step.binding.agentGeneration,
      idempotencyKey: step.idempotencyKey, origin: step.origin, step: step.step, descriptor, projectId: step.binding.projectId
    };
    if (!this.enabled()) {
      const recorded = this.actions.record({ ...base, decision: null, refusal: { reasonCode: 'CODING_DISABLED' }, state: 'REJECTED' });
      if (recorded.replayed) this.actions.transition(recorded.record.actionId, ['INTENT'], 'REJECTED', { errorCode: 'CODING_DISABLED' });
      return { record: this.actions.get(recorded.record.actionId) ?? recorded.record, replayed: recorded.replayed, decision: null, allowed: false, refusal: null };
    }
    const decision = await this.decide(step.binding, descriptor, step.usage ?? step.binding.usage, step.signal);
    // An owner approval lifts only REQUIRE_APPROVAL, only for a runner step, and only for the exact input
    // it was granted for; the receipt keeps the gate's decision and names the approval.
    const approvalId = decision.decision === 'REQUIRE_APPROVAL' && step.origin === 'runner' && step.approvedFor
      ? step.approvedFor(decision.inputFingerprint) : null;
    const allowed = decision.decision === 'ALLOW' || approvalId !== null;
    const recorded = this.actions.record({
      ...base, decision, state: allowed ? 'INTENT' : 'REJECTED', ...(approvalId !== null ? { outcome: { approvalId } } : {})
    });
    const stored = recorded.record.inputFingerprint;
    if (recorded.replayed && stored !== null && stored !== decision.inputFingerprint) {
      // The key was recorded for different input: never let one receipt stand for two actions.
      return { record: recorded.record, replayed: true, decision, allowed: false, refusal: 'IDEMPOTENCY_KEY_REUSED' };
    }
    if (recorded.replayed && !allowed) {
      this.actions.transition(recorded.record.actionId, ['INTENT'], 'REJECTED', { errorCode: decision.reasonCode });
    }
    return { record: this.actions.get(recorded.record.actionId) ?? recorded.record, replayed: recorded.replayed, decision, allowed, refusal: null };
  }

  /**
   * Records a refusal decided outside the gate (unsupported input, ambiguous repository, an unverifiable
   * checkout). A step already recorded but not yet dispatched is moved to REJECTED with the reason.
   */
  refuse(step: BrokeredStep, reasonCode: CodingErrorCode): CodingActionRecord {
    const descriptor = AgentActionDescriptorSchema.parse(step.descriptor);
    const recorded = this.actions.record({
      principalId: step.binding.principalId, workflowId: step.binding.workflowId, workspaceId: step.binding.workspaceId,
      agentId: step.agent?.agentId ?? step.binding.agentId, agentGeneration: step.agent?.generation ?? step.binding.agentGeneration,
      idempotencyKey: step.idempotencyKey, origin: step.origin, step: step.step, descriptor, projectId: step.binding.projectId,
      decision: null, refusal: { reasonCode }, state: 'REJECTED'
    });
    if (recorded.replayed) this.actions.transition(recorded.record.actionId, ['INTENT'], 'REJECTED', { errorCode: reasonCode });
    const record = this.actions.get(recorded.record.actionId) ?? recorded.record;
    this.trace(step.binding, record, step.agent?.requestId, this.now(), this.now());
    return record;
  }

  dispatched(record: CodingActionRecord): boolean {
    return this.actions.transition(record.actionId, ['INTENT', 'DISPATCHED', 'UNKNOWN'], 'DISPATCHED');
  }

  /** Settles an action and writes its trace span. */
  settle(binding: CodingBinding, record: CodingActionRecord, state: CodingActionState, outcome: CodingActionOutcome, startedAt: number, requestId?: string): void {
    // REJECTED and the other settled states are terminal: a late writer cannot reopen them.
    this.actions.transition(record.actionId, ['INTENT', 'DISPATCHED', 'UNKNOWN'], state, outcome);
    const settled = this.actions.get(record.actionId) ?? record;
    this.trace(binding, settled, requestId, startedAt, this.now());
  }

  /** Writes the span of a refused action; refusals are settled when they are recorded. */
  traceRefusal(binding: CodingBinding, record: CodingActionRecord, requestId?: string): void {
    this.trace(binding, record, requestId, this.now(), this.now());
  }

  /**
   * Wraps the agent proxy executor. Reads pass through unchanged. Edits, commands and Git reads of a
   * coding workspace are brokered; the brokered-only operations are refused for any other workspace, so
   * an interactive agent can never run a command through the proxy.
   */
  async executeAgentTool(request: AgentToolRequest, inner: (request: AgentToolRequest) => Promise<RunnerResponse>): Promise<RunnerResponse> {
    const brokeredOnly = BROKERED_ONLY.has(request.operation);
    const binding = this.bindingForWorkspace(request.ownerId, request.workspaceId);
    if (!binding) {
      if (brokeredOnly) return refusal('ACTION_DENIED', `${request.operation} is available only to a coding workflow agent`);
      return await inner(request);
    }
    if (!EDIT_OPERATIONS.has(request.operation) && !brokeredOnly) return await inner(request);
    if (!(CODING_PROXY_OPERATIONS as readonly string[]).includes(request.operation)) {
      return refusal('ACTION_DENIED', `${request.operation} is not part of the coding tool set`);
    }
    const agent = { agentId: request.agentId, generation: request.agentGeneration, requestId: request.requestId };
    const key = `agent:${request.agentId}:${request.agentGeneration}:${request.requestId}`;
    const base = { binding, origin: 'agent' as const, idempotencyKey: key, usage: request.usage, agent };
    let toolInput = request.toolInput;
    let descriptor: AgentActionDescriptorInput;
    let step: CodingActionStep;
    if (request.operation === 'exec_run') {
      step = 'exec_run';
      const command = typeof toolInput.command === 'string' ? toolInput.command : '';
      const argv = plainArgv(command);
      const cwd = typeof toolInput.cwd === 'string' ? toolInput.cwd : '.';
      descriptor = { version: 1, actionClass: 'test', repository: binding.repository, ...(cwd !== '.' ? { paths: [cwd] } : {}), ...(argv ? { command: argv } : {}) };
      if (!argv) {
        const record = this.refuse({ ...base, step, descriptor: { version: 1, actionClass: 'test', repository: binding.repository } }, 'COMMAND_UNSUPPORTED');
        return refusal('COMMAND_UNSUPPORTED', 'commands must be plain space-separated tokens without shell syntax', { actionId: record.actionId });
      }
      // The broker owns these fields: an agent command never runs privileged, detached or with a grant.
      const { approvalGrantToken: _grant, ...rest } = toolInput;
      void _grant;
      toolInput = { ...rest, privileged: false, async: false };
    } else if (request.operation === 'git_status' || request.operation === 'git_diff') {
      step = request.operation;
      descriptor = { version: 1, actionClass: 'read', repository: binding.repository };
    } else {
      step = request.operation as CodingActionStep;
      const paths = pathsOf(request.operation, toolInput);
      descriptor = { version: 1, actionClass: editActionClass(paths), repository: binding.repository, paths };
    }
    if (!AgentActionDescriptorSchema.safeParse(descriptor).success) {
      return { ok: false, message: 'invalid tool input', error: { code: 'INVALID_INPUT', message: 'the tool input does not name valid paths', retryable: false }, truncated: false };
    }
    if (this.workspaces.repositoryCount(request.workspaceId) > 1) {
      const record = this.refuse({ ...base, step, descriptor }, 'REPOSITORY_AMBIGUOUS');
      return refusal('REPOSITORY_AMBIGUOUS', 'the coding workspace holds more than one repository', { actionId: record.actionId });
    }
    const startedAt = this.now();
    const admission = await this.begin({ ...base, step, descriptor, signal: request.signal });
    if (admission.refusal !== null) {
      return refusal('ACTION_DENIED', admission.refusal, { actionId: admission.record.actionId });
    }
    if (!admission.allowed) {
      this.traceRefusal(binding, admission.record, request.requestId);
      const code = admission.decision === null ? 'CODING_DISABLED'
        : admission.decision.decision === 'REQUIRE_APPROVAL' ? 'ACTION_REQUIRES_APPROVAL' : 'ACTION_DENIED';
      return refusal(code, admission.decision?.reasonCode ?? 'coding is disabled on this instance', {
        actionId: admission.record.actionId, decision: admission.decision?.decision ?? 'DENY', reasonCode: admission.record.reasonCode
      });
    }
    if (admission.replayed && admission.record.state !== 'INTENT') {
      return refusal('ACTION_DENIED', 'this tool request was already brokered', { actionId: admission.record.actionId });
    }
    if (!this.dispatched(admission.record)) {
      // Another writer settled this action first; dispatching it again could act twice.
      return refusal('ACTION_DENIED', 'this tool request was already brokered', { actionId: admission.record.actionId });
    }
    try {
      const result = await inner({ ...request, toolInput });
      const exitCode = (result.data as { exitCode?: unknown } | undefined)?.exitCode;
      this.settle(binding, admission.record, result.ok ? 'APPLIED' : 'REJECTED', {
        ...(typeof exitCode === 'number' ? { exitCode } : {}),
        ...(result.ok ? {} : { errorCode: result.error?.code ?? 'TOOL_ERROR' })
      }, startedAt, request.requestId);
      return result;
    } catch (error) {
      // The executor did not answer; the working tree is re-read by the publish steps, which never trust this outcome.
      this.settle(binding, admission.record, 'UNKNOWN', { errorCode: (error as { code?: unknown })?.code === undefined ? 'UNKNOWN' : String((error as { code: unknown }).code).slice(0, 100) }, startedAt, request.requestId);
      throw error;
    }
  }

  private decide(binding: CodingBinding, descriptor: AgentActionDescriptor, usage: CodingUsage | null, signal: AbortSignal | undefined): Promise<GateDecision> {
    return this.executionDecision(binding.principalId, binding.projectId, descriptor, this.context(binding, usage), signal);
  }

  /** Runtime facts the gate re-checks: usage, pinned revisions, workspace generation and revocation. */
  private context(binding: CodingBinding, usage: CodingUsage | null): GateContext {
    // Only runs admitted before this one count, so the run admitted first keeps its slot at every action.
    const others = this.database.prepare(`SELECT COUNT(*) AS count FROM automation_workflows WHERE owner_id = ? AND id != ?
      AND project_id IS NOT NULL AND state IN ('STARTING', 'RUNNING', 'WAITING_FOR_HUMAN')
      AND (COALESCE(coding_started_at, created_at) < ? OR (COALESCE(coding_started_at, created_at) = ? AND id < ?))`)
      .get(binding.principalId, binding.workflowId, binding.startedAt, binding.startedAt, binding.workflowId) as { count: number };
    const current = binding.workspaceId === null ? null : this.workspaces.generation(binding.workspaceId);
    const revoked = !ACTIVE_STATES.has(binding.state) || (binding.workspaceId !== null && current === null);
    return {
      usage: {
        ...(usage ? { costMicros: usage.costMicros, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
        elapsedSeconds: Math.max(0, Math.floor((this.now() - binding.startedAt - binding.pausedMs) / 1_000)),
        concurrentRuns: others.count
      },
      ...(binding.pinned ? { pinned: binding.pinned } : {}),
      ...(binding.workspaceGeneration !== null && current !== null
        ? { workspaceGeneration: { pinned: binding.workspaceGeneration, current } }
        : {}),
      revoked
    };
  }

  private trace(binding: CodingBinding, record: CodingActionRecord, requestId: string | undefined, startedAt: number, endedAt: number): void {
    const agentId = record.agentId ?? binding.agentId;
    const generation = record.agentGeneration ?? binding.agentGeneration;
    if (!this.traces || agentId === null || generation === null) return;
    const consult = this.actions.advisorConsult(record.actionId);
    const placed = this.traces.action({ agentId, generation }, {
      actionId: record.actionId, step: record.step, actionClass: record.descriptor.actionClass, decision: record.decision,
      reasonCode: record.reasonCode, state: record.state, requestId,
      ...(record.outcome.branch ? { branch: record.outcome.branch } : record.descriptor.branch ? { branch: record.descriptor.branch } : {}),
      ...(record.outcome.commitSha ? { commitSha: record.outcome.commitSha } : {}),
      ...(record.outcome.prNumber ? { prNumber: record.outcome.prNumber } : {}),
      inputDigest: traceInputDigest(record.descriptor),
      ...(consult ? {
        advisor: { decisionId: consult.decisionId, effect: consult.effect, risk: consult.risk, confidence: consult.confidence, fallbackReason: consult.fallbackReason }
      } : {}),
      startedAt, endedAt
    });
    if (placed) this.actions.attachTrace(record.actionId, placed.traceId, placed.spanId);
  }

  private bindingOf(row: BindingRow): CodingBinding | undefined {
    const snapshot = JSON.parse(row.rule_snapshot_json) as { match?: { repository?: unknown }; action?: { coding?: unknown } };
    const coding = CodingRuleActionSchema.safeParse(snapshot.action?.coding);
    const repository = snapshot.match?.repository;
    if (!coding.success || typeof repository !== 'string') return undefined;
    let pinned: CodingBinding['pinned'] = null;
    if (row.policy_revision_json) {
      const parsed = JSON.parse(row.policy_revision_json) as { globalRevisionId?: string | null; projectRevisionId?: string | null };
      pinned = { globalRevisionId: parsed.globalRevisionId ?? null, projectRevisionId: parsed.projectRevisionId ?? null };
    }
    let usage: CodingUsage | null = null;
    if (row.usage_json) {
      const parsed = JSON.parse(row.usage_json) as Partial<CodingUsage>;
      if (typeof parsed.inputTokens === 'number' && typeof parsed.outputTokens === 'number' && typeof parsed.costMicros === 'number') {
        usage = { inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens, costMicros: parsed.costMicros };
      }
    }
    return {
      workflowId: row.id, principalId: row.owner_id, repository, projectId: row.project_id, coding: coding.data, state: row.state,
      workspaceId: row.workspace_id, workspaceGeneration: row.workspace_generation, agentId: row.agent_id, agentGeneration: row.agent_generation,
      startedAt: row.coding_started_at ?? row.created_at, pausedMs: row.paused_ms ?? 0, pinned, usage
    };
  }
}
