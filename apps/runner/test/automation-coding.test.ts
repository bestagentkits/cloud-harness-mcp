import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GlobalExecutionPolicy, RunnerOperation, RunnerPrincipalSelector } from '@cloud-harness/contracts';
import { CodingActionBroker } from '../src/agent-governance/action-broker.js';
import {
  createCodingGitPort, nulPaths, parseCommitObject, parseTransferInspection, porcelainPaths,
  type CodingGitCommit, type CodingGitPort, type PushVerifier
} from '../src/agent-governance/coding-git.js';
import {
  CODING_COMMIT_AUTHOR, codingBranch, codingCommitMessage, CodingWorkflowEngine, packagesDigest, workflowTrailer,
  type CodingInstallPort, type CodingPublishPort, type CodingWorkflowRow
} from '../src/automation-coding.js';
import type { AutomationOperationResult } from '../src/automation-service.js';
import { CODING_GLOBAL_POLICY, CODING_PROJECT, CODING_REPOSITORY, createPolicyService, insertCodingWorkflow } from './support/coding-policy.js';

const OWNER = 'owner';
const owner: RunnerPrincipalSelector = { kind: 'owner', ownerId: OWNER };
const WORKFLOW = `wfl_${'e'.repeat(32)}`;
const WORKSPACE = `ws_${'w'.repeat(24)}`;
const BASE = 'a'.repeat(40);
const COMMIT = 'c'.repeat(40);
const BRANCH = codingBranch(7, WORKFLOW);
/** The message and identity the runner commits with, as Git stores them. */
const OWN_MESSAGE = `${codingCommitMessage(7, 'Fix issues', WORKFLOW)}\n`;
const IDENTITY = `${CODING_COMMIT_AUTHOR.name} <${CODING_COMMIT_AUTHOR.email}>`;

type Call = { operation: RunnerOperation; input: Record<string, unknown> };
type Handler = (input: Record<string, unknown>) => AutomationOperationResult | Promise<AutomationOperationResult>;

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const text = (output: string): AutomationOperationResult => ({ ok: true, data: { output, exitCode: 0 } });
/** A raw commit object as `git cat-file commit` prints it. */
const rawCommit = (parents: string[], message: string) =>
  `tree ${'1'.repeat(40)}\n${parents.map((parent) => `parent ${parent}\n`).join('')}author ${IDENTITY} 1 +0000\ncommitter ${IDENTITY} 1 +0000\n\n${message}`;

type CheckoutState = {
  head: string;
  paths: string[];
  truncated: boolean;
  /** The commit HEAD names once the runner (or anything else) committed, as the checkout reports it. */
  commit: CodingGitCommit;
  /**
   * The commit as the staged transfer clone holds it, read with a clean configuration; `undefined` means
   * the same as `commit`, `null` that the clone holds no such commit.
   */
  transfer?: CodingGitCommit | null;
  /** Staging or reading the transfer clone fails before anything is inspected. */
  stageFails?: boolean;
  /** The verified push fails with this code around the helper (a credential, the executor pause, a probe). */
  publishFails?: string;
};

