import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import {
  DEFAULT_RUNNER_AGENT_LIMITS,
  type ApiConfig,
  type RunnerConfig
} from '@cloud-harness/contracts';
import { createApiApp, type ApiRuntime } from '../../apps/api/src/app.js';
import { createRunnerApp } from '../../apps/runner/src/app.js';
import { DockerAgentGatewayControl } from '../../apps/runner/src/agent-gateway-control.js';
import { AgentStateRepository } from '../../apps/runner/src/agent-state-repository.js';
import { inspectContainer, removeContainer, runDocker } from '../../apps/runner/src/docker-engine.js';
import { StateStore } from '../../apps/runner/src/state-store.js';
import { WorkspaceService } from '../../apps/runner/src/workspace-service.js';
import {
  dockerLogs,
  dockerGithubNetworkIssue,
  dockerPrerequisiteIssue,
  requireDockerPrerequisites,
  startGatewayTestStack,
  stopGatewayTestStack,
  waitFor,
  type GatewayTestStack
} from '../agent-docker-test-support.js';

const prerequisiteIssue = dockerPrerequisiteIssue([
  'cloud-harness-agent:local',
  'cloud-harness-executor:local',
  'cloud-harness-model-gateway:local'
]) ?? dockerGithubNetworkIssue('cloud-harness-executor:local');
requireDockerPrerequisites(prerequisiteIssue);
const bearer = 'pi-agent-e2e-bearer-token-that-is-longer-than-32-characters';
const serviceToken = 'pi-agent-e2e-runner-token-that-is-longer-than-32-characters';
const terminalAgentStatuses: Record<string, true> = {
  SUCCEEDED: true,
  FAILED: true,
  CANCELLED: true,
  TIMED_OUT: true,
  LIMIT_EXCEEDED: true,
  INTERRUPTED: true
};
let ownerId = 'owner';
const activeWorkspaceIds = new Set<string>();
let directory: string;
let stack: GatewayTestStack;
let store: StateStore;
let service: WorkspaceService;
let repository: AgentStateRepository;
let runnerServer: Server;
let apiServer: Server;
let apiRuntime: ApiRuntime;
let client: Client;

beforeAll(async () => {
  if (prerequisiteIssue) return;
  stack = startGatewayTestStack('ch-pi-e2e');
  directory = mkdtempSync(join(tmpdir(), 'cloud-harness-pi-e2e-'));
  const limits = { ...DEFAULT_RUNNER_AGENT_LIMITS, cancellationGraceMs: 1_000 };
  const runnerConfig: RunnerConfig = {
    host: '127.0.0.1',
    port: 3001,
    serviceToken,
    jobsRoot: join(directory, 'jobs'),
    stateDb: join(directory, 'state', 'state.db'),
    executorImage: 'cloud-harness-executor:local',
    allowedGitHosts: ['github.com'],
    networkProfile: 'network-none',
    wallTtlSeconds: 300,
    idleTtlSeconds: 180,
    maxOutputBytes: 262_144,
    minFreeBytes: 104_857_600,
    maxWorkspaceBytes: 536_870_912,
    reaperIntervalSeconds: 30,
    agents: {
      image: 'cloud-harness-agent:local',
      networkMode: 'none',
      gatewayUrl: 'http://model-gateway:3210',
      profiles: [{
        id: 'fake-test-only',
        displayName: 'Deterministic fake provider',
        provider: 'fake',
        model: 'fake-model',
        inputMicrosPerMillionTokens: 1_000,
        outputMicrosPerMillionTokens: 2_000,
        maxInputTokens: 65_536,
        maxOutputTokens: 1_024,
        maxCostMicros: 1_000_000,
        maxProxyOperations: ['files_write', 'files_apply_patch']
      }],
      limits
    }
  };
  store = new StateStore(runnerConfig.stateDb);
  ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' });
  repository = new AgentStateRepository(store.database, limits, store.instanceId());
  service = new WorkspaceService(runnerConfig, store, {
    gateway: new DockerAgentGatewayControl(stack.gatewayContainer)
  });
  await service.start();
  runnerServer = createServer(createRunnerApp(runnerConfig, service));
  const runnerPort = await listen(runnerServer);
  const apiConfig: ApiConfig = {
    host: '127.0.0.1',
    port: 3000,
    ownerId,
    bearerToken: bearer,
    runnerUrl: `http://127.0.0.1:${runnerPort}`,
    runnerToken: serviceToken,
    publicHosts: ['127.0.0.1'],
    allowedOrigins: [],
    requestTimeoutMs: 120_000,
    maxBodyBytes: 262_144
  };
  apiRuntime = createApiApp(apiConfig);
  apiServer = createServer(apiRuntime.app);
  const apiPort = await listen(apiServer);
  client = new Client({ name: 'cloud-harness-pi-agent-e2e', version: '1.0.0' }, {
    versionNegotiation: { mode: { pin: '2026-07-28' } }
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${apiPort}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } }
  }));
}, 60_000);

