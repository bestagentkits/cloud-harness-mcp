import { createHash } from 'node:crypto';
import {
  AGENT_POLICY_LIMITS,
  CODING_LIMITS,
  type AgentActionDescriptorInput,
  type CodingActionOutcome,
  type CodingActionStep,
  type CodingErrorCode,
  type CodingPhase,
  type GateDecision
} from '@cloud-harness/contracts';
import {
  editActionClass,
  plainArgv,
  type BrokeredAdmission,
  type BrokeredStep,
  type CodingActionBroker,
  type CodingBinding
} from './agent-governance/action-broker.js';
import type { CodingActionRecord } from './agent-governance/action-store.js';
import type { CodingGitPort } from './agent-governance/coding-git.js';
import { ExecutionBackendError, WorkspaceExecutionBackend } from './agent-governance/workspace-execution-backend.js';
import { admitNpmLockfile, INSTALL_TIMEOUT_MS, MAX_LOCKFILE_BYTES, NPM_LOCKFILE, type InstallResult } from './agent-governance/install-executor.js';
import type { AutomationOperationResult } from './automation-service.js';
import type { RunnerOperation } from '@cloud-harness/contracts';

/** Upper bound for the verify command; the executor caps it again. */
const VERIFY_TIMEOUT_MS = 300_000;
/** Delay before a step that hit a transient failure runs again. The gate's run-time budget bounds the retries. */
const STEP_RETRY_MS = 5_000;
/** Delay before a run held back by the concurrency limit asks to be admitted again. */
const ADMIT_RETRY_MS = 15_000;
/** Bound on one gate decision, including an advisor call it makes. */
const GATE_TIMEOUT_MS = 60_000;
/** Bound on one Git inspection of the checkout. */
const INSPECT_TIMEOUT_MS = 90_000;
/**
 * The most changed paths the runner gates for one commit. Every path is decided, in chunks of the
 * gate's per-action limit, so a larger change is refused as unverifiable rather than partly checked.
 */
const MAX_GATED_PATHS = 2_000;
const MAX_PATH_CHARS = 1_024;
const DIFF_FILE = '.cloud-harness-coding.diff';
const RETRYABLE_CODES = new Set(['UNAVAILABLE', 'TIMEOUT', 'GITHUB_RATE_LIMITED', 'INTERNAL', 'UNKNOWN_REMOTE_STATE']);
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

/** The workflow columns the coding engine reads. */
export type CodingWorkflowRow = {
  id: string;
  owner_id: string;
  resource_number: number;
  rule_snapshot_json: string;
  workspace_id: string | null;
  project_id: string | null;
  coding_phase: string | null;
  base_oid: string | null;
  branch: string | null;
  commit_sha: string | null;
};

/** What the automation engine lends the coding engine: owner-scoped operations and guarded workflow updates. */
export type CodingEngineHost = {
  call(ownerId: string, operation: RunnerOperation, input: Record<string, unknown>): Promise<AutomationOperationResult>;
  /** Updates coding columns of a workflow that is still running; returns false when it already left RUNNING. */
  update(workflowId: string, fields: Record<string, string | number | null>): boolean;
  /** Ends a running workflow as FAILED with the code. */
  fail(workflowId: string, code: string, fields?: Record<string, string | number | null>): void;
  /** Ends a running workflow as COMPLETED. */
  complete(workflowId: string, fields: Record<string, string | number | null>): void;
  now(): number;
  install?: CodingInstallPort | undefined;
  /** Read-only Git inspection of the checkout. Without it nothing is committed (COMMIT_UNVERIFIED). */
  git?: CodingGitPort | undefined;
};

/** The lockfile install executor as the engine sees it. */
export type CodingInstallPort = {
  /** AGENT_CODING_PACKAGE_INSTALL_ENABLED, read on every start. */
  enabled(): boolean;
  /** The registry `npm ci` uses; every locked package must resolve below it. */
  registry: string;
  run(ownerId: string, workspaceId: string, signal: AbortSignal): Promise<InstallResult>;
};

/** How admission of a coding run ended. `waiting`: the concurrency limit holds it back for now. */
export type CodingAdmission = { state: 'admitted' } | { state: 'waiting'; retryAt: number } | { state: 'refused'; code: string } | { state: 'gone' };

type StepResult = { ok: true } | { ok: false; code: string; retry: boolean };
type OwnCommit = { ok: true; sha: string; paths: string[] } | { ok: false; code: string; retryable: boolean };

const retryable = (result: AutomationOperationResult) => result.error?.retryable === true || RETRYABLE_CODES.has(result.error?.code ?? '');
const bounded = (value: string, max = 100) => (value.length <= max ? value : value.slice(0, max));
const gateSignal = () => AbortSignal.timeout(GATE_TIMEOUT_MS);
const inspectSignal = () => AbortSignal.timeout(INSPECT_TIMEOUT_MS);

