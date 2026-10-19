import {
  AGENT_POLICY_LIMITS,
  CODING_LIMITS,
  type AgentActionDescriptorInput,
  type CodingActionOutcome,
  type CodingActionStep,
  type CodingPhase,
  type GateDecision
} from '@cloud-harness/contracts';
import {
  editActionClass,
  plainArgv,
  type BrokeredAdmission,
  type CodingActionBroker,
  type CodingBinding
} from './agent-governance/action-broker.js';
import type { CodingActionRecord } from './agent-governance/action-store.js';
import { ExecutionBackendError, WorkspaceExecutionBackend } from './agent-governance/workspace-execution-backend.js';
import { admitNpmLockfile, MAX_LOCKFILE_BYTES, NPM_LOCKFILE, type InstallResult } from './agent-governance/install-executor.js';
import type { AutomationOperationResult } from './automation-service.js';
import type { RunnerOperation } from '@cloud-harness/contracts';

/** Upper bound for the verify command; the executor caps it again. */
const VERIFY_TIMEOUT_MS = 300_000;
/** Delay before a step that hit a transient failure runs again. The gate's run-time budget bounds the retries. */
const STEP_RETRY_MS = 5_000;
const DIFF_FILE = '.cloud-harness-coding.diff';
const RETRYABLE_CODES = new Set(['UNAVAILABLE', 'TIMEOUT', 'GITHUB_RATE_LIMITED', 'INTERNAL', 'UNKNOWN_REMOTE_STATE']);

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
};

/** The lockfile install executor as the engine sees it. */
export type CodingInstallPort = {
  /** AGENT_CODING_PACKAGE_INSTALL_ENABLED, read on every start. */
  enabled(): boolean;
  /** The registry `npm ci` uses; every locked package must resolve below it. */
  registry: string;
  run(ownerId: string, workspaceId: string): Promise<InstallResult>;
};

const retryable = (result: AutomationOperationResult) => result.error?.retryable === true || RETRYABLE_CODES.has(result.error?.code ?? '');
const bounded = (value: string, max = 100) => (value.length <= max ? value : value.slice(0, max));