async function setup(options: { policy?: GlobalExecutionPolicy; phase?: string; install?: CodingInstallPort; git?: false; publish?: false } = {}) {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  const policies = createPolicyService(database, (selector) => (selector.kind === 'owner' ? selector.ownerId : 'external'), owner);
  policies.saveGlobal(options.policy ?? CODING_GLOBAL_POLICY);
  const broker = new CodingActionBroker({
    database, enabled: () => true, policies: policies.service,
    workspaces: { generation: () => 1, repositoryCount: () => 1 }
  });
  const admitted = await broker.admit(OWNER, CODING_PROJECT, { version: 1, actionClass: 'read', repository: CODING_REPOSITORY }, 0);
  insertCodingWorkflow(database, {
    id: WORKFLOW, ownerId: OWNER, workspaceId: WORKSPACE, codingPhase: options.phase ?? 'VERIFY', baseOid: BASE,
    policyRevisionJson: JSON.stringify({ globalRevisionId: admitted.policy.globalRevisionId, projectRevisionId: admitted.policy.projectRevisionId })
  });
  const checkout: CheckoutState = {
    head: BASE,
    paths: ['src/a.ts', 'test/a.test.ts'],
    truncated: false,
    commit: { sha: COMMIT, parents: [BASE], author: IDENTITY, committer: IDENTITY, message: OWN_MESSAGE, paths: ['src/a.ts', 'test/a.test.ts'], truncated: false }
  };
  const calls: Call[] = [];
  // Answers have the worker's shapes: `git_commit` names the author, never the commit.
  const handlers: Partial<Record<RunnerOperation, Handler>> = {
    exec_run: () => ({ ok: true, data: { output: '', exitCode: 0, signal: null, truncated: false } }),
    git_checkout: () => ({ ok: true, data: {} }),
    git_add: () => ({ ok: true, data: {} }),
    git_commit: () => {
      checkout.head = checkout.commit.sha;
      return { ok: true, data: { output: '[agent/7 cccccc] fix', authorName: 'Cloud Harness', authorEmail: 'bot@example.invalid' } };
    },
    git_push: () => ({ ok: true, data: {} }),
    git_log: () => text(`${BASE}\t2026-10-19T00:00:00Z\tbot\tfix`),
    git_diff: () => text('diff --git a/src/a.ts b/src/a.ts\n'),
    files_write: () => ({ ok: true, data: {} }),
    artifacts_snapshot: () => ({ ok: true, data: { artifactId: 'art_1' } }),
    github_read: (input) => (input.action === 'pr_list' ? text('[]') : text(JSON.stringify({ exists: false }))),
    github_action: () => text('https://github.com/acme/widgets/pull/12\n')
  };
  const inspections: { kind: 'status' | 'commit'; revision?: string }[] = [];
  const git: CodingGitPort = {
    status: async () => {
      inspections.push({ kind: 'status' });
      return { ok: true, data: { head: checkout.head, paths: [...checkout.paths], truncated: checkout.truncated } };
    },
    commit: async (_owner, _workspace, revision) => {
      inspections.push({ kind: 'commit', revision });
      if (revision === 'HEAD' && checkout.head === BASE) return { ok: true, data: { sha: BASE, parents: ['b'.repeat(40)], author: null, committer: null, message: 'Initial', paths: [], truncated: false } };
      return { ok: true, data: { ...checkout.commit, paths: [...checkout.commit.paths] } };
    },
    diff: async () => ({ ok: true, data: { text: 'diff --git a/src/a.ts b/src/a.ts\n+added\n-removed\n', truncated: false } }),
    change: async (_owner, _workspace, _base, sha) => ({
      ok: true, data: { head: sha === null ? checkout.head : null, listing: (sha === null ? checkout.paths : checkout.commit.paths).join('\0'), truncated: false }
    })
  };
  const verifiers: PushVerifier[] = [];
  // As the workspace service runs a verified push: the staged clone is read and decided before anything
  // is sent, and a refusal sends nothing (only a sent push is recorded as a `git_push` call).
  const publish: CodingPublishPort = async (_owner, input, verifier) => {
    verifiers.push(verifier);
    if (checkout.publishFails) return { ok: false, error: { code: checkout.publishFails, retryable: true } };
    if (checkout.stageFails) {
      verifier.stagingFailed?.();
      return { ok: false, error: { code: 'UNAVAILABLE', retryable: true } };
    }
    const staged = checkout.transfer === undefined ? checkout.commit : checkout.transfer;
    const refusal = await verifier.verify(staged ? { ...staged, paths: [...staged.paths] } : null);
    if (refusal !== null) return { ok: false, error: { code: 'FORBIDDEN', retryable: false } };
    calls.push({ operation: 'git_push', input });
    return await handlers.git_push!(input);
  };
  const outcome: { state: string; code: string | null; fields: Record<string, unknown> } = { state: 'RUNNING', code: null, fields: {} };
  let clock = Date.now();
  const engine = new CodingWorkflowEngine(broker, {
    call: async (_owner, operation, input) => {
      calls.push({ operation, input });
      const handler = handlers[operation];
      return handler ? await handler(input) : { ok: true, data: {} };
    },
    update: (id, fields) => {
      if (outcome.state !== 'RUNNING') return false;
      const assignments = Object.keys(fields).map((key) => `${key} = ?`).join(', ');
      database.prepare(`UPDATE automation_workflows SET ${assignments} WHERE id = ?`).run(...Object.values(fields), id);
      return true;
    },
    fail: (_id, code, fields) => { outcome.state = 'FAILED'; outcome.code = code; outcome.fields = fields ?? {}; },
    complete: (_id, fields) => { outcome.state = 'COMPLETED'; outcome.fields = fields; },
    now: () => (clock += 10),
    ...(options.install ? { install: options.install } : {}),
    ...(options.git === false ? {} : { git }),
    ...(options.publish === false ? {} : { publish })
  });
  const row = (): CodingWorkflowRow => database.prepare('SELECT * FROM automation_workflows WHERE id = ?').get(WORKFLOW) as CodingWorkflowRow;
  /** Advances until the workflow leaves RUNNING or stops making progress. */
  const run = async (steps = 6) => {
    for (let index = 0; index < steps && outcome.state === 'RUNNING'; index += 1) await engine.advance(row());
  };
  const count = (operation: RunnerOperation) => calls.filter((call) => call.operation === operation).length;
  /** Receipts oldest first (the store pages newest first). */
  const receipts = () => broker.actions.receipts(OWNER, WORKFLOW).receipts.reverse();
  return { database, broker, engine, handlers, calls, outcome, row, run, count, receipts, policies, checkout, inspections, verifiers };
}

