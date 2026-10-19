import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  AGENT_TRACE_OPERATIONS, AGENT_TRACE_RESULT_SCHEMAS, RunnerConfigSchema, ToolResultSchema,
  type ApiConfig, type RunnerConfig
} from '@cloud-harness/contracts';
import { createApiApp, type ApiRuntime } from '../../apps/api/src/app.js';
import { createRunnerApp } from '../../apps/runner/src/app.js';
import { AgentTraceStore, spanIdFor, traceIdFor } from '../../apps/runner/src/agent-trace-store.js';
import { StateStore } from '../../apps/runner/src/state-store.js';
import { WorkspaceService } from '../../apps/runner/src/workspace-service.js';

const bearer = 'integration-bearer-token-longer-than-32-characters';
const serviceToken = 'runner-token-that-is-longer-than-32-characters';
const DAY = 86_400_000;
const workspaceId = `ws_${'w'.repeat(24)}`;

type Booted = { client: Client; store: StateStore; service: WorkspaceService; traces: AgentTraceStore; close: () => Promise<void> };
const transcripts: unknown[] = [];

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

/** A real runner (WorkspaceService over SQLite) behind the real API, reached by an MCP client over HTTP. */
async function boot(root: string, tracesEnabled: boolean): Promise<Booted> {
  const jobsRoot = join(root, 'jobs');
  mkdirSync(jobsRoot, { recursive: true });
  const config: RunnerConfig = RunnerConfigSchema.parse({
    serviceToken, jobsRoot, stateDb: join(root, 'state.db'), executorImage: 'executor:test', allowedGitHosts: ['github.com'],
    agentTraces: { enabled: tracesEnabled, retentionDays: 14 }
  });
  const store = new StateStore(config.stateDb);
  const service = new WorkspaceService(config, store);
  const traces = new AgentTraceStore(store.database, { retentionDays: 14, maxTracesPerPrincipal: 5_000 });
  const runner = createServer(createRunnerApp(config, service));
  const runnerPort = await listen(runner);
  const apiConfig: ApiConfig = {
    host: '127.0.0.1', port: 0, ownerId: 'owner', bearerToken: bearer, apiKeyAuthEnabled: false,
    runnerUrl: `http://127.0.0.1:${runnerPort}`, runnerToken: serviceToken,
    publicHosts: ['127.0.0.1'], allowedOrigins: [], requestTimeoutMs: 10_000, maxBodyBytes: 262_144,
    mcpGatewayTimeoutMs: 30_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
    mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
    mcpGatewayMaxConnections: 32, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false
  };
  const runtime: ApiRuntime = createApiApp(apiConfig);
  const api = createServer(runtime.app);
  const apiPort = await listen(api);
  const client = new Client({ name: 'agent-traces-http-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${apiPort}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } }
  }));
  return {
    client, store, service, traces,
    close: async () => {
      await client.close();
      await runtime.close();
      await Promise.all([api, runner].map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
      store.close();
    }
  };
}

let agentCounter = 0;
/** Seeds one finished trace with two model calls and a tool call, as the recorder would have written it. */
function seed(target: Booted, principalId: string, startedAt: number, options: { endedAt?: number } = {}): string {
  agentCounter += 1;
  const agentId = `agent_${String(agentCounter).padStart(24, '0')}`;
  const traceId = traceIdFor(agentId, 1);
  target.traces.createTrace({
    traceId, principalId, workspaceId, agentId, generation: 1, runId: null, parentTraceId: null, workflowId: null,
    profileId: 'coding', profileRevisionId: 'mrev_aaaaaaaaaaaaaaaaaaaaaaaa', startedAt
  });
  const spans: Array<['model_call' | 'tool_call', number]> = [['model_call', 1], ['tool_call', 2], ['model_call', 3]];
  for (const [kind, seq] of spans) {
    target.traces.writeSpan({
      traceId, spanSeq: seq, spanId: spanIdFor(traceId, seq), parentSpanId: spanIdFor(traceId, 0), kind,
      name: kind === 'model_call' ? 'model.call' : 'tool.files_read', state: 'OK', startedAt: startedAt + seq * 100,
      endedAt: startedAt + seq * 100 + 80, ttftMs: kind === 'model_call' ? 20 : null,
      promptTokens: kind === 'model_call' ? 10 : null, outputTokens: kind === 'model_call' ? 5 : null,
      cacheReadTokens: kind === 'model_call' ? 0 : null, cacheWriteTokens: kind === 'model_call' ? 0 : null,
      costMicros: kind === 'model_call' ? 3 : null, attributes: {}, inputDigest: null, errorClass: null
    });
  }
  const endedAt = options.endedAt ?? startedAt + 1_000;
  target.traces.updateTrace(traceId, {
    state: 'COMPLETED', finishReason: 'completed', endedAt, promptTokens: 20, outputTokens: 10, costMicros: 6,
    costProvenance: 'estimated', expiresAt: target.traces.retentionDeadline(endedAt)
  });
  return traceId;
}

