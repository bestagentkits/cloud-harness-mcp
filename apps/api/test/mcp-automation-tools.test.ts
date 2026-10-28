import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type AuthInfo, type McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTOMATION_TOOL_SPECS,
  WORKSPACE_EXPLORER_TOOL_SPEC,
  TOOL_SPECS,
  ToolResultSchema,
  type AutomationRuleSummary,
  type AutomationWorkflowSummary,
  type AutomationsRunnerRequest,
  type AutomationsRunnerResponse,
  type RunnerPrincipalSelector
} from '@cloud-harness/contracts';
import { createCloudHarnessServer, createCloudHarnessServerFactory, createWorkspaceBoundServerFactory, bindWorkspace } from '../src/mcp-server.js';
import type { RunnerClient } from '../src/runner-client.js';

const RULE_ID = `arl_${'a'.repeat(32)}`;
const CONNECTION_ID = `whc_${'b'.repeat(32)}`;
const RUN_ID = `wfl_${'c'.repeat(32)}`;
const SECRET = 'whsec-connection-secret-must-never-leave';
const READ = 'workspace:read';
const WRITE = 'workspace:write';
const ALL_SCOPES = [READ, WRITE, 'workspace:execute'];
const owner: RunnerPrincipalSelector = { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject: 'owner-subject' };

const match = { repository: 'acme/widgets', events: ['issues'], label: 'claude' };
const action = { profileId: 'reviewer', instructions: 'Summarize the issue.' };

function rule(overrides: Partial<AutomationRuleSummary> = {}): AutomationRuleSummary {
  return {
    id: RULE_ID, connectionId: CONNECTION_ID, name: 'Triage', enabled: false, generation: 1,
    match: { repository: 'acme/widgets', events: ['issues'], label: 'claude', ignoreBots: true },
    action: {
      profileId: 'reviewer', instructions: 'Summarize the issue.', proxyOperations: ['files_read'],
      budget: { ttlSeconds: 900, maxInputTokens: 200_000, maxOutputTokens: 32_000, maxCostMicros: 2_000_000 },
      publishComment: false, cooldownSeconds: 300, maxConcurrent: 1
    },
    createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z',
    ...overrides
  };
}

function run(id = RUN_ID, state: AutomationWorkflowSummary['state'] = 'RUNNING'): AutomationWorkflowSummary {
  return {
    id, ruleId: RULE_ID, ruleGeneration: 1, connectionId: CONNECTION_ID, deliveryId: `dlv_${'d'.repeat(32)}`,
    eventType: 'github.issue.label_added', provider: 'github', repository: 'acme/widgets', resourceNumber: 12, resourceRef: '#12',
    resourceUrl: 'https://github.com/acme/widgets/issues/12', label: 'claude', state, workspaceId: null, agentId: null,
    agentStatus: null, errorCode: null, publishState: 'NONE', usage: null,
    createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z', terminalAt: null
  };
}

type Responder = (request: AutomationsRunnerRequest) => AutomationsRunnerResponse;

function defaultResponder(request: AutomationsRunnerRequest): AutomationsRunnerResponse {
  switch (request.operation) {
    case 'rules_list': return { ok: true, data: { rules: [rule()] } };
    case 'rule_create': return { ok: true, data: { rule: rule({ enabled: (request.input as { enabled: boolean }).enabled }) } };
    case 'rule_update': return { ok: true, data: { rule: rule({ enabled: false, generation: 2 }) } };
    case 'workflows_list': return { ok: true, data: { workflows: [run()] } };
    case 'workflow_get': return { ok: true, data: { workflow: run(), result: null, transitions: [{ fromState: null, toState: 'QUEUED', actor: 'system', code: null, at: '2026-10-19T00:00:00.000Z' }] } };
    case 'workflow_cancel': return { ok: true, data: { workflow: run(RUN_ID, 'CANCELLED') } };
    default: return { ok: false, error: { code: 'INTERNAL', message: 'unexpected operation' } };
  }
}

function fakeRunner(responder: Responder = defaultResponder) {
  const requests: AutomationsRunnerRequest[] = [];
  const client = {
    async call() { return { ok: true, message: 'ok', data: {}, truncated: false }; },
    async callAutomations(request: AutomationsRunnerRequest) {
      requests.push(request);
      return responder(request);
    }
  } as unknown as RunnerClient;
  return { client, requests };
}

