import { hostname } from 'node:os';
import { z } from 'zod';
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
  /** The gateway process that issued the lease. An older gateway omits it. */
  gatewayBootId?: string;
};

const CounterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * The gateway's frozen accounting for a revoked or expired lease. Unknown or
 * negative fields are refused: the ledger charges from it, so a malformed
 * settlement must never be read as a smaller charge.
 */
export const AgentLeaseSettlementSchema = z.object({
  leaseId: z.string().min(1).max(256),
  reason: z.enum(['revoked', 'expired']),
  settledAt: CounterSchema,
  initialInputTokens: CounterSchema,
  initialOutputTokens: CounterSchema,
  initialCostMicros: CounterSchema,
  costMicros: CounterSchema,
  overrunCostMicros: CounterSchema,
  promptTokens: CounterSchema,
  cacheReadTokens: CounterSchema,
  cacheWriteTokens: CounterSchema,
  outputTokens: CounterSchema,
  reasoningTokens: CounterSchema,
  requests: CounterSchema,
  requestsWithoutUsage: CounterSchema
}).strict();
export type AgentLeaseSettlement = z.infer<typeof AgentLeaseSettlementSchema>;

/**
 * The outcome of a revoke. `gatewayBootId` and `settlement` are additive: an
 * older gateway sends neither, and a gateway that never issued the lease (for
 * example after a restart) sends no settlement.
 */
export type AgentLeaseRevocation = {
  revoked: boolean;
  gatewayBootId?: string;
  settlement?: AgentLeaseSettlement;
};

const BootIdSchema = z.string().min(1).max(256);
const IssueResponseSchema = z.object({ gatewayBootId: BootIdSchema.optional() });
const RevokeResponseSchema = z.object({
  revoked: z.boolean().optional(),
  gatewayBootId: BootIdSchema.optional(),
  settlement: AgentLeaseSettlementSchema.optional()
});

export interface AgentGatewayControl {
  gatewayContainer(): Promise<string>;
  issue(input: Omit<AgentLeaseGrant, 'lease' | 'gatewayBootId'>): Promise<AgentLeaseGrant>;
  /** Revokes the lease after its in-flight requests drain. A fake or older control may return nothing. */
  revokeAndDrain(leaseId: string): Promise<AgentLeaseRevocation | void>;
  cancelAndDrain(requestId: string): Promise<void>;
  applySnapshot(snapshot: {
    credentials: Record<string, { provider: string; authMode?: string; secret: string }>;
    profiles: Record<string, unknown>;
    generation?: number;
    sequence?: number;
  }): Promise<{ gatewayBootId: string; snapshotDigest: string }>;
  queryDigest(): Promise<{ gatewayBootId: string; snapshotDigest: string; activeProfileCount: number; activeCredentialCount: number; activeLeaseCount: number }>;
}

type ControlResponse = {
  ok: boolean;
  lease?: string;
  ack?: { gatewayBootId: string; snapshotDigest: string };
  digest?: { gatewayBootId: string; snapshotDigest: string; activeProfileCount: number; activeCredentialCount: number; activeLeaseCount: number };
  error?: string;
};

export class DockerAgentGatewayControl implements AgentGatewayControl {
  private resolvedContainer?: Promise<string>;

  constructor(private readonly explicitContainer?: string) {}

  gatewayContainer(): Promise<string> {
    this.resolvedContainer ??= this.resolveGatewayContainer();
    return this.resolvedContainer;
  }

  async issue(input: Omit<AgentLeaseGrant, 'lease' | 'gatewayBootId'>): Promise<AgentLeaseGrant> {
    const response = await this.control({ operation: 'issue', ...input });
    if (!response.lease || !/^[A-Za-z0-9_-]{43,512}$/.test(response.lease)) {
      throw new HarnessError('UNAVAILABLE', 'model gateway omitted the issued lease', 503, true);
    }
    const parsed = IssueResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new HarnessError('UNAVAILABLE', 'model gateway returned an invalid lease issue response', 503, true);
    }
    return {
      ...input,
      lease: response.lease,
      ...(parsed.data.gatewayBootId === undefined ? {} : { gatewayBootId: parsed.data.gatewayBootId })
    };
  }

  async revokeAndDrain(leaseId: string): Promise<AgentLeaseRevocation> {
    const response = await this.control({ operation: 'revoke', leaseId });
    const parsed = RevokeResponseSchema.safeParse(response);
    if (!parsed.success || (parsed.data.settlement !== undefined && parsed.data.settlement.leaseId !== leaseId)) {
      throw new HarnessError('UNAVAILABLE', 'model gateway returned an invalid lease settlement', 503, true);
    }
    const { revoked, gatewayBootId, settlement } = parsed.data;
    return {
      revoked: revoked === true,
      ...(gatewayBootId === undefined ? {} : { gatewayBootId }),
      ...(settlement === undefined ? {} : { settlement })
    };
  }

  async cancelAndDrain(requestId: string): Promise<void> {
    await this.control({ operation: 'cancel', requestId });
  }

  async applySnapshot(snapshot: {
    credentials: Record<string, { provider: string; authMode?: string; secret: string }>;
    profiles: Record<string, unknown>;
    generation?: number;
    sequence?: number;
  }): Promise<{ gatewayBootId: string; snapshotDigest: string }> {
    const response = await this.control({
      operation: 'apply_snapshot',
      sequence: snapshot.sequence ?? 1,
      generation: snapshot.generation ?? 1,
      credentials: snapshot.credentials,
      profiles: snapshot.profiles
    }, 1_048_576);
    if (!response.ack) {
      throw new HarnessError('UNAVAILABLE', 'model gateway omitted snapshot ack', 503, true);
    }
    return response.ack;
  }

  async queryDigest(): Promise<{ gatewayBootId: string; snapshotDigest: string; activeProfileCount: number; activeCredentialCount: number; activeLeaseCount: number }> {
    const response = await this.control({ operation: 'digest' });
    if (!response.digest) {
      throw new HarnessError('UNAVAILABLE', 'model gateway omitted status digest', 503, true);
    }
    return response.digest;
  }
  private async control(command: Record<string, unknown>, maxBytes = 65_536): Promise<ControlResponse> {
    const container = await this.gatewayContainer();
    const result = await runDocker(
      ['exec', '-i', container, 'node', 'apps/model-gateway/dist/control-client.js'],
      { stdin: `${JSON.stringify(command)}\n`, timeoutMs: 30_000, maxBytes }
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
