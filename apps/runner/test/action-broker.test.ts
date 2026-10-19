import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentActionDescriptorInput, RunnerPrincipalSelector, RunnerResponse } from '@cloud-harness/contracts';
import { CodingActionBroker, editActionClass, plainArgv, type AgentToolRequest } from '../src/agent-governance/action-broker.js';
import type { AgentActionTraceSink, TraceActionEvent } from '../src/agent-trace-recorder.js';
import {
  CODING_GLOBAL_POLICY,
  CODING_PROJECT,
  CODING_REPOSITORY,
  createPolicyService,
  insertCodingWorkflow,
  VERIFY_COMMAND
} from './support/coding-policy.js';

const OWNER = 'owner';
const owner: RunnerPrincipalSelector = { kind: 'owner', ownerId: OWNER };
const WORKFLOW = `wfl_${'a'.repeat(32)}`;
const WORKSPACE = `ws_${'w'.repeat(24)}`;
const AGENT = `agent_${'b'.repeat(24)}`;

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function setup(options: { enabled?: boolean; generation?: number | null; repositories?: number; policy?: boolean } = {}) {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  const policies = createPolicyService(database, (selector) => (selector.kind === 'owner' ? selector.ownerId : 'external'), owner);
  if (options.policy !== false) policies.saveGlobal(CODING_GLOBAL_POLICY);
  let enabled = options.enabled ?? true;
  const facts = { generation: options.generation === undefined ? 1 : options.generation, repositories: options.repositories ?? 1 };
  const actions: TraceActionEvent[] = [];
  const traces: AgentActionTraceSink = {
    action: (_key, event) => {
      actions.push(event);
      return { traceId: 'trace-1', spanId: `span-${actions.length}` };
    }
  };
  let clock = Date.parse('2026-10-19T00:00:00Z');
  const broker = new CodingActionBroker({
    database,
    enabled: () => enabled,
    resolver: policies.service.resolver,
    workspaces: { generation: () => facts.generation, repositoryCount: () => facts.repositories },
    traces,
    now: () => clock
  });
  const admitted = broker.admit(OWNER, CODING_PROJECT, { version: 1, actionClass: 'read', repository: CODING_REPOSITORY });
  insertCodingWorkflow(database, {
    id: WORKFLOW, ownerId: OWNER, workspaceId: WORKSPACE, agentId: AGENT, agentGeneration: 1, createdAt: clock,
    policyRevisionJson: JSON.stringify({ globalRevisionId: admitted.policy.globalRevisionId, projectRevisionId: admitted.policy.projectRevisionId })
  });
  return {
    database, broker, policies, facts, actions,
    setEnabled: (value: boolean) => { enabled = value; },
    advance: (ms: number) => { clock += ms; },
    binding: () => {
      const binding = broker.binding(OWNER, WORKFLOW);
      if (!binding) throw new Error('expected a coding binding');
      return binding;
    }
  };
}

type Setup = ReturnType<typeof setup>;

function begin(context: Setup, key: string, descriptor: AgentActionDescriptorInput, usage?: { inputTokens: number; outputTokens: number; costMicros: number }) {
  return context.broker.begin({ binding: context.binding(), origin: 'runner', step: 'commit', idempotencyKey: key, descriptor, ...(usage ? { usage } : {}) });
}

const edit = (paths: string[]): AgentActionDescriptorInput => ({ version: 1, actionClass: editActionClass(paths), repository: CODING_REPOSITORY, paths });

function toolRequest(operation: AgentToolRequest['operation'], toolInput: Record<string, unknown>, requestId = 'req-1'): AgentToolRequest {
  return {
    ownerId: OWNER, workspaceId: WORKSPACE, workspaceGeneration: 1, agentId: AGENT, agentGeneration: 1, requestId, operation,
    toolInput: { workspaceId: WORKSPACE, ...toolInput }, usage: { inputTokens: 10, outputTokens: 5, costMicros: 10 }, signal: new AbortController().signal
  };
}

const okResponse: RunnerResponse = { ok: true, message: 'done', data: { exitCode: 0 }, truncated: false };