afterEach(closeActiveWorkspaces, 120_000);

afterAll(async () => {
  await closeActiveWorkspaces();
  if (client) await client.close().catch(() => undefined);
  if (apiRuntime) await apiRuntime.close();
  if (service) await service.stop();
  if (store && stack) await forceRemoveAgentResources(store.instanceId(), stack.gatewayContainer);
  if (store) store.close();
  await Promise.all([
    closeServer(apiServer),
    closeServer(runnerServer)
  ]);
  if (directory) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      await runDocker([
        'run', '--rm', '--network', 'none', '--user', '0:0',
        '--volume', `${directory}:/target`,
        '--entrypoint', '/bin/sh', 'cloud-harness-executor:local',
        '-c', 'rm -rf /target/*'
      ]).catch(() => undefined);
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  if (stack) stopGatewayTestStack(stack);
}, 120_000);

describe.skipIf(Boolean(prerequisiteIssue))('actual Pi agent through MCP and the private runner', () => {
  it('edits only through allowed proxy tools and covers all six public operations with terminal cleanup', async () => {
    const workspaceId = await openWorkspace('pi-agent-network-none', 'network-none');
    const spawnInput = {
      workspaceId,
      prompt: 'Write then edit pi-agent-proof.txt exactly as requested using only the granted tools.',
      idempotencyKey: 'pi-agent-success',
      profileId: 'fake-test-only',
      proxyOperations: ['files_write', 'files_apply_patch'],
      ttlSeconds: 120,
      maxOutputBytes: 262_144,
      maxInputTokens: 65_536,
      maxOutputTokens: 1_024,
      maxCostMicros: 1_000_000
    };
    const spawned = await call('agent_spawn', spawnInput);
    const agentId = spawned.data.agentId as string;
    expect(spawned.data.replayed).toBe(false);
    const replayed = await call('agent_spawn', spawnInput);
    expect(replayed.data).toMatchObject({ agentId, replayed: true });

    const lookup = await call('agent_status', { workspaceId, idempotencyKey: spawnInput.idempotencyKey });
    expect(lookup.data.agentId).toBe(agentId);
    await waitFor(
      () => repository.findAgent(ownerId, workspaceId, agentId),
      (record) => record !== undefined && terminalAgentStatuses[record.status] === true,
      90_000
    );
    const terminal = (await call('agent_status', { workspaceId, agentId })).data;
    expect(terminal.status, JSON.stringify({
      terminal,
      gatewayLogs: dockerLogs(stack.gatewayContainer),
      providerLogs: dockerLogs(stack.providerContainer)
    })).toBe('SUCCEEDED');
    expect(terminal).toMatchObject({
      proxyOperations: ['files_write', 'files_apply_patch'],
      outcomeUnknown: false
    });

    const events: unknown[] = [];
    let cursor = '0';
    let hasMore = true;
    for (let pageNumber = 0; pageNumber < 50 && hasMore; pageNumber += 1) {
      const page = await call('agent_logs', { workspaceId, agentId, cursor, limitBytes: 1_024 });
      events.push(...(page.data.events as unknown[]));
      const nextCursor = page.data.nextCursor as string;
      expect(Number(nextCursor)).toBeGreaterThanOrEqual(Number(cursor));
      cursor = nextCursor;
      hasMore = page.data.hasMore as boolean;
    }
    expect(hasMore).toBe(false);
    expect(events.length).toBeGreaterThan(0);
    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).toContain('files_write');
    expect(serializedEvents).toContain('files_apply_patch');
    expect(serializedEvents).not.toContain('must-not-cross-gateway');
    const emptyTail = await call('agent_logs', { workspaceId, agentId, cursor, limitBytes: 1_024 });
    expect(emptyTail.data.events).toEqual([]);

    const file = await call('files_read', { workspaceId, path: 'pi-agent-proof.txt', offset: 0, limit: 65_536 });
    expect(file.data.content).toBe('edited by actual Pi agent through the proxy\n');
    const providerLogs = dockerLogs(stack.providerContainer);
    expect(providerLogs).toContain('"phase":"write"');
    expect(providerLogs).toContain('"phase":"edit"');
    expect(providerLogs).toContain('"phase":"complete"');
    const listed = await call('agent_list', { workspaceId, limit: 50 });
    expect(JSON.stringify(listed.data.agents)).toContain(agentId);
    const successRecord = repository.findAgent(ownerId, workspaceId, agentId);
    if (!successRecord) throw new Error('successful agent record was not retained');
    await expectAgentResourcesRemoved(successRecord.containerName, successRecord.networkName);

    const held = await call('agent_spawn', {
      ...spawnInput,
      prompt: '[FAKE_PROVIDER_HOLD] Wait for owner steering until cancelled.',
      idempotencyKey: 'pi-agent-cancel'
    });
    const heldAgentId = held.data.agentId as string;
    const heldStatus = await waitFor(
      () => repository.findAgent(ownerId, workspaceId, heldAgentId)?.status,
      (status) => status !== undefined && status !== 'SPAWNING',
      20_000
    );
    expect(heldStatus).toBe('RUNNING');
    await waitFor(
      () => dockerLogs(stack.providerContainer),
      (logs) => logs.includes('"event":"fake-provider-request","phase":"hold"'),
      10_000
    );
    const messageInput = {
      workspaceId,
      agentId: heldAgentId,
      idempotencyKey: 'pi-agent-steer',
      mode: 'steer',
      message: 'Keep the deterministic file unchanged.'
    };
    const message = await call('agent_message', messageInput);
    expect(message.data).toMatchObject({ agentId: heldAgentId, state: 'SENT', replayed: false });
    const messageReplay = await call('agent_message', messageInput);
    expect(messageReplay.data).toMatchObject({ agentId: heldAgentId, state: 'SENT', replayed: true });
    expect(JSON.stringify((await call('agent_list', { workspaceId, status: 'RUNNING', limit: 50 })).data.agents)).toContain(heldAgentId);
    const cancelled = await call('agent_cancel', { workspaceId, agentId: heldAgentId });
    expect(cancelled.data).toMatchObject({ agentId: heldAgentId, status: 'CANCELLED' });
    await waitFor(
      () => dockerLogs(stack.providerContainer),
      (logs) => logs.includes('"event":"fake-provider-close","phase":"hold"'),
      10_000
    );
    const cancelledRecord = repository.findAgent(ownerId, workspaceId, heldAgentId);
    if (!cancelledRecord) throw new Error('cancelled agent record was not retained');
    await expectAgentResourcesRemoved(cancelledRecord.containerName, cancelledRecord.networkName);

    const providerRequestsBeforeBudgetStop = fakeProviderRequestCount();
    const budgetStopped = await call('agent_spawn', {
      ...spawnInput,
      prompt: 'This request must stop at the gateway budget gate.',
      idempotencyKey: 'pi-agent-zero-budget',
      maxCostMicros: 0
    });
    const budgetAgentId = budgetStopped.data.agentId as string;
    await waitFor(
      () => repository.findAgent(ownerId, workspaceId, budgetAgentId),
      (record) => record !== undefined && terminalAgentStatuses[record.status] === true,
      30_000
    );
    const budgetTerminal = (await call('agent_status', { workspaceId, agentId: budgetAgentId })).data;
    expect(budgetTerminal.status).toBe('LIMIT_EXCEEDED');
    expect(budgetTerminal.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, costMicros: 0 });
    expect(fakeProviderRequestCount()).toBe(providerRequestsBeforeBudgetStop);
    const budgetRecord = repository.findAgent(ownerId, workspaceId, budgetAgentId);
    if (!budgetRecord) throw new Error('budget-stopped agent record was not retained');
    await expectAgentResourcesRemoved(budgetRecord.containerName, budgetRecord.networkName);

    const workspaceRecord = store.byId(workspaceId);
    if (!workspaceRecord?.containerName) throw new Error('workspace container record is unavailable');
    await call('workspace_close', { workspaceId });
    activeWorkspaceIds.delete(workspaceId);
    expect(await inspectContainer(workspaceRecord.containerName)).toBeUndefined();
    expect(existsSync(workspaceRecord.workspacePath)).toBe(false);
  }, 180_000);

  it('rejects agent spawn for a bridge-backed workspace before creating agent resources', async () => {
    const workspaceId = await openWorkspace('pi-agent-bridge-rejection', 'dependency-access');
    const before = await agentResourceInventory();
    const result = await client.callTool({
      name: 'agent_spawn',
      arguments: {
        workspaceId,
        prompt: 'must not launch',
        idempotencyKey: 'pi-agent-bridge-spawn',
        profileId: 'fake-test-only',
        proxyOperations: ['files_write'],
        ttlSeconds: 30,
        maxOutputBytes: 262_144,
        maxInputTokens: 65_536,
        maxOutputTokens: 1_024,
        maxCostMicros: 1_000_000
      }
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(await agentResourceInventory()).toEqual(before);
    await call('workspace_close', { workspaceId });
    activeWorkspaceIds.delete(workspaceId);
  }, 60_000);

});
async function closeActiveWorkspaces(): Promise<void> {
  if (!service) return;
  for (const workspaceId of [...activeWorkspaceIds]) {
    const record = store?.byId(workspaceId);
    try {
      await service.close(ownerId, workspaceId);
    } catch {
      if (record?.containerName) await removeContainer(record.containerName).catch(() => undefined);
      if (record?.workspacePath) {
        try {
          rmSync(record.workspacePath, { recursive: true, force: true });
        } catch {
          await runDocker([
            'run', '--rm', '--network', 'none', '--user', '0:0',
            '--volume', `${record.workspacePath}:/target`,
            '--entrypoint', '/bin/sh', 'cloud-harness-executor:local',
            '-c', 'rm -rf /target/*'
          ]).catch(() => undefined);
        }
      }
    } finally {
      activeWorkspaceIds.delete(workspaceId);
    }
  }
}