describe('coding workflow helpers', () => {
  it('derives the branch from the issue number and workflow id only', async () => {
    expect(BRANCH).toBe('agent/7-eeeeeeee');
    expect(codingBranch(12, `wfl_${'0123456789abcdef'.repeat(2)}`)).toBe('agent/12-01234567');
  });

  it('reads NUL-separated listings without unquoting, spaces, arrows and quotes included', async () => {
    expect(porcelainPaths(' M src/a.ts\0?? src/with space.ts\0D  "quoted".ts\0A  a -> b.ts\0')).toEqual(['"quoted".ts', 'a -> b.ts', 'src/a.ts', 'src/with space.ts']);
    expect(nulPaths('src/b.ts\0src/a.ts\0src/a.ts\0')).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('takes commit parents from the raw object headers only', async () => {
    const signed = `tree ${'1'.repeat(40)}\nparent ${BASE}\nauthor A <a@x> 1 +0000\ncommitter B <b@x> 2 -0130\ngpgsig -----BEGIN-----\n parent ${'d'.repeat(40)}\n -----END-----\n\n${OWN_MESSAGE}`;
    expect(parseCommitObject(signed)).toEqual({ parents: [BASE], author: 'A <a@x>', committer: 'B <b@x>', message: OWN_MESSAGE });
    // A `parent` line in the message is not a parent.
    expect(parseCommitObject(rawCommit([], `subject\n\nparent ${BASE}\n`))).toEqual({ parents: [], author: IDENTITY, committer: IDENTITY, message: `subject\n\nparent ${BASE}\n` });
    // As Git reads a commit, a `parent` header after another header is not a parent either.
    const late = `tree ${'1'.repeat(40)}\nparent ${BASE}\nauthor A <a@x> 1 +0000\nparent ${'d'.repeat(40)}\ncommitter A <a@x> 1 +0000\n\nx`;
    expect(parseCommitObject(late)?.parents).toEqual([BASE]);
    expect(parseCommitObject(`tree ${'1'.repeat(40)}\nauthor A <a@x> 1 +0000\nparent ${BASE}\n\nx`)?.parents).toEqual([]);
    // An identity without its date, or no identity at all, is not read as one.
    expect(parseCommitObject(`tree ${'1'.repeat(40)}\nauthor A <a@x>\n\nx`)).toMatchObject({ author: null, committer: null });
    expect(parseCommitObject(rawCommit([BASE, 'd'.repeat(40)], 'merge\n'))?.parents).toEqual([BASE, 'd'.repeat(40)]);
    expect(parseCommitObject('blob\n\nx')).toBeNull();
    expect(parseCommitObject(`tree ${'1'.repeat(40)}\nparent not-an-id\n\nx`)).toBeNull();
  });

  it('reads the transfer helper inspect answer, and nothing malformed', async () => {
    const encoded = Buffer.from(rawCommit([BASE], OWN_MESSAGE)).toString('base64');
    expect(parseTransferInspection(`${COMMIT}\n${encoded}\npaths\nsrc/b.ts\0src/a.ts\0`, false))
      .toEqual({ sha: COMMIT, parents: [BASE], author: IDENTITY, committer: IDENTITY, message: OWN_MESSAGE, paths: ['src/a.ts', 'src/b.ts'], truncated: false });
    expect(parseTransferInspection(`${COMMIT}\n${encoded}\nno-base\n`, true)).toEqual({ sha: COMMIT, parents: [BASE], author: IDENTITY, committer: IDENTITY, message: OWN_MESSAGE, paths: [], truncated: true });
    for (const malformed of ['\n', `${COMMIT}\n`, `${COMMIT}\n${encoded}\n`, `${COMMIT}\n${encoded}\nother\n`, `${COMMIT}\n!!\npaths\n`, `HEAD\n${encoded}\npaths\n`]) {
      expect(parseTransferInspection(malformed, false), JSON.stringify(malformed)).toBeNull();
    }
  });

  it('digests the locked package list independently of its order', async () => {
    const left = { name: 'left-pad', version: '1.3.0', registryHost: 'registry.npmjs.org' };
    const right = { name: 'right-pad', version: '1.0.0', registryHost: 'registry.npmjs.org' };
    expect(packagesDigest([left, right])).toBe(packagesDigest([right, left]));
    expect(packagesDigest([left, right])).not.toBe(packagesDigest([left, { ...right, version: '1.0.1' }]));
  });
});

describe('createCodingGitPort', () => {
  it('runs fixed read-only subcommands and reports a truncated listing', async () => {
    const seen: string[][] = [];
    const port = createCodingGitPort(async (_owner, _workspace, args) => {
      seen.push([...args]);
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: `${COMMIT}\n`, truncated: false };
      if (args[0] === 'cat-file') return { exitCode: 0, stdout: rawCommit([BASE], OWN_MESSAGE), truncated: false };
      if (args[0] === 'diff-tree') return { exitCode: 0, stdout: 'src/a.ts\0', truncated: true };
      return { exitCode: 0, stdout: ' M src/a.ts\0', truncated: false };
    });
    const status = await port.status(OWNER, WORKSPACE, AbortSignal.timeout(1_000));
    expect(status).toEqual({ ok: true, data: { head: COMMIT, paths: ['src/a.ts'], truncated: false } });
    const commit = await port.commit(OWNER, WORKSPACE, 'HEAD', BASE, AbortSignal.timeout(1_000));
    expect(commit).toEqual({ ok: true, data: { sha: COMMIT, parents: [BASE], author: IDENTITY, committer: IDENTITY, message: OWN_MESSAGE, paths: ['src/a.ts'], truncated: true } });
    expect(seen.map((args) => args[0])).toEqual(['rev-parse', 'status', 'rev-parse', 'cat-file', 'diff-tree']);
    expect(seen.find((args) => args[0] === 'cat-file')).toEqual(['cat-file', 'commit', COMMIT]);
    expect(seen.find((args) => args[0] === 'diff-tree')).toEqual(['diff-tree', '-r', '--no-renames', '--no-commit-id', '--name-only', '-z', BASE, COMMIT, '--']);
    // A revision that is not HEAD or an object id never reaches Git.
    expect(await port.commit(OWNER, WORKSPACE, '--output=/tmp/x', BASE, AbortSignal.timeout(1_000))).toMatchObject({ ok: false });
    expect(seen).toHaveLength(5);
  });

  it('identifies a staged or committed change by its raw listing of full object ids', async () => {
    const seen: string[][] = [];
    const listing = `:100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} M\0src/a.ts\0`;
    const port = createCodingGitPort(async (_owner, _workspace, args) => {
      seen.push([...args]);
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: `${BASE}\n`, truncated: false };
      return { exitCode: 0, stdout: listing, truncated: args[0] === 'diff-tree' };
    });
    const signal = AbortSignal.timeout(1_000);
    expect(await port.change(OWNER, WORKSPACE, BASE, null, signal)).toEqual({ ok: true, data: { head: BASE, listing, truncated: false } });
    expect(await port.change(OWNER, WORKSPACE, BASE, COMMIT, signal)).toEqual({ ok: true, data: { head: null, listing, truncated: true } });
    const options = ['-r', '-z', '--no-renames', '--no-abbrev', '--ignore-submodules=none'];
    expect(seen).toEqual([
      ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
      ['diff-index', '--cached', ...options, BASE, '--'],
      ['diff-tree', ...options, '--no-commit-id', BASE, COMMIT, '--']
    ]);
    // Anything but an object id never reaches Git.
    expect(await port.change(OWNER, WORKSPACE, '--output=/tmp/x', null, signal)).toMatchObject({ ok: false, code: 'GIT_INSPECT_FAILED' });
    expect(await port.change(OWNER, WORKSPACE, BASE, 'HEAD', signal)).toMatchObject({ ok: false, code: 'GIT_INSPECT_FAILED' });
    expect(seen).toHaveLength(3);
  });

  it('refuses a commit object it cannot read completely', async () => {
    const answers = (raw: { stdout: string; truncated: boolean }) => createCodingGitPort(async (_owner, _workspace, args) => {
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: `${COMMIT}\n`, truncated: false };
      if (args[0] === 'cat-file') return { exitCode: 0, ...raw };
      return { exitCode: 0, stdout: 'src/a.ts\0', truncated: false };
    });
    const signal = AbortSignal.timeout(1_000);
    expect(await answers({ stdout: rawCommit([BASE], OWN_MESSAGE), truncated: true }).commit(OWNER, WORKSPACE, 'HEAD', BASE, signal)).toMatchObject({ ok: false, code: 'GIT_INSPECT_FAILED' });
    expect(await answers({ stdout: 'not a commit', truncated: false }).commit(OWNER, WORKSPACE, 'HEAD', BASE, signal)).toMatchObject({ ok: false, code: 'GIT_INSPECT_FAILED' });
  });

  it('reports a failed or unavailable inspection with its retryability', async () => {
    const failed = createCodingGitPort(async () => ({ exitCode: 128, stdout: '', truncated: false }));
    expect(await failed.status(OWNER, WORKSPACE, AbortSignal.timeout(1_000))).toEqual({ ok: false, code: 'GIT_INSPECT_FAILED', retryable: false });
    const unavailable = createCodingGitPort(async () => { throw Object.assign(new Error('down'), { code: 'UNAVAILABLE', retryable: true }); });
    expect(await unavailable.status(OWNER, WORKSPACE, AbortSignal.timeout(1_000))).toEqual({ ok: false, code: 'UNAVAILABLE', retryable: true });
  });
});