const authInfo = (scopes: string[], principal: RunnerPrincipalSelector | null = owner): AuthInfo =>
  ({ token: 'opaque', clientId: 'client', scopes, extra: principal ? { principal } : {} });

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'automation-tools-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

async function connectRemote(runner: RunnerClient, options: { scopes?: string[]; enabled?: boolean; principal?: RunnerPrincipalSelector | null } = {}) {
  const principal = options.principal === undefined ? owner : options.principal;
  const factory = createCloudHarnessServerFactory(runner, undefined, { enabled: options.enabled ?? true });
  return await connect(factory({ era: 'modern', authInfo: authInfo(options.scopes ?? ALL_SCOPES, principal) }));
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = JSON.stringify(result);
  return { isError: result.isError === true, envelope: result.structuredContent ? ToolResultSchema.parse(result.structuredContent) : undefined, text };
}

/** Input the tool schema refuses never reaches the runner, whether the SDK answers with an error result or throws. */
async function rejected(client: Client, name: string, args: Record<string, unknown>): Promise<boolean> {
  try {
    return (await client.callTool({ name, arguments: args })).isError === true;
  } catch {
    return true;
  }
}

describe('automation management tools over MCP', () => {
  it('lists the automation tools with their annotations next to the workspace tools', async () => {
    const { client: runner } = fakeRunner();
    const client = await connectRemote(runner);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_SPECS, ...AUTOMATION_TOOL_SPECS, WORKSPACE_EXPLORER_TOOL_SPEC].map((spec) => spec.name));
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get('automation_rules_list')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get('automation_rule_disable')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get('automation_run_cancel')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get('automation_rule_create')?.description).toContain('DISABLED');
    for (const spec of AUTOMATION_TOOL_SPECS) {
      const schema = JSON.stringify(byName.get(spec.name)?.inputSchema);
      expect(schema, spec.name).not.toMatch(/"(?:principal|ownerId|owner|enabled|secret)"/u);
    }
    expect(tools.map((tool) => tool.name)).not.toContain('automation_rule_enable');
  });

  it('serves the same tools on the workspace-bound endpoint', async () => {
    const { client: runner, requests } = fakeRunner();
    const factory = createWorkspaceBoundServerFactory(runner, undefined, { enabled: true });
    const client = await connect(factory({ era: 'modern', authInfo: bindWorkspace(authInfo(ALL_SCOPES), `ws_${'a'.repeat(24)}`) }));
    expect((await call(client, 'automation_rules_list', {})).envelope?.ok).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it('is absent from backends without the automations channel, such as the local stdio backend', async () => {
    const client = await connect(createCloudHarnessServer({ call: async () => ({ ok: true, message: 'ok', data: {}, truncated: false }) }));
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.filter((name) => name.startsWith('automation_'))).toEqual([]);
  });

  it('runs each tool once against the matching channel operation for the session principal', async () => {
    const { client: runner, requests } = fakeRunner();
    const client = await connectRemote(runner);

    const listed = await call(client, 'automation_rules_list', { connectionId: CONNECTION_ID });
    expect(listed.envelope).toMatchObject({ ok: true, truncated: false, data: { rules: [{ id: RULE_ID, generation: 1 }] } });
    const created = await call(client, 'automation_rule_create', { connectionId: CONNECTION_ID, name: 'Triage', match, action });
    expect(created.envelope).toMatchObject({ ok: true, data: { rule: { id: RULE_ID, enabled: false } } });
    const disabled = await call(client, 'automation_rule_disable', { ruleId: RULE_ID, expectedGeneration: 1 });
    expect(disabled.envelope).toMatchObject({ ok: true, data: { rule: { enabled: false, generation: 2 } } });
    const runs = await call(client, 'automation_runs_list', { ruleId: RULE_ID, state: 'RUNNING', limit: 5 });
    expect(runs.envelope).toMatchObject({ ok: true, truncated: false, data: { runs: [{ id: RUN_ID }] } });
    const got = await call(client, 'automation_run_get', { runId: RUN_ID });
    expect(got.envelope).toMatchObject({ ok: true, data: { run: { id: RUN_ID }, result: null, transitions: [{ toState: 'QUEUED' }] } });
    const cancelled = await call(client, 'automation_run_cancel', { runId: RUN_ID, reason: 'not needed' });
    expect(cancelled.envelope).toMatchObject({ ok: true, data: { run: { id: RUN_ID, state: 'CANCELLED' } } });

    expect(requests.map((request) => [request.operation, request.input])).toEqual([
      ['rules_list', { connectionId: CONNECTION_ID }],
      ['rule_create', expect.objectContaining({ connectionId: CONNECTION_ID, name: 'Triage', enabled: false })],
      ['rule_update', { id: RULE_ID, expectedGeneration: 1, enabled: false }],
      ['workflows_list', { ruleId: RULE_ID, state: 'RUNNING', limit: 6 }],
      ['workflow_get', { id: RUN_ID }],
      ['workflow_cancel', { id: RUN_ID, reason: 'not needed' }]
    ]);
    for (const request of requests) expect(request).toMatchObject({ version: 1, principal: owner });
  });

  it('always creates rules disabled and refuses inputs that try to enable them or name a principal', async () => {
    const { client: runner, requests } = fakeRunner();
    const client = await connectRemote(runner);
    const base = { connectionId: CONNECTION_ID, name: 'Triage', match, action };

    expect(await rejected(client, 'automation_rule_create', { ...base, enabled: true })).toBe(true);
    expect(await rejected(client, 'automation_rule_create', { ...base, principal: { kind: 'owner', ownerId: 'someone-else' } })).toBe(true);
    expect(await rejected(client, 'automation_rules_list', { ownerId: 'someone-else' })).toBe(true);
    expect(await rejected(client, 'automation_rule_disable', { ruleId: RULE_ID, expectedGeneration: 1, enabled: true })).toBe(true);
    expect(requests).toEqual([]);

    await call(client, 'automation_rule_create', base);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ operation: 'rule_create', principal: owner, input: { enabled: false } });
  });

  it('checks the session scope per tool before reaching the runner', async () => {
    const { client: runner, requests } = fakeRunner();
    const readOnly = await connectRemote(runner, { scopes: [READ] });
    expect((await call(readOnly, 'automation_rules_list', {})).envelope?.ok).toBe(true);
    expect((await call(readOnly, 'automation_runs_list', {})).envelope?.ok).toBe(true);
    expect((await call(readOnly, 'automation_run_get', { runId: RUN_ID })).envelope?.ok).toBe(true);
    for (const [name, args] of [
      ['automation_rule_create', { connectionId: CONNECTION_ID, name: 'Triage', match, action }],
      ['automation_rule_disable', { ruleId: RULE_ID, expectedGeneration: 1 }],
      ['automation_run_cancel', { runId: RUN_ID }]
    ] as const) {
      const denied = await call(readOnly, name, args);
      expect(denied.isError, name).toBe(true);
      expect(denied.envelope?.error, name).toMatchObject({ code: 'FORBIDDEN', retryable: false });
      expect(denied.envelope?.error?.message, name).toContain(WRITE);
    }
    expect(requests.map((request) => request.operation)).toEqual(['rules_list', 'workflows_list', 'workflow_get']);

    const none = await connectRemote(runner, { scopes: [] });
    expect((await call(none, 'automation_rules_list', {})).envelope?.error).toMatchObject({ code: 'FORBIDDEN' });
    expect(requests).toHaveLength(3);
  });

  it('answers AUTHENTICATION_FAILED without a session principal', async () => {
    const { client: runner, requests } = fakeRunner();
    const client = await connectRemote(runner, { principal: null });
    expect((await call(client, 'automation_rules_list', {})).envelope?.error).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(requests).toEqual([]);
  });

  it('returns the canonical disabled error when automations are off on the API or the runner', async () => {
    const off = fakeRunner();
    const apiOff = await connectRemote(off.client, { enabled: false });
    const result = await call(apiOff, 'automation_rules_list', {});
    expect(result.envelope).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE', message: 'Automations are disabled on this instance', retryable: false } });
    expect(off.requests).toEqual([]);

    const runnerOff = await connectRemote(fakeRunner(() => ({ ok: false, error: { code: 'UNAVAILABLE', message: 'automations are disabled on this instance' } })).client);
    expect((await call(runnerOff, 'automation_runs_list', {})).envelope?.error)
      .toMatchObject({ code: 'UNAVAILABLE', message: 'Automations are disabled on this instance', retryable: false });
  });

  it('passes the runner fencing and generation errors through', async () => {
    const { client: runner } = fakeRunner((request) => request.operation === 'rule_update'
      ? { ok: false, error: { code: 'CONFLICT', message: 'rule changed; reload and retry' } }
      : { ok: false, error: { code: 'NOT_FOUND', message: 'workflow not found' } });
    const client = await connectRemote(runner);
    expect((await call(client, 'automation_run_cancel', { runId: RUN_ID })).envelope?.error).toMatchObject({ code: 'NOT_FOUND', message: 'workflow not found' });
    const conflict = await call(client, 'automation_rule_disable', { ruleId: RULE_ID, expectedGeneration: 3 });
    expect(conflict.envelope?.error).toMatchObject({ code: 'CONFLICT', retryable: false });
    expect(conflict.envelope?.error?.message).toContain('automation_rules_list');

    const unavailable = await connectRemote(fakeRunner(() => ({ ok: false, error: { code: 'INTERNAL', message: 'sqlite detail' } })).client);
    const internal = await call(unavailable, 'automation_rules_list', {});
    expect(internal.envelope?.error).toMatchObject({ code: 'INTERNAL_ERROR', retryable: true });
    expect(internal.text).not.toContain('sqlite detail');
  });

  it('never returns fields outside the rule and run summaries, such as a connection secret', async () => {
    const { client: runner } = fakeRunner((request) => request.operation === 'rules_list'
      ? { ok: true, data: { rules: [{ ...rule(), secret: SECRET }] } }
      : { ok: true, data: { workflow: run(), result: null, transitions: [], connection: { secret: SECRET } } });
    const client = await connectRemote(runner);
    for (const [name, args] of [['automation_rules_list', {}], ['automation_run_get', { runId: RUN_ID }]] as const) {
      const result = await call(client, name, args);
      expect(result.envelope?.error, name).toMatchObject({ code: 'UNAVAILABLE' });
      expect(result.text, name).not.toContain(SECRET);
    }
  });

  it('bounds list results and marks them truncated', async () => {
    const runs = Array.from({ length: 4 }, (_, index) => run(`wfl_${String(index).repeat(32)}`));
    const rules = Array.from({ length: 3 }, (_, index) => rule({ id: `arl_${String(index).repeat(32)}` }));
    const { client: runner, requests } = fakeRunner((request) => request.operation === 'rules_list'
      ? { ok: true, data: { rules } }
      : { ok: true, data: { workflows: runs.slice(0, (request.input as { limit: number }).limit) } });
    const client = await connectRemote(runner);

    const listedRuns = await call(client, 'automation_runs_list', { limit: 2 });
    expect(requests[0]?.input).toEqual({ limit: 3 });
    expect(listedRuns.envelope).toMatchObject({ ok: true, truncated: true });
    expect((listedRuns.envelope?.data as { runs: unknown[] }).runs).toHaveLength(2);
    expect((await call(client, 'automation_runs_list', { limit: 4 })).envelope?.truncated).toBe(false);

    const listedRules = await call(client, 'automation_rules_list', { limit: 1 });
    expect(listedRules.envelope).toMatchObject({ ok: true, truncated: true, data: { rules: [{ id: rules[0]!.id }] } });
    expect(await rejected(client, 'automation_runs_list', { limit: 101 })).toBe(true);
  });

  it('drops trailing items past the serialized size bound', async () => {
    const instructions = 'x'.repeat(15_000);
    const rules = Array.from({ length: 30 }, (_, index) => rule({
      id: `arl_${index.toString(16).padStart(32, '0')}`,
      action: { ...rule().action, instructions }
    }));
    const client = await connectRemote(fakeRunner(() => ({ ok: true, data: { rules } })).client);
    const result = await call(client, 'automation_rules_list', { limit: 100 });
    const kept = (result.envelope?.data as { rules: unknown[] }).rules;
    expect(result.envelope?.truncated).toBe(true);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(rules.length);
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(262_144);
  });
});
