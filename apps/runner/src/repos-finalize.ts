import { createHash } from 'node:crypto';
import {
  ErrorCodeSchema,
  HarnessError,
  type ErrorCode,
  type ReposFinalizeData,
  type ReposFinalizeStepStatus,
  type RunnerResponse
} from '@cloud-harness/contracts';
import type { ReposFinalizeStepRecord, StateStore, WorkspaceRepositoryRecord } from './state-store.js';
import { assertRepositoryWritable, findRepository, repositorySubpath, unknownRepository } from './workspace-repositories.js';

/**
 * Coordinated finalize across the checkouts of one workspace (`workspace_repos_finalize`).
 *
 * Each step runs the ordinary `workspace_finalize` and, when requested, `github_action` `pr_create` through
 * the caller-supplied executor, so commit, push, capability, and read-only rules stay in one place. Every
 * step carries an idempotency key derived from the caller's key, which is what makes a replay safe: a step
 * whose outcome is unknown is resolved by that tool's own idempotency, never by pushing blindly again.
 * The flow is deliberately not atomic; a later failure never undoes an earlier push.
 */

export type ReposFinalizeStepInput = {
  repositoryId: string;
  commitMessage: string;
  paths?: string[];
  all: boolean;
  branch?: string;
  push: boolean;
  pullRequest?: { title: string; body?: string; base?: string; draft: boolean };
};

export type ReposFinalizeInput = {
  idempotencyKey: string;
  repositories: ReposFinalizeStepInput[];
  authorName?: string;
  authorEmail?: string;
  preflight?: { checkDiff: boolean; forbiddenPatterns?: string[] };
  continueOnFailure: boolean;
};

export type ResolvedReposFinalizeStep = { entry: WorkspaceRepositoryRecord; input: ReposFinalizeStepInput };

export type ReposFinalizePlan = { steps: ResolvedReposFinalizeStep[]; fingerprint: string };

type StepOperation = 'workspace_finalize' | 'github_action' | 'github_read';

export type ReposFinalizeRun = {
  store: StateStore;
  ownerId: string;
  workspaceId: string;
  input: ReposFinalizeInput;
  plan: ReposFinalizePlan;
  /** Runs one ordinary tool call for the same principal; it must apply that tool's full checks. */
  execute: (operation: StepOperation, input: Record<string, unknown>) => Promise<RunnerResponse>;
};

type StepError = { code: ErrorCode; message: string; retryable: boolean };
type FinalizeOutcome = { commitSha?: string; branch?: string; pushed?: boolean; alreadyFinalized?: boolean; reason?: string; error?: StepError };
type PullRequestOutcome = { number?: number; url?: string; head?: string; base: string; reconciled?: boolean; reason?: string; error?: StepError };

const DEFAULT_PULL_REQUEST_BASE = 'main';

/**
 * Resolves every selector against the workspace's repositories, refuses unknown or repeated repositories and
 * pushes to read-only ones before anything runs, and fingerprints the request by resolved repository id.
 */
export function resolveReposFinalizePlan(entries: readonly WorkspaceRepositoryRecord[], input: ReposFinalizeInput): ReposFinalizePlan {
  const seen = new Set<string>();
  const steps = input.repositories.map((step) => {
    const entry = findRepository(entries, step.repositoryId);
    if (!entry) throw unknownRepository(entries, step.repositoryId);
    if (seen.has(entry.id)) throw new HarnessError('INVALID_INPUT', `repository ${entry.alias} appears in more than one step`, 400, false);
    seen.add(entry.id);
    if (step.push) {
      assertRepositoryWritable({
        repositoryScope: { id: entry.id, alias: entry.alias, access: entry.access, subpath: repositorySubpath(entry.alias) }
      }, 'workspace_repos_finalize with push');
    }
    return { entry, input: step };
  });
  const fingerprint = createHash('sha256').update(JSON.stringify({
    steps: steps.map(({ entry, input: step }) => ({ ...step, repositoryId: entry.id })),
    authorName: input.authorName ?? null,
    authorEmail: input.authorEmail ?? null,
    preflight: input.preflight ?? null,
    continueOnFailure: input.continueOnFailure
  })).digest('hex');
  return { steps, fingerprint };
}

