import { createHash } from 'node:crypto';
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

/**
 * The gateway answered the control record with an explicit `{ ok: false }`
 * refusal. The gateway validates a record completely before it acts, so a
 * refused `issue` created no lease and nothing can be spent on it. Every other
 * failure (the exec failing, a timeout, an unparseable answer) is ambiguous:
 * the gateway may have acted before the answer was lost.
 */
export class GatewayControlRejection extends HarnessError {
  constructor(readonly gatewayError: string) {
    super('UNAVAILABLE', `model gateway rejected control request: ${gatewayError}`.slice(0, 2_000), 503, true);
    this.name = 'GatewayControlRejection';
  }
}

const CounterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/**
 * Ten million dollars in micros, ten times the largest spend policy limit. No
 * single run costs that, so a larger amount is a corrupt answer, not a charge.
 */
const SETTLEMENT_COST_MAX_MICROS = 10_000_000_000_000;
const CostMicrosSchema = CounterSchema.max(SETTLEMENT_COST_MAX_MICROS);

/**
 * The gateway's frozen accounting for a revoked or expired lease. Unknown keys
 * are stripped so a newer gateway stays compatible; a missing, negative,
 * non-integer, or implausibly large value makes the settlement invalid, because
 * the ledger charges from it and a malformed settlement must never be read as a
 * smaller charge.
 */
export const AgentLeaseSettlementSchema = z.object({
  leaseId: z.string().min(1).max(256),
  reason: z.enum(['revoked', 'expired']),
  settledAt: CounterSchema,
  initialInputTokens: CounterSchema,
  initialOutputTokens: CounterSchema,
  initialCostMicros: CostMicrosSchema,
  costMicros: CostMicrosSchema,
  overrunCostMicros: CostMicrosSchema,
  promptTokens: CounterSchema,
  cacheReadTokens: CounterSchema,
  cacheWriteTokens: CounterSchema,
  outputTokens: CounterSchema,
  reasoningTokens: CounterSchema,
  requests: CounterSchema,
  requestsWithoutUsage: CounterSchema
});
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
  /**
   * The gateway sent a settlement the runner cannot trust (invalid values, another
   * lease id, or an unreadable boot id). The revoke itself succeeded, so cleanup
   * proceeds, and the ledger charges the lease its whole reservation.
   */
  settlementInvalid?: true;
};

/**
 * True when the gateway's refusal of an `issue` proves no lease exists for the id.
 * The gateway refuses a lease id it already holds (`lease-registry.ts`), and that
 * refusal means the lease does exist, for example when an earlier issue succeeded
 * but its answer was lost, so it is ambiguous like any transport failure.
 */
export function isDefiniteIssueRefusal(error: unknown): boolean {
  return error instanceof GatewayControlRejection && error.gatewayError !== 'leaseId already registered';
}

const BootIdSchema = z.string().min(1).max(256);
const IssueResponseSchema = z.object({ gatewayBootId: BootIdSchema.optional() });
export type GatewaySnapshot = {
  credentials: Record<string, { provider: string; authMode?: string; secret: string }>;
  profiles: Record<string, unknown>;
  generation?: number;
  sequence?: number;
};

/** The control command the runner sends to apply a snapshot. */
function snapshotCommand(snapshot: GatewaySnapshot): Record<string, unknown> {
  return {
    operation: 'apply_snapshot',
    sequence: snapshot.sequence ?? 1,
    generation: snapshot.generation ?? 1,
    credentials: snapshot.credentials,
    profiles: snapshot.profiles
  };
}

/**
 * The `snapshotDigest` the gateway acks after applying this snapshot. The gateway hashes
 * the exact control record it receives (apps/model-gateway/src/control.ts), and the runner
 * sends `JSON.stringify` of the snapshot command as that record, so the digest is
 * reproducible here without contacting the gateway.
 */