async function openWorkspace(idempotencyKey: string, networkProfile: 'network-none' | 'dependency-access'): Promise<string> {
  const opened = await call('workspace_open', {
    repositoryUrl: 'https://github.com/bestagentkits/cloud-harness-mcp.git',
    ref: 'test-fixture-v1',
    idempotencyKey,
    networkProfile
  });
  const workspaceId = opened.data.workspaceId as string;
  activeWorkspaceIds.add(workspaceId);
  return workspaceId;
}

async function listen(server: Server): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', resolve);
  await promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server failed to listen');
  return address.port;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  await promise;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  return structured(await client.callTool({ name, arguments: args }));
}

function structured(result: CallToolResult): Record<string, any> {
  expect(result.isError, JSON.stringify(result.structuredContent)).toBe(false);
  return result.structuredContent as Record<string, any>;
}

async function expectAgentResourcesRemoved(containerName: string, networkName: string): Promise<void> {
  expect(await inspectContainer(containerName)).toBeUndefined();
  expect((await runDocker(['network', 'inspect', networkName], { timeoutMs: 10_000, maxBytes: 4_096 })).exitCode).not.toBe(0);
}

function fakeProviderRequestCount(): number {
  return dockerLogs(stack.providerContainer).split('\n').filter((line) => line.includes('"event":"fake-provider-request"')).length;
}