describe('CodingWorkflowEngine', () => {
  it('verifies, commits, pushes the verified commit to a new agent branch and opens a pull request against the rule base', async () => {
    const context = await setup();
    await context.run();
    expect(context.outcome).toMatchObject({ state: 'COMPLETED', fields: { coding_phase: 'DONE', pr_number: 12 } });
    expect(context.calls.find((call) => call.operation === 'git_commit')?.input).toMatchObject({ expectedHeadOid: BASE, idempotencyKey: `automation:${WORKFLOW}:commit` });
    expect(String(context.calls.find((call) => call.operation === 'git_commit')?.input.message)).toContain(workflowTrailer(WORKFLOW));
    expect(context.calls.find((call) => call.operation === 'git_push')?.input).toMatchObject({ refspec: `${COMMIT}:refs/heads/${BRANCH}`, expectedAbsent: true });
    const pr = context.calls.find((call) => call.operation === 'github_action')?.input;
    expect(pr).toMatchObject({ action: 'pr_create', head: BRANCH, base: 'main' });
    expect(String(pr?.body)).toContain('Closes #7');
    expect(context.receipts().map((receipt) => [receipt.step, receipt.state])).toEqual([
      ['verify', 'APPLIED'], ['path_check', 'APPLIED'], ['commit', 'APPLIED'], ['push', 'APPLIED'], ['path_check', 'APPLIED'], ['open_pr', 'APPLIED']
    ]);
    expect(context.receipts().find((receipt) => receipt.step === 'commit')?.outcome.commitSha).toBe(COMMIT);
    expect(context.count('git_push')).toBe(1);
    // The push was decided on the staged clone, for the recorded commit against the base.
    expect(context.verifiers).toEqual([expect.objectContaining({ sha: COMMIT, base: BASE })]);
  });

  it('keeps the diff as an artifact and commits nothing when verification fails', async () => {
    const context = await setup();
    context.handlers.exec_run = () => ({ ok: true, data: { output: '', exitCode: 1, signal: null, truncated: false } });
    await context.run();
    expect(context.outcome).toMatchObject({ state: 'FAILED', code: 'CODING_VERIFY_FAILED' });
    expect(context.count('git_commit')).toBe(0);
    expect(context.receipts().find((receipt) => receipt.step === 'diff_artifact')).toMatchObject({ state: 'APPLIED', outcome: { artifactId: 'art_1' } });
  });

  it('retries verification after a transient executor failure', async () => {
    const context = await setup();
    context.handlers.exec_run = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'UNAVAILABLE', retryable: true } })
      .mockResolvedValue({ ok: true, data: { output: '', exitCode: 0, signal: null, truncated: false } });
    await context.engine.advance(context.row());
    expect(context.row().coding_phase).toBe('VERIFY');
    expect(context.receipts()[0]?.state).toBe('UNKNOWN');
    await context.engine.advance(context.row());
    expect(context.row().coding_phase).toBe('COMMIT');
  });

  it('refuses to commit a path outside the policy, a lockfile, or nothing at all', async () => {
    const outside = await setup({ phase: 'COMMIT' });
    outside.checkout.paths = ['src/a.ts', '.github/workflows/ci.yml'];
    await outside.run();
    expect(outside.outcome.code).toBe('ACTION_DENIED:PATH_OUT_OF_SCOPE');
    expect(outside.count('git_add') + outside.count('git_commit')).toBe(0);
    expect(outside.receipts().at(-1)).toMatchObject({ step: 'path_check', state: 'REJECTED' });

    const empty = await setup({ phase: 'COMMIT' });
    empty.checkout.paths = [];
    await empty.run();
    expect(empty.outcome.code).toBe('CODING_NO_CHANGES');

    const lockfile = await setup({ phase: 'COMMIT' });
    lockfile.checkout.paths = ['src/a.ts', 'package-lock.json'];
    await lockfile.run();
    expect(lockfile.outcome.code).toMatch(/^ACTION_DENIED:/u);
    expect(lockfile.receipts().at(-1)).toMatchObject({ step: 'path_check', actionClass: 'package_install', state: 'REJECTED' });
  });

  it('refuses to stage when HEAD is no longer the base, and says so on the commit receipt', async () => {
    const context = await setup({ phase: 'COMMIT' });
    // The agent or its verify command committed by itself.
    context.checkout.head = 'b'.repeat(40);
    await context.run();
    expect(context.outcome).toMatchObject({ state: 'FAILED', code: 'HEAD_MOVED' });
    expect(context.count('git_add') + context.count('git_commit') + context.count('git_push')).toBe(0);
    expect(context.receipts()).toEqual([expect.objectContaining({ step: 'commit', decision: 'DENY', reasonCode: 'HEAD_MOVED', state: 'REJECTED' })]);
  });

  it('refuses a listing it cannot gate completely', async () => {
    const truncated = await setup({ phase: 'COMMIT' });
    truncated.checkout.truncated = true;
    await truncated.run();
    expect(truncated.outcome.code).toBe('PATHS_UNVERIFIABLE');
    expect(truncated.count('git_add')).toBe(0);

    const huge = await setup({ phase: 'COMMIT' });
    huge.checkout.paths = [`src/${'x'.repeat(1_100)}.ts`];
    await huge.run();
    expect(huge.outcome.code).toBe('PATHS_UNVERIFIABLE');
  });

  it('fails closed without a Git inspection port', async () => {
    const context = await setup({ phase: 'COMMIT', git: false });
    await context.run();
    expect(context.outcome.code).toBe('COMMIT_UNVERIFIED');
    expect(context.count('git_commit')).toBe(0);
  });

  /** Lets the first `git_commit` commit and then lose the runner, leaving the commit step dispatched. */
  function crashAfterCommit(context: Awaited<ReturnType<typeof setup>>) {
    context.handlers.git_commit = vi.fn()
      .mockImplementationOnce(() => {
        context.checkout.head = COMMIT;
        throw new Error('runner lost');
      })
      .mockImplementation(() => ({ ok: false, error: { code: 'STALE_HEAD' } }));
  }

  it('adopts its own earlier commit on a replay whose first answer was lost, and nothing else', async () => {
    const own = await setup({ phase: 'COMMIT' });
    crashAfterCommit(own);
    await expect(own.engine.advance(own.row())).rejects.toThrow('runner lost');
    expect(own.receipts().find((receipt) => receipt.step === 'commit')?.state).toBe('DISPATCHED');
    await own.engine.advance(own.row());
    expect(own.row()).toMatchObject({ coding_phase: 'PUSH', commit_sha: COMMIT });
    // The replay found the branch it created on the first attempt.
    expect(own.calls.filter((call) => call.operation === 'git_checkout').map((call) => call.input.create)).toEqual([true, true]);

    // A commit without this workflow's trailer is never adopted.
    const foreign = await setup({ phase: 'COMMIT' });
    foreign.checkout.commit = { ...foreign.checkout.commit, message: 'chore: tidy\n' };
    crashAfterCommit(foreign);
    await expect(foreign.engine.advance(foreign.row())).rejects.toThrow('runner lost');
    await foreign.run();
    expect(foreign.outcome.code).toBe('COMMIT_UNVERIFIED');
    expect(foreign.receipts().find((receipt) => receipt.step === 'commit')).toMatchObject({ state: 'REJECTED', outcome: { errorCode: 'COMMIT_UNVERIFIED' } });
    expect(foreign.count('git_push')).toBe(0);

    // Nor is a commit on top of another one, even with the trailer.
    const stacked = await setup({ phase: 'COMMIT' });
    stacked.checkout.commit = { ...stacked.checkout.commit, parents: ['d'.repeat(40)] };
    await stacked.run();
    expect(stacked.outcome.code).toBe('COMMIT_UNVERIFIED');
    expect(stacked.count('git_push')).toBe(0);
  });

  it('never adopts a moved HEAD or an existing branch on a first attempt', async () => {
    // Something committed between the status read and the commit.
    const raced = await setup({ phase: 'COMMIT' });
    raced.handlers.git_commit = () => {
      raced.checkout.head = COMMIT;
      return { ok: false, error: { code: 'STALE_HEAD' } };
    };
    await raced.run();
    expect(raced.outcome).toMatchObject({ state: 'FAILED', code: 'HEAD_MOVED' });
    expect(raced.receipts().find((receipt) => receipt.step === 'commit')).toMatchObject({ state: 'REJECTED', outcome: { errorCode: 'HEAD_MOVED' } });
    expect(raced.count('git_push')).toBe(0);

    // The workflow's branch already exists: someone else made it, so it is never checked out.
    const planted = await setup({ phase: 'COMMIT' });
    planted.handlers.git_checkout = (input) => (input.create === true ? { ok: false, error: { code: 'CONFLICT' } } : { ok: true, data: {} });
    await planted.run();
    expect(planted.outcome).toMatchObject({ state: 'FAILED', code: 'BRANCH_EXISTS' });
    expect(planted.calls.filter((call) => call.operation === 'git_checkout').map((call) => call.input.create)).toEqual([true]);
    expect(planted.count('git_add') + planted.count('git_commit') + planted.count('git_push')).toBe(0);
  });

  it('decides the push on the staged clone, whatever the checkout reports', async () => {
    const cases: [string, (context: Awaited<ReturnType<typeof setup>>) => void, string | RegExp][] = [
      // A replace ref or graft in the checkout showed the base as the parent; the clone holds the real one.
      ['parent', (context) => { context.checkout.transfer = { ...context.checkout.commit, parents: ['d'.repeat(40)] }; }, 'COMMIT_UNVERIFIED'],
      ['trailer', (context) => { context.checkout.transfer = { ...context.checkout.commit, message: 'chore: tidy\n' }; }, 'COMMIT_UNVERIFIED'],
      ['missing', (context) => { context.checkout.transfer = null; }, 'COMMIT_UNVERIFIED'],
      ['other commit', (context) => { context.checkout.transfer = { ...context.checkout.commit, sha: 'e'.repeat(40) }; }, 'COMMIT_UNVERIFIED'],
      // A process left in the executor swapped in a commit of its own, trailer and all.
      ['author', (context) => { context.checkout.transfer = { ...context.checkout.commit, author: 'Agent <agent@example.invalid>' }; }, 'COMMIT_UNVERIFIED'],
      ['committer', (context) => { context.checkout.transfer = { ...context.checkout.commit, committer: null }; }, 'COMMIT_UNVERIFIED'],
      ['message', (context) => { context.checkout.transfer = { ...context.checkout.commit, message: `chore: other\n\n${workflowTrailer(WORKFLOW)}\n` }; }, 'COMMIT_UNVERIFIED'],
      ['extended trailer line', (context) => { context.checkout.transfer = { ...context.checkout.commit, message: `${OWN_MESSAGE.trimEnd()}x\n` }; }, 'COMMIT_UNVERIFIED'],
      // A relative or truncated listing in the checkout hid a path the clone's commit changes.
      ['hidden path', (context) => { context.checkout.transfer = { ...context.checkout.commit, paths: ['src/a.ts', '.github/workflows/evil.yml'] }; }, 'ACTION_DENIED:PATH_OUT_OF_SCOPE'],
      ['manifest', (context) => { context.checkout.transfer = { ...context.checkout.commit, paths: ['src/a.ts', 'package.json'] }; }, /^ACTION_DENIED:/u],
      ['truncated', (context) => { context.checkout.transfer = { ...context.checkout.commit, truncated: true }; }, 'PATHS_UNVERIFIABLE'],
      ['empty', (context) => { context.checkout.transfer = { ...context.checkout.commit, paths: [] }; }, 'PATHS_UNVERIFIABLE']
    ];
    for (const [name, plant, code] of cases) {
      const context = await setup({ phase: 'COMMIT' });
      await context.engine.advance(context.row());
      expect(context.row().coding_phase, name).toBe('PUSH');
      plant(context);
      await context.run();
      expect(context.outcome.code, name).toMatch(code);
      expect(context.count('git_push'), name).toBe(0);
      expect(context.receipts().find((receipt) => receipt.step === 'push'), name).toMatchObject({ state: 'REJECTED', outcome: { errorCode: expect.stringMatching(code) } });
    }
  });

  it('commits as the runner and publishes only its exact message', async () => {
    const context = await setup({ phase: 'COMMIT' });
    await context.engine.advance(context.row());
    expect(context.calls.find((call) => call.operation === 'git_commit')?.input).toMatchObject({
      authorName: CODING_COMMIT_AUTHOR.name, authorEmail: CODING_COMMIT_AUTHOR.email, message: OWN_MESSAGE.trimEnd()
    });
    // The worker commits with hooks off, so anything appended (another issue it closes, say) is not the runner's.
    for (const message of [`${OWN_MESSAGE}Closes #8\n`, OWN_MESSAGE.trimEnd(), `${OWN_MESSAGE}\n`]) {
      const appended = await setup({ phase: 'COMMIT' });
      await appended.engine.advance(appended.row());
      appended.checkout.transfer = { ...appended.checkout.commit, message };
      await appended.run();
      expect(appended.outcome.code, JSON.stringify(message)).toBe('COMMIT_UNVERIFIED');
      expect(appended.count('git_push')).toBe(0);
    }
    await context.run();
    expect(context.outcome).toMatchObject({ state: 'COMPLETED' });

    // On the checkout side, a commit by another identity is never adopted after a first-attempt commit.
    const forged = await setup({ phase: 'COMMIT' });
    forged.checkout.commit = { ...forged.checkout.commit, author: 'Agent <agent@example.invalid>' };
    await forged.run();
    expect(forged.outcome.code).toBe('COMMIT_UNVERIFIED');
    expect(forged.count('git_push')).toBe(0);
  });

  it('builds the commit message in the form Git stores it, whatever whitespace the rule name holds', async () => {
    expect(codingCommitMessage(7, '  Fix  \n\n\n issues\t', WORKFLOW)).toBe(codingCommitMessage(7, 'Fix issues', WORKFLOW));
    const message = codingCommitMessage(7, 'Fix\r\n\r\nissues', WORKFLOW);
    // What `git commit -m` cleans up: trailing blanks on a line, and runs of blank lines.
    expect(message).not.toMatch(/[ \t]$|\n\n\n/mu);
    expect(message).toContain('automation "Fix issues".');
  });

  it('counts only failures to stage or read the transfer clone, in a row, and stops at the third', async () => {
    const context = await setup({ phase: 'COMMIT' });
    await context.engine.advance(context.row());
    // Failures around the helper (a credential, the executor pause, the remote probe) never count.
    for (const code of ['UNAVAILABLE', 'UNKNOWN_REMOTE_STATE', 'GITHUB_RATE_LIMITED', 'UNAVAILABLE']) {
      context.checkout.publishFails = code;
      await context.engine.advance(context.row());
    }
    expect(context.row()).toMatchObject({ coding_phase: 'PUSH', push_unverified_attempts: 0 });
    expect(context.outcome.state).toBe('RUNNING');
    delete context.checkout.publishFails;

    // Two staging failures, then an attempt that reaches the clone: the count starts over.
    context.checkout.stageFails = true;
    await context.engine.advance(context.row());
    await context.engine.advance(context.row());
    expect(context.row()).toMatchObject({ push_unverified_attempts: 2 });
    context.checkout.stageFails = false;
    context.handlers.git_push = () => ({ ok: false, error: { code: 'UNAVAILABLE', retryable: true } });
    await context.engine.advance(context.row());
    expect(context.row()).toMatchObject({ coding_phase: 'PUSH', push_unverified_attempts: 0 });
    expect(context.outcome.state).toBe('RUNNING');

    // Three in a row stop the push.
    context.checkout.stageFails = true;
    await context.engine.advance(context.row());
    await context.engine.advance(context.row());
    expect(context.row()).toMatchObject({ coding_phase: 'PUSH', push_unverified_attempts: 2 });
    expect(context.outcome.state).toBe('RUNNING');
    await context.engine.advance(context.row());
    expect(context.outcome).toMatchObject({ state: 'FAILED', code: 'COMMIT_UNVERIFIED' });
    expect(context.receipts().find((receipt) => receipt.step === 'push')).toMatchObject({ state: 'REJECTED', outcome: { errorCode: 'COMMIT_UNVERIFIED' } });
    expect(context.count('git_push')).toBe(1);
    expect(context.verifiers).toHaveLength(10);
  });

  it('refuses the push as unverified when the verifier itself fails', async () => {
    const context = await setup({ phase: 'COMMIT' });
    await context.engine.advance(context.row());
    // The path gate cannot decide while the push is verified.
    vi.spyOn(context.broker, 'begin').mockImplementation(async (step) => {
      if (step.step === 'path_check') throw new Error('gate unavailable');
      return await CodingActionBroker.prototype.begin.call(context.broker, step);
    });
    await context.run();
    expect(context.outcome).toMatchObject({ state: 'FAILED', code: 'COMMIT_UNVERIFIED' });
    expect(context.receipts().find((receipt) => receipt.step === 'push')).toMatchObject({ state: 'REJECTED', outcome: { errorCode: 'COMMIT_UNVERIFIED' } });
    expect(context.count('git_push')).toBe(0);
  });

  it('fails closed without a verified publish port', async () => {
    const context = await setup({ phase: 'COMMIT', publish: false });
    await context.run();
    expect(context.outcome.code).toBe('COMMIT_UNVERIFIED');
    expect(context.count('git_push')).toBe(0);
  });

  it('reconciles a push whose answer was lost by reading the remote branch', async () => {
    const context = await setup({ phase: 'COMMIT' });
    await context.engine.advance(context.row());
    context.handlers.git_push = () => ({ ok: false, error: { code: 'TIMEOUT', retryable: true } });
    context.handlers.github_read = (input) => (input.action === 'ref_get' ? text(JSON.stringify({ exists: true, oid: COMMIT })) : text('[]'));
    await context.engine.advance(context.row());
    expect(context.row().coding_phase).toBe('PR');
    expect(context.receipts().find((receipt) => receipt.step === 'push')?.state).toBe('APPLIED');
  });

  it('blocks with EFFECT_UNKNOWN when the remote cannot be read after an ambiguous push', async () => {
    const context = await setup({ phase: 'COMMIT' });
    await context.engine.advance(context.row());
    context.handlers.git_push = () => ({ ok: false, error: { code: 'TIMEOUT', retryable: true } });
    context.handlers.github_read = () => ({ ok: false, error: { code: 'UNAVAILABLE', retryable: true } });
    await context.run();
    expect(context.outcome).toMatchObject({ state: 'FAILED', code: 'EFFECT_UNKNOWN', fields: { coding_phase: 'BLOCKED' } });
    expect(context.receipts().find((receipt) => receipt.step === 'push')).toMatchObject({ state: 'BLOCKED', outcome: { errorCode: 'EFFECT_UNKNOWN' } });
    expect(context.count('git_push')).toBe(1);
  });

  it('never overwrites a branch that holds another commit, and retries a push proven absent', async () => {
    const taken = await setup({ phase: 'COMMIT' });
    await taken.engine.advance(taken.row());
    taken.handlers.git_push = () => ({ ok: false, error: { code: 'CONFLICT' } });
    taken.handlers.github_read = () => text(JSON.stringify({ exists: true, oid: 'f'.repeat(40) }));
    await taken.engine.advance(taken.row());
    expect(taken.outcome).toMatchObject({ state: 'FAILED', code: 'BRANCH_EXISTS' });
    expect(taken.receipts().find((receipt) => receipt.step === 'push')).toMatchObject({ state: 'REJECTED', outcome: { errorCode: 'BRANCH_EXISTS' } });

    // A definite failure with the branch absent stays a publish failure.
    const refusedByGitHub = await setup({ phase: 'COMMIT' });
    await refusedByGitHub.engine.advance(refusedByGitHub.row());
    refusedByGitHub.handlers.git_push = () => ({ ok: false, error: { code: 'FORBIDDEN', retryable: false } });
    await refusedByGitHub.engine.advance(refusedByGitHub.row());
    expect(refusedByGitHub.outcome.code).toBe('CODING_PUBLISH_FAILED');
    expect(refusedByGitHub.receipts().find((receipt) => receipt.step === 'push')?.outcome.errorCode).toBe('FORBIDDEN');

    const absent = await setup({ phase: 'COMMIT' });
    await absent.engine.advance(absent.row());
    absent.handlers.git_push = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'GITHUB_RATE_LIMITED', retryable: true } })
      .mockResolvedValue({ ok: true, data: {} });
    await absent.engine.advance(absent.row());
    expect(absent.row().coding_phase).toBe('PUSH');
    await absent.engine.advance(absent.row());
    expect(absent.row().coding_phase).toBe('PR');
    // Every attempt that sends is decided on its own staged clone; the path checks replay their first receipt.
    expect(absent.verifiers).toHaveLength(2);
    expect(absent.receipts().filter((receipt) => receipt.step === 'path_check')).toHaveLength(2);
  });

  it('adopts only its own pull request: same repository, same branch, the rule base', async () => {
    const pull = (fields: Record<string, unknown>) => ({ number: 9, headRefName: BRANCH, baseRefName: 'main', isCrossRepository: false, url: 'https://github.com/acme/widgets/pull/9', ...fields });
    const own = await setup({ phase: 'COMMIT' });
    await own.engine.advance(own.row());
    await own.engine.advance(own.row());
    own.handlers.github_read = () => text(JSON.stringify([pull({})]));
    await own.engine.advance(own.row());
    expect(own.outcome.fields).toMatchObject({ pr_number: 9 });
    expect(own.count('github_action')).toBe(0);

    for (const other of [{ isCrossRepository: true }, { baseRefName: 'release' }, { isCrossRepository: undefined }]) {
      const context = await setup({ phase: 'COMMIT' });
      await context.engine.advance(context.row());
      await context.engine.advance(context.row());
      context.handlers.github_read = () => text(JSON.stringify([pull(other)]));
      await context.engine.advance(context.row());
      expect(context.outcome.fields, JSON.stringify(other)).toMatchObject({ pr_number: 12 });
      expect(context.count('github_action')).toBe(1);
    }
  });

  it('blocks when a pull request may exist but the list cannot be read', async () => {
    const context = await setup({ phase: 'COMMIT' });
    await context.engine.advance(context.row());
    await context.engine.advance(context.row());
    context.handlers.github_action = () => ({ ok: false, error: { code: 'TIMEOUT', retryable: true } });
    context.handlers.github_read = () => ({ ok: false, error: { code: 'UNAVAILABLE' } });
    await context.engine.advance(context.row());
    expect(context.outcome).toMatchObject({ code: 'EFFECT_UNKNOWN' });
  });

  it('fails closed when publishing needs approval and approvals are off, with no effect', async () => {
    const context = await setup({ phase: 'COMMIT', policy: { ...CODING_GLOBAL_POLICY, defaults: { ...CODING_GLOBAL_POLICY.defaults, publish_branch: { effect: 'require_approval', delegable: false } } } });
    await context.run();
    expect(context.outcome.code).toBe('ACTION_DENIED:APPROVALS_DISABLED');
    expect(context.count('git_push')).toBe(0);
  });
});

