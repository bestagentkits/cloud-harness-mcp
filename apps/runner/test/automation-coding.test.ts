import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GlobalExecutionPolicy, RunnerOperation, RunnerPrincipalSelector } from '@cloud-harness/contracts';
import { CodingActionBroker } from '../src/agent-governance/action-broker.js';
import { changedPaths, codingBranch, CodingWorkflowEngine, type CodingInstallPort, type CodingWorkflowRow } from '../src/automation-coding.js';
import type { AutomationOperationResult } from '../src/automation-service.js';
import { CODING_GLOBAL_POLICY, CODING_PROJECT, CODING_REPOSITORY, createPolicyService, insertCodingWorkflow } from './support/coding-policy.js';

const OWNER = 'owner';
const owner: RunnerPrincipalSelector = { kind: 'owner', ownerId: OWNER };
const WORKFLOW = `wfl_${'e'.repeat(32)}`;
const WORKSPACE = `ws_${'w'.repeat(24)}`;
const BASE = 'a'.repeat(40);
const COMMIT = 'c'.repeat(40);
const BRANCH = codingBranch(7, WORKFLOW);

type Call = { operation: RunnerOperation; input: Record<string, unknown> };
type Handler = (input: Record<string, unknown>) => AutomationOperationResult | Promise<AutomationOperationResult>;

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const text = (output: string): AutomationOperationResult => ({ ok: true, data: { output } });

async function setup(options: { policy?: GlobalExecutionPolicy; phase?: string; install?: CodingInstallPort } = {}) {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  const policies = createPolicyService(database, (selector) => (selector.kind === 'owner' ? selector.ownerId : 'external'), owner);
  policies.saveGlobal(options.policy ?? CODING_GLOBAL_POLICY);
  const broker = new CodingActionBroker({
    database, enabled: () => true, policies: policies.service,
    workspaces: { generation: () => 1, repositoryCount: () => 1 }
  });
  const admitted = await broker.admit(OWNER, CODING_PROJECT, { version: 1, actionClass: 'read', repository: CODING_REPOSITORY });
  insertCodingWorkflow(database, {
    id: WORKFLOW, ownerId: OWNER, workspaceId: WORKSPACE, codingPhase: options.phase ?? 'VERIFY', baseOid: BASE,
    policyRevisionJson: JSON.stringify({ globalRevisionId: admitted.policy.globalRevisionId, projectRevisionId: admitted.policy.projectRevisionId })
  });
  const calls: Call[] = [];
  const handlers: Partial<Record<RunnerOperation, Handler>> = {
    exec_run: () => ({ ok: true, data: { exitCode: 0, output: '' } }),
    git_status: () => text('## main\n M src/a.ts\n?? test/a.test.ts\n'),
    git_checkout: () => ({ ok: true, data: {} }),
    git_add: () => ({ ok: true, data: {} }),
    git_commit: () => ({ ok: true, data: { commitSha: COMMIT } }),
    git_push: () => ({ ok: true, data: {} }),
    git_log: () => text(`${COMMIT}\t2026-10-19T00:00:00Z\tbot\tfix`),
    git_diff: () => text('diff --git a/src/a.ts b/src/a.ts\n'),
    files_write: () => ({ ok: true, data: {} }),
    artifacts_snapshot: () => ({ ok: true, data: { artifactId: 'art_1' } }),
    github_read: (input) => (input.action === 'pr_list' ? text('[]') : text(JSON.stringify({ exists: false }))),
    github_action: () => text('https://github.com/acme/widgets/pull/12\n')
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
    ...(options.install ? { install: options.install } : {})
  });
  const row = (): CodingWorkflowRow => database.prepare('SELECT * FROM automation_workflows WHERE id = ?').get(WORKFLOW) as CodingWorkflowRow;
  /** Advances until the workflow leaves RUNNING or stops making progress. */
  const run = async (steps = 6) => {
    for (let index = 0; index < steps && outcome.state === 'RUNNING'; index += 1) await engine.advance(row());
  };
  const count = (operation: RunnerOperation) => calls.filter((call) => call.operation === operation).length;
  const receipts = () => broker.actions.receipts(OWNER, WORKFLOW);
  return { database, broker, engine, handlers, calls, outcome, row, run, count, receipts, policies };
}

describe('coding workflow helpers', () => {
  it('derives the branch from the issue number and workflow id only', async () => {
    expect(BRANCH).toBe('agent/7-eeeeeeee');
    expect(codingBranch(12, `wfl_${'0123456789abcdef'.repeat(2)}`)).toBe('agent/12-01234567');
  });

  it('reads changed paths from short status output, renames included', async () => {
    expect(changedPaths('## main\n M src/a.ts\nR  old.ts -> src/new.ts\n?? "src/with space.ts"\n')).toEqual(['old.ts', 'src/a.ts', 'src/new.ts', 'src/with space.ts']);
  });
});

