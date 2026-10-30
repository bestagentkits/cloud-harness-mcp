import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { DEFAULT_RUNNER_AGENT_LIMITS, type ApiConfig, type RunnerConfig } from '@cloud-harness/contracts';
import { createApiApp, type ApiRuntime } from '../../apps/api/src/app.js';
import { createRunnerApp } from '../../apps/runner/src/app.js';
import { DockerAgentGatewayControl } from '../../apps/runner/src/agent-gateway-control.js';
import { AgentStateRepository } from '../../apps/runner/src/agent-state-repository.js';
import { removeContainer, runDocker } from '../../apps/runner/src/docker-engine.js';
import { StateStore } from '../../apps/runner/src/state-store.js';
import { WorkspaceService } from '../../apps/runner/src/workspace-service.js';
import {
  dockerGithubNetworkIssue,
  dockerLogs,
  dockerPrerequisiteIssue,
  requireDockerPrerequisites,
  startGatewayTestStack,
  stopGatewayTestStack,
  waitFor,
  type GatewayTestStack
} from '../agent-docker-test-support.js';

// The durable engine ships only in an agent image built with INCLUDE_DURABLE_RUNTIME=true:
//   docker build -f docker/agent.Dockerfile --build-arg INCLUDE_DURABLE_RUNTIME=true -t cloud-harness-agent-durable:local .
const DURABLE_IMAGE = 'cloud-harness-agent-durable:local';
const prerequisiteIssue = dockerPrerequisiteIssue([
  DURABLE_IMAGE,
  'cloud-harness-agent:local',
  'cloud-harness-executor:local',
  'cloud-harness-model-gateway:local'
]) ?? dockerGithubNetworkIssue('cloud-harness-executor:local');
requireDockerPrerequisites(prerequisiteIssue);
const bearer = 'pi-durable-e2e-bearer-token-that-is-longer-than-32-characters';
const serviceToken = 'pi-durable-e2e-runner-token-that-is-longer-than-32-characters';
const terminalAgentStatuses: Record<string, true> = {
  SUCCEEDED: true, FAILED: true, CANCELLED: true, TIMED_OUT: true, LIMIT_EXCEEDED: true, INTERRUPTED: true
};
let ownerId = 'owner';
let directory: string;
let stack: GatewayTestStack;
let store: StateStore;
let service: WorkspaceService;
let repository: AgentStateRepository;
let runnerServer: Server;
let apiServer: Server;
let apiRuntime: ApiRuntime;
let client: Client;
let workspaceId: string | undefined;

beforeAll(async () => {
  if (prerequisiteIssue) return;
  stack = startGatewayTestStack('ch-durable-e2e');
  directory = mkdtempSync(join(tmpdir(), 'cloud-harness-durable-e2e-'));
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
      image: DURABLE_IMAGE,
      networkMode: 'none',
      gatewayUrl: 'http://model-gateway:3210',
      durableRuntimeEnabled: true,
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
  service = new WorkspaceService(runnerConfig, store, { gateway: new DockerAgentGatewayControl(stack.gatewayContainer) });
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
    maxBodyBytes: 262_144,
    mcpGatewayTimeoutMs: 30_000,
    mcpGatewayMaxResponseBytes: 262_144,
    mcpGatewayMaxToolsPerServer: 500,
    mcpGatewayMaxSchemaBytes: 65_536,
    mcpGatewayMaxCatalogBytes: 2_097_152,
    mcpGatewayMaxTraceRows: 20_000,
    mcpGatewayMaxConnections: 32,
    mcpGatewayAllowInsecureHttp: false,
    mcpGatewayAllowPrivateEndpoints: false
  };
  apiRuntime = createApiApp(apiConfig);
  apiServer = createServer(apiRuntime.app);
  const apiPort = await listen(apiServer);
  client = new Client({ name: 'cloud-harness-durable-agent-e2e', version: '1.0.0' }, {
    versionNegotiation: { mode: { pin: '2026-07-28' } }
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${apiPort}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } }
  }));
}, 60_000);

afterAll(async () => {
  if (workspaceId && service) {
    const record = store?.byId(workspaceId);
    await service.close(ownerId, workspaceId).catch(async () => {
      if (record?.containerName) await removeContainer(record.containerName).catch(() => undefined);
    });
  }
  if (client) await client.close().catch(() => undefined);
  if (apiRuntime) await apiRuntime.close();
  if (service) await service.stop();
  if (store) store.close();
  await Promise.all([closeServer(apiServer), closeServer(runnerServer)]);
  if (directory) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      await runDocker([
        'run', '--rm', '--network', 'none', '--user', '0:0', '--volume', `${directory}:/target`,
        '--entrypoint', '/bin/sh', 'cloud-harness-executor:local', '-c', 'rm -rf /target/*'
      ]).catch(() => undefined);
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  if (stack) stopGatewayTestStack(stack);
}, 120_000);