async function call(target: Booted, name: (typeof AGENT_TRACE_OPERATIONS)[number], args: Record<string, unknown>) {
  const result = await target.client.callTool({ name, arguments: args });
  transcripts.push(result);
  const envelope = ToolResultSchema.parse(result.structuredContent);
  return { isError: result.isError, envelope, data: envelope.ok ? AGENT_TRACE_RESULT_SCHEMAS[name].parse(envelope.data) as any : undefined };
}

let root: string;
let enabled: Booted;
let disabled: Booted;
let ownerPrincipal: string;
let otherPrincipal: string;
const ownTraces: string[] = [];
let foreignTrace: string;
let expiredTrace: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-traces-http-'));
  enabled = await boot(join(root, 'enabled'), true);
  disabled = await boot(join(root, 'disabled'), false);
  // The API forwards a bearer caller as the configured owner.
  ownerPrincipal = enabled.store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' });
  otherPrincipal = enabled.store.resolvePrincipal({ kind: 'owner', ownerId: 'someone-else' });
  const now = Date.now();
  for (let index = 0; index < 5; index += 1) ownTraces.push(seed(enabled, ownerPrincipal, now - (index + 1) * 60_000));
  foreignTrace = seed(enabled, otherPrincipal, now - 30_000);
  expiredTrace = seed(enabled, ownerPrincipal, now - 40 * DAY, { endedAt: now - 30 * DAY });
}, 60_000);