describe('CodingWorkflowEngine', () => {
  it('verifies, commits, pushes a new agent branch and opens a pull request against the rule base', async () => {
    const context = await setup();
    await context.run();
    expect(context.outcome).toMatchObject({ state: 'COMPLETED', fields: { coding_phase: 'DONE', pr_number: 12 } });
    expect(context.calls.find((call) => call.operation === 'git_commit')?.input).toMatchObject({ expectedHeadOid: BASE, idempotencyKey: `automation:${WORKFLOW}:commit` });
    expect(context.calls.find((call) => call.operation === 'git_push')?.input).toMatchObject({ refspec: `HEAD:refs/heads/${BRANCH}`, expectedAbsent: true });
    const pr = context.calls.find((call) => call.operation === 'github_action')?.input;
    expect(pr).toMatchObject({ action: 'pr_create', head: BRANCH, base: 'main' });
    expect(String(pr?.body)).toContain('Closes #7');
    expect(context.receipts().map((receipt) => [receipt.step, receipt.state])).toEqual([
      ['verify', 'APPLIED'], ['commit', 'APPLIED'], ['commit', 'APPLIED'], ['push', 'APPLIED'], ['open_pr', 'APPLIED']
    ]);
    expect(context.count('git_push')).toBe(1);
  });

  it('keeps the diff as an artifact and commits nothing when verification fails', async () => {
    const context = await setup();
    context.handlers.exec_run = () => ({ ok: true, data: { exitCode: 1 } });
    await context.run();
    expect(context.outcome).toMatchObject({ state: 'FAILED', code: 'CODING_VERIFY_FAILED' });
    expect(context.count('git_commit')).toBe(0);
    expect(context.receipts().find((receipt) => receipt.step === 'diff_artifact')).toMatchObject({ state: 'APPLIED', outcome: { artifactId: 'art_1' } });
  });

  it('retries verification after a transient executor failure', async () => {
    const context = await setup();
    context.handlers.exec_run = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'UNAVAILABLE', retryable: true } })
      .mockResolvedValue({ ok: true, data: { exitCode: 0 } });
    await context.engine.advance(context.row());
    expect(context.row().coding_phase).toBe('VERIFY');
    expect(context.receipts()[0]?.state).toBe('UNKNOWN');
    await context.engine.advance(context.row());
    expect(context.row().coding_phase).toBe('COMMIT');
  });

  it('refuses to commit a path outside the policy or nothing at all', async () => {
    const outside = await setup({ phase: 'COMMIT' });
    outside.handlers.git_status = () => text('## main\n M src/a.ts\n M .github/workflows/ci.yml\n');
    await outside.run();
    expect(outside.outcome.code).toBe('ACTION_DENIED:PATH_OUT_OF_SCOPE');
    expect(outside.count('git_add') + outside.count('git_commit')).toBe(0);

    const empty = await setup({ phase: 'COMMIT' });
    empty.handlers.git_status = () => text('## main\n');
    await empty.run();
    expect(empty.outcome.code).toBe('CODING_NO_CHANGES');

    const lockfile = await setup({ phase: 'COMMIT' });
    lockfile.handlers.git_status = () => text('## main\n M src/a.ts\n M package-lock.json\n');
    await lockfile.run();
    expect(lockfile.outcome.code).toMatch(/^ACTION_DENIED:/u);
    expect(lockfile.receipts().at(-1)).toMatchObject({ actionClass: 'package_install', state: 'REJECTED' });
  });

  it('recognises its own earlier commit when the commit answer was lost', async () => {
    const context = await setup({ phase: 'COMMIT' });
    context.handlers.git_commit = () => ({ ok: false, error: { code: 'STALE_HEAD' } });
    await context.engine.advance(context.row());
    expect(context.row()).toMatchObject({ coding_phase: 'PUSH', commit_sha: COMMIT });
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
    expect(taken.outcome.code).toBe('CODING_PUBLISH_FAILED');
    expect(taken.receipts().find((receipt) => receipt.step === 'push')?.outcome.errorCode).toBe('BRANCH_EXISTS');

    const absent = await setup({ phase: 'COMMIT' });
    await absent.engine.advance(absent.row());
    absent.handlers.git_push = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'GITHUB_RATE_LIMITED', retryable: true } })
      .mockResolvedValue({ ok: true, data: {} });
    await absent.engine.advance(absent.row());
    expect(absent.row().coding_phase).toBe('PUSH');
    await absent.engine.advance(absent.row());
    expect(absent.row().coding_phase).toBe('PR');
  });

  it('adopts an existing pull request for the branch instead of opening a second one', async () => {
    const context = await setup({ phase: 'COMMIT' });
    await context.engine.advance(context.row());
    await context.engine.advance(context.row());
    context.handlers.github_read = () => text(JSON.stringify([{ number: 9, headRefName: BRANCH, url: 'https://github.com/acme/widgets/pull/9' }]));
    await context.engine.advance(context.row());
    expect(context.outcome.fields).toMatchObject({ pr_number: 9 });
    expect(context.count('github_action')).toBe(0);
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

  it('fails closed when publishing needs approval, with no effect', async () => {
    const context = await setup({ phase: 'COMMIT', policy: { ...CODING_GLOBAL_POLICY, defaults: { ...CODING_GLOBAL_POLICY.defaults, publish_branch: { effect: 'require_approval', delegable: false } } } });
    await context.run();
    expect(context.outcome.code).toMatch(/^ACTION_REQUIRES_APPROVAL:/u);
    expect(context.count('git_push')).toBe(0);
  });
});

