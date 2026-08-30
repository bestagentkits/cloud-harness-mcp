import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HarnessError } from '@cloud-harness/contracts';
import { DockerAgentGatewayControl } from '../../apps/runner/src/agent-gateway-control.js';
import { DockerAgentLauncher, type AgentLaunchSpec } from '../../apps/runner/src/agent-launcher.js';
import { inspectContainer, runDocker } from '../../apps/runner/src/docker-engine.js';
import {
  dockerPrerequisiteIssue,
  requireDockerPrerequisites,
  startGatewayTestStack,
  stopGatewayTestStack,
  type GatewayTestStack
} from '../agent-docker-test-support.js';

const prerequisiteIssue = dockerPrerequisiteIssue([
  'cloud-harness-agent:local',
  'cloud-harness-model-gateway:local'
]);
requireDockerPrerequisites(prerequisiteIssue);
const specs: AgentLaunchSpec[] = [];
let stack: GatewayTestStack;
let launcher: DockerAgentLauncher;
let instanceId: string;

beforeAll(() => {
  if (prerequisiteIssue) return;
  stack = startGatewayTestStack('ch-agent-isolation');
  instanceId = `test-${randomBytes(6).toString('hex')}`;
  launcher = new DockerAgentLauncher(new DockerAgentGatewayControl(stack.gatewayContainer), instanceId);
}, 120_000);

afterAll(async () => {
  if (launcher) {
    for (const spec of specs.splice(0)) await forceCleanup(spec);
  }
  if (stack) stopGatewayTestStack(stack);
}, 120_000);

describe.skipIf(Boolean(prerequisiteIssue))('real agent Docker isolation', () => {
  it('gives each agent only its internal gateway network and removes every resource', async () => {
    const first = launchSpec('first');
    const second = launchSpec('second');
    specs.push(first, second);
    await Promise.all([launcher.launch(first), launcher.launch(second)]);

    const gatewayContainerName = await gatewayName(stack.gatewayContainer);
    const firstInspection = requireContainerInspection(await inspectContainer(first.containerName));
    const secondInspection = requireContainerInspection(await inspectContainer(second.containerName));
    for (const [spec, inspection] of [[first, firstInspection], [second, secondInspection]] as const) {
      expect(inspection.Config.User).toBe('10001:10001');
      expect(inspection.Config.Labels).toMatchObject({
        'cloud-harness.agent-container': 'true',
        'cloud-harness.workspace': spec.workspaceId,
        'cloud-harness.workspace-generation': String(spec.workspaceGeneration),
        'cloud-harness.agent': spec.agentId,
        'cloud-harness.agent-generation': String(spec.agentGeneration)
      });
      expect(inspection.HostConfig.ReadonlyRootfs).toBe(true);
      expect(inspection.HostConfig.CapDrop).toContain('ALL');
      expect(inspection.HostConfig.SecurityOpt).toContain('no-new-privileges');
      expect(inspection.HostConfig.PidsLimit).toBe(256);
      expect(inspection.HostConfig.Memory).toBe(1_073_741_824);
      expect(inspection.HostConfig.MemorySwap).toBe(1_073_741_824);
      expect(inspection.HostConfig.NanoCpus).toBe(1_000_000_000);
      expect(inspection.HostConfig.Binds ?? []).toEqual([]);
      expect(inspection.Mounts).toEqual([]);
      expect(inspection.HostConfig.PortBindings ?? {}).toEqual({});
      expect(inspection.NetworkSettings.Ports ?? {}).toEqual({});
      expect(Object.keys(inspection.NetworkSettings.Networks)).toEqual([spec.networkName]);
      expect(JSON.stringify(inspection.Config.Env)).not.toMatch(/docker\.sock|provider-api-key|credential|repository|control|runner/i);
    }

    expect(first.networkName).not.toBe(second.networkName);
    const gatewayInspection = requireContainerInspection(await inspectContainer(stack.gatewayContainer));
    expect(Object.keys(gatewayInspection.NetworkSettings.Networks)).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/control|runner|frontend/u)
    ]));
    for (const spec of [first, second]) {
      const network = await inspectNetwork(spec.networkName);
      expect(network.Internal).toBe(true);
      expect(network.Labels).toMatchObject({
        'cloud-harness.agent-network': 'true',
        'cloud-harness.workspace': spec.workspaceId,
        'cloud-harness.agent': spec.agentId
      });
      expect(Object.values(network.Containers).map((container) => container.Name).sort()).toEqual([
        spec.containerName,
        gatewayContainerName
      ].sort());
    }

    await expectTcp(first.containerName, 'model-gateway', 3210, true);
    await expectTcp(first.containerName, `agent-${second.agentId.slice(-12)}`, 3210, false);
    await expectTcp(first.containerName, 'runner', 3001, false);
    await expectTcp(first.containerName, 'api', 3000, false);
    await expectTcp(first.containerName, 'fake-provider', 3443, false);
    await expectTcp(first.containerName, '169.254.169.254', 80, false);
    await expectTcp(first.containerName, '1.1.1.1', 443, false);

    await Promise.all([launcher.cleanup(first, 1_000), launcher.cleanup(second, 1_000)]);
    specs.splice(0);
    expect(await inspectContainer(first.containerName)).toBeUndefined();
    expect(await inspectContainer(second.containerName)).toBeUndefined();
    expect((await runDocker(['network', 'inspect', first.networkName])).exitCode).not.toBe(0);
    expect((await runDocker(['network', 'inspect', second.networkName])).exitCode).not.toBe(0);
  }, 60_000);

  it('removes orphaned agent containers and networks during startup reconciliation', async () => {
    const orphan = launchSpec('restart');
    specs.push(orphan);
    await launcher.launch(orphan);
    const restarted = new DockerAgentLauncher(
      new DockerAgentGatewayControl(stack.gatewayContainer),
      instanceId
    );
    await restarted.reconcile();
    specs.splice(specs.indexOf(orphan), 1);
    expect(await inspectContainer(orphan.containerName)).toBeUndefined();
    expect((await runDocker(['network', 'inspect', orphan.networkName])).exitCode).not.toBe(0);
  }, 60_000);
});

