import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { HarnessError } from '@cloud-harness/contracts';
import { inspectContainer, runDocker, spawnDocker } from './docker-engine.js';
import type { AgentGatewayControl } from './agent-gateway-control.js';

export type AgentLaunchSpec = {
  ownerId: string;
  workspaceId: string;
  workspaceGeneration: number;
  agentId: string;
  agentGeneration: number;
  containerName: string;
  networkName: string;
  image: string;
  gatewayUrl: string;
};

export type AgentRuntimeProcess = {
  process: ChildProcessWithoutNullStreams;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

export interface AgentLauncher {
  reconcile?(): Promise<void>;
  launch(spec: AgentLaunchSpec): Promise<AgentRuntimeProcess>;
  cleanup(spec: Pick<AgentLaunchSpec, 'containerName' | 'networkName'>, graceMs: number): Promise<void>;
  inspect(spec: Pick<AgentLaunchSpec, 'containerName' | 'networkName'>): Promise<{ container: boolean; network: boolean }>;
}

export class DockerAgentLauncher implements AgentLauncher {
  constructor(private readonly gateway: AgentGatewayControl, private readonly instanceId: string) {}
  async reconcile(): Promise<void> {
    const containers = await runDocker([
      'ps', '-a',
      '--filter', 'label=cloud-harness.agent-container=true',
      '--filter', `label=cloud-harness.instance=${this.instanceId}`,
      '--format', '{{.Names}}'
    ], { timeoutMs: 30_000, maxBytes: 1_048_576 });
    if (containers.exitCode !== 0) {
      throw new HarnessError('UNAVAILABLE', 'agent container inventory failed', 503, true);
    }
    for (const name of containers.stdout.split('\n').filter(Boolean)) {
      const removed = await runDocker(['rm', '--force', name], { timeoutMs: 30_000, maxBytes: 16_384 });
      if (removed.exitCode !== 0 && !/No such container/i.test(removed.stderr)) {
        throw new HarnessError('UNAVAILABLE', 'startup agent container cleanup failed', 503, true);
      }
    }
    const networks = await runDocker([
      'network', 'ls',
      '--filter', 'label=cloud-harness.agent-network=true',
      '--filter', `label=cloud-harness.instance=${this.instanceId}`,
      '--format', '{{.Name}}'
    ], { timeoutMs: 30_000, maxBytes: 1_048_576 });
    if (networks.exitCode !== 0) {
      throw new HarnessError('UNAVAILABLE', 'agent network inventory failed', 503, true);
    }
    const gatewayContainer = await this.gateway.gatewayContainer();
    for (const name of networks.stdout.split('\n').filter(Boolean)) {
      await runDocker(['network', 'disconnect', '--force', name, gatewayContainer], { timeoutMs: 30_000, maxBytes: 16_384 });
      const removed = await runDocker(['network', 'rm', name], { timeoutMs: 30_000, maxBytes: 16_384 });
      if (removed.exitCode !== 0 && !/No such network/i.test(removed.stderr)) {
        throw new HarnessError('UNAVAILABLE', 'startup agent network cleanup failed', 503, true);
      }
    }
  }


  async launch(spec: AgentLaunchSpec): Promise<AgentRuntimeProcess> {
    const gatewayContainer = await this.gateway.gatewayContainer();
    const network = await runDocker([
      'network', 'create', '--internal', '--driver', 'bridge',
      '--label', 'cloud-harness.agent-network=true',
      '--label', `cloud-harness.instance=${this.instanceId}`,
      '--label', `cloud-harness.workspace=${spec.workspaceId}`,
      '--label', `cloud-harness.agent=${spec.agentId}`,
      spec.networkName
    ], { timeoutMs: 30_000, maxBytes: 16_384 });
    if (network.exitCode !== 0) throw new HarnessError('UNAVAILABLE', 'agent network creation failed', 503, true);
    const connected = await runDocker(['network', 'connect', '--alias', 'model-gateway', spec.networkName, gatewayContainer], { timeoutMs: 30_000, maxBytes: 16_384 });
    if (connected.exitCode !== 0) {
      await runDocker(['network', 'rm', spec.networkName], { timeoutMs: 30_000, maxBytes: 16_384 });
      throw new HarnessError('UNAVAILABLE', 'model gateway could not join the agent network', 503, true);
    }

    const child = spawnDocker([
      'run', '--interactive', '--pull', 'never', '--name', spec.containerName,
      '--label', 'cloud-harness.agent-container=true',
      '--label', `cloud-harness.instance=${this.instanceId}`,
      '--label', `cloud-harness.workspace=${spec.workspaceId}`,
      '--label', `cloud-harness.workspace-generation=${spec.workspaceGeneration}`,
      '--label', `cloud-harness.agent=${spec.agentId}`,
      '--label', `cloud-harness.agent-generation=${spec.agentGeneration}`,
      '--network', spec.networkName,
      '--network-alias', `agent-${spec.agentId.slice(-12)}`,
      '--user', '10001:10001', '--read-only',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '256', '--memory', '1g', '--memory-swap', '1g', '--cpus', '1',
      '--env', `AGENT_MODEL_GATEWAY_URL=${spec.gatewayUrl.replace(/\/$/, '')}/v1`,
      '--env', 'HOME=/tmp',
      spec.image
    ]);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    await waitForRunningContainer(spec.containerName, exited);
    return { process: child, exited };
  }

  async cleanup(spec: Pick<AgentLaunchSpec, 'containerName' | 'networkName'>, graceMs: number): Promise<void> {
    const seconds = Math.max(1, Math.ceil(graceMs / 1_000));
    const stopped = await runDocker(['stop', '--time', String(seconds), spec.containerName], {
      timeoutMs: graceMs + 10_000,
      maxBytes: 16_384
    });
    if (stopped.exitCode !== 0 && !/No such container/i.test(stopped.stderr)) {
      const killed = await runDocker(['kill', spec.containerName], { timeoutMs: 10_000, maxBytes: 16_384 });
      if (killed.exitCode !== 0 && !/No such container|is not running/i.test(killed.stderr)) {
        throw new HarnessError('UNAVAILABLE', 'agent container termination failed', 503, true);
      }
    }
    const removed = await runDocker(['rm', '--force', spec.containerName], { timeoutMs: 30_000, maxBytes: 16_384 });
    if (removed.exitCode !== 0 && !/No such container/i.test(removed.stderr)) {
      throw new HarnessError('UNAVAILABLE', 'agent container removal failed', 503, true);
    }
    const gatewayContainer = await this.gateway.gatewayContainer();
    const disconnected = await runDocker(['network', 'disconnect', '--force', spec.networkName, gatewayContainer], {
      timeoutMs: 30_000,
      maxBytes: 16_384
    });
    if (disconnected.exitCode !== 0 && !/No such network|network .* not found|is not connected/i.test(disconnected.stderr)) {
      throw new HarnessError('UNAVAILABLE', 'model gateway network disconnect failed', 503, true);
    }
    const networkRemoved = await runDocker(['network', 'rm', spec.networkName], { timeoutMs: 30_000, maxBytes: 16_384 });
    if (networkRemoved.exitCode !== 0 && !/No such network|network .* not found/i.test(networkRemoved.stderr)) {
      throw new HarnessError('UNAVAILABLE', 'agent network removal failed', 503, true);
    }
    const residual = await this.inspect(spec);
    if (residual.container || residual.network) {
      throw new HarnessError('UNAVAILABLE', 'agent cleanup could not confirm resource removal', 503, true);
    }
  }

  async inspect(spec: Pick<AgentLaunchSpec, 'containerName' | 'networkName'>): Promise<{ container: boolean; network: boolean }> {
    const [container, network] = await Promise.all([
      inspectContainer(spec.containerName),
      runDocker(['network', 'inspect', spec.networkName], { timeoutMs: 10_000, maxBytes: 4_096 })
    ]);
    return { container: container !== undefined, network: network.exitCode === 0 };
  }
}

async function waitForRunningContainer(
  containerName: string,
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
): Promise<void> {
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let launchError: unknown;
  void exited.then(
    (result) => { exit = result; },
    (error: unknown) => { launchError = error; }
  );
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (launchError !== undefined) {
      throw new HarnessError('UNAVAILABLE', 'agent container process failed to start', 503, true);
    }
    if (exit !== undefined) {
      throw new HarnessError('UNAVAILABLE', `agent container exited during startup (${exit.code ?? exit.signal ?? 'unknown'})`, 503, true);
    }
    const inspection = await inspectContainer(containerName);
    if (inspection !== undefined) {
      const state = inspection.State;
      if (state !== null && typeof state === 'object' && 'Running' in state && state.Running === true) return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new HarnessError('TIMEOUT', 'agent container startup timed out', 504, true);
}