/** The idempotency key one step passes to `workspace_finalize` or `pr_create`; stable across replays. */
export function reposFinalizeStepKey(key: string, repositoryId: string, kind: 'finalize' | 'pr'): string {
  const digest = createHash('sha256').update(`${key}\0${repositoryId}\0${kind}`).digest('hex').slice(0, 40);
  return `repos-finalize.${kind}.${digest}`;
}

export async function runReposFinalize(run: ReposFinalizeRun): Promise<RunnerResponse> {
  const { store, ownerId, workspaceId, input, plan } = run;
  const key = input.idempotencyKey;
  const recorded = store.reposFinalizeSteps(ownerId, workspaceId, key);
  const replayed = recorded.length > 0;
  const rows = replayed
    ? recorded
    : store.createReposFinalizePlan(ownerId, workspaceId, key, plan.fingerprint, plan.steps.map(({ entry, input: step }) => ({
      repositoryId: entry.id, alias: entry.alias, pullRequest: step.pullRequest !== undefined
    })));
  if (rows.length !== plan.steps.length || rows.some((row, index) => row.fingerprint !== plan.fingerprint || row.repositoryId !== plan.steps[index]!.entry.id)) {
    throw new HarnessError('CONFLICT', 'Idempotency key reused with different workspace_repos_finalize parameters', 409, false);
  }

  const update = (position: number, changes: Parameters<StateStore['updateReposFinalizeStep']>[4]) =>
    store.updateReposFinalizeStep(ownerId, workspaceId, key, position, changes);
  let halted = false;
  for (const [position, { entry, input: step }] of plan.steps.entries()) {
    const row = rows[position]!;
    if (halted) {
      skipRemaining(row, update, 'skipped because an earlier repository step failed and continueOnFailure is false');
      continue;
    }
    let finalize = row.finalizeStatus === 'SUCCEEDED' ? parseOutcome<FinalizeOutcome>(row.finalizeResultJson) : undefined;
    if (!finalize) {
      update(position, { finalizeStatus: 'PENDING', finalizeAttempted: true });
      const response = await callStep(() => run.execute('workspace_finalize', finalizeStepInput(workspaceId, entry, step, input, key)));
      const outcome = finalizeOutcome(response);
      update(position, { finalizeStatus: response.ok ? 'SUCCEEDED' : 'FAILED', finalizeResultJson: JSON.stringify(outcome) });
      if (!response.ok) {
        if (row.prStatus !== null) {
          update(position, { prStatus: 'SKIPPED', prResultJson: JSON.stringify(pullRequestBase(step, { reason: 'skipped because this repository was not finalized' })) });
        }
        halted = !input.continueOnFailure;
        continue;
      }
      finalize = outcome;
    }
    if (!step.pullRequest || row.prStatus === null || row.prStatus === 'SUCCEEDED') continue;
    const pullRequest = await openPullRequest(run, position, row, entry, step, finalize, update);
    if (!pullRequest) halted = !input.continueOnFailure;
  }
  return reposFinalizeResponse(workspaceId, store.reposFinalizeSteps(ownerId, workspaceId, key), replayed, input.continueOnFailure);
}

function skipRemaining(row: ReposFinalizeStepRecord, update: (position: number, changes: Parameters<StateStore['updateReposFinalizeStep']>[4]) => void, reason: string): void {
  if (row.finalizeStatus !== 'SUCCEEDED') {
    update(row.position, { finalizeStatus: 'SKIPPED', finalizeResultJson: JSON.stringify({ reason } satisfies FinalizeOutcome) });
  }
  if (row.prStatus !== null && row.prStatus !== 'SUCCEEDED') {
    const previous = parseOutcome<PullRequestOutcome>(row.prResultJson);
    update(row.position, { prStatus: 'SKIPPED', prResultJson: JSON.stringify({ base: previous?.base ?? DEFAULT_PULL_REQUEST_BASE, reason } satisfies PullRequestOutcome) });
  }
}