function launchSpec(label: string): AgentLaunchSpec {
  const suffix = randomBytes(8).toString('hex');
  return {
    ownerId: 'owner',
    workspaceId: `ws_${label}_${suffix}`,
    workspaceGeneration: 1,
    agentId: `agent_${label}_${suffix}`,
    agentGeneration: 1,
    containerName: `ch-agent-test-${label}-${suffix}`,
    networkName: `ch-agent-test-net-${label}-${suffix}`,
    image: 'cloud-harness-agent:local',
    gatewayUrl: 'http://model-gateway:3210'
  };
}

type ContainerInspection = {
  Config: { User: string; Env: string[]; Labels: Record<string, string> };
  HostConfig: {
    ReadonlyRootfs: boolean;
    CapDrop: string[];
    SecurityOpt: string[];
    PidsLimit: number;
    Memory: number;
    MemorySwap: number;
    NanoCpus: number;
    Binds: string[] | null;
    PortBindings: Record<string, unknown> | null;
  };
  Mounts: unknown[];
  NetworkSettings: { Ports: Record<string, unknown> | null; Networks: Record<string, unknown> };
};

function requireContainerInspection(value: unknown): ContainerInspection {
  if (value === undefined || value === null || typeof value !== 'object') throw new Error('agent container was not inspectable');
  return value as ContainerInspection;
}

type NetworkInspection = {
  Internal: boolean;
  Labels: Record<string, string>;
  Containers: Record<string, { Name: string }>;
};

async function inspectNetwork(name: string): Promise<NetworkInspection> {
  const result = await runDocker(['network', 'inspect', name], { timeoutMs: 10_000, maxBytes: 262_144 });
  expect(result.exitCode, result.stderr).toBe(0);
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0] === null || typeof parsed[0] !== 'object') {
    throw new Error('Docker returned an invalid network inspection');
  }
  return parsed[0] as NetworkInspection;
}

async function expectTcp(container: string, host: string, port: number, reachable: boolean): Promise<void> {
  // This probes the real Docker network; a bounded real socket timeout is the negative reachability signal.
  const script = "const net=require('node:net');const s=net.connect(Number(process.argv[2]),process.argv[1]);const done=c=>{s.destroy();process.exit(c)};s.once('connect',()=>done(0));s.once('error',()=>done(1));s.setTimeout(1000,()=>done(1));";
  const result = await runDocker(['exec', container, 'node', '-e', script, host, String(port)], {
    timeoutMs: 3_000,
    maxBytes: 4_096
  }).catch((error: unknown) => {
    if (!reachable && error instanceof HarnessError && error.code === 'TIMEOUT') return undefined;
    throw error;
  });
  if (result === undefined) return;
  expect(result.exitCode === 0, `${host}:${port} unexpectedly ${reachable ? 'unreachable' : 'reachable'}: ${result.stderr}`).toBe(reachable);
}

async function gatewayName(containerId: string): Promise<string> {
  const result = await runDocker(['inspect', '--format', '{{.Name}}', containerId], { timeoutMs: 10_000, maxBytes: 4_096 });
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.replace(/^\//u, '').trim();
}

async function forceCleanup(spec: AgentLaunchSpec): Promise<void> {
  try {
    await launcher.cleanup(spec, 1_000);
    return;
  } catch {
    await runDocker(['rm', '--force', spec.containerName], { timeoutMs: 10_000, maxBytes: 4_096 });
    if (stack) {
      await runDocker(['network', 'disconnect', '--force', spec.networkName, stack.gatewayContainer], {
        timeoutMs: 10_000,
        maxBytes: 4_096
      });
    }
    await runDocker(['network', 'rm', spec.networkName], { timeoutMs: 10_000, maxBytes: 4_096 });
  }
}