describe('CodingWorkflowEngine.admit', () => {
  const OTHER = { id: `wfl_${'f'.repeat(32)}`, owner_id: OWNER };

  it('holds a run back while the owner is at the policy concurrency limit', async () => {
    // The workflow inserted by setup is RUNNING, so it is the one coding run in progress.
    const limited = await setup({ policy: { ...CODING_GLOBAL_POLICY, budget: { ...CODING_GLOBAL_POLICY.budget, maxConcurrentRuns: 1 } } });
    expect(await limited.engine.admit(OTHER, CODING_PROJECT, CODING_REPOSITORY)).toMatchObject({ state: 'waiting' });

    const room = await setup();
    expect(await room.engine.admit(OTHER, CODING_PROJECT, CODING_REPOSITORY)).toEqual({ state: 'admitted' });
  });

  it('refuses a repository the policy does not cover', async () => {
    const context = await setup();
    expect(await context.engine.admit(OTHER, CODING_PROJECT, 'acme/other')).toMatchObject({ state: 'refused', code: expect.stringMatching(/^ACTION_DENIED:/u) });
  });
});

describe('CodingWorkflowEngine.installDependencies', () => {
  const registry = 'https://registry.npmjs.org/';
  const entry = (name: string, version: string) => ({
    version, resolved: `${registry}${name}/-/${name}-${version}.tgz`, integrity: `sha512-${createHash('sha512').update(`${name}${version}`).digest('base64')}`
  });
  const lockOf = (packages: Record<string, ReturnType<typeof entry>>) => JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'app' }, ...packages } });
  const lock = lockOf({ 'node_modules/left-pad': entry('left-pad', '1.3.0'), 'node_modules/right-pad': entry('right-pad', '1.0.0') });
  const installPolicy: GlobalExecutionPolicy = {
    ...CODING_GLOBAL_POLICY,
    allowedActionClasses: [...CODING_GLOBAL_POLICY.allowedActionClasses, 'package_install'],
    defaults: { ...CODING_GLOBAL_POLICY.defaults, package_install: { effect: 'allow', delegable: false } },
    scope: { ...CODING_GLOBAL_POLICY.scope, packages: ['npm:left-pad', 'npm:right-pad'], registries: ['registry.npmjs.org'] }
  };

  function withLockfile(context: Awaited<ReturnType<typeof setup>>, content = lock) {
    context.handlers.files_list = () => ({ ok: true, data: { entries: [{ name: 'package-lock.json', type: 'file' }] } });
    context.handlers.files_read = () => ({ ok: true, data: { content, totalBytes: content.length } });
  }

  it('does nothing while the install flag is off or without a lockfile', async () => {
    const run = vi.fn();
    const off = await setup({ install: { enabled: () => false, registry, run } });
    withLockfile(off);
    expect(await off.engine.installDependencies(off.row(), WORKSPACE)).toEqual({ ok: true });
    const none = await setup({ install: { enabled: () => true, registry, run } });
    none.handlers.files_list = () => ({ ok: true, data: { entries: [{ name: 'src', type: 'directory' }] } });
    expect(await none.engine.installDependencies(none.row(), WORKSPACE)).toEqual({ ok: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('denies the install before anything is fetched, naming the refused package on its one receipt', async () => {
    const run = vi.fn();
    const context = await setup({ policy: { ...installPolicy, scope: { ...installPolicy.scope, packages: ['npm:left-pad'] } }, install: { enabled: () => true, registry, run } });
    withLockfile(context);
    const result = await context.engine.installDependencies(context.row(), WORKSPACE);
    expect(result).toMatchObject({ ok: false, retry: false });
    expect((result as { code: string }).code).toMatch(/^ACTION_DENIED:/u);
    expect(run).not.toHaveBeenCalled();
    expect(context.receipts()).toEqual([expect.objectContaining({ step: 'install', actionClass: 'package_install', decision: 'DENY', state: 'REJECTED' })]);
    const record = context.database.prepare('SELECT descriptor_json FROM coding_actions').get() as { descriptor_json: string };
    expect(JSON.parse(record.descriptor_json)).toMatchObject({ package: { name: 'right-pad' } });
  });

  it('refuses a lockfile that fails supply-chain admission', async () => {
    const run = vi.fn();
    const context = await setup({ policy: installPolicy, install: { enabled: () => true, registry, run } });
    withLockfile(context, lock.replaceAll(registry, 'https://evil.example.com/'));
    expect(await context.engine.installDependencies(context.row(), WORKSPACE)).toEqual({ ok: false, code: 'LOCKFILE_REJECTED', retry: false });
    expect(run).not.toHaveBeenCalled();
  });

  it('installs as one action with the package count and list digest, and a replay does not install again', async () => {
    const run = vi.fn(async (_owner: string, _workspace: string, signal: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return { ok: true as const, exitCode: 0 as const };
    });
    const context = await setup({ policy: installPolicy, install: { enabled: () => true, registry, run } });
    withLockfile(context);
    expect(await context.engine.installDependencies(context.row(), WORKSPACE)).toEqual({ ok: true });
    expect(await context.engine.installDependencies(context.row(), WORKSPACE)).toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(1);
    const digest = packagesDigest([
      { name: 'left-pad', version: '1.3.0', registryHost: 'registry.npmjs.org' },
      { name: 'right-pad', version: '1.0.0', registryHost: 'registry.npmjs.org' }
    ]);
    expect(context.receipts()).toEqual([expect.objectContaining({
      step: 'install', actionClass: 'package_install', state: 'APPLIED', outcome: { exitCode: 0, packageCount: 2, packagesDigest: digest }
    })]);
    // The receipt describes the install, not one of its packages.
    const recorded = JSON.parse((context.database.prepare('SELECT descriptor_json FROM coding_actions').get() as { descriptor_json: string }).descriptor_json);
    expect(recorded).toMatchObject({ actionClass: 'package_install', paths: ['package-lock.json'], reason: expect.stringContaining(`2 locked packages from package-lock.json (sha256 ${digest})`) });
    expect(recorded.package).toBeUndefined();

    // A changed lockfile is a different install.
    withLockfile(context, lockOf({ 'node_modules/left-pad': entry('left-pad', '1.3.1') }));
    expect(await context.engine.installDependencies(context.row(), WORKSPACE)).toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(2);
    expect(context.receipts()).toHaveLength(2);
  });

  it('fails closed when the dependency egress attestation fails', async () => {
    const run = vi.fn(async () => { throw Object.assign(new Error('no attestation'), { code: 'DEPENDENCY_EGRESS_UNAVAILABLE' }); });
    const context = await setup({ policy: installPolicy, install: { enabled: () => true, registry, run } });
    withLockfile(context);
    expect(await context.engine.installDependencies(context.row(), WORKSPACE)).toEqual({ ok: false, code: 'DEPENDENCY_EGRESS_UNAVAILABLE', retry: false });
    expect(context.receipts()[0]).toMatchObject({ state: 'REJECTED', outcome: { errorCode: 'DEPENDENCY_EGRESS_UNAVAILABLE', packageCount: 2 } });
  });
});
