import { hostname } from 'node:os';
import { HarnessError } from '@cloud-harness/contracts';
import { runDocker } from './docker-engine.js';

export type AgentLeaseGrant = {
  leaseId: string;
  lease: string;
  agentId: string;
  profileId: string;
  ttlMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostMicros: number;
};

export interface AgentGatewayControl {
  gatewayContainer(): Promise<string>;
  issue(input: Omit<AgentLeaseGrant, 'lease'>): Promise<AgentLeaseGrant>;
  revokeAndDrain(leaseId: string): Promise<void>;
  cancelAndDrain(requestId: string): Promise<void>;
}

type ControlResponse = { ok: boolean; lease?: string; error?: string };

export class DockerAgentGatewayControl implements AgentGatewayControl {
  private resolvedContainer?: Promise<string>;

  constructor(private readonly explicitContainer?: string) {}

  gatewayContainer(): Promise<string> {
    this.resolvedContainer ??= this.resolveGatewayContainer();
    return this.resolvedContainer;
  }

  async issue(input: Omit<AgentLeaseGrant, 'lease'>): Promise<AgentLeaseGrant> {
    const response = await this.control({ operation: 'issue', ...input });
    if (!response.lease || !/^[A-Za-z0-9_-]{43,512}$/.test(response.lease)) {
      throw new HarnessError('UNAVAILABLE', 'model gateway omitted the issued lease', 503, true);
    }
    return { ...input, lease: response.lease };
  }

  async revokeAndDrain(leaseId: string): Promise<void> {
    await this.control({ operation: 'revoke', leaseId });
  }

  async cancelAndDrain(requestId: string): Promise<void> {
    await this.control({ operation: 'cancel', requestId });
  }

  private async control(command: Record<string, unknown>): Promise<ControlResponse> {
    const container = await this.gatewayContainer();
    const result = await runDocker(
      ['exec', '-i', container, 'node', 'apps/model-gateway/dist/control-client.js'],
      { stdin: `${JSON.stringify(command)}\n`, timeoutMs: 30_000, maxBytes: 16_384 }
    );
    if (result.exitCode !== 0) {
      throw new HarnessError('UNAVAILABLE', 'model gateway control request failed', 503, true);
    }
    let response: ControlResponse;
    try {
      response = JSON.parse(result.stdout.trim()) as ControlResponse;
    } catch {
      throw new HarnessError('UNAVAILABLE', 'model gateway returned an invalid control response', 503, true);
    }
    if (!response.ok) {
      throw new HarnessError('UNAVAILABLE', `model gateway rejected control request: ${response.error ?? 'unknown error'}`.slice(0, 2_000), 503, true);
    }
    return response;
  }

  private async resolveGatewayContainer(): Promise<string> {
    if (this.explicitContainer) return this.explicitContainer;
    const self = await runDocker([
      'inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project" }}', hostname()
    ], { timeoutMs: 10_000, maxBytes: 1_024 });
    const project = self.exitCode === 0 ? self.stdout.trim() : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(project)) {
      throw new HarnessError('UNAVAILABLE', 'runner Compose project label is unavailable for gateway discovery', 503, false);
    }
    const inventory = await runDocker([
      'ps', '-a',
      '--filter', `label=com.docker.compose.project=${project}`,
      '--filter', 'label=com.docker.compose.service=model-gateway',
      '--format', '{{.Names}}'
    ], { timeoutMs: 10_000, maxBytes: 8_192 });
    const names = inventory.stdout.split('\n').filter(Boolean);
    if (inventory.exitCode !== 0 || names.length !== 1) {
      throw new HarnessError('UNAVAILABLE', 'scoped model gateway container discovery failed', 503, true);
    }
    return names[0]!;
  }
}