/** The workflow error code for a refused step. */
export function refusalCode(admission: { decision: GateDecision | null; refusal?: string | null }): string {
  if (admission.refusal) return bounded(`ACTION_DENIED:${admission.refusal}`);
  const decision = admission.decision;
  if (decision === null) return 'CODING_DISABLED';
  return bounded(`${decision.decision === 'REQUIRE_APPROVAL' ? 'ACTION_REQUIRES_APPROVAL' : 'ACTION_DENIED'}:${decision.reasonCode}`);
}

/**
 * The branch a workflow publishes, derived only from the issue number and the workflow id, so nothing
 * in the issue text can steer it outside the `agent/` prefix.
 */
export function codingBranch(resourceNumber: number, workflowId: string): string {
  return `${CODING_LIMITS.branchPrefix}${resourceNumber}-${workflowId.slice(4, 12)}`;
}

/** The trailer that marks a commit as this workflow's own. */
export function workflowTrailer(workflowId: string): string {
  return `Cloud-Harness-Workflow: ${workflowId}`;
}

/** sha256 of the sorted `ecosystem:name@version registry` lines of the packages an install covers. */
export function packagesDigest(packages: readonly { name: string; version: string; registryHost: string }[]): string {
  const lines = [...new Set(packages.map((entry) => `npm:${entry.name}@${entry.version} ${entry.registryHost}`))].sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function outputOf(result: AutomationOperationResult): string {
  const output = (result.data as { output?: unknown } | undefined)?.output;
  return typeof output === 'string' ? output : '';
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Whether every path can be described to the gate exactly; anything else is refused, never truncated. */
function verifiablePaths(paths: readonly string[]): boolean {
  return paths.length <= MAX_GATED_PATHS && paths.every((path) => path.length > 0 && path.length <= MAX_PATH_CHARS && !path.includes('\0'));
}

/**
 * The runner-owned half of a coding workflow, after the agent has finished editing: verify, commit,
 * push and open the pull request. One step runs per engine tick; every step is described, decided by
 * the gate, recorded as a receipt and traced before it runs, and keyed so a replay after a restart or
 * a lost response finds its first effect instead of acting twice. An effect that cannot be proven
 * either way stops the workflow as BLOCKED with EFFECT_UNKNOWN. The engine never merges or deploys.
 *
 * The agent and its verify command run arbitrary code in the checkout, including Git. The runner
 * therefore reads the checkout itself: HEAD must still be the base before anything is staged, every
 * changed path is gated before the commit, and the commit it pushes must be its own (one parent, the
 * base, and this workflow's trailer) with every path it changes gated again. The push names that
 * commit by its id, never by HEAD.
 */
export class CodingWorkflowEngine {
  private readonly backend: WorkspaceExecutionBackend;

  constructor(readonly broker: CodingActionBroker, private readonly host: CodingEngineHost) {
    this.backend = new WorkspaceExecutionBackend((ownerId, operation, input) => host.call(ownerId, operation, input));
  }

  get enabled(): boolean {
    return this.broker.isEnabled;
  }

  /**
   * Admits a coding workflow: the rule's repository must be readable under the owner's policy for the
   * rule's project, and the owner's coding runs must be below the policy's concurrency limit. The
   * revisions it was admitted under are pinned, so a later policy change stops it. A run held back by
   * the concurrency limit waits; it is admitted when an earlier run finishes, or expires with the queue.
   */
  async admit(row: { id: string; owner_id: string }, projectId: string, repository: string): Promise<CodingAdmission> {
    const active = this.broker.activeCodingRuns(row.owner_id);
    const decision = await this.broker.admit(row.owner_id, projectId, { version: 1, actionClass: 'read', repository }, active);
    // Another run was admitted while the gate decided: decide again against the new count. The check and
    // the update below run without yielding, so two runs can never both take the last slot.
    if (this.broker.activeCodingRuns(row.owner_id) !== active) return { state: 'waiting', retryAt: this.host.now() };
    if (decision.decision !== 'ALLOW') {
      // At admission the only usage the gate sees is the concurrency count.
      if (decision.reasonCode === 'BUDGET_EXHAUSTED') return { state: 'waiting', retryAt: this.host.now() + ADMIT_RETRY_MS };
      return { state: 'refused', code: refusalCode({ decision }) };
    }
    const admitted = this.host.update(row.id, {
      project_id: projectId,
      coding_phase: 'AGENT' satisfies CodingPhase,
      coding_started_at: this.host.now(),
      policy_revision_json: JSON.stringify({ globalRevisionId: decision.policy.globalRevisionId, projectRevisionId: decision.policy.projectRevisionId })
    });
    return admitted ? { state: 'admitted' } : { state: 'gone' };
  }

  /**
   * Binds the opened workspace: one repository only (the repository is resolved from the rule, so a
   * workspace with several checkouts is ambiguous), its generation pinned, and the base commit recorded.
   */
  async bindWorkspace(row: CodingWorkflowRow, workspaceId: string): Promise<StepResult> {
    if (this.broker.workspaces.repositoryCount(workspaceId) > 1) return { ok: false, code: 'REPOSITORY_AMBIGUOUS', retry: false };
    const generation = this.broker.workspaces.generation(workspaceId);
    if (generation === null) return { ok: false, code: 'WORKSPACE_LOST', retry: false };
    const log = await this.host.call(row.owner_id, 'git_log', { workspaceId, limit: 1 });
    const base = outputOf(log).split('\t')[0]?.trim() ?? '';
    if (!log.ok || !SHA.test(base)) {
      return { ok: false, code: bounded(`WORKSPACE_OPEN_FAILED:${log.error?.code ?? 'NO_BASE_COMMIT'}`), retry: !log.ok && retryable(log) };
    }
    this.host.update(row.id, { workspace_generation: generation, base_oid: base });
    return { ok: true };
  }

  /**
   * Installs the checkout's npm lockfile before the agent starts, when the install flag is on and a
   * lockfile exists. The lockfile must pass supply-chain admission and the gate must allow every locked
   * package as a `package_install`; one refusal stops the workflow before anything is fetched. The
   * install is one action whose receipt names the package count and the digest of the package list, and
   * whose key is that digest, so a replay after a restart finds the finished install instead of running
   * again, and a changed lockfile is a different action.
   */
  async installDependencies(row: CodingWorkflowRow, workspaceId: string): Promise<StepResult> {
    const install = this.host.install;
    if (!install?.enabled()) return { ok: true };
    const binding = this.broker.binding(row.owner_id, row.id);
    if (!binding) return { ok: false, code: 'CODING_RULE_INVALID', retry: false };
    const present = await this.lockfilePresent(row.owner_id, workspaceId);
    if (present === null) return { ok: false, code: 'CODING_INSTALL_FAILED:FILES_LIST_FAILED', retry: true };
    if (!present) return { ok: true };
    const read = await this.host.call(row.owner_id, 'files_read', { workspaceId, path: NPM_LOCKFILE, readAll: true });
    const content = (read.data as { content?: unknown; totalBytes?: unknown } | undefined)?.content;
    const totalBytes = (read.data as { totalBytes?: unknown } | undefined)?.totalBytes;
    if (!read.ok) return { ok: false, code: bounded(`CODING_INSTALL_FAILED:${read.error?.code ?? 'FILES_READ_FAILED'}`), retry: retryable(read) };
    if (typeof content !== 'string' || typeof totalBytes !== 'number' || totalBytes > MAX_LOCKFILE_BYTES) return { ok: false, code: 'LOCKFILE_REJECTED', retry: false };
    const lockfile = admitNpmLockfile(content, [install.registry]);
    if (!lockfile.ok) return { ok: false, code: 'LOCKFILE_REJECTED', retry: false };
    if (lockfile.packages.length === 0) return { ok: true };
    const digest = packagesDigest(lockfile.packages);
    const packageCount = lockfile.packages.length;
    const descriptors = new Map<string, AgentActionDescriptorInput>();
    for (const locked of lockfile.packages) {
      descriptors.set(`${locked.name} ${locked.registryHost}`, {
        version: 1, actionClass: 'package_install', repository: binding.repository,
        package: { ecosystem: 'npm', name: locked.name, registry: locked.registryHost }
      });
    }
    const step = (descriptor: AgentActionDescriptorInput): BrokeredStep => ({
      binding, origin: 'runner', step: 'install', idempotencyKey: `automation:${row.id}:install:${digest.slice(0, 16)}`,
      descriptor: { ...descriptor, reason: `npm ci of ${packageCount} locked packages from ${NPM_LOCKFILE} (sha256 ${digest})` },
      signal: gateSignal()
    });
    // Every package is decided by the pure gate first. A refusal is recorded on the install receipt with
    // the package it names; a package the advisor would have to clear is not cleared in bulk.
    const refused = this.broker.precheck(binding, [...descriptors.values()]);
    if (refused) {
      this.broker.reject(step(refused.descriptor), refused.decision);
      return { ok: false, code: refusalCode({ decision: refused.decision }), retry: false };
    }
    const admission = await this.broker.begin(step(descriptors.values().next().value as AgentActionDescriptorInput));
    if (!admission.allowed) {
      this.broker.traceRefusal(binding, admission.record);
      return { ok: false, code: refusalCode(admission), retry: false };
    }
    const { record } = admission;
    if (record.state === 'APPLIED') return { ok: true };
    if (record.state === 'REJECTED' || record.state === 'BLOCKED') return { ok: false, code: 'CODING_INSTALL_FAILED', retry: false };
    const startedAt = this.host.now();
    if (!this.broker.dispatched(record)) return { ok: false, code: 'CODING_INSTALL_FAILED', retry: true };
    let result: InstallResult;
    try {
      result = await install.run(row.owner_id, workspaceId, AbortSignal.timeout(INSTALL_TIMEOUT_MS + 60_000));
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'CODING_INSTALL_FAILED';
      this.broker.settle(binding, record, 'REJECTED', { errorCode: bounded(code), packageCount, packagesDigest: digest }, startedAt);
      return { ok: false, code: bounded(code), retry: false };
    }
    this.broker.settle(binding, record, result.ok ? 'APPLIED' : 'REJECTED',
      result.ok ? { exitCode: 0, packageCount, packagesDigest: digest } : { exitCode: result.exitCode, errorCode: result.code, packageCount, packagesDigest: digest }, startedAt);
    return result.ok ? { ok: true } : { ok: false, code: result.code, retry: false };
  }

  /** Whether the checkout root holds an npm lockfile; null when the listing could not be read. */
  private async lockfilePresent(ownerId: string, workspaceId: string): Promise<boolean | null> {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const listed = await this.host.call(ownerId, 'files_list', { workspaceId, path: '.', limit: 500, ...(cursor ? { cursor } : {}) });
      if (!listed.ok) return null;
      const entries = (listed.data as { entries?: unknown } | undefined)?.entries;
      if (!Array.isArray(entries)) return null;
      if ((entries as { name?: unknown; type?: unknown }[]).some((entry) => entry?.name === NPM_LOCKFILE && entry.type === 'file')) return true;
      cursor = listed.cursor;
      if (!cursor) return false;
    }
    return null;
  }

  /** Runs the current runner-owned phase once. */
  async advance(row: CodingWorkflowRow): Promise<void> {
    const binding = this.broker.binding(row.owner_id, row.id);
    if (!binding) {
      this.host.fail(row.id, 'CODING_RULE_INVALID');
      return;
    }
    switch (row.coding_phase) {
      case 'VERIFY': return await this.verify(row, binding);
      case 'COMMIT': return await this.commit(row, binding);
      case 'PUSH': return await this.push(row, binding);
      case 'PR': return await this.openPullRequest(row, binding);
      default: return;
    }
  }

  // ---------------------------------------------------------------- steps

  private async verify(row: CodingWorkflowRow, binding: CodingBinding): Promise<void> {
    const workspaceId = binding.workspaceId;
    const argv = plainArgv(binding.coding.verifyCommand);
    if (!workspaceId || !argv) {
      this.host.fail(row.id, workspaceId ? 'COMMAND_UNSUPPORTED' : 'WORKSPACE_LOST');
      return;
    }
    const admission = await this.gate(row, binding, 'verify', `automation:${row.id}:verify`, { version: 1, actionClass: 'test', repository: binding.repository, command: argv });
    if (!admission) return;
    const { record } = admission;
    if (record.state === 'APPLIED') return this.phase(row, 'COMMIT');
    if (record.state === 'REJECTED' || record.state === 'BLOCKED') return await this.verifyFailed(row, binding, workspaceId);
    const startedAt = this.host.now();
    if (!this.broker.dispatched(record)) return;
    let ran: { exitCode: number | null; timedOut: boolean };
    try {
      ran = await this.backend.run({ principalId: row.owner_id, workspaceId, argv, timeoutMs: VERIFY_TIMEOUT_MS, signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS + 60_000) });
    } catch (error) {
      const failure = error instanceof ExecutionBackendError ? error : new ExecutionBackendError('UNKNOWN', true);
      if (failure.retryable || RETRYABLE_CODES.has(failure.code)) {
        // Verification has no side effect outside the checkout, so running it again is safe.
        this.broker.settle(binding, record, 'UNKNOWN', { errorCode: bounded(failure.code) }, startedAt);
        this.retryLater(row);
        return;
      }
      this.broker.settle(binding, record, 'REJECTED', { errorCode: bounded(failure.code) }, startedAt);
      this.host.fail(row.id, 'CODING_VERIFY_FAILED');
      return;
    }
    if (ran.exitCode === 0) {
      this.broker.settle(binding, record, 'APPLIED', { exitCode: 0 }, startedAt);
      return this.phase(row, 'COMMIT');
    }
    this.broker.settle(binding, record, 'REJECTED', { exitCode: ran.exitCode, errorCode: ran.timedOut ? 'TIMEOUT' : 'CODING_VERIFY_FAILED' }, startedAt);
    await this.verifyFailed(row, binding, workspaceId);
  }

  /** Nothing is committed when verification fails; the diff is kept as an artifact for the owner instead. */
  private async verifyFailed(row: CodingWorkflowRow, binding: CodingBinding, workspaceId: string): Promise<void> {
    const admission = await this.broker.begin({
      binding, origin: 'runner', step: 'diff_artifact', idempotencyKey: `automation:${row.id}:diff`,
      descriptor: { version: 1, actionClass: 'read', repository: binding.repository }, signal: gateSignal()
    });
    if (!admission.allowed) {
      this.broker.traceRefusal(binding, admission.record);
    } else if ((admission.record.state === 'INTENT' || admission.record.state === 'DISPATCHED') && this.broker.dispatched(admission.record)) {
      const startedAt = this.host.now();
      const outcome = await this.snapshotDiff(row.owner_id, row.id, workspaceId);
      this.broker.settle(binding, admission.record, outcome.artifactId ? 'APPLIED' : 'REJECTED', outcome, startedAt);
    }
    this.host.fail(row.id, 'CODING_VERIFY_FAILED');
  }

  private async snapshotDiff(ownerId: string, workflowId: string, workspaceId: string): Promise<CodingActionOutcome> {
    const staged = await this.host.call(ownerId, 'git_add', { workspaceId, all: true });
    if (!staged.ok) return { errorCode: bounded(staged.error?.code ?? 'GIT_ADD_FAILED') };
    const diff = await this.host.call(ownerId, 'git_diff', { workspaceId, staged: true, readAll: true });
    const text = outputOf(diff);
    if (!diff.ok || !text) return { errorCode: diff.ok ? 'CODING_NO_CHANGES' : bounded(diff.error?.code ?? 'GIT_DIFF_FAILED') };
    const written = await this.host.call(ownerId, 'files_write', { workspaceId, path: DIFF_FILE, content: text });
    if (!written.ok) return { errorCode: bounded(written.error?.code ?? 'FILES_WRITE_FAILED') };
    const snapshot = await this.host.call(ownerId, 'artifacts_snapshot', { workspaceId, path: DIFF_FILE, logicalName: `coding-${workflowId}.diff` });
    const artifactId = (snapshot.data as { artifactId?: unknown } | undefined)?.artifactId;
    return snapshot.ok && typeof artifactId === 'string' ? { artifactId: artifactId.slice(0, 200) } : { errorCode: bounded(snapshot.error?.code ?? 'ARTIFACT_FAILED') };
  }

  private async commit(row: CodingWorkflowRow, binding: CodingBinding): Promise<void> {
    const workspaceId = binding.workspaceId;
    const base = row.base_oid;
    if (!workspaceId || !base) {
      this.host.fail(row.id, 'WORKSPACE_LOST');
      return;
    }
    const git = this.host.git;
    if (!git) {
      this.host.fail(row.id, 'COMMIT_UNVERIFIED');
      return;
    }
    const branch = row.branch ?? codingBranch(row.resource_number, row.id);
    if (!row.branch && !this.host.update(row.id, { branch })) return;
    const key = `automation:${row.id}:commit`;
    const descriptor: AgentActionDescriptorInput = { version: 1, actionClass: 'vcs_local', repository: binding.repository, branch };
    const earlier = this.broker.actions.byKey(row.owner_id, row.id, key);
    if (!earlier || earlier.state === 'INTENT') {
      // Before anything is staged: HEAD must still be the base (the agent or its verify command can run
      // Git, and its commits are never adopted), and every changed path is decided as an edit (a manifest
      // or lockfile as a package install), so a path the agent could not have been allowed to write is
      // never committed.
      const status = await git.status(row.owner_id, workspaceId, inspectSignal());
      if (!status.ok) {
        if (status.retryable || RETRYABLE_CODES.has(status.code)) this.retryLater(row);
        else this.host.fail(row.id, bounded(`CODING_PUBLISH_FAILED:${status.code}`));
        return;
      }
      if (status.data.head !== base) return this.refuseStep(row, binding, 'commit', key, descriptor, 'HEAD_MOVED');
      if (status.data.truncated || !verifiablePaths(status.data.paths)) return this.refuseStep(row, binding, 'commit', key, descriptor, 'PATHS_UNVERIFIABLE');
      if (status.data.paths.length === 0) {
        this.host.fail(row.id, 'CODING_NO_CHANGES');
        return;
      }
      if (!(await this.checkPaths(row, binding, key, branch, status.data.paths))) return;
    }
    const admission = await this.gate(row, binding, 'commit', key, descriptor);
    if (!admission) return;
    const { record } = admission;
    if (record.state === 'APPLIED' && record.outcome.commitSha) return this.phase(row, 'PUSH', { commit_sha: record.outcome.commitSha });
    if (record.state !== 'INTENT' && record.state !== 'DISPATCHED' && record.state !== 'UNKNOWN') {
      this.host.fail(row.id, 'CODING_PUBLISH_FAILED');
      return;
    }
    const startedAt = this.host.now();
    if (!this.broker.dispatched(record)) return;
    const created = await this.host.call(row.owner_id, 'git_checkout', { workspaceId, ref: branch, create: true });
    if (!created.ok) {
      // A replay finds the branch already created by the first attempt.
      const existing = await this.host.call(row.owner_id, 'git_checkout', { workspaceId, ref: branch, create: false });
      if (!existing.ok) return this.stepFailed(row, binding, record, existing, startedAt);
    }
    const staged = await this.host.call(row.owner_id, 'git_add', { workspaceId, all: true });
    if (!staged.ok) return this.stepFailed(row, binding, record, staged, startedAt);
    const committed = await this.host.call(row.owner_id, 'git_commit', {
      workspaceId,
      message: [
        `fix: resolve issue #${row.resource_number}`,
        '',
        `Automated change by the Cloud Harness coding automation "${this.snapshotOf(row).name}".`,
        '',
        `Closes #${row.resource_number}`,
        '',
        workflowTrailer(row.id)
      ].join('\n'),
      expectedHeadOid: base,
      idempotencyKey: key
    });
    // The commit tool answers without the commit id, and a replay may find HEAD already past the base
    // (an earlier attempt committed and only its answer was lost). Either way the commit is read back
    // from the checkout and adopted only if it is this workflow's own.
    if (!committed.ok && committed.error?.code !== 'STALE_HEAD') return this.stepFailed(row, binding, record, committed, startedAt);
    const own = await this.ownCommit(row, workspaceId, 'HEAD');
    if (!own.ok) {
      if (own.retryable) {
        this.broker.settle(binding, record, 'UNKNOWN', { errorCode: bounded(own.code) }, startedAt);
        this.retryLater(row);
        return;
      }
      this.broker.settle(binding, record, 'REJECTED', { errorCode: own.code }, startedAt);
      this.host.fail(row.id, own.code);
      return;
    }
    this.broker.settle(binding, record, 'APPLIED', { commitSha: own.sha, branch }, startedAt);
    this.phase(row, 'PUSH', { commit_sha: own.sha });
  }

  private async push(row: CodingWorkflowRow, binding: CodingBinding): Promise<void> {
    const workspaceId = binding.workspaceId;
    const branch = row.branch;
    const commitSha = row.commit_sha;
    if (!workspaceId || !branch || !commitSha || !SHA.test(commitSha) || !row.base_oid) {
      this.host.fail(row.id, 'WORKSPACE_LOST');
      return;
    }
    const key = `automation:${row.id}:push`;
    const descriptor: AgentActionDescriptorInput = { version: 1, actionClass: 'publish_branch', repository: binding.repository, branch };
    const earlier = this.broker.actions.byKey(row.owner_id, row.id, key);
    if (!earlier || earlier.state === 'INTENT') {
      // What is published is the commit, not the working tree: it must be this workflow's own, and every
      // path it changes against the base is gated again before the first push attempt.
      const own = await this.ownCommit(row, workspaceId, commitSha);
      if (!own.ok) {
        if (own.retryable) return this.retryLater(row);
        return this.refuseStep(row, binding, 'push', key, descriptor, own.code);
      }
      if (!(await this.checkPaths(row, binding, key, branch, own.paths))) return;
    }
    const admission = await this.gate(row, binding, 'push', key, descriptor);
    if (!admission) return;
    const { record } = admission;
    if (record.state === 'APPLIED') return this.phase(row, 'PR');
    if (record.state !== 'INTENT' && record.state !== 'DISPATCHED' && record.state !== 'UNKNOWN') {
      this.host.fail(row.id, 'CODING_PUBLISH_FAILED');
      return;
    }
    const startedAt = this.host.now();
    if (!this.broker.dispatched(record)) return;
    // Create-only: the push succeeds only when the branch does not exist yet, so it never overwrites
    // anything, and a replay that finds its own commit there is recognised by the reconciliation below.
    // The source is the verified commit id, so whatever HEAD points at now is never published.
    const pushed = await this.host.call(row.owner_id, 'git_push', {
      workspaceId, refspec: `${commitSha}:refs/heads/${branch}`, forceWithLease: true, expectedAbsent: true, idempotencyKey: key
    });
    if (pushed.ok) {
      this.broker.settle(binding, record, 'APPLIED', { branch, commitSha }, startedAt);
      return this.phase(row, 'PR');
    }
    const remote = await this.remoteBranch(row.owner_id, workspaceId, branch);
    if (remote.readable && remote.oid === commitSha) {
      this.broker.settle(binding, record, 'APPLIED', { branch, commitSha }, startedAt);
      return this.phase(row, 'PR');
    }
    const ambiguous = retryable(pushed) || pushed.error?.code === 'CONFLICT';
    if (!remote.readable) {
      if (ambiguous) return this.blocked(row, binding, record, startedAt);
      return this.stepFailed(row, binding, record, pushed, startedAt);
    }
    if (remote.oid === null && ambiguous) {
      // Proven absent: nothing was published, so the push is attempted again on the next tick.
      this.broker.settle(binding, record, 'UNKNOWN', { errorCode: bounded(pushed.error?.code ?? 'UNKNOWN') }, startedAt);
      this.retryLater(row);
      return;
    }
    // The branch is absent after a definite failure, or holds another commit: never overwritten.
    this.stepFailed(row, binding, record, remote.oid === null ? pushed : { ok: false, error: { code: 'BRANCH_EXISTS' } }, startedAt);
  }

  private async openPullRequest(row: CodingWorkflowRow, binding: CodingBinding): Promise<void> {
    const workspaceId = binding.workspaceId;
    const branch = row.branch;
    if (!workspaceId || !branch) {
      this.host.fail(row.id, 'WORKSPACE_LOST');
      return;
    }
    const admission = await this.gate(row, binding, 'open_pr', `automation:${row.id}:pr`, { version: 1, actionClass: 'open_pr', repository: binding.repository, branch });
    if (!admission) return;
    const { record } = admission;
    if (record.state === 'APPLIED' && record.outcome.prNumber && record.outcome.prUrl) return this.done(row, record.outcome.prNumber, record.outcome.prUrl);
    if (record.state !== 'INTENT' && record.state !== 'DISPATCHED' && record.state !== 'UNKNOWN') {
      this.host.fail(row.id, 'CODING_PUBLISH_FAILED');
      return;
    }
    const startedAt = this.host.now();
    const attempted = record.state !== 'INTENT';
    if (!this.broker.dispatched(record)) return;
    const baseBranch = binding.coding.baseBranch;
    // The provider has no idempotency key for pull requests, so an existing one for the branch is adopted.
    const before = await this.findPullRequest(row.owner_id, workspaceId, branch, baseBranch);
    if (before.found) return this.prApplied(row, binding, record, before.found, branch, startedAt);
    if (!before.readable && attempted) return this.blocked(row, binding, record, startedAt);
    const created = await this.host.call(row.owner_id, 'github_action', {
      workspaceId,
      action: 'pr_create',
      title: bounded(`Resolve #${row.resource_number}: ${this.snapshotOf(row).name}`, 256),
      body: [
        `Closes #${row.resource_number}`,
        '',
        `Opened by the Cloud Harness coding automation for workflow \`${row.id}\`. The change was verified with \`${binding.coding.verifyCommand}\` before it was committed. Review it before merging; the automation never merges.`
      ].join('\n'),
      head: branch,
      // Always explicit: the provider's default base is never relied on.
      base: baseBranch
    });
    const url = outputOf(created).match(/https:\/\/\S+\/pull\/(\d+)/u);
    if (created.ok && url?.[1]) return this.prApplied(row, binding, record, { number: Number(url[1]), url: url[0] }, branch, startedAt);
    const after = await this.findPullRequest(row.owner_id, workspaceId, branch, baseBranch);
    if (after.found) return this.prApplied(row, binding, record, after.found, branch, startedAt);
    if (!after.readable) return this.blocked(row, binding, record, startedAt);
    if (!created.ok && retryable(created)) {
      this.broker.settle(binding, record, 'UNKNOWN', { errorCode: bounded(created.error?.code ?? 'UNKNOWN') }, startedAt);
      this.retryLater(row);
      return;
    }
    this.stepFailed(row, binding, record, created.ok ? { ok: false, error: { code: 'NO_PR_URL' } } : created, startedAt);
  }

  // ---------------------------------------------------------------- helpers

  /** Records and decides a step; on a refusal the workflow fails and nothing is dispatched. */
  private async gate(row: CodingWorkflowRow, binding: CodingBinding, step: CodingActionStep, idempotencyKey: string, descriptor: AgentActionDescriptorInput): Promise<BrokeredAdmission | null> {
    const admission = await this.broker.begin({ binding, origin: 'runner', step, idempotencyKey, descriptor, signal: gateSignal() });
    if (admission.allowed) return admission;
    this.broker.traceRefusal(binding, admission.record);
    this.host.fail(row.id, refusalCode(admission));
    return null;
  }

  /** Gates changed paths as edits, in chunks of the gate's per-action limit; false when one is refused. */
  private async checkPaths(row: CodingWorkflowRow, binding: CodingBinding, keyPrefix: string, branch: string, paths: readonly string[]): Promise<boolean> {
    const size = AGENT_POLICY_LIMITS.maxPathsPerAction;
    for (let index = 0; index * size < paths.length; index += 1) {
      const chunk = paths.slice(index * size, (index + 1) * size);
      const check = await this.gate(row, binding, 'path_check', `${keyPrefix}:paths:${index}`, {
        version: 1, actionClass: editActionClass(chunk), repository: binding.repository, branch, paths: chunk
      });
      if (!check) return false;
      if (check.record.state === 'INTENT') this.broker.settle(binding, check.record, 'APPLIED', { branch }, this.host.now());
    }
    return true;
  }

  /**
   * The commit `revision` names, accepted only as this workflow's own: exactly one parent, the base, and
   * the workflow trailer in its message, with a complete, gateable list of the paths it changes.
   */
  private async ownCommit(row: CodingWorkflowRow, workspaceId: string, revision: string): Promise<OwnCommit> {
    const base = row.base_oid;
    if (!this.host.git || !base) return { ok: false, code: 'COMMIT_UNVERIFIED', retryable: false };
    const inspected = await this.host.git.commit(row.owner_id, workspaceId, revision, base, inspectSignal());
    if (!inspected.ok) {
      const transient = inspected.retryable || RETRYABLE_CODES.has(inspected.code);
      return { ok: false, code: transient ? bounded(inspected.code) : 'COMMIT_UNVERIFIED', retryable: transient };
    }
    const { sha, parents, message, paths, truncated } = inspected.data;
    const trailer = workflowTrailer(row.id);
    const marked = message.split('\n').some((line) => line.trim() === trailer);
    if (sha === base || parents.length !== 1 || parents[0] !== base || !marked) return { ok: false, code: 'COMMIT_UNVERIFIED', retryable: false };
    if (truncated || paths.length === 0 || !verifiablePaths(paths)) return { ok: false, code: 'PATHS_UNVERIFIABLE', retryable: false };
    return { ok: true, sha, paths };
  }

  /** Records a refusal decided by the runner itself (not the gate) on the step's receipt and fails the workflow. */
  private refuseStep(row: CodingWorkflowRow, binding: CodingBinding, step: CodingActionStep, idempotencyKey: string, descriptor: AgentActionDescriptorInput, code: string): void {
    const reason = (['HEAD_MOVED', 'PATHS_UNVERIFIABLE', 'COMMIT_UNVERIFIED'] as const).find((known) => known === code);
    if (reason) this.broker.refuse({ binding, origin: 'runner', step, idempotencyKey, descriptor }, reason satisfies CodingErrorCode);
    this.host.fail(row.id, bounded(code));
  }

  private phase(row: CodingWorkflowRow, phase: CodingPhase, fields: Record<string, string | number | null> = {}): void {
    this.host.update(row.id, { ...fields, coding_phase: phase, next_attempt_at: this.host.now() });
  }

  private retryLater(row: CodingWorkflowRow): void {
    this.host.update(row.id, { next_attempt_at: this.host.now() + STEP_RETRY_MS });
  }

  private stepFailed(row: CodingWorkflowRow, binding: CodingBinding, record: CodingActionRecord, result: AutomationOperationResult, startedAt: number): void {
    this.broker.settle(binding, record, 'REJECTED', { errorCode: bounded(result.error?.code ?? 'UNKNOWN') }, startedAt);
    this.host.fail(row.id, 'CODING_PUBLISH_FAILED');
  }

  /** The effect may or may not have happened and nothing can tell: stop and say so. */
  private blocked(row: CodingWorkflowRow, binding: CodingBinding, record: CodingActionRecord, startedAt: number): void {
    this.broker.settle(binding, record, 'BLOCKED', { errorCode: 'EFFECT_UNKNOWN' }, startedAt);
    this.host.fail(row.id, 'EFFECT_UNKNOWN', { coding_phase: 'BLOCKED' });
  }

  private prApplied(row: CodingWorkflowRow, binding: CodingBinding, record: CodingActionRecord, pr: { number: number; url: string }, branch: string, startedAt: number): void {
    this.broker.settle(binding, record, 'APPLIED', { prNumber: pr.number, prUrl: pr.url.slice(0, 2_048), branch }, startedAt);
    this.done(row, pr.number, pr.url);
  }

  private done(row: CodingWorkflowRow, prNumber: number, prUrl: string): void {
    this.host.complete(row.id, { coding_phase: 'DONE', pr_number: prNumber, pr_url: prUrl.slice(0, 2_048) });
  }

  /** The remote branch's commit: `oid` null when it provably does not exist. */
  private async remoteBranch(ownerId: string, workspaceId: string, branch: string): Promise<{ readable: boolean; oid: string | null }> {
    const result = await this.host.call(ownerId, 'github_read', { workspaceId, action: 'ref_get', ref: `refs/heads/${branch}` });
    if (!result.ok) return { readable: false, oid: null };
    const parsed = parseJson(outputOf(result)) as { exists?: unknown; oid?: unknown } | undefined;
    if (parsed?.exists === false) return { readable: true, oid: null };
    if (parsed?.exists === true && typeof parsed.oid === 'string') return { readable: true, oid: parsed.oid };
    return { readable: false, oid: null };
  }

  /**
   * An existing pull request of this workflow's branch: its head in this repository (never a fork's
   * branch of the same name) and its base the rule's base branch. The listing cannot be filtered by head,
   * so it reads the most recent pull requests.
   */
  private async findPullRequest(ownerId: string, workspaceId: string, branch: string, baseBranch: string): Promise<{ readable: boolean; found: { number: number; url: string } | null }> {
    const result = await this.host.call(ownerId, 'github_read', { workspaceId, action: 'pr_list', state: 'all', limit: 100 });
    if (!result.ok) return { readable: false, found: null };
    const parsed = parseJson(outputOf(result));
    if (!Array.isArray(parsed)) return { readable: false, found: null };
    for (const entry of parsed as { number?: unknown; headRefName?: unknown; baseRefName?: unknown; isCrossRepository?: unknown; url?: unknown }[]) {
      if (entry?.headRefName === branch && entry.isCrossRepository === false && entry.baseRefName === baseBranch
        && typeof entry.number === 'number' && typeof entry.url === 'string') {
        return { readable: true, found: { number: entry.number, url: entry.url } };
      }
    }
    return { readable: true, found: null };
  }

  private snapshotOf(row: CodingWorkflowRow): { name: string } {
    const parsed = parseJson(row.rule_snapshot_json) as { name?: unknown } | undefined;
    return { name: typeof parsed?.name === 'string' ? parsed.name : 'automation' };
  }
}