describe.skipIf(Boolean(prerequisiteIssue))('durable Pi agent engine through MCP and the private runner', () => {
  it('fails a durable start clearly in the default agent image, which omits the engine', () => {
    const start = {
      type: 'start', requestId: 'start-1', agentId: `agent_${'a'.repeat(24)}`, prompt: 'hello', tools: ['files_read'],
      gateway: { profile: 'fake-test-only', lease: 'lease-value-that-is-long-enough-to-redact' },
      model: {
        id: 'fake-model', name: 'fake', api: 'openai-completions', reasoning: false, contextWindow: 8_192, maxTokens: 1_024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      },
      limits: { deadlineMs: 10_000, maxEvents: 100, maxOutputBytes: 65_536, maxEventBytes: 8_192, maxToolResultBytes: 65_536 },
      runtime: 'pi-durable'
    };
    const result = spawnSync('docker', ['run', '--rm', '-i', '--network', 'none', 'cloud-harness-agent:local'], {
      input: `${JSON.stringify(start)}\n`, encoding: 'utf8', timeout: 60_000
    });
    const terminal = result.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.type === 'terminal');
    expect(terminal, result.stderr).toMatchObject({ state: 'FAILED' });
    expect(String(terminal?.error)).toContain('INCLUDE_DURABLE_RUNTIME=true');
  }, 90_000);

  it('runs a durable agent with its session store in the runner, continues it, and deletes the store with the workspace', async () => {
    const opened = await call('workspace_open', {
      repositoryUrl: 'https://github.com/bestagentkits/cloud-harness-mcp.git',
      ref: 'test-fixture-v1',
      idempotencyKey: 'pi-durable-workspace',
      networkProfile: 'network-none'
    });
    workspaceId = opened.data.workspaceId as string;
    const spawnInput = {
      workspaceId,
      prompt: 'Write then edit pi-agent-proof.txt exactly as requested using only the granted tools.',
      idempotencyKey: 'pi-durable-success',
      profileId: 'fake-test-only',
      proxyOperations: ['files_write', 'files_apply_patch'],
      ttlSeconds: 120,
      maxOutputBytes: 262_144,
      maxInputTokens: 65_536,
      maxOutputTokens: 1_024,
      maxCostMicros: 1_000_000,
      runtime: 'pi-durable'
    };
    const agentId = (await call('agent_spawn', spawnInput)).data.agentId as string;
    await waitFor(
      () => repository.findAgent(ownerId, workspaceId!, agentId),
      (record) => record !== undefined && terminalAgentStatuses[record.status] === true,
      90_000
    );
    const terminal = (await call('agent_status', { workspaceId, agentId })).data;
    expect(terminal.status, JSON.stringify({
      terminal,
      gatewayLogs: dockerLogs(stack.gatewayContainer),
      providerLogs: dockerLogs(stack.providerContainer)
    })).toBe('SUCCEEDED');
    expect(terminal).toMatchObject({ runtime: 'pi-durable', run: { resumable: false }, outcomeUnknown: false });
    expect(terminal.usage.inputTokens).toBeGreaterThan(0);
    const file = await call('files_read', { workspaceId, path: 'pi-agent-proof.txt', offset: 0, limit: 65_536 });
    expect(file.data.content).toBe('edited by actual Pi agent through the proxy\n');

    // The session store lives with the runner state; the lease that reached the agent is not in it.
    const sessionFile = join(directory, 'state', 'agent-sessions', `${agentId}.sqlite`);
    expect(existsSync(sessionFile)).toBe(true);
    expect(readFileSync(sessionFile).includes(Buffer.from('bearer_'))).toBe(false);

    // A continuation inherits the engine and shares the lineage's store.
    const continued = await call('agent_spawn', {
      ...spawnInput,
      prompt: 'Report that the file is complete.',
      idempotencyKey: 'pi-durable-continue',
      continueFrom: agentId,
      runtime: undefined
    });
    const successorId = continued.data.agentId as string;
    await waitFor(
      () => repository.findAgent(ownerId, workspaceId!, successorId),
      (record) => record !== undefined && terminalAgentStatuses[record.status] === true,
      90_000
    );
    expect((await call('agent_status', { workspaceId, agentId: successorId })).data).toMatchObject({ runtime: 'pi-durable', continuedFrom: agentId });
    expect(existsSync(join(directory, 'state', 'agent-sessions', `${successorId}.sqlite`))).toBe(false);

    await call('workspace_close', { workspaceId });
    workspaceId = undefined;
    expect(existsSync(sessionFile)).toBe(false);
  }, 240_000);
});

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