async function agentResourceInventory(): Promise<{ containers: string[]; networks: string[] }> {
  const [containers, networks] = await Promise.all([
    runDocker(['ps', '-a', '--filter', 'label=cloud-harness.agent-container=true', '--format', '{{.Names}}']),
    runDocker(['network', 'ls', '--filter', 'label=cloud-harness.agent-network=true', '--format', '{{.Name}}'])
  ]);
  expect(containers.exitCode, containers.stderr).toBe(0);
  expect(networks.exitCode, networks.stderr).toBe(0);
  return {
    containers: containers.stdout.split('\n').filter(Boolean).sort(),
    networks: networks.stdout.split('\n').filter(Boolean).sort()
  };
}

async function forceRemoveAgentResources(instanceId: string, gatewayContainer: string): Promise<void> {
  const containers = await runDocker([
    'ps', '-a',
    '--filter', 'label=cloud-harness.agent-container=true',
    '--filter', `label=cloud-harness.instance=${instanceId}`,
    '--format', '{{.Names}}'
  ]);
  for (const container of containers.stdout.split('\n').filter(Boolean)) {
    await runDocker(['rm', '--force', container], { timeoutMs: 10_000, maxBytes: 4_096 });
  }
  const networks = await runDocker([
    'network', 'ls',
    '--filter', 'label=cloud-harness.agent-network=true',
    '--filter', `label=cloud-harness.instance=${instanceId}`,
    '--format', '{{.Name}}'
  ]);
  for (const network of networks.stdout.split('\n').filter(Boolean)) {
    await runDocker(['network', 'disconnect', '--force', network, gatewayContainer], { timeoutMs: 10_000, maxBytes: 4_096 });
    await runDocker(['network', 'rm', network], { timeoutMs: 10_000, maxBytes: 4_096 });
  }
}