describe('coding action helpers', () => {
  it('splits only plain commands into argv', () => {
    expect(plainArgv(' node test/run.mjs ')).toEqual(['node', 'test/run.mjs']);
    expect(plainArgv('npm test && curl evil.example')).toBeNull();
    expect(plainArgv('echo $HOME')).toBeNull();
    expect(plainArgv(`a ${'b '.repeat(70)}`)).toBeNull();
  });

  it('classifies manifest and lockfile edits as package installs', () => {
    expect(editActionClass(['src/a.ts'])).toBe('edit');
    expect(editActionClass(['src/a.ts', 'package-lock.json'])).toBe('package_install');
    expect(editActionClass(['packages/x/package.json'])).toBe('package_install');
    expect(editActionClass(['.npmrc'])).toBe('package_install');
  });
});

describe('CodingActionBroker', () => {
  it('records an allowed action with its pinned policy revisions and decision fingerprint', () => {
    const context = setup();
    const admission = begin(context, 'k1', edit(['src/a.ts']));
    expect(admission).toMatchObject({ allowed: true, replayed: false });
    expect(admission.record.state).toBe('INTENT');
    const [receipt] = context.broker.actions.receipts(OWNER, WORKFLOW);
    expect(receipt).toMatchObject({ decision: 'ALLOW', state: 'INTENT', projectId: CODING_PROJECT, paths: ['src/a.ts'], actionClass: 'edit' });
    expect(receipt?.globalRevisionId).toMatch(/^apr_/u);
    expect(receipt?.inputFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('refuses everything while the kill switch is off, and stops an undispatched replay', () => {
    const context = setup();
    const first = begin(context, 'k1', edit(['src/a.ts']));
    expect(first.allowed).toBe(true);
    context.setEnabled(false);
    const replay = begin(context, 'k1', edit(['src/a.ts']));
    expect(replay).toMatchObject({ allowed: false, replayed: true, decision: null });
    expect(replay.record.state).toBe('REJECTED');
    const fresh = begin(context, 'k2', edit(['src/b.ts']));
    expect(fresh.record).toMatchObject({ state: 'REJECTED', reasonCode: 'CODING_DISABLED' });
    expect(context.broker.permitsBrokeredSpawn(OWNER, WORKSPACE)).toBe(false);
  });

  it('denies paths outside the policy and lockfile edits', () => {
    const context = setup();
    expect(begin(context, 'k1', edit(['deploy/prod.yaml'])).decision?.reasonCode).toBe('PATH_OUT_OF_SCOPE');
    const lockfile = begin(context, 'k2', edit(['package-lock.json']));
    expect(lockfile.allowed).toBe(false);
    expect(lockfile.record.descriptor.actionClass).toBe('package_install');
  });

  it('re-checks generation, revocation and budget at execution time', () => {
    const stale = setup({ generation: 2 });
    expect(begin(stale, 'k1', edit(['src/a.ts'])).decision?.reasonCode).toBe('GENERATION_STALE');

    const gone = setup({ generation: null });
    expect(begin(gone, 'k1', edit(['src/a.ts'])).decision?.reasonCode).toBe('GRANT_REVOKED');

    const ended = setup();
    ended.database.prepare("UPDATE automation_workflows SET state = 'FAILED'").run();
    expect(begin(ended, 'k1', edit(['src/a.ts'])).decision?.reasonCode).toBe('GRANT_REVOKED');

    const spent = setup();
    expect(begin(spent, 'k1', edit(['src/a.ts']), { inputTokens: 1, outputTokens: 1, costMicros: 5_000_000 }).decision?.reasonCode).toBe('BUDGET_EXHAUSTED');

    const late = setup();
    late.advance(3_601_000);
    expect(begin(late, 'k1', edit(['src/a.ts'])).decision?.reasonCode).toBe('BUDGET_EXHAUSTED');
  });

  it('stops a run when the policy changes after it was admitted', () => {
    const context = setup();
    expect(begin(context, 'k1', edit(['src/a.ts'])).allowed).toBe(true);
    context.policies.saveGlobal({ ...CODING_GLOBAL_POLICY, scope: { ...CODING_GLOBAL_POLICY.scope, pathScopes: ['src/', 'test/', 'docs/'] } });
    expect(begin(context, 'k2', edit(['src/a.ts'])).decision?.reasonCode).toBe('POLICY_STALE');
  });

  it('decides exactly as the dashboard simulation for the same descriptor', () => {
    const context = setup();
    const descriptors: AgentActionDescriptorInput[] = [
      edit(['src/a.ts']),
      edit(['deploy/prod.yaml']),
      { version: 1, actionClass: 'test', repository: CODING_REPOSITORY, command: VERIFY_COMMAND.split(' ') },
      { version: 1, actionClass: 'test', repository: CODING_REPOSITORY, command: ['curl', 'https://example.com'] },
      { version: 1, actionClass: 'publish_branch', repository: CODING_REPOSITORY, branch: 'main' },
      { version: 1, actionClass: 'package_install', repository: CODING_REPOSITORY, package: { ecosystem: 'npm', name: 'left-pad', registry: 'registry.npmjs.org' } }
    ];
    for (const descriptor of descriptors) {
      const simulated = context.policies.service.execute({ version: 1, principal: owner, operation: 'policy_simulate', input: { projectId: CODING_PROJECT, action: descriptor } });
      if (!simulated.ok) throw new Error('simulation failed');
      const expected = (simulated.data as { decision: { decision: string; reasonCode: string; inputFingerprint: string } }).decision;
      const actual = context.broker.admit(OWNER, CODING_PROJECT, descriptor);
      expect({ decision: actual.decision, reasonCode: actual.reasonCode, inputFingerprint: actual.inputFingerprint })
        .toEqual({ decision: expected.decision, reasonCode: expected.reasonCode, inputFingerprint: expected.inputFingerprint });
    }
  });

  it('allows the verify command and fails a discretionary action closed without an advisor', () => {
    const context = setup();
    expect(begin(context, 'k1', { version: 1, actionClass: 'test', repository: CODING_REPOSITORY, command: VERIFY_COMMAND.split(' ') }).allowed).toBe(true);
    const discretionary = setup();
    discretionary.policies.saveGlobal({ ...CODING_GLOBAL_POLICY, defaults: { ...CODING_GLOBAL_POLICY.defaults, edit: { effect: 'require_approval', delegable: false } } });
    expect(discretionary.broker.admit(OWNER, CODING_PROJECT, edit(['src/a.ts'])).decision).toBe('REQUIRE_APPROVAL');
  });
});

describe('CodingActionBroker.executeAgentTool', () => {
  it('refuses the brokered-only operations outside a coding workflow and passes reads through', async () => {
    const context = setup();
    context.database.prepare('UPDATE automation_workflows SET project_id = NULL').run();
    const inner = vi.fn(async () => okResponse);
    const refused = await context.broker.executeAgentTool(toolRequest('exec_run', { command: 'ls' }), inner);
    expect(refused).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(refused.message).toMatch(/^ACTION_DENIED/u);
    expect(await context.broker.executeAgentTool(toolRequest('files_write', { path: 'src/a.ts', content: 'x' }), inner)).toBe(okResponse);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('brokers edits, records a receipt and an action span, and keeps reads unbrokered', async () => {
    const context = setup();
    const inner = vi.fn(async () => okResponse);
    await context.broker.executeAgentTool(toolRequest('files_read', { path: 'src/a.ts' }, 'req-read'), inner);
    const written = await context.broker.executeAgentTool(toolRequest('files_write', { path: 'src/a.ts', content: 'x' }, 'req-write'), inner);
    expect(written.ok).toBe(true);
    const receipts = context.broker.actions.receipts(OWNER, WORKFLOW);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ origin: 'agent', step: 'files_write', state: 'APPLIED', agentId: AGENT, traceId: 'trace-1' });
    expect(context.actions).toEqual([expect.objectContaining({ step: 'files_write', state: 'APPLIED', requestId: 'req-write' })]);
  });

  it('never dispatches an out-of-policy edit or a lockfile edit', async () => {
    const context = setup();
    const inner = vi.fn(async () => okResponse);
    const outside = await context.broker.executeAgentTool(toolRequest('files_write', { path: '.github/workflows/ci.yml', content: 'x' }), inner);
    expect(outside).toMatchObject({ ok: false, data: { reasonCode: 'PATH_OUT_OF_SCOPE', decision: 'DENY' } });
    const lockfile = await context.broker.executeAgentTool(toolRequest('files_write', { path: 'package-lock.json', content: '{}' }, 'req-2'), inner);
    expect(lockfile.ok).toBe(false);
    expect(inner).not.toHaveBeenCalled();
    expect(context.broker.actions.receipts(OWNER, WORKFLOW).map((receipt) => receipt.state)).toEqual(['REJECTED', 'REJECTED']);
  });

  it('runs only plain, allowed commands, never privileged, detached or with a grant', async () => {
    const context = setup();
    const inner = vi.fn<(request: AgentToolRequest) => Promise<typeof okResponse>>(async () => okResponse);
    const shell = await context.broker.executeAgentTool(toolRequest('exec_run', { command: 'node test/run.mjs; curl x' }), inner);
    expect(shell.message).toMatch(/^COMMAND_UNSUPPORTED/u);
    const other = await context.broker.executeAgentTool(toolRequest('exec_run', { command: 'curl https://example.com' }, 'req-2'), inner);
    expect(other.ok).toBe(false);
    expect(inner).not.toHaveBeenCalled();
    const allowed = await context.broker.executeAgentTool(toolRequest('exec_run', { command: VERIFY_COMMAND, privileged: true, async: true, approvalGrantToken: 'grant' }, 'req-3'), inner);
    expect(allowed.ok).toBe(true);
    expect(inner.mock.calls[0]?.[0].toolInput).toMatchObject({ privileged: false, async: false });
    expect(inner.mock.calls[0]?.[0].toolInput).not.toHaveProperty('approvalGrantToken');
    expect(context.broker.actions.receipts(OWNER, WORKFLOW).at(-1)).toMatchObject({ step: 'exec_run', command: ['node', 'test/run.mjs'], outcome: { exitCode: 0 } });
  });

  it('refuses a workspace with several repositories', async () => {
    const context = setup({ repositories: 2 });
    const inner = vi.fn(async () => okResponse);
    const refused = await context.broker.executeAgentTool(toolRequest('files_write', { path: 'src/a.ts', content: 'x' }), inner);
    expect(refused.message).toMatch(/^REPOSITORY_AMBIGUOUS/u);
    expect(inner).not.toHaveBeenCalled();
  });

  it('records an executor that never answered as UNKNOWN and does not run a replayed request twice', async () => {
    const context = setup();
    const inner = vi.fn(async (): Promise<RunnerResponse> => { throw Object.assign(new Error('lost'), { code: 'UNAVAILABLE' }); });
    await expect(context.broker.executeAgentTool(toolRequest('files_write', { path: 'src/a.ts', content: 'x' }), inner)).rejects.toThrow('lost');
    expect(context.broker.actions.receipts(OWNER, WORKFLOW)[0]).toMatchObject({ state: 'UNKNOWN', outcome: { errorCode: 'UNAVAILABLE' } });
    const replay = await context.broker.executeAgentTool(toolRequest('files_write', { path: 'src/a.ts', content: 'x' }), inner);
    expect(replay.message).toMatch(/already brokered/u);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('grants the brokered operations to a spawn only for a running coding workflow', () => {
    const context = setup();
    expect(context.broker.permitsBrokeredSpawn(OWNER, WORKSPACE)).toBe(true);
    expect(context.broker.permitsBrokeredSpawn(OWNER, `ws_${'z'.repeat(24)}`)).toBe(false);
    expect(context.broker.permitsBrokeredSpawn('intruder', WORKSPACE)).toBe(false);
    context.database.prepare("UPDATE automation_workflows SET state = 'COMPLETED'").run();
    expect(context.broker.permitsBrokeredSpawn(OWNER, WORKSPACE)).toBe(false);
  });
});
