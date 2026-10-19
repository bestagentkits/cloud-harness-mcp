import { afterEach, describe, expect, it, vi } from 'vitest';
import { TraceSpanSchema } from '@cloud-harness/contracts';
import { AgentManager } from '../src/agent-manager.js';
import { AgentTraceRecorder } from '../src/agent-trace-recorder.js';
import { AgentTraceStore, executeAgentTraceOperation, traceIdFor } from '../src/agent-trace-store.js';
import { AgentStateRepository } from '../src/agent-state-repository.js';
import { createAgentHarness, RecordScript, ScriptedGateway, ScriptedLauncher, type AgentHarness } from './support/agent-runtime-fakes.js';

const harnesses: AgentHarness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

function tracedHarness(options: { failingStore?: boolean } = {}) {
  const log = vi.fn();
  let created: AgentTraceStore | undefined;
  const harness = createAgentHarness({
    dependencies: (state) => {
      created = new AgentTraceStore(state.database, { retentionDays: 14, maxTracesPerPrincipal: 5_000 });
      if (options.failingStore) vi.spyOn(created, 'writeSpan').mockImplementation(() => { throw new Error('injected trace store failure'); });
      return { traceRecorder: new AgentTraceRecorder(created, { maxSpansPerTrace: 2_000, previewBytes: 0, log }) };
    }
  });
  harnesses.push(harness);
  if (!created) throw new Error('trace store was not created');
  const store: AgentTraceStore = created;
  function read(agentId: string, generation = 1) {
    const traceId = traceIdFor(agentId, generation);
    const now = Date.now() + 1_000;
    const detail = executeAgentTraceOperation(store, harness.ownerId, 'agent_trace_get', { traceId }, { now, maxSpans: 2_000 });
    const page = executeAgentTraceOperation(store, harness.ownerId, 'agent_trace_spans', { traceId, limit: 500 }, { now, maxSpans: 2_000 });
    const trace = (detail.data as { trace: Record<string, unknown> & { reconciliation: { status: string; reasons: string[] } } }).trace;
    const spans = (page.data as { spans: unknown[] }).spans.map((span) => TraceSpanSchema.parse(span));
    return { trace, spans };
  }
  return { harness, store, log, read };
}