describe('CodingWorkflowEngine.installDependencies', () => {
  const registry = 'https://registry.npmjs.org/';
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'app' },
      'node_modules/left-pad': {
        version: '1.3.0', resolved: `${registry}left-pad/-/left-pad-1.3.0.tgz`, integrity: `sha512-${createHash('sha512').update('x').digest('base64')}`
      }
    }
  });
  const installPolicy: GlobalExecutionPolicy = {
    ...CODING_GLOBAL_POLICY,
    allowedActionClasses: [...CODING_GLOBAL_POLICY.allowedActionClasses, 'package_install'],
    defaults: { ...CODING_GLOBAL_POLICY.defaults, package_install: { effect: 'allow', delegable: false } },
    scope: { ...CODING_GLOBAL_POLICY.scope, packages: ['npm:left-pad'], registries: ['registry.npmjs.org'] }
  };

  function withLockfile(context: Awaited<ReturnType<typeof setup>>) {
    context.handlers.files_list = () => ({ ok: true, data: { entries: [{ name: 'package-lock.json', type: 'file' }] } });
    context.handlers.files_read = () => ({ ok: true, data: { content: lock, totalBytes: lock.length } });
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

  it('denies every package by default before anything is fetched', async () => {
    const run = vi.fn();
    const context = await setup({ install: { enabled: () => true, registry, run } });
    withLockfile(context);
    const result = await context.engine.installDependencies(context.row(), WORKSPACE);
    expect(result).toMatchObject({ ok: false, retry: false });
    expect((result as { code: string }).code).toMatch(/^ACTION_DENIED:/u);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a lockfile that fails supply-chain admission', async () => {
    const run = vi.fn();
    const context = await setup({ policy: installPolicy, install: { enabled: () => true, registry, run } });
    withLockfile(context);
    context.handlers.files_read = () => ({ ok: true, data: { content: lock.replace(registry, 'https://evil.example.com/'), totalBytes: lock.length } });
    expect(await context.engine.installDependencies(context.row(), WORKSPACE)).toEqual({ ok: false, code: 'LOCKFILE_REJECTED', retry: false });
    expect(run).not.toHaveBeenCalled();
  });

  it('installs once when the policy allows every locked package, and a replay does not install again', async () => {
    const run = vi.fn(async () => ({ ok: true as const, exitCode: 0 as const }));
    const context = await setup({ policy: installPolicy, install: { enabled: () => true, registry, run } });
    withLockfile(context);
    expect(await context.engine.installDependencies(context.row(), WORKSPACE)).toEqual({ ok: true });
    expect(await context.engine.installDependencies(context.row(), WORKSPACE)).toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(context.receipts()).toEqual([expect.objectContaining({ step: 'install', actionClass: 'package_install', state: 'APPLIED' })]);
  });

  it('fails closed when the dependency egress attestation fails', async () => {
    const run = vi.fn(async () => { throw Object.assign(new Error('no attestation'), { code: 'DEPENDENCY_EGRESS_UNAVAILABLE' }); });
    const context = await setup({ policy: installPolicy, install: { enabled: () => true, registry, run } });
    withLockfile(context);
    expect(await context.engine.installDependencies(context.row(), WORKSPACE)).toEqual({ ok: false, code: 'DEPENDENCY_EGRESS_UNAVAILABLE', retry: false });
    expect(context.receipts()[0]).toMatchObject({ state: 'REJECTED', outcome: { errorCode: 'DEPENDENCY_EGRESS_UNAVAILABLE' } });
  });
});