/** Returns false when the pull request step did not succeed. */
async function openPullRequest(
  run: ReposFinalizeRun,
  position: number,
  row: ReposFinalizeStepRecord,
  entry: WorkspaceRepositoryRecord,
  step: ReposFinalizeStepInput,
  finalize: FinalizeOutcome,
  update: (position: number, changes: Parameters<StateStore['updateReposFinalizeStep']>[4]) => void
): Promise<boolean> {
  const pullRequest = step.pullRequest!;
  const base = pullRequest.base ?? DEFAULT_PULL_REQUEST_BASE;
  if (finalize.pushed !== true || !finalize.branch) {
    update(position, { prStatus: 'SKIPPED', prResultJson: JSON.stringify({ base, reason: 'skipped because the branch was not pushed' } satisfies PullRequestOutcome) });
    return false;
  }
  const head = finalize.branch;
  // An earlier attempt may have opened the pull request before its outcome was recorded. GitHub allows one
  // open pull request per head and base, so an open one found here is that attempt's result.
  if (row.prAttempts > 0) {
    const existing = await findOpenPullRequest(run, entry, head, base);
    if (existing) {
      update(position, { prStatus: 'SUCCEEDED', prResultJson: JSON.stringify({ ...existing, head, base, reconciled: true } satisfies PullRequestOutcome) });
      return true;
    }
  }
  update(position, { prStatus: 'PENDING', prAttempted: true });
  const response = await callStep(() => run.execute('github_action', {
    workspaceId: run.workspaceId,
    repositoryId: entry.id,
    action: 'pr_create',
    title: pullRequest.title,
    ...(pullRequest.body !== undefined ? { body: pullRequest.body } : {}),
    head,
    base,
    draft: pullRequest.draft,
    idempotencyKey: reposFinalizeStepKey(run.input.idempotencyKey, entry.id, 'pr')
  }));
  const outcome: PullRequestOutcome = response.ok
    ? { ...parsePullRequestUrl(outputOf(response)), head, base }
    : { head, base, error: stepError(response) };
  update(position, { prStatus: response.ok ? 'SUCCEEDED' : 'FAILED', prResultJson: JSON.stringify(outcome) });
  return response.ok;
}

async function findOpenPullRequest(run: ReposFinalizeRun, entry: WorkspaceRepositoryRecord, head: string, base: string): Promise<{ number?: number; url?: string } | undefined> {
  const response = await callStep(() => run.execute('github_read', {
    workspaceId: run.workspaceId, repositoryId: entry.id, action: 'pr_list', state: 'open', limit: 100
  }));
  if (!response.ok) return undefined;
  let listed: unknown;
  try { listed = JSON.parse(outputOf(response)); } catch { return undefined; }
  if (!Array.isArray(listed)) return undefined;
  const match = listed.find((candidate: unknown) => {
    const pr = candidate as Record<string, unknown> | null;
    return pr !== null && typeof pr === 'object' && pr.headRefName === head && pr.baseRefName === base && pr.isCrossRepository !== true;
  }) as Record<string, unknown> | undefined;
  if (!match) return undefined;
  return {
    ...(typeof match.number === 'number' ? { number: match.number } : {}),
    ...(typeof match.url === 'string' ? { url: match.url } : {})
  };
}

function finalizeStepInput(workspaceId: string, entry: WorkspaceRepositoryRecord, step: ReposFinalizeStepInput, input: ReposFinalizeInput, key: string): Record<string, unknown> {
  return {
    workspaceId,
    repositoryId: entry.id,
    commitMessage: step.commitMessage,
    all: step.all,
    push: step.push,
    ...(step.paths !== undefined ? { paths: step.paths } : {}),
    ...(step.branch !== undefined ? { branch: step.branch } : {}),
    ...(input.authorName !== undefined ? { authorName: input.authorName } : {}),
    ...(input.authorEmail !== undefined ? { authorEmail: input.authorEmail } : {}),
    ...(input.preflight !== undefined ? { preflight: input.preflight } : {}),
    idempotencyKey: reposFinalizeStepKey(key, entry.id, 'finalize')
  };
}

/** A thrown tool error is a step failure, recorded like a failed result, so later steps can still be reported. */
async function callStep(action: () => Promise<RunnerResponse>): Promise<RunnerResponse> {
  try {
    return await action();
  } catch (error) {
    const harness = error instanceof HarnessError ? error : undefined;
    const message = (error instanceof Error ? error.message : 'step failed').slice(0, 2_000);
    return {
      ok: false,
      message,
      error: { code: harness?.code ?? 'INTERNAL_ERROR', message, retryable: harness?.retryable ?? true, ...(harness?.repository ? { repository: harness.repository } : {}) },
      truncated: false
    };
  }
}