describe('agent traces through AgentManager', () => {
  it('records two model requests and two tool invocations that reconcile with agent_usage', async () => {
    const { harness, read } = tracedHarness();
    harness.gateway.defaultSettlement = { promptTokens: 300, outputTokens: 60, costMicros: 140, requests: 2 };
    const agentId = await harness.spawn();
    await harness.waitForStatus(agentId, 'RUNNING');
    harness.send(agentId, new RecordScript()
      .turn({
        textDeltas: ['reading'], outcome: 'toolUse', usage: { input: 100, output: 20, cost: 0.00005 },
        tools: [
          { toolCallId: 'call-1', operation: 'files_read', input: { path: 'README.md' } },
          { toolCallId: 'call-2', operation: 'files_write', input: { path: 'notes.md', content: 'hello' } }
        ]
      })
      .turn({ textDeltas: ['done'], outcome: 'stop', usage: { input: 300, output: 60, cost: 0.00014 } })
      .terminal('SUCCEEDED'));
    await harness.waitForStatus(agentId, 'SUCCEEDED');
    expect(harness.toolExecutor).toHaveBeenCalledTimes(2);

    const usage = harness.repository.usage(harness.ownerId, harness.workspace.id, agentId, 1);
    const { trace, spans } = read(agentId);
    expect(trace).toMatchObject({
      state: 'COMPLETED', agentId, workspaceId: harness.workspace.id, profileId: 'default',
      modelCalls: 2, toolCalls: 2, errors: 0, coverage: 'full', reconciliationStatus: 'reconciled',
      tokens: { prompt: usage.inputTokens, output: usage.outputTokens }, costMicros: usage.costMicros
    });
    expect(trace.reconciliation.reasons).toEqual([]);
    const models = spans.filter((span) => span.kind === 'model_call');
    const tools = spans.filter((span) => span.kind === 'tool_call');
    expect(models.reduce((sum, span) => sum + (span.tokens.prompt ?? 0), 0)).toBe(usage.inputTokens);
    expect(models.reduce((sum, span) => sum + (span.tokens.output ?? 0), 0)).toBe(usage.outputTokens);
    expect(tools.map((span) => [span.name, span.state, span.attributes.brokered])).toEqual([
      ['files_read', 'OK', true], ['files_write', 'OK', true]
    ]);
    expect(tools.every((span) => span.parentSpanId === models[0]!.spanId)).toBe(true);
    expect(spans.filter((span) => span.kind === 'gateway')).toHaveLength(1);
  });

  it('records the profile revision of a spawned agent', async () => {
    const { harness, read } = tracedHarness();
    const agentId = await harness.spawn();
    await harness.waitForStatus(agentId, 'RUNNING');
    const record = harness.repository.findAgent(harness.ownerId, harness.workspace.id, agentId);
    const { trace } = read(agentId);
    expect(trace).toMatchObject({ state: 'RUNNING', profileId: 'default', reconciliationStatus: 'pending' });
    expect(trace.profileRevisionId ?? null).toBe((record as { profileRevisionId?: string | null } | undefined)?.profileRevisionId ?? null);
    await harness.cancel(agentId);
  });

  it('closes a cancelled run as a partial CANCELLED trace', async () => {
    const { harness, read } = tracedHarness();
    harness.gateway.defaultSettlement = { promptTokens: 10, outputTokens: 2, costMicros: 3, requests: 2 };
    const agentId = await harness.spawn();
    await harness.waitForStatus(agentId, 'RUNNING');
    harness.send(agentId, new RecordScript().turn({ outcome: 'stop', usage: { input: 10, output: 2, cost: 0.000003 } }).openTurn(['partial']));
    await vi.waitFor(() => expect(read(agentId).spans.filter((span) => span.kind === 'model_call')).toHaveLength(2));
    await harness.cancel(agentId);
    await harness.waitForStatus(agentId, 'CANCELLED');
    const { trace, spans } = read(agentId);
    expect(trace).toMatchObject({ state: 'CANCELLED', coverage: 'partial', tokens: { prompt: 10, output: 2 } });
    expect(spans.filter((span) => span.kind === 'model_call').map((span) => span.state)).toEqual(['OK', 'UNKNOWN']);
    expect(spans.some((span) => span.state === 'OPEN')).toBe(false);
  });

  it('records a failed run whose stream ended mid-turn', async () => {
    const { harness, read } = tracedHarness();
    harness.gateway.defaultSettlement = { promptTokens: 5, outputTokens: 1, costMicros: 1, requests: 1 };
    const agentId = await harness.spawn();
    await harness.waitForStatus(agentId, 'RUNNING');
    harness.send(agentId, new RecordScript().openTurn(['half']).terminal('FAILED', 'stream terminated'));
    await harness.waitForStatus(agentId, 'FAILED');
    const { trace, spans } = read(agentId);
    expect(trace).toMatchObject({ state: 'FAILED', coverage: 'partial' });
    expect(spans.find((span) => span.kind === 'model_call')?.state).toBe('UNKNOWN');
  });

  it('links a nested child agent to the parent trace', async () => {
    const { harness, read } = tracedHarness();
    const parentId = await harness.spawn();
    await harness.waitForStatus(parentId, 'RUNNING');
    const childId = await harness.spawn({ parentAgentId: parentId });
    await harness.waitForStatus(childId, 'RUNNING');
    expect(read(childId).trace.parentTraceId).toBe(traceIdFor(parentId, 1));
    expect(read(parentId).trace.parentTraceId).toBeNull();
    await harness.cancel(parentId);
    await harness.waitForStatus(childId, 'CANCELLED');
    expect(read(childId).trace.state).toBe('CANCELLED');
  });

  it('marks an agent interrupted by a runner restart INCOMPLETE with its open spans UNKNOWN', async () => {
    const { harness, store, read } = tracedHarness();
    const agentId = await harness.spawn();
    await harness.waitForStatus(agentId, 'RUNNING');
    harness.send(agentId, new RecordScript().turn({ outcome: 'stop', usage: { input: 10, output: 2, cost: 0 } }).openTurn(['thinking']));
    await vi.waitFor(() => expect(read(agentId).spans.filter((span) => span.kind === 'model_call')).toHaveLength(2));

    const gateway = new ScriptedGateway();
    gateway.defaultSettlement = { promptTokens: 10, outputTokens: 2, requests: 2 };
    const restarted = new AgentManager(harness.config, harness.store, {
      repository: new AgentStateRepository(harness.store.database, harness.config.limits),
      launcher: new ScriptedLauncher(), gateway, toolExecutor: harness.toolExecutor, spendLedger: harness.spendLedger,
      traceRecorder: new AgentTraceRecorder(store, { maxSpansPerTrace: 2_000, previewBytes: 0, log: () => undefined })
    });
    await restarted.start();
    await restarted.stop();
    expect(harness.status(agentId)).toBe('INTERRUPTED');
    const { trace, spans } = read(agentId);
    expect(trace).toMatchObject({ state: 'INCOMPLETE', coverage: 'partial', finishReason: 'runner_restart', tokens: { prompt: 10, output: 2 } });
    expect(spans.filter((span) => span.kind === 'model_call').map((span) => span.state)).toEqual(['OK', 'UNKNOWN']);
    expect(spans.some((span) => span.state === 'OPEN')).toBe(false);
  });

  it('keeps the agent lifecycle intact when trace storage fails', async () => {
    const { harness, log, read } = tracedHarness({ failingStore: true });
    const agentId = await harness.spawn();
    await harness.waitForStatus(agentId, 'RUNNING');
    harness.send(agentId, new RecordScript().turn({ outcome: 'stop', usage: { input: 10, output: 2, cost: 0 } }).terminal('SUCCEEDED'));
    await harness.waitForStatus(agentId, 'SUCCEEDED');
    expect(harness.repository.usage(harness.ownerId, harness.workspace.id, agentId, 1).inputTokens).toBe(10);
    expect(read(agentId).trace).toMatchObject({ coverage: 'partial' });
    expect(log).toHaveBeenCalled();
  });

  it('records nothing and reports FEATURE_DISABLED without a recorder', async () => {
    const harness = createAgentHarness();
    harnesses.push(harness);
    const agentId = await harness.spawn();
    await harness.waitForStatus(agentId, 'RUNNING');
    expect(harness.store.database.prepare('SELECT COUNT(*) AS count FROM agent_traces').get()).toEqual({ count: 0 });
    expect(() => executeAgentTraceOperation(undefined, harness.ownerId, 'agent_traces_list', { limit: 25 }, { now: Date.now(), maxSpans: 10 }))
      .toThrowError(expect.objectContaining({ code: 'FEATURE_DISABLED' }));
    await harness.cancel(agentId);
  });
});