afterAll(async () => {
  await enabled?.close();
  await disabled?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('agent trace tools over MCP HTTP', () => {
  it('lists every trace tool as read-only and idempotent', async () => {
    const { tools } = await enabled.client.listTools();
    for (const name of AGENT_TRACE_OPERATIONS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations, name).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    }
  });

  it('reads a trace, its spans and every export format for the caller', async () => {
    const traceId = ownTraces[0];
    const detail = await call(enabled, 'agent_trace_get', { traceId });
    expect(detail.isError).toBe(false);
    expect(detail.data.trace).toMatchObject({ traceId, state: 'COMPLETED', profileRevisionId: 'mrev_aaaaaaaaaaaaaaaaaaaaaaaa', modelCalls: 2, toolCalls: 1 });
    const spans = await call(enabled, 'agent_trace_spans', { traceId, kind: 'model_call' });
    expect(spans.data.spans.map((span: { kind: string }) => span.kind)).toEqual(['model_call', 'model_call']);
    for (const format of ['json', 'csv', 'otlp-json'] as const) {
      const exported = await call(enabled, 'agent_trace_export', { traceId, format });
      expect(exported.isError, format).toBe(false);
      expect(exported.data.content, format).toContain(traceId);
    }
  });

  it('pages two concurrent listings without loss or duplication while traces are written', async () => {
    const walk = async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await call(enabled, 'agent_traces_list', { limit: 2, ...(cursor ? { cursor } : {}) });
        expect(page.isError).toBe(false);
        seen.push(...page.data.traces.map((trace: { traceId: string }) => trace.traceId));
        // A trace written mid-walk starts after the anchor, so it never shifts an older page.
        seed(enabled, ownerPrincipal, Date.now());
        cursor = page.data.nextCursor ?? undefined;
      } while (cursor);
      return seen;
    };
    const [first, second] = await Promise.all([walk(), walk()]);
    for (const seen of [first, second]) {
      expect(new Set(seen).size).toBe(seen.length);
      for (const traceId of ownTraces) expect(seen).toContain(traceId);
      expect(seen).not.toContain(foreignTrace);
      expect(seen).not.toContain(expiredTrace);
    }
  });

  it('reports another identity\'s trace exactly like a missing one', async () => {
    const foreign = await call(enabled, 'agent_trace_get', { traceId: foreignTrace });
    const missing = await call(enabled, 'agent_trace_get', { traceId: `trc_${'z'.repeat(26)}` });
    expect(foreign.isError).toBe(true);
    expect(foreign.envelope.error?.code).toBe('NOT_FOUND');
    expect(foreign.envelope.error?.code).toBe(missing.envelope.error?.code);
    expect(foreign.envelope.message.replace(foreignTrace, '')).toBe(missing.envelope.message.replace(`trc_${'z'.repeat(26)}`, ''));
    for (const name of ['agent_trace_spans', 'agent_trace_export'] as const) {
      const result = await call(enabled, name, { traceId: foreignTrace, ...(name === 'agent_trace_export' ? { format: 'json' } : {}) });
      expect(result.envelope.error?.code, name).toBe('NOT_FOUND');
    }
  });

  it('answers TRACE_EXPIRED for a trace past retention', async () => {
    const expired = await call(enabled, 'agent_trace_get', { traceId: expiredTrace });
    expect(expired.isError).toBe(true);
    expect(expired.envelope.error?.code).toBe('TRACE_EXPIRED');
  });

  it('returns the KPI summary on the first page only', async () => {
    const first = await call(enabled, 'agent_traces_list', { limit: 1 });
    expect(first.data.summary).not.toBeNull();
    const next = await call(enabled, 'agent_traces_list', { limit: 1, cursor: first.data.nextCursor });
    expect(next.isError).toBe(false);
    expect(next.data.summary).toBeNull();
    expect((await call(enabled, 'agent_traces_list', { limit: 1, includeSummary: false })).data.summary).toBeNull();
  });

  it('keeps purging past-retention traces while traces are turned off', async () => {
    const principal = disabled.store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' });
    const now = Date.now();
    const old = seed(disabled, principal, now - 40 * DAY, { endedAt: now - 30 * DAY });
    const recent = seed(disabled, principal, now - 60_000);
    expect(await disabled.service.purgeAgentTraces(now)).toBe(1);
    expect(disabled.traces.findTrace(old)).toBeUndefined();
    expect(disabled.traces.findTrace(recent)).toBeDefined();
  });

  it('refuses a cursor issued for different filters', async () => {
    const page = await call(enabled, 'agent_traces_list', { limit: 1 });
    const reused = await call(enabled, 'agent_traces_list', { limit: 1, state: 'FAILED', cursor: page.data.nextCursor });
    expect(reused.envelope.error?.code).toBe('INVALID_INPUT');
  });

  it('answers FEATURE_DISABLED for every tool when traces are turned off', async () => {
    const traceId = ownTraces[0];
    const inputs: Record<(typeof AGENT_TRACE_OPERATIONS)[number], Record<string, unknown>> = {
      agent_traces_list: {}, agent_trace_get: { traceId }, agent_trace_spans: { traceId }, agent_trace_export: { traceId, format: 'json' }
    };
    for (const name of AGENT_TRACE_OPERATIONS) {
      const result = await call(disabled, name, inputs[name]);
      expect(result.isError, name).toBe(true);
      expect(result.envelope.error?.code, name).toBe('FEATURE_DISABLED');
    }
  });

  it('never carries a credential or an internal principal id in any response', () => {
    const body = JSON.stringify(transcripts);
    expect(transcripts.length).toBeGreaterThan(10);
    expect(body).not.toContain(ownerPrincipal);
    expect(body).not.toContain(otherPrincipal);
    expect(body).not.toContain(serviceToken);
    expect(body).not.toContain(bearer);
  });
});