function finalizeOutcome(response: RunnerResponse): FinalizeOutcome {
  const data = response.data && typeof response.data === 'object' ? response.data as Record<string, unknown> : {};
  return {
    ...(typeof data.commitSha === 'string' && data.commitSha ? { commitSha: data.commitSha } : {}),
    ...(typeof data.branch === 'string' && data.branch ? { branch: data.branch } : {}),
    ...(typeof data.pushed === 'boolean' ? { pushed: data.pushed } : {}),
    ...(data.alreadyFinalized === true ? { alreadyFinalized: true } : {}),
    ...(response.ok ? {} : { error: stepError(response) })
  };
}

function stepError(response: RunnerResponse): StepError {
  const parsed = ErrorCodeSchema.safeParse(response.error?.code);
  return {
    code: parsed.success ? parsed.data : 'INTERNAL_ERROR',
    message: (response.error?.message ?? response.message).slice(0, 2_000),
    retryable: response.error?.retryable ?? true
  };
}

function pullRequestBase(step: ReposFinalizeStepInput, extra: Omit<PullRequestOutcome, 'base'>): PullRequestOutcome {
  return { base: step.pullRequest?.base ?? DEFAULT_PULL_REQUEST_BASE, ...extra };
}

function outputOf(response: RunnerResponse): string {
  const data = response.data as { output?: unknown } | undefined;
  return typeof data?.output === 'string' ? data.output : '';
}

function parsePullRequestUrl(output: string): { number?: number; url?: string } {
  const match = output.match(/https?:\/\/\S+?\/pull\/(\d+)/);
  return match ? { number: Number(match[1]), url: match[0] } : {};
}

function parseOutcome<T>(json: string | null): T | undefined {
  if (!json) return undefined;
  try { return JSON.parse(json) as T; } catch { return undefined; }
}

function repositoryStatus(row: ReposFinalizeStepRecord): ReposFinalizeStepStatus {
  if (row.finalizeStatus !== 'SUCCEEDED') return row.finalizeStatus;
  return row.prStatus ?? 'SUCCEEDED';
}

export function reposFinalizeResponse(workspaceId: string, rows: readonly ReposFinalizeStepRecord[], replayed: boolean, continueOnFailure: boolean): RunnerResponse {
  const repositories: ReposFinalizeData['repositories'] = rows.map((row) => {
    const finalize = parseOutcome<FinalizeOutcome>(row.finalizeResultJson) ?? {};
    const pullRequest = row.prStatus === null ? undefined : parseOutcome<PullRequestOutcome>(row.prResultJson);
    return {
      repositoryId: row.repositoryId,
      alias: row.alias,
      status: repositoryStatus(row),
      finalize: { status: row.finalizeStatus, ...finalize },
      ...(row.prStatus === null ? {} : { pullRequest: { status: row.prStatus, base: DEFAULT_PULL_REQUEST_BASE, ...pullRequest } })
    };
  });
  const succeeded = repositories.filter((repository) => repository.status === 'SUCCEEDED').length;
  const finalized = rows.filter((row) => row.finalizeStatus === 'SUCCEEDED').length;
  const status: ReposFinalizeData['status'] = succeeded === rows.length ? 'succeeded' : finalized === 0 ? 'failed' : 'partial';
  const data: ReposFinalizeData = { workspaceId, status, atomic: false, replayed, continueOnFailure, repositories };
  if (status === 'succeeded') {
    return { ok: true, message: `Finalized ${rows.length} of ${rows.length} repositories`, data, truncated: false };
  }
  const failing = repositories.find((repository) => repository.status !== 'SUCCEEDED')!;
  const cause = failing.finalize.error ?? failing.pullRequest?.error;
  const reason = cause?.message ?? failing.finalize.reason ?? failing.pullRequest?.reason ?? 'step did not complete';
  const message = `Coordinated finalize ${status}: ${succeeded} of ${rows.length} repositories completed; ${failing.alias}: ${reason}. Not atomic: completed pushes were not rolled back; replay the idempotencyKey to retry the remaining steps.`.slice(0, 2_000);
  return {
    ok: false,
    message,
    data,
    error: { code: cause?.code ?? 'CONFLICT', message, retryable: cause?.retryable ?? true, repository: failing.alias },
    truncated: false
  };
}