export function gatewaySnapshotDigest(snapshot: GatewaySnapshot): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(snapshotCommand(snapshot)), 'utf8').digest('hex')}`;
}

/** Outcome of this runner process's snapshot pushes, whichever component made them. */
export type GatewaySnapshotPushState = {
  /** When a push last succeeded, or null when none has since the runner started. */
  lastSuccessAt: number | null;
  /** Why the latest push failed, or null when it succeeded or none was made. */
  lastError: string | null;
};

/** A snapshot builder. It runs inside the push section, so it reads the state as of the push. */
export type GatewaySnapshotBuilder = () => GatewaySnapshot | Promise<GatewaySnapshot>;

/** The result of one snapshot sync. */
export type GatewaySnapshotSync = {
  gatewayBootId: string;
  /** The digest the gateway holds after the sync. */
  gatewayDigest: string;
  /** The digest of the snapshot built during the sync, the runner's current state. */
  expectedDigest: string;
  pushed: boolean;
};

export type GatewaySnapshotSyncOptions = {
  /** Query the gateway first and push only when its digest differs from the built snapshot. */
  onlyIfMismatch: boolean;
  /** Called with the gateway's answer to the query, before any push, so a caller keeps it when the push fails. */
  onQueried?: (digest: { gatewayBootId: string; snapshotDigest: string }) => void;
};

export interface AgentGatewayControl {
  gatewayContainer(): Promise<string>;
  issue(input: Omit<AgentLeaseGrant, 'lease' | 'gatewayBootId'>): Promise<AgentLeaseGrant>;
  /** Revokes the lease after its in-flight requests drain. A fake or older control may return nothing. */
  revokeAndDrain(leaseId: string): Promise<AgentLeaseRevocation | void>;
  cancelAndDrain(requestId: string): Promise<void>;
  queryDigest(): Promise<{ gatewayBootId: string; snapshotDigest: string; activeProfileCount: number; activeCredentialCount: number; activeLeaseCount: number }>;
  /** The shared record of every snapshot push outcome. Optional so lease-only test doubles stay small. */
  snapshotPushState?(): GatewaySnapshotPushState;
  /**
   * The only way to push a snapshot. Builds and, when needed, pushes it in one section, serialized
   * against every other sync on this control, so a snapshot is always built after the previous push
   * landed and an older snapshot never lands over a newer one.
   */
  syncSnapshot(build: GatewaySnapshotBuilder, options: GatewaySnapshotSyncOptions): Promise<GatewaySnapshotSync>;
}

type GatewayDigest = { gatewayBootId: string; snapshotDigest: string };

/**
 * One sync, unserialized: query (when asked), build after the query answered, compare, push.
 * DockerAgentGatewayControl runs it inside its push queue; a control with no concurrent callers,
 * such as a test double, may call it directly.
 */
export async function runSnapshotSync(
  query: () => Promise<GatewayDigest>,
  apply: (snapshot: GatewaySnapshot) => Promise<GatewayDigest>,
  build: GatewaySnapshotBuilder,
  options: GatewaySnapshotSyncOptions
): Promise<GatewaySnapshotSync> {
  if (options.onlyIfMismatch) {
    const digest = await query();
    options.onQueried?.(digest);
    const snapshot = await build();
    const expectedDigest = gatewaySnapshotDigest(snapshot);
    if (digest.snapshotDigest === expectedDigest) {
      return { gatewayBootId: digest.gatewayBootId, gatewayDigest: digest.snapshotDigest, expectedDigest, pushed: false };
    }
    const ack = await apply(snapshot);
    return { gatewayBootId: ack.gatewayBootId, gatewayDigest: ack.snapshotDigest, expectedDigest, pushed: true };
  }
  const snapshot = await build();
  const ack = await apply(snapshot);
  return { gatewayBootId: ack.gatewayBootId, gatewayDigest: ack.snapshotDigest, expectedDigest: gatewaySnapshotDigest(snapshot), pushed: true };
}

/** A queued sync section that has not started yet. Later syncs join it instead of queueing another. */
type PendingSnapshotSync = {
  build: GatewaySnapshotBuilder;
  forced: boolean;
  listeners: Array<(digest: GatewayDigest) => void>;
  result: Promise<GatewaySnapshotSync>;
};

type ControlResponse = {
  ok: boolean;
  lease?: string;
  ack?: { gatewayBootId: string; snapshotDigest: string };
  digest?: { gatewayBootId: string; snapshotDigest: string; activeProfileCount: number; activeCredentialCount: number; activeLeaseCount: number };
  error?: string;
};

export class DockerAgentGatewayControl implements AgentGatewayControl {
  private resolvedContainer?: Promise<string>;
  private pushState: GatewaySnapshotPushState = { lastSuccessAt: null, lastError: null };
  /** The tail of the snapshot push queue. It never rejects, so a failed push does not block later ones. */
  private pushQueue: Promise<unknown> = Promise.resolve();
  private pendingSync: PendingSnapshotSync | undefined;

  constructor(
    private readonly explicitContainer?: string,
    private readonly now: () => number = Date.now
  ) {}

  snapshotPushState(): GatewaySnapshotPushState {
    return { ...this.pushState };
  }

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
    const response = await this.control({ operation: 'revoke', leaseId }) as ControlResponse & Record<string, unknown>;
    const revoked = response.revoked === true;
    const bootId = response.gatewayBootId === undefined ? undefined : BootIdSchema.safeParse(response.gatewayBootId);
    const gatewayBootId = bootId?.success === true ? { gatewayBootId: bootId.data } : {};
    if (response.settlement === undefined) return { revoked, ...gatewayBootId };
    const settlement = AgentLeaseSettlementSchema.safeParse(response.settlement);
    if (!settlement.success || settlement.data.leaseId !== leaseId || bootId?.success === false) {
      return { revoked, ...gatewayBootId, settlementInvalid: true };
    }
    return { revoked, ...gatewayBootId, settlement: settlement.data };
  }

  async cancelAndDrain(requestId: string): Promise<void> {
    await this.control({ operation: 'cancel', requestId });
  }

  /**
   * Queues one sync section. A section that has not started yet is joined rather than followed by
   * another: its build runs only when the section starts, so it already reads the latest state, and a
   * forced call upgrades it to a forced push. Every joined caller gets that section's result.
   *
   * At most one section is in flight and one pending, so a caller waits for at most two sections,
   * each bounded by the control request timeout. That remaining wait is the accepted cost of never
   * letting an older snapshot land over a newer one.
   */
  syncSnapshot(build: GatewaySnapshotBuilder, options: GatewaySnapshotSyncOptions): Promise<GatewaySnapshotSync> {
    const pending = this.pendingSync;
    if (pending) {
      pending.build = build;
      if (!options.onlyIfMismatch) pending.forced = true;
      if (options.onQueried) pending.listeners.push(options.onQueried);
      return pending.result;
    }
    const start = () => this.runSection(section);
    const section: PendingSnapshotSync = {
      build,
      forced: !options.onlyIfMismatch,
      listeners: options.onQueried ? [options.onQueried] : [],
      // The queue callback always runs after this method returns, so `section` is initialized by then.
      result: this.pushQueue.then(start, start)
    };
    this.pendingSync = section;
    this.pushQueue = section.result.catch(() => undefined);
    return section.result;
  }

  private runSection(section: PendingSnapshotSync): Promise<GatewaySnapshotSync> {
    // From here on the section is running, so a later sync queues behind it instead of joining.
    if (this.pendingSync === section) this.pendingSync = undefined;
    return runSnapshotSync(() => this.queryDigest(), (snapshot) => this.pushNow(snapshot), () => section.build(), {
      onlyIfMismatch: !section.forced,
      onQueried: (digest) => { for (const listener of section.listeners) listener(digest); }
    });
  }

  /** One push, recorded. Only called inside the push queue, so outcomes are recorded in push order. */
  private async pushNow(snapshot: GatewaySnapshot): Promise<{ gatewayBootId: string; snapshotDigest: string }> {
    try {
      const response = await this.control(snapshotCommand(snapshot), 1_048_576);
      if (!response.ack) {
        throw new HarnessError('UNAVAILABLE', 'model gateway omitted snapshot ack', 503, true);
      }
      this.pushState = { lastSuccessAt: this.now(), lastError: null };
      return response.ack;
    } catch (err) {
      this.pushState = { lastSuccessAt: this.pushState.lastSuccessAt, lastError: err instanceof Error ? err.message : 'snapshot push failed' };
      throw err;
    }
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
    if (typeof response !== 'object' || response === null || (response.ok !== true && response.ok !== false)) {
      throw new HarnessError('UNAVAILABLE', 'model gateway returned an invalid control response', 503, true);
    }
    if (!response.ok) {
      throw new GatewayControlRejection(typeof response.error === 'string' ? response.error : 'unknown error');
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