/** The workflow error code for a refused step. */
export function refusalCode(admission: Pick<BrokeredAdmission, 'decision'>): string {
  const decision: GateDecision | null = admission.decision;
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

/** Paths in `git status --short` output, both sides of a rename included. */
export function changedPaths(statusOutput: string): string[] {
  const paths = new Set<string>();
  for (const line of statusOutput.split('\n')) {
    if (line.length < 4 || line.startsWith('##')) continue;
    for (const part of line.slice(3).split(' -> ')) {
      const trimmed = part.trim();
      const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
      if (unquoted) paths.add(unquoted);
    }
  }
  return [...paths].sort();
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

/**
 * The runner-owned half of a coding workflow, after the agent has finished editing: verify, commit,
 * push and open the pull request. One step runs per engine tick; every step is described, decided by
 * the gate, recorded as a receipt and traced before it runs, and keyed so a replay after a restart or
 * a lost response finds its first effect instead of acting twice. An effect that cannot be proven
 * either way stops the workflow as BLOCKED with EFFECT_UNKNOWN. The engine never merges or deploys.
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
   * rule's project. The revisions it was admitted under are pinned, so a later policy change stops it.
   */
  async admit(ownerId: string, projectId: string, repository: string): Promise<{ ok: true; fields: Record<string, string | number> } | { ok: false; code: string }> {
    const decision = await this.broker.admit(ownerId, projectId, { version: 1, actionClass: 'read', repository });
    if (decision.decision !== 'ALLOW') return { ok: false, code: refusalCode({ decision }) };
    return {
      ok: true,
      fields: {
        project_id: projectId,
        coding_phase: 'AGENT' satisfies CodingPhase,
        coding_started_at: this.host.now(),
        policy_revision_json: JSON.stringify({ globalRevisionId: decision.policy.globalRevisionId, projectRevisionId: decision.policy.projectRevisionId })
      }
    };
  }

  /**
   * Binds the opened workspace: one repository only (the repository is resolved from the rule, so a
   * workspace with several checkouts is ambiguous), its generation pinned, and the base commit recorded.
   */
  async bindWorkspace(row: CodingWorkflowRow, workspaceId: string): Promise<{ ok: true } | { ok: false; code: string; retry: boolean }> {
    if (this.broker.workspaces.repositoryCount(workspaceId) > 1) return { ok: false, code: 'REPOSITORY_AMBIGUOUS', retry: false };
    const generation = this.broker.workspaces.generation(workspaceId);
    if (generation === null) return { ok: false, code: 'WORKSPACE_LOST', retry: false };
    const log = await this.host.call(row.owner_id, 'git_log', { workspaceId, limit: 1 });
    const base = outputOf(log).split('\t')[0]?.trim() ?? '';
    if (!log.ok || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(base)) {
      return { ok: false, code: bounded(`WORKSPACE_OPEN_FAILED:${log.error?.code ?? 'NO_BASE_COMMIT'}`), retry: !log.ok && retryable(log) };
    }
    this.host.update(row.id, { workspace_generation: generation, base_oid: base });
    return { ok: true };
  }

  /**
   * Installs the checkout's npm lockfile before the agent starts, when the install flag is on and a
   * lockfile exists. The lockfile must pass supply-chain admission and the gate must allow every locked
   * package as a `package_install`; one refusal stops the workflow before anything is fetched. Each
   * package is a receipt, so a replay after a restart finds the finished install instead of running again.
   */
  async installDependencies(row: CodingWorkflowRow, workspaceId: string): Promise<{ ok: true } | { ok: false; code: string; retry: boolean }> {
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
    const records: CodingActionRecord[] = [];
    for (const locked of lockfile.packages) {
      const admission = await this.broker.begin({
        binding, origin: 'runner', step: 'install', idempotencyKey: `automation:${row.id}:install:${locked.name}`,
        descriptor: { version: 1, actionClass: 'package_install', repository: binding.repository, package: { ecosystem: 'npm', name: locked.name, registry: locked.registryHost } }
      });
      if (!admission.allowed) {
        this.broker.traceRefusal(binding, admission.record);
        return { ok: false, code: refusalCode(admission), retry: false };
      }
      records.push(admission.record);
    }
    if (records.every((record) => record.state === 'APPLIED')) return { ok: true };
    const startedAt = this.host.now();
    for (const record of records) this.broker.dispatched(record);
    let result: InstallResult;
    try {
      result = await install.run(row.owner_id, workspaceId);
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'CODING_INSTALL_FAILED';
      for (const record of records) this.broker.settle(binding, record, 'REJECTED', { errorCode: bounded(code) }, startedAt);
      return { ok: false, code: bounded(code), retry: false };
    }
    for (const record of records) {
      this.broker.settle(binding, record, result.ok ? 'APPLIED' : 'REJECTED', result.ok ? { exitCode: 0 } : { exitCode: result.exitCode, errorCode: result.code }, startedAt);
    }
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
    this.broker.dispatched(record);
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
      descriptor: { version: 1, actionClass: 'read', repository: binding.repository }
    });
    if (!admission.allowed) {
      this.broker.traceRefusal(binding, admission.record);
    } else if (admission.record.state === 'INTENT' || admission.record.state === 'DISPATCHED') {
      const startedAt = this.host.now();
      this.broker.dispatched(admission.record);
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
    if (!workspaceId || !row.base_oid) {
      this.host.fail(row.id, 'WORKSPACE_LOST');
      return;
    }
    const branch = row.branch ?? codingBranch(row.resource_number, row.id);
    if (!row.branch && !this.host.update(row.id, { branch })) return;
    const key = `automation:${row.id}:commit`;
    const earlier = this.broker.actions.byKey(row.owner_id, row.id, key);
    if (!earlier || earlier.state === 'INTENT') {
      // The changed paths are decided as edits (a manifest or lockfile as a package install) before
      // anything is staged, so a path the agent could not have been allowed to write is never committed.
      const status = await this.host.call(row.owner_id, 'git_status', { workspaceId });
      if (!status.ok) {
        if (retryable(status)) this.retryLater(row);
        else this.host.fail(row.id, bounded(`CODING_PUBLISH_FAILED:${status.error?.code ?? 'GIT_STATUS_FAILED'}`));
        return;
      }
      const paths = changedPaths(outputOf(status));
      if (paths.length === 0) {
        this.host.fail(row.id, 'CODING_NO_CHANGES');
        return;
      }
      for (let index = 0; index * AGENT_POLICY_LIMITS.maxPathsPerAction < paths.length; index += 1) {
        const chunk = paths.slice(index * AGENT_POLICY_LIMITS.maxPathsPerAction, (index + 1) * AGENT_POLICY_LIMITS.maxPathsPerAction);
        const check = await this.gate(row, binding, 'commit', `${key}:paths:${index}`, {
          version: 1, actionClass: editActionClass(chunk), repository: binding.repository, branch, paths: chunk
        });
        if (!check) return;
        if (check.record.state === 'INTENT') this.broker.settle(binding, check.record, 'APPLIED', { branch }, this.host.now());
      }
    }
    const admission = await this.gate(row, binding, 'commit', key, { version: 1, actionClass: 'vcs_local', repository: binding.repository, branch });
    if (!admission) return;
    const { record } = admission;
    if (record.state === 'APPLIED' && record.outcome.commitSha) return this.phase(row, 'PUSH', { commit_sha: record.outcome.commitSha });
    if (record.state === 'REJECTED' || record.state === 'BLOCKED') {
      this.host.fail(row.id, 'CODING_PUBLISH_FAILED');
      return;
    }
    const startedAt = this.host.now();
    this.broker.dispatched(record);
    const created = await this.host.call(row.owner_id, 'git_checkout', { workspaceId, ref: branch, create: true });
    if (!created.ok) {
      // A replay finds the branch already created by the first attempt.
      const existing = await this.host.call(row.owner_id, 'git_checkout', { workspaceId, ref: branch, create: false });
      if (!existing.ok) return this.stepFailed(row, binding, record, existing, startedAt);
    }
    const staged = await this.host.call(row.owner_id, 'git_add', { workspaceId, all: true });
    if (!staged.ok) return this.stepFailed(row, binding, record, staged, startedAt);
    const snapshot = this.snapshotOf(row);
    const committed = await this.host.call(row.owner_id, 'git_commit', {
      workspaceId,
      message: [
        `fix: resolve issue #${row.resource_number}`,
        '',
        `Automated change by the Cloud Harness coding automation "${snapshot.name}".`,
        '',
        `Closes #${row.resource_number}`,
        '',
        `Cloud-Harness-Workflow: ${row.id}`
      ].join('\n'),
      expectedHeadOid: row.base_oid,
      idempotencyKey: key
    });
    let commitSha = (committed.data as { commitSha?: unknown } | undefined)?.commitSha;
    if (!committed.ok && committed.error?.code === 'STALE_HEAD') {
      // HEAD moved past the base: an earlier attempt committed, and only its answer was lost.
      const head = await this.head(row.owner_id, workspaceId);
      if (head && head !== row.base_oid) commitSha = head;
    }
    if (typeof commitSha !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commitSha)) {
      return this.stepFailed(row, binding, record, committed.ok ? { ok: false, error: { code: 'NO_COMMIT_SHA' } } : committed, startedAt);
    }
    this.broker.settle(binding, record, 'APPLIED', { commitSha, branch }, startedAt);
    this.phase(row, 'PUSH', { commit_sha: commitSha });
  }

  private async push(row: CodingWorkflowRow, binding: CodingBinding): Promise<void> {
    const workspaceId = binding.workspaceId;
    const branch = row.branch;
    const commitSha = row.commit_sha;
    if (!workspaceId || !branch || !commitSha) {
      this.host.fail(row.id, 'WORKSPACE_LOST');
      return;
    }
    const key = `automation:${row.id}:push`;
    const admission = await this.gate(row, binding, 'push', key, { version: 1, actionClass: 'publish_branch', repository: binding.repository, branch });
    if (!admission) return;
    const { record } = admission;
    if (record.state === 'APPLIED') return this.phase(row, 'PR');
    if (record.state === 'REJECTED' || record.state === 'BLOCKED') {
      this.host.fail(row.id, 'CODING_PUBLISH_FAILED');
      return;
    }
    const startedAt = this.host.now();
    this.broker.dispatched(record);
    // Create-only: the push succeeds only when the branch does not exist yet, so it never overwrites
    // anything, and a replay that finds its own commit there is recognised by the reconciliation below.
    const pushed = await this.host.call(row.owner_id, 'git_push', {
      workspaceId, refspec: `HEAD:refs/heads/${branch}`, forceWithLease: true, expectedAbsent: true, idempotencyKey: key
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
    if (record.state === 'REJECTED' || record.state === 'BLOCKED') {
      this.host.fail(row.id, 'CODING_PUBLISH_FAILED');
      return;
    }
    const startedAt = this.host.now();
    const attempted = record.state !== 'INTENT';
    this.broker.dispatched(record);
    // The provider has no idempotency key for pull requests, so an existing one for the branch is adopted.
    const before = await this.findPullRequest(row.owner_id, workspaceId, branch);
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
      base: binding.coding.baseBranch
    });
    const url = outputOf(created).match(/https:\/\/\S+\/pull\/(\d+)/u);
    if (created.ok && url?.[1]) return this.prApplied(row, binding, record, { number: Number(url[1]), url: url[0] }, branch, startedAt);
    const after = await this.findPullRequest(row.owner_id, workspaceId, branch);
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
    const admission = await this.broker.begin({ binding, origin: 'runner', step, idempotencyKey, descriptor });
    if (admission.allowed) return admission;
    this.broker.traceRefusal(binding, admission.record);
    this.host.fail(row.id, refusalCode(admission));
    return null;
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

  private async head(ownerId: string, workspaceId: string): Promise<string | null> {
    const log = await this.host.call(ownerId, 'git_log', { workspaceId, limit: 1 });
    const sha = outputOf(log).split('\t')[0]?.trim() ?? '';
    return log.ok && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha) ? sha : null;
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

  private async findPullRequest(ownerId: string, workspaceId: string, branch: string): Promise<{ readable: boolean; found: { number: number; url: string } | null }> {
    const result = await this.host.call(ownerId, 'github_read', { workspaceId, action: 'pr_list', state: 'all', limit: 100 });
    if (!result.ok) return { readable: false, found: null };
    const parsed = parseJson(outputOf(result));
    if (!Array.isArray(parsed)) return { readable: false, found: null };
    for (const entry of parsed as { number?: unknown; headRefName?: unknown; url?: unknown }[]) {
      if (entry?.headRefName === branch && typeof entry.number === 'number' && typeof entry.url === 'string') {
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
