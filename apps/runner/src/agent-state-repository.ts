import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  AgentProxyOperationSchema,
  HarnessError,
  type AgentBudget,
  type AgentMessageDeliveryState,
  type AgentMessageMode,
  type AgentProxyOperation,
  type AgentProxyReplayClass,
  type AgentStatus,
  type AgentUsage,
  type RunnerAgentLimits
} from '@cloud-harness/contracts';
import { emitAgentTerminalEvent, withEventSavepoint } from './event-outbox.js';
import type { EffectPreEntry } from './agent-effect-reconciler.js';

const EFFECT_PRE_ENTRIES: ReadonlySet<string> = new Set<EffectPreEntry>(['file', 'directory', 'absent']);

const ACTIVE_STATUSES: AgentStatus[] = ['SPAWNING', 'RUNNING', 'CANCELLING'];
const TERMINAL_STATUSES: AgentStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED'];
const STATUS_TRANSITIONS: Record<AgentStatus, readonly AgentStatus[]> = {
  SPAWNING: ['RUNNING', 'CANCELLING', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED'],
  RUNNING: ['CANCELLING'],
  CANCELLING: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
  LIMIT_EXCEEDED: [],
  INTERRUPTED: []
};

export type AgentRecord = {
  id: string;
  ownerId: string;
  workspaceId: string;
  workspaceGeneration: number;
  parentAgentId: string | null;
  parentGeneration: number | null;
  idempotencyKey: string;
  payloadHash: string;
  promptHash: string;
  profileId: string;
  proxyOperations: AgentProxyOperation[];
  budget: AgentBudget;
  containerName: string;
  networkName: string;
  gatewayLeaseId: string;
  status: AgentStatus;
  generation: number;
  runtimeEpoch: number;
  spawnAdmissionOpen: boolean;
  messageAdmissionOpen: boolean;
  createdAt: number;
  startedAt: number | null;
  terminalAt: number | null;
  expiresAt: number;
  terminalReason: string | null;
  cleanupReason: string | null;
  outcomeUnknown: boolean;
};

export type AgentTombstone = {
  ownerId: string;
  workspaceId: string;
  agentId: string;
  idempotencyKey: string;
  payloadHash: string;
  status: AgentStatus;
  generation: number;
  createdAt: number;
  expiresAt: number;
};

export type AgentMessageRecord = {
  ownerId: string;
  workspaceId: string;
  agentId: string;
  agentGeneration: number;
  runnerEpoch: number;
  idempotencyKey: string;
  payloadHash: string;
  mode: AgentMessageMode;
  state: AgentMessageDeliveryState;
  createdAt: number;
  updatedAt: number;
  error: string | null;
};

export type AgentEffectState = 'INTENT' | 'DISPATCHED' | 'APPLIED' | 'REJECTED' | 'UNKNOWN';

export type AgentEffectRecord = {
  ownerId: string;
  workspaceId: string;
  /** The agent that first reserved the effect; a continuation may later reconcile it. */
  agentId: string;
  agentGeneration: number;
  runnerEpoch: number;
  /** The lineage root: the first agent of a chain of continuations, or the agent itself. */
  rootAgentId: string;
  requestId: string;
  kind: string;
  payloadHash: string;
  state: AgentEffectState;
  replayClass: AgentProxyReplayClass | null;
  preImageSha256: string | null;
  intendedSha256: string | null;
  /** What a delete's or mkdir's path, or a move's source, was just before dispatch, when observed. */
  preEntry: EffectPreEntry | null;
  /** The exact tool-result text the model received, while the receipt is retained. */
  resultJson: string | null;
  resultSha256: string | null;
  /** The stored result was synthesized from observed workspace state after an unknown outcome. */
  reconciled: boolean;
  executorGeneration: number | null;
  workspaceGeneration: number | null;
  retainUntil: number | null;
  createdAt: number;
  updatedAt: number;
};

/** Identifies the agent writing effect state; every write checks that it is still the live owner. */
export type AgentEffectFence = {
  ownerId: string;
  workspaceId: string;
  agentId: string;
  agentGeneration: number;
  runnerEpoch: number;
};

/** The key of an effect within an agent lineage. */
export type AgentEffectKey = { rootAgentId: string; requestId: string; kind: string };

/** Mirrors the agent protocol tool-result text bound; a receipt never holds more than the model received. */
export const MAX_AGENT_EFFECT_RECEIPT_BYTES = 2 * 1024 * 1024;
const EFFECT_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type AgentLogEvent = {
  cursor: string;
  nextCursor: string;
  timestamp: number;
  type: string;
  content: string;
};

export type AgentLogPage = {
  cursor: string;
  nextCursor: string;
  retainedBaseCursor: string;
  events: AgentLogEvent[];
  truncated: boolean;
  hasMore: boolean;
};

export type AgentListPageRequest = {
  limit: number;
  cursor?: string;
  parentAgentId?: string;
  status?: AgentStatus;
};

export type AgentListPage = {
  records: AgentRecord[];
  nextCursor: string | null;
};

export type AgentSpawnReservation = {
  id: string;
  ownerId: string;
  workspaceId: string;
  workspaceGeneration: number;
  parentAgentId?: string;
  idempotencyKey: string;
  payloadHash: string;
  promptHash: string;
  profileId: string;
  proxyOperations: AgentProxyOperation[];
  budget: AgentBudget;
  containerName: string;
  networkName: string;
  gatewayLeaseId: string;
  runtimeEpoch?: number;
  now: number;
  expiresAt: number;
  /**
   * Present when the instance persists agent sessions, so the decision is recorded at spawn. With
   * `continuedFrom`, the new session starts as a copy of that predecessor's sealed log.
   */
  session?: {
    continuedFrom?: string;
    /**
     * Runs inside the spawn transaction with the verified predecessor and the size of its log,
     * before any spend admission.
     */
    admitContinuation?: (predecessor: AgentRecord, log: { bytes: number; messageCount: number }) => void;
  };
  /**
   * Runs inside the spawn transaction after the replay, capacity, and TTL checks
   * and before the agent row is written, so a replay never calls it and
   * concurrent spawns are serialised. Throwing refuses the spawn and rolls back
   * whatever it wrote.
   */
  admit?: () => void;
};
export type AgentStatusTransition = {
  ownerId: string;
  workspaceId: string;
  agentId: string;
  generation: number;
  runtimeEpoch?: number;
  expectedStatuses: AgentStatus[];
  status: AgentStatus;
  now: number;
  terminalReason?: string | null;
  cleanupReason?: string | null;
  outcomeUnknown?: boolean;
};


export type AgentUsageDelta = Partial<AgentUsage>;

export type AgentSessionState = 'ACTIVE' | 'SEALED' | 'PURGED';

export type AgentSessionRecord = {
  agentId: string;
  ownerId: string;
  workspaceId: string;
  workspaceGeneration: number;
  rootAgentId: string;
  continuedFrom: string | null;
  messageCount: number;
  bytes: number;
  headSha256: string;
  state: AgentSessionState;
  continuable: boolean;
  retainUntil: number | null;
  createdAt: number;
  updatedAt: number;
};

/** The outcome of offering one worker `session_message` record to the store. */
export type AgentSessionAppendResult =
  /** Stored as the next message of the log. */
  | 'APPENDED'
  /** The writer lost its lifecycle fence (stale epoch or generation, or the agent is not running). */
  | 'FENCED'
  /** The agent records no session, or its log already stopped being continuable. */
  | 'IGNORED'
  /** The message broke the log (a gap, an invalid role, or the bounds); the log is no longer continuable. */
  | 'DISCONTINUED';

export type AgentSessionAppend = {
  ownerId: string;
  workspaceId: string;
  agentId: string;
  generation: number;
  runnerEpoch: number;
  seq: number;
  message: unknown;
  now: number;
};

/** The chain head of an empty session log. */
export const AGENT_SESSION_GENESIS_SHA256 = '0'.repeat(64);
const SESSION_ROLES = new Set(['user', 'assistant', 'toolResult']);
/** Every terminal status leaves a sealed log continuable; only an incomplete or oversized log is not. */
const CONTINUABLE_TERMINAL_STATUSES: readonly AgentStatus[] = ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED', 'CANCELLED'];

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Each message extends the chain: head(n) = sha256(head(n-1) + sha256(message JSON)). */
export function chainAgentSessionHead(previousHead: string, messageSha256: string): string {
  return sha256Hex(`${previousHead}${messageSha256}`);
}

export type CleanupRetryRecord = {
  ownerId: string;
  workspaceId: string;
  agentId: string;
  agentGeneration: number;
  attempts: number;
  nextAttemptAt: number;
  lastError: string;
  updatedAt: number;
};

export type ClosedWorkspaceMaintenance = {
  workspaces: number;
  compactedAgents: number;
  purgedTombstones: number;
};

type AgentRow = {
  id: string;
  owner_id: string;
  workspace_id: string;
  workspace_generation: number;
  parent_agent_id: string | null;
  parent_generation: number | null;
  idempotency_key: string;
  payload_hash: string;
  prompt_hash: string;
  profile_id: string;
  proxy_operations_json: string;
  max_ttl_seconds: number;
  max_output_bytes: number;
  max_input_tokens: number;
  max_output_tokens: number;
  max_cost_micros: number;
  container_name: string;
  network_name: string;
  gateway_lease_id: string;
  status: AgentStatus;
  generation: number;
  runner_epoch: number;
  spawn_admission_open: number;
  message_admission_open: number;
  created_at: number;
  started_at: number | null;
  terminal_at: number | null;
  expires_at: number;
  terminal_reason: string | null;
  cleanup_reason: string | null;
  outcome_unknown: number;
};

type MessageRow = {
  owner_id: string;
  workspace_id: string;
  agent_id: string;
  agent_generation: number;
  runner_epoch: number;
  idempotency_key: string;
  payload_hash: string;
  mode: AgentMessageMode;
  state: AgentMessageDeliveryState;
  created_at: number;
  updated_at: number;
  error: string | null;
};

type UsageRow = {
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  output_bytes: number;
  event_count: number;
  tool_time_ms: number;
  wall_time_ms: number;
};

type TombstoneRow = {
  owner_id: string;
  workspace_id: string;
  agent_id: string;
  idempotency_key: string;
  payload_hash: string;
  status: AgentStatus;
  generation: number;
  created_at: number;
  expires_at: number;
};

type CleanupRetryRow = {
  owner_id: string;
  workspace_id: string;
  agent_id: string;
  agent_generation: number;
  attempts: number;
  next_attempt_at: number;
  last_error: string;
  updated_at: number;
};

function agentFromRow(row: AgentRow): AgentRecord {
  const parsedOperations = AgentProxyOperationSchema.array().parse(JSON.parse(row.proxy_operations_json));
  return {
    id: row.id,
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
    workspaceGeneration: row.workspace_generation,
    parentAgentId: row.parent_agent_id,
    parentGeneration: row.parent_generation,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    promptHash: row.prompt_hash,
    profileId: row.profile_id,
    proxyOperations: parsedOperations,
    budget: {
      ttlSeconds: row.max_ttl_seconds,
      maxOutputBytes: row.max_output_bytes,
      maxInputTokens: row.max_input_tokens,
      maxOutputTokens: row.max_output_tokens,
      maxCostMicros: row.max_cost_micros
    },
    containerName: row.container_name,
    networkName: row.network_name,
    gatewayLeaseId: row.gateway_lease_id,
    status: row.status,
    generation: row.generation,
    runtimeEpoch: row.runner_epoch ?? 1,
    spawnAdmissionOpen: row.spawn_admission_open === 1,
    messageAdmissionOpen: row.message_admission_open === 1,
    createdAt: row.created_at,
    startedAt: row.started_at,
    terminalAt: row.terminal_at,
    expiresAt: row.expires_at,
    terminalReason: row.terminal_reason,
    cleanupReason: row.cleanup_reason,
    outcomeUnknown: row.outcome_unknown === 1
  };
}

function messageFromRow(row: MessageRow): AgentMessageRecord {
  return {
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    agentGeneration: row.agent_generation,
    runnerEpoch: row.runner_epoch ?? 1,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    mode: row.mode,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error
  };
}

function tombstoneFromRow(row: TombstoneRow): AgentTombstone {
  return {
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    status: row.status,
    generation: row.generation,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

function cleanupRetryFromRow(row: CleanupRetryRow): CleanupRetryRecord {
  return {
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    agentGeneration: row.agent_generation,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    updatedAt: row.updated_at
  };
}

type SessionRow = {
  agent_id: string;
  owner_id: string;
  workspace_id: string;
  workspace_generation: number;
  root_agent_id: string;
  continued_from: string | null;
  message_count: number;
  bytes: number;
  head_sha256: string;
  state: AgentSessionState;
  continuable: number;
  retain_until: number | null;
  created_at: number;
  updated_at: number;
};

function sessionFromRow(row: SessionRow): AgentSessionRecord {
  return {
    agentId: row.agent_id,
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
    workspaceGeneration: row.workspace_generation,
    rootAgentId: row.root_agent_id,
    continuedFrom: row.continued_from,
    messageCount: row.message_count,
    bytes: row.bytes,
    headSha256: row.head_sha256,
    state: row.state,
    continuable: row.continuable === 1,
    retainUntil: row.retain_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

type EffectRow = {
  owner_id: string;
  workspace_id: string;
  agent_id: string;
  agent_generation: number;
  runner_epoch: number;
  root_agent_id: string | null;
  request_id: string;
  kind: string;
  payload_hash: string;
  state: AgentEffectState;
  replay_class: AgentProxyReplayClass | null;
  pre_image_sha256: string | null;
  intended_sha256: string | null;
  pre_entry: EffectPreEntry | null;
  result_json: string | null;
  result_sha256: string | null;
  result_reconciled: number;
  executor_generation: number | null;
  workspace_generation: number | null;
  retain_until: number | null;
  created_at: number;
  updated_at: number;
};

function effectFromRow(row: EffectRow): AgentEffectRecord {
  return {
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    agentGeneration: row.agent_generation,
    runnerEpoch: row.runner_epoch,
    rootAgentId: row.root_agent_id ?? row.agent_id,
    requestId: row.request_id,
    kind: row.kind,
    payloadHash: row.payload_hash,
    state: row.state,
    replayClass: row.replay_class,
    preImageSha256: row.pre_image_sha256,
    intendedSha256: row.intended_sha256,
    preEntry: row.pre_entry ?? null,
    resultJson: row.result_json,
    resultSha256: row.result_sha256,
    reconciled: row.result_reconciled === 1,
    executorGeneration: row.executor_generation,
    workspaceGeneration: row.workspace_generation,
    retainUntil: row.retain_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function optionalSha256(value: string | null | undefined, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (!SHA256_HEX.test(value)) throw new HarnessError('INVALID_INPUT', `${name} must be a lowercase SHA-256 digest`);
  return value;
}

function immediate<T>(database: DatabaseSync, action: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function notEligibleForAgents(): HarnessError {
  return new HarnessError('CONFLICT', 'workspace is not eligible for agent admission; subagents require a workspace opened with networkProfile "network-none"', 409, false);
}

function notFound(): HarnessError {
  return new HarnessError('NOT_FOUND', 'agent was not found in this workspace', 404, false);
}

function nonnegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new HarnessError('INVALID_INPUT', `${name} must be a nonnegative safe integer`);
}

function redactLogContent(content: string): string {
  return content
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1[REDACTED]')
    .replace(/\b((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]{8,}/gi, '$1[REDACTED]');
}

export class AgentStateRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly limits: RunnerAgentLimits,
    private readonly instanceId?: string
  ) {}

  bumpEpoch(instanceId: string, now: number): number {
    return immediate(this.database, () => {
      this.database.prepare(`INSERT INTO runtime_epochs (instance_id, epoch, updated_at)
        VALUES (?, 1, ?)
        ON CONFLICT(instance_id) DO UPDATE SET epoch = epoch + 1, updated_at = excluded.updated_at`)
        .run(instanceId, now);
      const row = this.database.prepare('SELECT epoch FROM runtime_epochs WHERE instance_id = ?').get(instanceId) as { epoch: number };
      return row.epoch;
    });
  }

  currentEpoch(instanceId: string): number {
    const row = this.database.prepare('SELECT epoch FROM runtime_epochs WHERE instance_id = ?').get(instanceId) as { epoch: number } | undefined;
    return row ? row.epoch : 0;
  }

  findAgent(ownerId: string, workspaceId: string, agentId: string): AgentRecord | undefined {
    const row = this.database.prepare('SELECT * FROM agents WHERE owner_id=? AND workspace_id=? AND id=?')
      .get(ownerId, workspaceId, agentId) as AgentRow | undefined;
    return row ? agentFromRow(row) : undefined;
  }

  findByIdempotency(ownerId: string, workspaceId: string, idempotencyKey: string): AgentRecord | undefined {
    const row = this.database.prepare('SELECT * FROM agents WHERE owner_id=? AND workspace_id=? AND idempotency_key=?')
      .get(ownerId, workspaceId, idempotencyKey) as AgentRow | undefined;
    return row ? agentFromRow(row) : undefined;
  }

  findTombstone(ownerId: string, workspaceId: string, agentId: string, now = Date.now()): AgentTombstone | undefined {
    const row = this.database.prepare('SELECT * FROM agent_tombstones WHERE owner_id=? AND workspace_id=? AND agent_id=? AND expires_at>?')
      .get(ownerId, workspaceId, agentId, now) as TombstoneRow | undefined;
    return row ? tombstoneFromRow(row) : undefined;
  }
  findTombstoneByIdempotency(ownerId: string, workspaceId: string, idempotencyKey: string, now = Date.now()): AgentTombstone | undefined {
    const row = this.database.prepare('SELECT * FROM agent_tombstones WHERE owner_id=? AND workspace_id=? AND idempotency_key=? AND expires_at>?')
      .get(ownerId, workspaceId, idempotencyKey, now) as TombstoneRow | undefined;
    return row ? tombstoneFromRow(row) : undefined;
  }

  listAgentPage(ownerId: string, workspaceId: string, request: AgentListPageRequest): AgentListPage {
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100) {
      throw new HarnessError('INVALID_INPUT', 'agent list limit is out of bounds');
    }
    if (request.cursor !== undefined
      && (!/^[1-9]\d*$/.test(request.cursor) || Number(request.cursor) > Number.MAX_SAFE_INTEGER)) {
      throw new HarnessError('INVALID_INPUT', 'agent list cursor is invalid');
    }
    const parentAgentId = request.parentAgentId ?? null;
    const status = request.status ?? null;
    const cursor = request.cursor === undefined ? null : Number(request.cursor);
    const rows = this.database.prepare(`SELECT rowid AS pagination_rowid, agents.* FROM agents
      WHERE owner_id=? AND workspace_id=?
        AND (? IS NULL OR parent_agent_id=?)
        AND (? IS NULL OR status=?)
        AND (? IS NULL OR rowid<?)
      ORDER BY rowid DESC LIMIT ?`)
      .all(ownerId, workspaceId, parentAgentId, parentAgentId, status, status, cursor, cursor, request.limit + 1) as Array<AgentRow & {
        pagination_rowid: number;
      }>;
    const pageRows = rows.slice(0, request.limit);
    return {
      records: pageRows.map(agentFromRow),
      nextCursor: rows.length > request.limit ? String(pageRows.at(-1)!.pagination_rowid) : null
    };
  }

  listActiveAgents(ownerId: string, workspaceId: string, workspaceGeneration?: number): AgentRecord[] {
    const generation = workspaceGeneration ?? null;
    const rows = this.database.prepare(`SELECT * FROM agents
      WHERE owner_id=? AND workspace_id=? AND (? IS NULL OR workspace_generation=?)
        AND status IN ('SPAWNING','RUNNING','CANCELLING')
      ORDER BY created_at ASC, id ASC LIMIT ?`)
      .all(ownerId, workspaceId, generation, generation, this.limits.workspaceActive + 1) as AgentRow[];
    if (rows.length > this.limits.workspaceActive) {
      throw new HarnessError('INTERNAL_ERROR', 'persisted active agent count exceeds configured workspace capacity', 500, false);
    }
    return rows.map(agentFromRow);
  }

  reserveSpawn(input: AgentSpawnReservation): { replayed: boolean; record: AgentRecord } {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.gatewayLeaseId)) {
      throw new HarnessError('INVALID_INPUT', 'invalid gateway lease identifier');
    }
    return immediate(this.database, () => {
      if (input.runtimeEpoch !== undefined && this.instanceId) {
        const current = this.currentEpoch(this.instanceId);
        if (current !== 0 && input.runtimeEpoch !== current) {
          throw new HarnessError('CONFLICT', 'spawn request lost its runtime epoch fence', 409, true);
        }
      }
      const workspace = this.database.prepare(`SELECT id, generation, status, network_profile, expires_at FROM workspaces
        WHERE owner_id=? AND id=? AND generation=?`)
        .get(input.ownerId, input.workspaceId, input.workspaceGeneration) as {
          id: string; generation: number; status: string; network_profile: string; expires_at: number;
        } | undefined;
      if (!workspace) throw new HarnessError('NOT_FOUND', 'workspace was not found', 404, false);
      if (workspace.status !== 'ACTIVE' || workspace.network_profile !== 'network-none') {
        throw notEligibleForAgents();
      }

      this.database.prepare(`INSERT OR IGNORE INTO agent_workspace_admission
        (owner_id, workspace_id, workspace_generation, spawn_open, message_open, lifetime_records, updated_at)
        VALUES (?, ?, ?, 1, 1, 0, ?)`)
        .run(input.ownerId, input.workspaceId, input.workspaceGeneration, input.now);
      const admission = this.database.prepare(`SELECT workspace_generation, spawn_open, lifetime_records
        FROM agent_workspace_admission WHERE owner_id=? AND workspace_id=?`)
        .get(input.ownerId, input.workspaceId) as { workspace_generation: number; spawn_open: number; lifetime_records: number };
      if (admission.workspace_generation !== input.workspaceGeneration || admission.spawn_open !== 1) {
        throw new HarnessError('CONFLICT', 'workspace agent admission is closed', 409, false);
      }

      const replay = this.database.prepare(`SELECT * FROM agents
        WHERE owner_id=? AND workspace_id=? AND idempotency_key=?`)
        .get(input.ownerId, input.workspaceId, input.idempotencyKey) as AgentRow | undefined;
      if (replay) {
        if (replay.payload_hash !== input.payloadHash) {
          throw new HarnessError('CONFLICT', 'spawn idempotency key was used with a different payload', 409, false);
        }
        return { replayed: true, record: agentFromRow(replay) };
      }
      const tombstone = this.database.prepare(`SELECT payload_hash FROM agent_tombstones
        WHERE owner_id=? AND workspace_id=? AND idempotency_key=?`)
        .get(input.ownerId, input.workspaceId, input.idempotencyKey) as { payload_hash: string } | undefined;
      if (tombstone) {
        if (tombstone.payload_hash !== input.payloadHash) {
          throw new HarnessError('CONFLICT', 'spawn idempotency key was used with a different payload', 409, false);
        }
        throw new HarnessError('CONFLICT', 'spawn replay is retained as a closed-workspace tombstone', 409, false);
      }
      if (admission.lifetime_records >= this.limits.workspaceLifetimeRecords) {
        throw new HarnessError('LIMIT_EXCEEDED', 'workspace agent lifetime record capacity is exhausted', 429, false);
      }

      const retained = this.database.prepare(`SELECT
        (SELECT COUNT(*) FROM agents) + (SELECT COUNT(*) FROM agent_tombstones) AS global_count,
        (SELECT COUNT(*) FROM agents WHERE owner_id=?) + (SELECT COUNT(*) FROM agent_tombstones WHERE owner_id=?) AS principal_count,
        (SELECT COUNT(*) FROM agents WHERE owner_id=? AND workspace_id=?) +
          (SELECT COUNT(*) FROM agent_tombstones WHERE owner_id=? AND workspace_id=?) AS workspace_count`)
        .get(input.ownerId, input.ownerId, input.ownerId, input.workspaceId, input.ownerId, input.workspaceId) as {
          global_count: number; principal_count: number; workspace_count: number;
        };
      if (retained.global_count >= this.limits.globalRetainedRows
        || retained.principal_count >= this.limits.principalRetainedRows
        || retained.workspace_count >= this.limits.workspaceRetainedRows) {
        throw new HarnessError('LIMIT_EXCEEDED', 'agent retained record capacity is exhausted', 429, false);
      }

      let parentGeneration: number | null = null;
      if (input.parentAgentId) {
        const parent = this.database.prepare(`SELECT generation FROM agents
          WHERE owner_id=? AND workspace_id=? AND id=? AND status='RUNNING'
            AND spawn_admission_open=1 AND workspace_generation=?`)
          .get(input.ownerId, input.workspaceId, input.parentAgentId, input.workspaceGeneration) as { generation: number } | undefined;
        if (!parent) throw notFound();
        parentGeneration = parent.generation;
      }

      const active = this.database.prepare(`SELECT
        (SELECT COUNT(*) FROM agents WHERE status IN ('SPAWNING','RUNNING','CANCELLING')) AS global_count,
        (SELECT COUNT(*) FROM agents WHERE owner_id=? AND status IN ('SPAWNING','RUNNING','CANCELLING')) AS principal_count,
        (SELECT COUNT(*) FROM agents WHERE owner_id=? AND workspace_id=? AND status IN ('SPAWNING','RUNNING','CANCELLING')) AS workspace_count,
        (SELECT COUNT(*) FROM agents WHERE owner_id=? AND workspace_id=? AND parent_agent_id IS ? AND status IN ('SPAWNING','RUNNING','CANCELLING')) AS parent_count`)
        .get(input.ownerId, input.ownerId, input.workspaceId, input.ownerId, input.workspaceId, input.parentAgentId ?? null) as {
          global_count: number; principal_count: number; workspace_count: number; parent_count: number;
        };
      if (active.global_count >= this.limits.globalActive
        || active.principal_count >= this.limits.principalActive
        || active.workspace_count >= this.limits.workspaceActive
        || (input.parentAgentId !== undefined && active.parent_count >= this.limits.parentActive)) {
        throw new HarnessError('LIMIT_EXCEEDED', 'agent active capacity is exhausted', 429, true);
      }
      if (input.budget.maxOutputBytes > this.limits.maxOutputBytesPerAgent) {
        throw new HarnessError('INVALID_INPUT', 'agent output byte budget exceeds configured limit');
      }
      if (input.expiresAt <= input.now || input.expiresAt > workspace.expires_at || input.expiresAt - input.now > input.budget.ttlSeconds * 1_000) {
        throw new HarnessError('INVALID_INPUT', 'agent expiry is outside its TTL budget');
      }
      if (input.budget.ttlSeconds < this.limits.minTtlSeconds || input.budget.ttlSeconds > this.limits.maxTtlSeconds) {
        throw new HarnessError('INVALID_INPUT', 'agent TTL is outside configured limits');
      }
      const proxyOperations = AgentProxyOperationSchema.array().min(1).max(AgentProxyOperationSchema.options.length).parse(input.proxyOperations);
      if (new Set(proxyOperations).size !== proxyOperations.length) {
        throw new HarnessError('INVALID_INPUT', 'agent proxy operations must be unique');
      }
      // Rechecked inside the spawn transaction, so two concurrent continuations cannot both win.
      const predecessor = input.session?.continuedFrom === undefined
        ? undefined
        : this.requireContinuable(input.ownerId, input.workspaceId, input.workspaceGeneration, input.session.continuedFrom);
      if (predecessor) {
        // A corrupted log is refused here rather than copied into the new agent's session.
        const log = this.loadSessionLog(predecessor.predecessor.id, predecessor.predecessor.generation);
        input.session?.admitContinuation?.(predecessor.predecessor, { bytes: log.bytes, messageCount: log.messages.length });
        // The successor starts with a full copy of the log, so the copy counts against the aggregate budgets.
        const exceeded = this.exceededSessionBudget(input.ownerId, input.workspaceId, log.bytes);
        if (exceeded) {
          throw new HarnessError(
            'LIMIT_EXCEEDED',
            `persisted agent sessions would exceed the ${exceeded} session byte budget; start a fresh agent, or wait until retention or a workspace close frees stored sessions`,
            429,
            false
          );
        }
      }
      input.admit?.();

      this.database.prepare(`INSERT INTO agents
        (id, owner_id, workspace_id, workspace_generation, parent_agent_id, parent_generation,
         idempotency_key, payload_hash, prompt_hash, profile_id, proxy_operations_json,
         max_ttl_seconds, max_output_bytes, max_input_tokens, max_output_tokens, max_cost_micros,
         container_name, network_name, gateway_lease_id, status, generation, runner_epoch, spawn_admission_open, message_admission_open,
         created_at, started_at, terminal_at, expires_at, terminal_reason, cleanup_reason, outcome_unknown)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SPAWNING', 1, ?, 1, 1, ?, NULL, NULL, ?, NULL, NULL, 0)`)
        .run(
          input.id, input.ownerId, input.workspaceId, input.workspaceGeneration, input.parentAgentId ?? null, parentGeneration,
          input.idempotencyKey, input.payloadHash, input.promptHash, input.profileId, JSON.stringify(proxyOperations),
          input.budget.ttlSeconds, input.budget.maxOutputBytes, input.budget.maxInputTokens, input.budget.maxOutputTokens,
          input.budget.maxCostMicros, input.containerName, input.networkName, input.gatewayLeaseId, input.runtimeEpoch ?? 1, input.now, input.expiresAt
        );
      this.database.prepare(`INSERT INTO agent_usage
        (owner_id, workspace_id, agent_id, agent_generation) VALUES (?, ?, ?, 1)`)
        .run(input.ownerId, input.workspaceId, input.id);
      this.database.prepare(`INSERT INTO agent_log_watermarks
        (owner_id, workspace_id, agent_id, agent_generation) VALUES (?, ?, ?, 1)`)
        .run(input.ownerId, input.workspaceId, input.id);
      this.database.prepare(`UPDATE agent_workspace_admission SET lifetime_records=lifetime_records+1, updated_at=?
        WHERE owner_id=? AND workspace_id=? AND workspace_generation=? AND spawn_open=1`)
        .run(input.now, input.ownerId, input.workspaceId, input.workspaceGeneration);
      if (input.session) this.insertSession(input, predecessor);
      const created = this.database.prepare('SELECT * FROM agents WHERE owner_id=? AND workspace_id=? AND id=?')
        .get(input.ownerId, input.workspaceId, input.id) as AgentRow;
      return { replayed: false, record: agentFromRow(created) };
    });
  }

  transitionStatus(input: AgentStatusTransition): AgentRecord | undefined {
    if (input.expectedStatuses.length === 0) throw new HarnessError('INVALID_INPUT', 'expected status set cannot be empty');
    if (input.status === 'INTERRUPTED' && input.outcomeUnknown !== true) {
      throw new HarnessError('INVALID_INPUT', 'interrupted agents must record an unknown outcome');
    }
    if (input.outcomeUnknown === true && input.status !== 'INTERRUPTED') {
      throw new HarnessError('INVALID_INPUT', 'unknown outcome is only valid for interrupted agents');
    }
    if ((input.terminalReason && Buffer.byteLength(input.terminalReason, 'utf8') > 2_000)
      || (input.cleanupReason && Buffer.byteLength(input.cleanupReason, 'utf8') > 2_000)) {
      throw new HarnessError('INVALID_INPUT', 'agent terminal metadata is too large');
    }
    if (input.expectedStatuses.some((status) => !STATUS_TRANSITIONS[status].includes(input.status))) {
      throw new HarnessError('INVALID_INPUT', 'invalid agent status transition');
    }
    const terminal = TERMINAL_STATUSES.includes(input.status);
    const closesAdmission = terminal || input.status === 'CANCELLING';
    const placeholders = input.expectedStatuses.map(() => '?').join(',');
    const epochPredicate = input.runtimeEpoch !== undefined ? 'AND runner_epoch=?' : '';
    const epochArgs = input.runtimeEpoch !== undefined ? [input.runtimeEpoch] : [];
    const update = () => this.database.prepare(`UPDATE agents SET status=?,
      started_at=CASE WHEN ?='RUNNING' AND started_at IS NULL THEN ? ELSE started_at END,
      terminal_at=CASE WHEN ?=1 THEN ? ELSE terminal_at END,
      terminal_reason=COALESCE(?, terminal_reason), cleanup_reason=COALESCE(?, cleanup_reason),
      outcome_unknown=CASE WHEN ? IS NULL THEN outcome_unknown ELSE ? END,
      spawn_admission_open=CASE WHEN ?=1 THEN 0 ELSE spawn_admission_open END,
      message_admission_open=CASE WHEN ?=1 THEN 0 ELSE message_admission_open END
      WHERE owner_id=? AND workspace_id=? AND id=? AND generation=? ${epochPredicate} AND status IN (${placeholders})`)
      .run(
        input.status, input.status, input.now, terminal ? 1 : 0, input.now,
        input.terminalReason ?? null, input.cleanupReason ?? null,
        input.outcomeUnknown === undefined ? null : (input.outcomeUnknown ? 1 : 0), input.outcomeUnknown ? 1 : 0,
        closesAdmission ? 1 : 0, closesAdmission ? 1 : 0,
        input.ownerId, input.workspaceId, input.agentId, input.generation, ...epochArgs, ...input.expectedStatuses
      );
    const changed = terminal
      // A terminal record and its MCP event commit together; the outbox keys the event by agent id.
      ? withEventSavepoint(this.database, () => {
        if (Number(update().changes) !== 1) return false;
        this.sealSession(input.agentId, input.status, input.now);
        emitAgentTerminalEvent(this.database, input.ownerId, input.workspaceId, input.agentId, input.now);
        return true;
      })
      : Number(update().changes) === 1;
    return changed ? this.findAgent(input.ownerId, input.workspaceId, input.agentId) : undefined;
  }

  closeWorkspaceAdmission(ownerId: string, workspaceId: string, now: number, workspaceGeneration?: number): boolean {
    return immediate(this.database, () => {
      const gen = workspaceGeneration ?? null;
      const result = this.database.prepare(`UPDATE agent_workspace_admission SET spawn_open=0, message_open=0, updated_at=?
        WHERE owner_id=? AND workspace_id=? AND (? IS NULL OR workspace_generation=?)`)
        .run(now, ownerId, workspaceId, gen, gen);
      this.database.prepare(`UPDATE agents SET spawn_admission_open=0, message_admission_open=0
        WHERE owner_id=? AND workspace_id=? AND (? IS NULL OR workspace_generation=?) AND status IN ('SPAWNING','RUNNING','CANCELLING')`)
        .run(ownerId, workspaceId, gen, gen);
      return result.changes >= 1;
    });
  }

  openWorkspaceAdmission(ownerId: string, workspaceId: string, workspaceGeneration: number, now: number): boolean {
    return immediate(this.database, () => {
      const workspace = this.database.prepare(`SELECT status, network_profile FROM workspaces
        WHERE owner_id=? AND id=? AND generation=?`)
        .get(ownerId, workspaceId, workspaceGeneration) as { status: string; network_profile: string } | undefined;
      if (!workspace) throw new HarnessError('NOT_FOUND', 'workspace was not found', 404, false);
      // A workspace that exists but cannot host agents is a precondition failure, not a missing
      // workspace; report it the same way reserveSpawn does.
      if (workspace.status !== 'ACTIVE' || workspace.network_profile !== 'network-none') {
        throw notEligibleForAgents();
      }
      const active = this.database.prepare(`SELECT COUNT(*) AS count FROM agents
        WHERE owner_id=? AND workspace_id=? AND workspace_generation=? AND status IN ('SPAWNING','RUNNING','CANCELLING')`)
        .get(ownerId, workspaceId, workspaceGeneration) as { count: number };
      if (active.count !== 0) throw new HarnessError('CONFLICT', 'workspace still has unreconciled agents', 409, true);
      const result = this.database.prepare(`UPDATE agent_workspace_admission SET spawn_open=1, message_open=1, updated_at=?
        WHERE owner_id=? AND workspace_id=? AND workspace_generation=?`)
        .run(now, ownerId, workspaceId, workspaceGeneration);
      return result.changes === 1;
    });
  }

  descendants(ownerId: string, workspaceId: string, parentAgentId: string): AgentRecord[] {
    const rows = this.database.prepare(`WITH RECURSIVE descendants(id, depth) AS (
      SELECT id, 1 FROM agents WHERE owner_id=? AND workspace_id=? AND parent_agent_id=?
      UNION ALL
      SELECT child.id, parent.depth+1 FROM agents child JOIN descendants parent ON child.parent_agent_id=parent.id
        WHERE child.owner_id=? AND child.workspace_id=?
    ) SELECT agents.* FROM agents JOIN descendants ON agents.id=descendants.id
      WHERE agents.owner_id=? AND agents.workspace_id=? ORDER BY descendants.depth DESC, agents.created_at DESC, agents.id DESC`)
      .all(ownerId, workspaceId, parentAgentId, ownerId, workspaceId, ownerId, workspaceId) as AgentRow[];
    return rows.map(agentFromRow);
  }

  reserveMessage(input: {
    ownerId: string;
    workspaceId: string;
    agentId: string;
    generation: number;
    runtimeEpoch?: number;
    idempotencyKey: string;
    payloadHash: string;
    mode: AgentMessageMode;
    now: number;
  }): { replayed: boolean; message: AgentMessageRecord } {
    return immediate(this.database, () => {
      const agent = this.database.prepare(`SELECT agents.generation, agents.status, agents.message_admission_open FROM agents
        JOIN workspaces ON workspaces.id=agents.workspace_id AND workspaces.owner_id=agents.owner_id
        WHERE agents.owner_id=? AND agents.workspace_id=? AND agents.id=? AND agents.generation=?
          AND workspaces.status='ACTIVE' AND workspaces.generation=agents.workspace_generation AND workspaces.network_profile='network-none'`)
        .get(input.ownerId, input.workspaceId, input.agentId, input.generation) as {
          generation: number; status: AgentStatus; message_admission_open: number;
        } | undefined;
      if (!agent) throw notFound();
      const replay = this.database.prepare(`SELECT * FROM agent_messages
        WHERE owner_id=? AND workspace_id=? AND agent_id=? AND idempotency_key=?`)
        .get(input.ownerId, input.workspaceId, input.agentId, input.idempotencyKey) as MessageRow | undefined;
      if (replay) {
        if (replay.payload_hash !== input.payloadHash || replay.mode !== input.mode) {
          throw new HarnessError('CONFLICT', 'message idempotency key was used with a different payload', 409, false);
        }
        return { replayed: true, message: messageFromRow(replay) };
      }
      if (agent.status !== 'RUNNING' || agent.message_admission_open !== 1) {
        throw new HarnessError('CONFLICT', 'agent message admission is closed', 409, false);
      }
      const workspaceAdmission = this.database.prepare(`SELECT message_open, lifetime_records FROM agent_workspace_admission
        WHERE owner_id=? AND workspace_id=? AND message_open=1`)
        .get(input.ownerId, input.workspaceId) as { message_open: number; lifetime_records: number } | undefined;
      if (!workspaceAdmission) throw new HarnessError('CONFLICT', 'workspace agent admission is closed', 409, false);
      if (workspaceAdmission.lifetime_records >= this.limits.workspaceLifetimeRecords) {
        throw new HarnessError('LIMIT_EXCEEDED', 'workspace agent lifetime record capacity is exhausted', 429, false);
      }
      this.database.prepare(`INSERT INTO agent_messages
        (owner_id, workspace_id, agent_id, agent_generation, runner_epoch, idempotency_key, payload_hash, mode, state, created_at, updated_at, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?, ?, NULL)`)
        .run(input.ownerId, input.workspaceId, input.agentId, input.generation, (input as { runtimeEpoch?: number }).runtimeEpoch ?? 1, input.idempotencyKey, input.payloadHash, input.mode, input.now, input.now);
      this.database.prepare(`UPDATE agent_workspace_admission SET lifetime_records=lifetime_records+1, updated_at=?
        WHERE owner_id=? AND workspace_id=? AND message_open=1`)
        .run(input.now, input.ownerId, input.workspaceId);
      const created = this.database.prepare(`SELECT * FROM agent_messages
        WHERE owner_id=? AND workspace_id=? AND agent_id=? AND idempotency_key=?`)
        .get(input.ownerId, input.workspaceId, input.agentId, input.idempotencyKey) as MessageRow;
      return { replayed: false, message: messageFromRow(created) };
    });
  }

  transitionMessage(input: {
    ownerId: string;
    workspaceId: string;
    agentId: string;
    generation: number;
    idempotencyKey: string;
    expectedState: 'RESERVED';
    state: Exclude<AgentMessageDeliveryState, 'RESERVED'>;
    now: number;
    error?: string | null;
  }): AgentMessageRecord | undefined {
    if (input.error && Buffer.byteLength(input.error, 'utf8') > 2_000) {
      throw new HarnessError('INVALID_INPUT', 'message delivery error is too large');
    }
    const result = this.database.prepare(`UPDATE agent_messages SET state=?, updated_at=?, error=?
      WHERE owner_id=? AND workspace_id=? AND agent_id=? AND agent_generation=? AND idempotency_key=? AND state=?`)
      .run(input.state, input.now, input.error ?? null, input.ownerId, input.workspaceId, input.agentId, input.generation, input.idempotencyKey, input.expectedState);
    if (result.changes !== 1) return undefined;
    const row = this.database.prepare(`SELECT * FROM agent_messages
      WHERE owner_id=? AND workspace_id=? AND agent_id=? AND idempotency_key=?`)
      .get(input.ownerId, input.workspaceId, input.agentId, input.idempotencyKey) as MessageRow;
    return messageFromRow(row);
  }


  /**
   * Adds usage to an agent. With `fence`, usage from a stale writer (an earlier runner epoch or
   * generation, or a predecessor that was continued) is ignored rather than counted.
   */
  addUsage(
    ownerId: string,
    workspaceId: string,
    agentId: string,
    generation: number,
    delta: AgentUsageDelta,
    fence?: { runnerEpoch: number }
  ): AgentUsage {
    if (fence && this.isEffectWriterFenced({ ownerId, workspaceId, agentId, agentGeneration: generation, runnerEpoch: fence.runnerEpoch })) {
      return this.usage(ownerId, workspaceId, agentId, generation);
    }
    const values: AgentUsage = {
      inputTokens: delta.inputTokens ?? 0,
      outputTokens: delta.outputTokens ?? 0,
      costMicros: delta.costMicros ?? 0,
      outputBytes: delta.outputBytes ?? 0,
      eventCount: delta.eventCount ?? 0,
      toolTimeMs: delta.toolTimeMs ?? 0,
      wallTimeMs: delta.wallTimeMs ?? 0
    };
    for (const [name, value] of Object.entries(values)) nonnegativeInteger(value, name);
    const result = this.database.prepare(`UPDATE agent_usage SET input_tokens=input_tokens+?, output_tokens=output_tokens+?,
      cost_micros=cost_micros+?, output_bytes=output_bytes+?, event_count=event_count+?, tool_time_ms=tool_time_ms+?, wall_time_ms=wall_time_ms+?
      WHERE owner_id=? AND workspace_id=? AND agent_id=? AND agent_generation=?`)
      .run(values.inputTokens, values.outputTokens, values.costMicros, values.outputBytes, values.eventCount, values.toolTimeMs, values.wallTimeMs,
        ownerId, workspaceId, agentId, generation);
    if (result.changes !== 1) throw notFound();
    return this.usage(ownerId, workspaceId, agentId, generation);
  }

  /**
   * Reserves an effect by its lineage key `(root agent, request ID, kind)`, so a continuation that
   * repeats a predecessor's request finds the predecessor's effect. A repeated request with a
   * different payload is a conflict. With `fenced`, only the live owner of the lineage may reserve:
   * a running agent of the current runner epoch and generation that has not been continued.
   */
  reserveEffect(input: {
    ownerId: string;
    workspaceId: string;
    agentId: string;
    agentGeneration: number;
    runnerEpoch: number;
    requestId: string;
    kind: string;
    payloadHash: string;
    now: number;
    replayClass?: AgentProxyReplayClass;
    preImageSha256?: string | null;
    intendedSha256?: string | null;
    fenced?: boolean;
  }): { replayed: boolean; effect: AgentEffectRecord } {
    if (!EFFECT_REQUEST_ID.test(input.requestId)) throw new HarnessError('INVALID_INPUT', 'invalid effect request ID');
    const preImageSha256 = optionalSha256(input.preImageSha256, 'pre-image digest');
    const intendedSha256 = optionalSha256(input.intendedSha256, 'intended post-image digest');
    return immediate(this.database, () => {
      if (input.fenced && this.isEffectWriterFenced(input, ['RUNNING'])) {
        throw new HarnessError('EXPIRED', 'agent tool execution lost its lifecycle fence', 410, false);
      }
      const rootAgentId = this.lineageRoot(input.agentId);
      const existing = this.findEffectRow({ rootAgentId, requestId: input.requestId, kind: input.kind });
      if (existing) {
        if (existing.owner_id !== input.ownerId || existing.workspace_id !== input.workspaceId || existing.payload_hash !== input.payloadHash) {
          throw new HarnessError('CONFLICT', 'effect request ID was used with a different payload', 409, false);
        }
        return { replayed: true, effect: effectFromRow(existing) };
      }
      const agent = this.database.prepare('SELECT workspace_generation FROM agents WHERE owner_id=? AND workspace_id=? AND id=?')
        .get(input.ownerId, input.workspaceId, input.agentId) as { workspace_generation: number } | undefined;
      this.database.prepare(`INSERT INTO agent_effects
        (owner_id, workspace_id, agent_id, agent_generation, runner_epoch, request_id, kind, payload_hash, state, created_at, updated_at,
         root_agent_id, replay_class, pre_image_sha256, intended_sha256, workspace_generation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'INTENT', ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.ownerId, input.workspaceId, input.agentId, input.agentGeneration, input.runnerEpoch, input.requestId, input.kind,
          input.payloadHash, input.now, input.now, rootAgentId, input.replayClass ?? null, preImageSha256, intendedSha256,
          agent?.workspace_generation ?? null
        );
      return { replayed: false, effect: effectFromRow(this.findEffectRow({ rootAgentId, requestId: input.requestId, kind: input.kind })!) };
    });
  }

  /** The lineage root of an agent: the root recorded in its persisted session, or the agent itself. */
  lineageRoot(agentId: string): string {
    const row = this.database.prepare('SELECT root_agent_id FROM agent_sessions WHERE agent_id=?').get(agentId) as { root_agent_id: string } | undefined;
    return row?.root_agent_id ?? agentId;
  }

  findEffect(key: AgentEffectKey): AgentEffectRecord | undefined {
    const row = this.findEffectRow(key);
    return row ? effectFromRow(row) : undefined;
  }

  /**
   * Moves an effect to DISPATCHED immediately before it reaches the executor, recording the images
   * captured at dispatch. Only the live owner of the lineage may dispatch, and only from one of the
   * expected states; a read-safe effect of unknown outcome is dispatched again this way.
   */
  dispatchEffect(input: AgentEffectKey & {
    fence: AgentEffectFence;
    expectedStates: AgentEffectState[];
    preImageSha256?: string | null;
    intendedSha256?: string | null;
    preEntry?: EffectPreEntry | null;
    now: number;
  }): boolean {
    const preImageSha256 = optionalSha256(input.preImageSha256, 'pre-image digest');
    const intendedSha256 = optionalSha256(input.intendedSha256, 'intended post-image digest');
    const preEntry = input.preEntry ?? null;
    if (preEntry !== null && !EFFECT_PRE_ENTRIES.has(preEntry)) throw new HarnessError('INVALID_INPUT', 'invalid effect pre-entry');
    if (input.expectedStates.length === 0) throw new HarnessError('INVALID_INPUT', 'expected effect state set cannot be empty');
    return immediate(this.database, () => {
      if (this.isEffectWriterFenced(input.fence, ['RUNNING'])) return false;
      const placeholders = input.expectedStates.map(() => '?').join(',');
      // The pre-entry is that of this dispatch: an earlier dispatch's observation is not carried over.
      const result = this.database.prepare(`UPDATE agent_effects SET state='DISPATCHED', runner_epoch=?, updated_at=?,
          pre_image_sha256=COALESCE(?, pre_image_sha256), intended_sha256=COALESCE(?, intended_sha256), pre_entry=?
        WHERE root_agent_id=? AND request_id=? AND kind=? AND owner_id=? AND workspace_id=? AND state IN (${placeholders})`)
        .run(input.fence.runnerEpoch, input.now, preImageSha256, intendedSha256, preEntry,
          input.rootAgentId, input.requestId, input.kind, input.fence.ownerId, input.fence.workspaceId, ...input.expectedStates);
      return Number(result.changes) === 1;
    });
  }

  /**
   * Records an effect's outcome and, when given, its receipt (the exact result text the model
   * received) in one transaction. Only a writer that still holds the fence may complete it: a
   * stale runner epoch or generation, an ended agent, or a continued predecessor changes nothing.
   * Returns false when the write was fenced or the effect was not in an expected state.
   */
  completeEffect(input: AgentEffectKey & {
    fence: AgentEffectFence;
    expectedStates: AgentEffectState[];
    state: 'APPLIED' | 'REJECTED' | 'UNKNOWN';
    receipt?: { text: string; reconciled?: boolean };
    now: number;
  }): boolean {
    if (input.expectedStates.length === 0) throw new HarnessError('INVALID_INPUT', 'expected effect state set cannot be empty');
    const text = input.receipt?.text;
    if (text !== undefined && (text.length === 0 || Buffer.byteLength(text, 'utf8') > MAX_AGENT_EFFECT_RECEIPT_BYTES)) {
      throw new HarnessError('LIMIT_EXCEEDED', 'agent effect receipt exceeds the tool result bound', 413, false);
    }
    if (text !== undefined && input.state === 'UNKNOWN') throw new HarnessError('INVALID_INPUT', 'an unknown effect has no receipt');
    return immediate(this.database, () => {
      if (this.isEffectWriterFenced(input.fence, ['RUNNING', 'CANCELLING'])) return false;
      const placeholders = input.expectedStates.map(() => '?').join(',');
      const stored = text !== undefined && this.retainsReceiptText(input.fence.agentId, input.rootAgentId, Buffer.byteLength(text, 'utf8'))
        ? text
        : null;
      const result = this.database.prepare(`UPDATE agent_effects SET state=?, updated_at=?,
          result_json=?, result_sha256=?, result_reconciled=?, executor_generation=?, retain_until=?
        WHERE root_agent_id=? AND request_id=? AND kind=? AND owner_id=? AND workspace_id=? AND state IN (${placeholders})`)
        .run(
          input.state, input.now,
          stored, text === undefined ? null : sha256Hex(text), input.receipt?.reconciled ? 1 : 0,
          text === undefined ? null : input.fence.runnerEpoch,
          stored === null ? null : input.now + this.limits.sessionRetentionMs,
          input.rootAgentId, input.requestId, input.kind, input.fence.ownerId, input.fence.workspaceId, ...input.expectedStates
        );
      return Number(result.changes) === 1;
    });
  }

  /**
   * Whether a receipt's result text is stored, or only its hash. Only a continuation can replay a
   * stored result to the model, so only an agent spawned with session persistence stores text, and
   * its lineage stops at the configured byte cap; past it a repeat behaves as after retention.
   */
  private retainsReceiptText(agentId: string, rootAgentId: string, bytes: number): boolean {
    if (!this.database.prepare('SELECT 1 FROM agent_sessions WHERE agent_id=?').get(agentId)) return false;
    const held = this.database.prepare(`SELECT COALESCE(SUM(length(CAST(result_json AS BLOB))), 0) AS bytes FROM agent_effects
      WHERE root_agent_id=? AND result_json IS NOT NULL`).get(rootAgentId) as { bytes: number };
    return Number(held.bytes) + bytes <= this.limits.maxReceiptBytesPerLineage;
  }

  /** Clears receipt content past its retention; the effect state stays, so a repeat is never re-issued. */
  purgeExpiredReceipts(now: number, limit = 100): number {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new HarnessError('INVALID_INPUT', 'receipt purge page size is out of bounds');
    }
    // The reaper calls this every tick, so the common case takes no write lock.
    const due = this.database.prepare(`SELECT 1 FROM agent_effects
      WHERE result_json IS NOT NULL AND retain_until IS NOT NULL AND retain_until<=? LIMIT 1`).get(now);
    if (!due) return 0;
    return immediate(this.database, () => Number(this.database.prepare(`UPDATE agent_effects
      SET result_json=NULL, result_sha256=NULL, retain_until=NULL
      WHERE rowid IN (SELECT rowid FROM agent_effects
        WHERE result_json IS NOT NULL AND retain_until IS NOT NULL AND retain_until<=? ORDER BY retain_until ASC LIMIT ?)`)
      .run(now, limit).changes));
  }

  /**
   * Whether a writer has lost the right to change an agent's effects, usage, or session: the runner
   * epoch moved on, the agent's generation or epoch differs, its status is not one of `statuses`,
   * its workspace is no longer the active generation, or the agent was continued by a successor.
   */
  private isEffectWriterFenced(fence: AgentEffectFence, statuses?: readonly AgentStatus[]): boolean {
    if (this.instanceId && this.currentEpoch(this.instanceId) !== fence.runnerEpoch) return true;
    // Without a status set only the writer's identity is checked: an ended agent may still report
    // its final usage, but an earlier epoch or generation, or a continued predecessor, may not.
    const agent = (statuses
      ? this.database.prepare(`SELECT agents.status, agents.generation, agents.runner_epoch FROM agents
        JOIN workspaces ON workspaces.id=agents.workspace_id AND workspaces.owner_id=agents.owner_id
        WHERE agents.owner_id=? AND agents.workspace_id=? AND agents.id=?
          AND workspaces.status='ACTIVE' AND workspaces.generation=agents.workspace_generation`)
      : this.database.prepare(`SELECT status, generation, runner_epoch FROM agents WHERE owner_id=? AND workspace_id=? AND id=?`))
      .get(fence.ownerId, fence.workspaceId, fence.agentId) as { status: AgentStatus; generation: number; runner_epoch: number | null } | undefined;
    if (!agent || agent.generation !== fence.agentGeneration || agent.runner_epoch !== fence.runnerEpoch) return true;
    if (statuses && !statuses.includes(agent.status)) return true;
    return this.findSuccessor(fence.agentId) !== undefined;
  }

  private findEffectRow(key: AgentEffectKey): EffectRow | undefined {
    return this.database.prepare('SELECT * FROM agent_effects WHERE root_agent_id=? AND request_id=? AND kind=?')
      .get(key.rootAgentId, key.requestId, key.kind) as EffectRow | undefined;
  }

  transitionEffect(input: {
    agentId: string;
    agentGeneration: number;
    requestId: string;
    kind: string;
    expectedState: AgentEffectState | AgentEffectState[];
    state: AgentEffectState;
    runnerEpoch?: number;
    now: number;
  }): boolean {
    const expected = Array.isArray(input.expectedState) ? input.expectedState : [input.expectedState];
    const placeholders = expected.map(() => '?').join(',');
    const epochPredicate = input.runnerEpoch !== undefined ? 'AND runner_epoch=?' : '';
    const epochArgs = input.runnerEpoch !== undefined ? [input.runnerEpoch] : [];
    const result = this.database.prepare(`UPDATE agent_effects SET state=?, updated_at=?
      WHERE agent_id=? AND agent_generation=? AND request_id=? AND kind=? ${epochPredicate} AND state IN (${placeholders})`)
      .run(input.state, input.now, input.agentId, input.agentGeneration, input.requestId, input.kind, ...epochArgs, ...expected);
    return result.changes === 1;
  }

  usage(ownerId: string, workspaceId: string, agentId: string, generation: number): AgentUsage {
    const row = this.usageRow(ownerId, workspaceId, agentId, generation);
    return {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      costMicros: row.cost_micros,
      outputBytes: row.output_bytes,
      eventCount: row.event_count,
      toolTimeMs: row.tool_time_ms,
      wallTimeMs: row.wall_time_ms
    };
  }

  appendLog(ownerId: string, workspaceId: string, agentId: string, generation: number, eventType: string, content: string, now: number): AgentLogEvent {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(eventType)) throw new HarnessError('INVALID_INPUT', 'invalid agent log event type');
    const redacted = redactLogContent(content);
    const byteLength = Buffer.byteLength(redacted, 'utf8');
    if (byteLength === 0) throw new HarnessError('INVALID_INPUT', 'agent log event content cannot be empty');
    if (byteLength > this.limits.maxLogEventBytes) throw new HarnessError('LIMIT_EXCEEDED', 'agent log event exceeds configured size', 413, false);
    return immediate(this.database, () => {
      const agent = this.database.prepare(`SELECT max_output_bytes FROM agents WHERE owner_id=? AND workspace_id=? AND id=? AND generation=?`)
        .get(ownerId, workspaceId, agentId, generation) as { max_output_bytes: number } | undefined;
      if (!agent) throw notFound();
      const usage = this.usageRow(ownerId, workspaceId, agentId, generation);
      if (usage.output_bytes + byteLength > agent.max_output_bytes) {
        throw new HarnessError('LIMIT_EXCEEDED', 'agent output byte budget is exhausted', 429, false);
      }
      const watermark = this.database.prepare(`SELECT retained_base_cursor, next_cursor, retained_bytes, retained_events
        FROM agent_log_watermarks WHERE owner_id=? AND workspace_id=? AND agent_id=? AND agent_generation=?`)
        .get(ownerId, workspaceId, agentId, generation) as {
          retained_base_cursor: number; next_cursor: number; retained_bytes: number; retained_events: number;
        } | undefined;
      if (!watermark) throw new HarnessError('INTERNAL_ERROR', 'agent log watermark is missing', 500, false);
      const cursorEnd = watermark.next_cursor + byteLength;
      if (!Number.isSafeInteger(cursorEnd)) throw new HarnessError('LIMIT_EXCEEDED', 'agent log cursor capacity is exhausted', 429, false);
      this.database.prepare(`INSERT INTO agent_log_chunks
        (owner_id, workspace_id, agent_id, agent_generation, cursor_start, cursor_end, created_at, event_type, content, byte_length)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(ownerId, workspaceId, agentId, generation, watermark.next_cursor, cursorEnd, now, eventType, redacted, byteLength);
      this.database.prepare(`UPDATE agent_log_watermarks SET next_cursor=?, retained_bytes=retained_bytes+?, retained_events=retained_events+1
        WHERE owner_id=? AND workspace_id=? AND agent_id=? AND agent_generation=?`)
        .run(cursorEnd, byteLength, ownerId, workspaceId, agentId, generation);
      this.database.prepare(`UPDATE agent_usage SET output_bytes=output_bytes+?, event_count=event_count+1
        WHERE owner_id=? AND workspace_id=? AND agent_id=? AND agent_generation=?`)
        .run(byteLength, ownerId, workspaceId, agentId, generation);
      this.enforceLogCaps(ownerId, workspaceId, agentId, generation);
      return { cursor: String(watermark.next_cursor), nextCursor: String(cursorEnd), timestamp: now, type: eventType, content: redacted };
    });
  }

  readLogs(ownerId: string, workspaceId: string, agentId: string, generation: number, cursor: string, limitBytes: number): AgentLogPage {
    if (!/^(?:0|[1-9]\d*)$/.test(cursor) || Number(cursor) > Number.MAX_SAFE_INTEGER) {
      throw new HarnessError('INVALID_INPUT', 'agent log cursor is invalid');
    }
    if (!Number.isInteger(limitBytes) || limitBytes < 1_024 || limitBytes > 262_144) {
      throw new HarnessError('INVALID_INPUT', 'agent log page size is out of bounds');
    }
    const agent = this.database.prepare(`SELECT id FROM agents WHERE owner_id=? AND workspace_id=? AND id=? AND generation=?`)
      .get(ownerId, workspaceId, agentId, generation);
    if (!agent) throw notFound();
    const watermark = this.database.prepare(`SELECT retained_base_cursor, next_cursor FROM agent_log_watermarks
      WHERE owner_id=? AND workspace_id=? AND agent_id=? AND agent_generation=?`)
      .get(ownerId, workspaceId, agentId, generation) as { retained_base_cursor: number; next_cursor: number };
    const requested = Number(cursor);
    const start = Math.max(requested, watermark.retained_base_cursor);
    const rows = this.database.prepare(`SELECT cursor_start, cursor_end, created_at, event_type, content, byte_length
      FROM agent_log_chunks WHERE owner_id=? AND workspace_id=? AND agent_id=? AND agent_generation=? AND cursor_end>?
      ORDER BY cursor_start ASC`)
      .all(ownerId, workspaceId, agentId, generation, start) as Array<{
        cursor_start: number; cursor_end: number; created_at: number; event_type: string; content: string; byte_length: number;
      }>;
    const events: AgentLogEvent[] = [];
    let retainedBytes = 0;
    for (const row of rows) {
      if (events.length >= 1_000 || (events.length > 0 && retainedBytes + row.byte_length > limitBytes)) break;
      events.push({ cursor: String(row.cursor_start), nextCursor: String(row.cursor_end), timestamp: row.created_at, type: row.event_type, content: row.content });
      retainedBytes += row.byte_length;
    }
    const next = events.at(-1)?.nextCursor ?? String(start);
    return {
      cursor: String(start),
      nextCursor: next,
      retainedBaseCursor: String(watermark.retained_base_cursor),
      events,
      truncated: requested < watermark.retained_base_cursor,
      hasMore: Number(next) < watermark.next_cursor
    };
  }

  scheduleCleanupRetry(input: CleanupRetryRecord): void {
    if (!Number.isInteger(input.attempts) || input.attempts < 1 || input.attempts > this.limits.cleanupRetryLimit) {
      throw new HarnessError('LIMIT_EXCEEDED', 'cleanup retry limit is exhausted', 429, false);
    }
    if (Buffer.byteLength(input.lastError, 'utf8') > 2_000) {
      throw new HarnessError('INVALID_INPUT', 'cleanup retry error is too large');
    }
    immediate(this.database, () => {
      const agent = this.database.prepare(`SELECT id FROM agents
        WHERE owner_id=? AND workspace_id=? AND id=? AND generation=?`)
        .get(input.ownerId, input.workspaceId, input.agentId, input.agentGeneration);
      if (!agent) throw notFound();
      this.database.prepare(`INSERT INTO agent_cleanup_retries
        (owner_id, workspace_id, agent_id, agent_generation, attempts, next_attempt_at, last_error, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, workspace_id, agent_id, agent_generation) DO UPDATE SET
          attempts=excluded.attempts, next_attempt_at=excluded.next_attempt_at, last_error=excluded.last_error, updated_at=excluded.updated_at`)
        .run(input.ownerId, input.workspaceId, input.agentId, input.agentGeneration, input.attempts, input.nextAttemptAt, input.lastError, input.updatedAt);
    });
  }

  cleanupRetry(ownerId: string, workspaceId: string, agentId: string, generation: number): CleanupRetryRecord | undefined {
    const row = this.database.prepare(`SELECT * FROM agent_cleanup_retries
      WHERE owner_id=? AND workspace_id=? AND agent_id=? AND agent_generation=?`)
      .get(ownerId, workspaceId, agentId, generation) as CleanupRetryRow | undefined;
    return row ? cleanupRetryFromRow(row) : undefined;
  }

  listCleanupRetries(ownerId: string, workspaceId: string, dueBefore: number, limit = 100): CleanupRetryRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new HarnessError('INVALID_INPUT', 'cleanup retry page size is out of bounds');
    }
    const rows = this.database.prepare(`SELECT * FROM agent_cleanup_retries
      WHERE owner_id=? AND workspace_id=? AND next_attempt_at<=? ORDER BY next_attempt_at ASC, agent_id ASC LIMIT ?`)
      .all(ownerId, workspaceId, dueBefore, limit) as CleanupRetryRow[];
    return rows.map(cleanupRetryFromRow);
  }

  clearCleanupRetry(ownerId: string, workspaceId: string, agentId: string, generation: number): boolean {
    return this.database.prepare(`DELETE FROM agent_cleanup_retries
      WHERE owner_id=? AND workspace_id=? AND agent_id=? AND agent_generation=?`)
      .run(ownerId, workspaceId, agentId, generation).changes === 1;
  }

  prepareWorkspaceStartupRepair(ownerId: string, workspaceId: string, workspaceGeneration: number, now: number): AgentRecord[] {
    return immediate(this.database, () => {
      this.database.prepare(`UPDATE agent_workspace_admission SET spawn_open=0, message_open=0, updated_at=?
        WHERE owner_id=? AND workspace_id=? AND workspace_generation=?`)
        .run(now, ownerId, workspaceId, workspaceGeneration);
      this.database.prepare(`UPDATE agents SET spawn_admission_open=0, message_admission_open=0
        WHERE owner_id=? AND workspace_id=? AND workspace_generation=? AND status IN ('SPAWNING','RUNNING','CANCELLING')`)
        .run(ownerId, workspaceId, workspaceGeneration);
      this.database.prepare(`UPDATE agent_messages SET state='UNKNOWN', updated_at=?, error='runner restart interrupted delivery'
        WHERE owner_id=? AND workspace_id=? AND agent_generation IN (
          SELECT generation FROM agents WHERE owner_id=? AND workspace_id=? AND workspace_generation=?
        ) AND state='RESERVED'`)
        .run(now, ownerId, workspaceId, ownerId, workspaceId, workspaceGeneration);
      this.database.prepare(`UPDATE agent_effects SET state='UNKNOWN', updated_at=?
        WHERE owner_id=? AND workspace_id=? AND agent_generation IN (
          SELECT generation FROM agents WHERE owner_id=? AND workspace_id=? AND workspace_generation=?
        ) AND state IN ('INTENT', 'DISPATCHED')`)
        .run(now, ownerId, workspaceId, ownerId, workspaceId, workspaceGeneration);
      const rows = this.database.prepare(`SELECT * FROM agents
        WHERE owner_id=? AND workspace_id=? AND workspace_generation=? ORDER BY created_at ASC`)
        .all(ownerId, workspaceId, workspaceGeneration) as AgentRow[];
      for (const row of rows) this.enforceLogCaps(ownerId, workspaceId, row.id, row.generation);
      return rows.filter((row) => ACTIVE_STATUSES.includes(row.status)).map(agentFromRow);
    });
  }

  compactClosedWorkspace(ownerId: string, workspaceId: string, workspaceGeneration: number, now: number): number {
    return immediate(this.database, () => {
      const workspace = this.database.prepare(`SELECT status, generation FROM workspaces
        WHERE owner_id=? AND id=? AND generation=? AND status='CLOSED'`)
        .get(ownerId, workspaceId, workspaceGeneration) as { status: string; generation: number } | undefined;
      if (!workspace) throw new HarnessError('CONFLICT', 'workspace must be closed before agent state compaction', 409, false);
      const active = this.database.prepare(`SELECT COUNT(*) AS count FROM agents
        WHERE owner_id=? AND workspace_id=? AND status IN ('SPAWNING','RUNNING','CANCELLING')`)
        .get(ownerId, workspaceId) as { count: number };
      if (active.count !== 0) throw new HarnessError('CONFLICT', 'nonterminal agents prevent workspace compaction', 409, true);
      const retentionCutoff = now - this.limits.retentionSeconds * 1_000;
      const retained = this.database.prepare(`SELECT COUNT(*) AS count FROM agents
        WHERE owner_id=? AND workspace_id=? AND (terminal_at IS NULL OR terminal_at>?)`)
        .get(ownerId, workspaceId, retentionCutoff) as { count: number };
      if (retained.count !== 0) {
        throw new HarnessError('CONFLICT', 'closed workspace agent retention horizon has not elapsed', 409, true);
      }
      this.database.prepare(`INSERT INTO agent_tombstones
        (owner_id, workspace_id, agent_id, idempotency_key, payload_hash, status, generation, created_at, expires_at)
        SELECT owner_id, workspace_id, id, idempotency_key, payload_hash, status, generation, ?,
          terminal_at + ? FROM agents
        WHERE owner_id=? AND workspace_id=?
        ON CONFLICT(owner_id, workspace_id, agent_id) DO UPDATE SET
          status=excluded.status, generation=excluded.generation, expires_at=MAX(agent_tombstones.expires_at, excluded.expires_at)`)
        .run(now, this.limits.lookupHorizonSeconds * 1_000, ownerId, workspaceId);
      const count = this.database.prepare('SELECT COUNT(*) AS count FROM agents WHERE owner_id=? AND workspace_id=?')
        .get(ownerId, workspaceId) as { count: number };
      this.database.prepare('DELETE FROM agent_log_chunks WHERE owner_id=? AND workspace_id=?').run(ownerId, workspaceId);
      this.database.prepare('DELETE FROM agent_log_watermarks WHERE owner_id=? AND workspace_id=?').run(ownerId, workspaceId);
      this.database.prepare('DELETE FROM agent_usage WHERE owner_id=? AND workspace_id=?').run(ownerId, workspaceId);
      this.database.prepare('DELETE FROM agent_messages WHERE owner_id=? AND workspace_id=?').run(ownerId, workspaceId);
      this.database.prepare('DELETE FROM agent_cleanup_retries WHERE owner_id=? AND workspace_id=?').run(ownerId, workspaceId);
      this.deleteSessionRows(ownerId, workspaceId);
      this.database.prepare('DELETE FROM agents WHERE owner_id=? AND workspace_id=?').run(ownerId, workspaceId);
      this.database.prepare('DELETE FROM agent_workspace_admission WHERE owner_id=? AND workspace_id=? AND workspace_generation=?')
        .run(ownerId, workspaceId, workspaceGeneration);
      return count.count;
    });
  }

  purgeExpiredTombstones(ownerId: string, workspaceId: string, now: number): number {
    return Number(this.database.prepare(`DELETE FROM agent_tombstones
      WHERE owner_id=? AND workspace_id=? AND expires_at<=? AND EXISTS (
        SELECT 1 FROM workspaces WHERE owner_id=? AND id=? AND status='CLOSED'
      )`).run(ownerId, workspaceId, now, ownerId, workspaceId).changes);
  }

  maintainClosedWorkspaces(now: number, limit = 100): ClosedWorkspaceMaintenance {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new HarnessError('INVALID_INPUT', 'closed workspace maintenance page size is out of bounds');
    }
    const retentionCutoff = now - this.limits.retentionSeconds * 1_000;
    const candidates = this.database.prepare(`SELECT w.owner_id, w.id, w.generation,
        EXISTS (
          SELECT 1 FROM agents a WHERE a.owner_id=w.owner_id AND a.workspace_id=w.id
        ) AND NOT EXISTS (
          SELECT 1 FROM agents a WHERE a.owner_id=w.owner_id AND a.workspace_id=w.id
            AND (a.status IN ('SPAWNING','RUNNING','CANCELLING') OR a.terminal_at IS NULL OR a.terminal_at>?)
        ) AS compactable,
        EXISTS (
          SELECT 1 FROM agent_tombstones t
          WHERE t.owner_id=w.owner_id AND t.workspace_id=w.id AND t.expires_at<=?
        ) AS purgeable
      FROM workspaces w
      WHERE w.status='CLOSED' AND (
        (
          EXISTS (SELECT 1 FROM agents a WHERE a.owner_id=w.owner_id AND a.workspace_id=w.id)
          AND NOT EXISTS (
            SELECT 1 FROM agents a WHERE a.owner_id=w.owner_id AND a.workspace_id=w.id
              AND (a.status IN ('SPAWNING','RUNNING','CANCELLING') OR a.terminal_at IS NULL OR a.terminal_at>?)
          )
        )
        OR EXISTS (
          SELECT 1 FROM agent_tombstones t
          WHERE t.owner_id=w.owner_id AND t.workspace_id=w.id AND t.expires_at<=?
        )
      )
      ORDER BY w.last_activity_at ASC, w.id ASC LIMIT ?`)
      .all(retentionCutoff, now, retentionCutoff, now, limit) as Array<{
        owner_id: string;
        id: string;
        generation: number;
        compactable: number;
        purgeable: number;
      }>;
    let compactedAgents = 0;
    let purgedTombstones = 0;
    for (const candidate of candidates) {
      if (candidate.compactable === 1) {
        compactedAgents += this.compactClosedWorkspace(
          candidate.owner_id,
          candidate.id,
          candidate.generation,
          now
        );
      }
      if (candidate.purgeable === 1 || candidate.compactable === 1) {
        purgedTombstones += this.purgeExpiredTombstones(candidate.owner_id, candidate.id, now);
      }
    }
    return { workspaces: candidates.length, compactedAgents, purgedTombstones };
  }

  findSession(agentId: string): AgentSessionRecord | undefined {
    const row = this.database.prepare('SELECT * FROM agent_sessions WHERE agent_id=?').get(agentId) as SessionRow | undefined;
    return row ? sessionFromRow(row) : undefined;
  }

  /** The agent that continued this one, if any; the schema allows at most one. */
  findSuccessor(agentId: string): string | undefined {
    const row = this.database.prepare('SELECT agent_id FROM agent_sessions WHERE continued_from=?').get(agentId) as { agent_id: string } | undefined;
    return row?.agent_id;
  }

  /**
   * Checks that an agent may be continued by a new one: it belongs to this owner, workspace, and
   * workspace generation, it is terminal, its session is sealed and continuable, and nothing has
   * continued it yet. Spawn admission calls it again inside its transaction.
   */
  requireContinuable(ownerId: string, workspaceId: string, workspaceGeneration: number, agentId: string): { predecessor: AgentRecord; session: AgentSessionRecord } {
    const predecessor = this.findAgent(ownerId, workspaceId, agentId);
    if (!predecessor) throw new HarnessError('NOT_FOUND', 'the agent to continue was not found in this workspace', 404, false);
    if (predecessor.workspaceGeneration !== workspaceGeneration) {
      throw new HarnessError('STALE_GENERATION', 'the agent to continue belongs to an earlier generation of this workspace', 409, false);
    }
    if (!TERMINAL_STATUSES.includes(predecessor.status)) {
      throw new HarnessError('CONFLICT', 'the agent to continue has not ended; wait for a terminal status or cancel it first', 409, true);
    }
    const session = this.findSession(agentId);
    if (!session || session.ownerId !== ownerId || session.workspaceId !== workspaceId) {
      throw new HarnessError('CONFLICT', 'the agent to continue has no persisted session; it was spawned while session persistence was off', 409, false);
    }
    if (session.state === 'PURGED') {
      throw new HarnessError('EXPIRED', 'the persisted session of the agent to continue was purged by retention', 410, false);
    }
    if (session.state !== 'SEALED' || !session.continuable) {
      throw new HarnessError('CONFLICT', 'the persisted session of the agent to continue is not continuable: its log is incomplete or exceeded the session bounds', 409, false);
    }
    const successor = this.findSuccessor(agentId);
    if (successor) throw new HarnessError('CONFLICT', `the agent was already continued by ${successor}; continue that agent instead`, 409, false);
    return { predecessor, session };
  }

  /**
   * Reads an agent's session log and verifies it against its stored count, bytes, per-message
   * digests, and chained head before anything is sent to a runtime.
   */
  loadSessionLog(agentId: string, generation: number): { messages: unknown[]; headSha256: string; bytes: number } {
    const session = this.findSession(agentId);
    if (!session || session.state === 'PURGED') throw new HarnessError('NOT_FOUND', 'agent session was not found', 404, false);
    const rows = this.database.prepare(`SELECT seq, message_json, bytes, sha256 FROM agent_session_messages
      WHERE agent_id=? AND agent_generation=? ORDER BY seq ASC`)
      .all(agentId, generation) as Array<{ seq: number; message_json: string; bytes: number; sha256: string }>;
    let head = AGENT_SESSION_GENESIS_SHA256;
    let bytes = 0;
    const messages: unknown[] = [];
    const corrupt = () => new HarnessError('INTERNAL_ERROR', 'agent session log failed integrity verification', 500, false);
    if (rows.length !== session.messageCount) throw corrupt();
    for (const [index, row] of rows.entries()) {
      const digest = sha256Hex(row.message_json);
      if (row.seq !== index || row.sha256 !== digest || row.bytes !== Buffer.byteLength(row.message_json, 'utf8')) throw corrupt();
      head = chainAgentSessionHead(head, digest);
      bytes += row.bytes;
      messages.push(JSON.parse(row.message_json));
    }
    if (head !== session.headSha256 || bytes !== session.bytes) throw corrupt();
    return { messages, headSha256: head, bytes };
  }

  /**
   * Appends one runtime message to an agent's session log. Only a running agent of the current
   * runner epoch and generation may write, and only the next sequence number is accepted. A gap,
   * an invalid message, or exceeding the bounds stops the log and marks it not continuable; the
   * run itself continues.
   */
  appendSessionMessage(input: AgentSessionAppend): AgentSessionAppendResult {
    const role = typeof input.message === 'object' && input.message !== null && !Array.isArray(input.message)
      ? (input.message as { role?: unknown }).role
      : undefined;
    const valid = typeof role === 'string' && SESSION_ROLES.has(role) && Number.isSafeInteger(input.seq) && input.seq >= 0;
    const json = valid ? JSON.stringify(input.message) : '';
    const bytes = Buffer.byteLength(json, 'utf8');
    return immediate(this.database, () => {
      if (this.instanceId && this.currentEpoch(this.instanceId) !== input.runnerEpoch) return 'FENCED';
      const agent = this.database.prepare(`SELECT status, generation, runner_epoch FROM agents
        WHERE owner_id=? AND workspace_id=? AND id=?`)
        .get(input.ownerId, input.workspaceId, input.agentId) as { status: AgentStatus; generation: number; runner_epoch: number } | undefined;
      if (!agent || agent.status !== 'RUNNING' || agent.generation !== input.generation || agent.runner_epoch !== input.runnerEpoch) return 'FENCED';
      if (this.findSuccessor(input.agentId) !== undefined) return 'FENCED';
      const session = this.database.prepare('SELECT * FROM agent_sessions WHERE agent_id=? AND owner_id=? AND workspace_id=?')
        .get(input.agentId, input.ownerId, input.workspaceId) as SessionRow | undefined;
      if (!session || session.state !== 'ACTIVE' || session.continuable !== 1) return 'IGNORED';
      if (!valid || input.seq !== session.message_count
        || session.message_count + 1 > this.limits.maxSessionMessages
        || session.bytes + bytes > this.limits.maxSessionBytes
        || this.exceededSessionBudget(input.ownerId, input.workspaceId, bytes)) {
        this.database.prepare('UPDATE agent_sessions SET continuable=0, updated_at=? WHERE agent_id=?').run(input.now, input.agentId);
        return 'DISCONTINUED';
      }
      const digest = sha256Hex(json);
      this.database.prepare(`INSERT INTO agent_session_messages
        (agent_id, agent_generation, seq, role, message_json, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.agentId, input.generation, input.seq, role, json, bytes, digest, input.now);
      this.database.prepare(`UPDATE agent_sessions SET message_count=message_count+1, bytes=bytes+?, head_sha256=?, updated_at=?
        WHERE agent_id=?`)
        .run(bytes, chainAgentSessionHead(session.head_sha256, digest), input.now, input.agentId);
      return 'APPENDED';
    });
  }

  /**
   * Names the aggregate session byte budget that `addedBytes` more stored messages would exceed, if
   * any. Every stored log counts, including a discontinued one, until retention or workspace close
   * deletes it; a purged session holds no bytes.
   */
  private exceededSessionBudget(ownerId: string, workspaceId: string, addedBytes: number): 'workspace' | 'principal' | 'instance' | undefined {
    const usage = this.database.prepare(`SELECT
      (SELECT COALESCE(SUM(bytes), 0) FROM agent_sessions WHERE owner_id=? AND workspace_id=?) AS workspace_bytes,
      (SELECT COALESCE(SUM(bytes), 0) FROM agent_sessions WHERE owner_id=?) AS principal_bytes,
      (SELECT COALESCE(SUM(bytes), 0) FROM agent_sessions) AS global_bytes`)
      .get(ownerId, workspaceId, ownerId) as { workspace_bytes: number; principal_bytes: number; global_bytes: number };
    if (usage.workspace_bytes + addedBytes > this.limits.workspaceSessionBytes) return 'workspace';
    if (usage.principal_bytes + addedBytes > this.limits.principalSessionBytes) return 'principal';
    if (usage.global_bytes + addedBytes > this.limits.globalSessionBytes) return 'instance';
    return undefined;
  }

  /** Stops an active log after a failure to record it, so a partial history is never continued. */
  discontinueSession(agentId: string, now: number): void {
    this.database.prepare(`UPDATE agent_sessions SET continuable=0, updated_at=? WHERE agent_id=? AND state='ACTIVE'`).run(now, agentId);
  }

  /** Purges the logs of sealed sessions past their retention; the session row stays as PURGED. */
  purgeExpiredSessions(now: number, limit = 100): number {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new HarnessError('INVALID_INPUT', 'session purge page size is out of bounds');
    }
    // The reaper calls this every tick, so the common case takes no write lock.
    const due = this.database.prepare(`SELECT 1 FROM agent_sessions
      WHERE state='SEALED' AND retain_until IS NOT NULL AND retain_until<=? LIMIT 1`).get(now);
    if (!due) return 0;
    return immediate(this.database, () => {
      const rows = this.database.prepare(`SELECT agent_id FROM agent_sessions
        WHERE state='SEALED' AND retain_until IS NOT NULL AND retain_until<=? ORDER BY retain_until ASC LIMIT ?`)
        .all(now, limit) as Array<{ agent_id: string }>;
      for (const row of rows) {
        this.database.prepare('DELETE FROM agent_session_messages WHERE agent_id=?').run(row.agent_id);
        this.database.prepare(`UPDATE agent_sessions SET state='PURGED', continuable=0, message_count=0, bytes=0, updated_at=?
          WHERE agent_id=?`).run(now, row.agent_id);
      }
      return rows.length;
    });
  }

  /**
   * Deletes every session row and effect receipt of a workspace, used when the workspace closes or
   * expires and when its agent records are compacted.
   */
  deleteWorkspaceSessions(ownerId: string, workspaceId: string): number {
    return immediate(this.database, () => this.deleteSessionRows(ownerId, workspaceId));
  }

  private deleteSessionRows(ownerId: string, workspaceId: string): number {
    this.database.prepare('DELETE FROM agent_effects WHERE owner_id=? AND workspace_id=?').run(ownerId, workspaceId);
    this.database.prepare(`DELETE FROM agent_session_messages WHERE agent_id IN (
      SELECT agent_id FROM agent_sessions WHERE owner_id=? AND workspace_id=?)`).run(ownerId, workspaceId);
    return Number(this.database.prepare('DELETE FROM agent_sessions WHERE owner_id=? AND workspace_id=?').run(ownerId, workspaceId).changes);
  }

  private insertSession(input: AgentSpawnReservation, continuation: { predecessor: AgentRecord; session: AgentSessionRecord } | undefined): void {
    const source = continuation?.session;
    try {
      this.database.prepare(`INSERT INTO agent_sessions
        (agent_id, owner_id, workspace_id, workspace_generation, root_agent_id, continued_from, message_count, bytes,
         head_sha256, state, continuable, retain_until, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1, NULL, ?, ?)`)
        .run(
          input.id, input.ownerId, input.workspaceId, input.workspaceGeneration, source?.rootAgentId ?? input.id,
          source?.agentId ?? null, source?.messageCount ?? 0, source?.bytes ?? 0, source?.headSha256 ?? AGENT_SESSION_GENESIS_SHA256,
          input.now, input.now
        );
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
        throw new HarnessError('CONFLICT', 'the agent was already continued by another agent', 409, false);
      }
      throw error;
    }
    if (!continuation) return;
    // The new log starts as a copy of the predecessor's, so each session is self-contained.
    this.database.prepare(`INSERT INTO agent_session_messages
      (agent_id, agent_generation, seq, role, message_json, bytes, sha256, created_at)
      SELECT ?, 1, seq, role, message_json, bytes, sha256, created_at FROM agent_session_messages
      WHERE agent_id=? AND agent_generation=? ORDER BY seq ASC`)
      .run(input.id, continuation.predecessor.id, continuation.predecessor.generation);
  }

  private sealSession(agentId: string, status: AgentStatus, now: number): void {
    this.database.prepare(`UPDATE agent_sessions SET state='SEALED',
      continuable=CASE WHEN ?=1 THEN continuable ELSE 0 END, retain_until=?, updated_at=?
      WHERE agent_id=? AND state='ACTIVE'`)
      .run(CONTINUABLE_TERMINAL_STATUSES.includes(status) ? 1 : 0, now + this.limits.sessionRetentionMs, now, agentId);
  }

  private usageRow(ownerId: string, workspaceId: string, agentId: string, generation: number): UsageRow {
    const row = this.database.prepare(`SELECT * FROM agent_usage
      WHERE owner_id=? AND workspace_id=? AND agent_id=? AND agent_generation=?`)
      .get(ownerId, workspaceId, agentId, generation) as UsageRow | undefined;
    if (!row) throw notFound();
    return row;
  }

  private enforceLogCaps(ownerId: string, workspaceId: string, agentId: string, generation: number): void {
    const other = this.database.prepare(`SELECT
      (SELECT COALESCE(SUM(byte_length),0) FROM agent_log_chunks WHERE NOT (owner_id=? AND workspace_id=? AND agent_id=? AND agent_generation=?)) AS global_bytes,
      (SELECT COUNT(*) FROM agent_log_chunks WHERE NOT (owner_id=? AND workspace_id=? AND agent_id=? AND agent_generation=?)) AS global_rows,
      (SELECT COALESCE(SUM(byte_length),0) FROM agent_log_chunks WHERE owner_id=? AND NOT (workspace_id=? AND agent_id=? AND agent_generation=?)) AS principal_bytes,
      (SELECT COUNT(*) FROM agent_log_chunks WHERE owner_id=? AND NOT (workspace_id=? AND agent_id=? AND agent_generation=?)) AS principal_rows,
      (SELECT COALESCE(SUM(byte_length),0) FROM agent_log_chunks WHERE owner_id=? AND workspace_id=? AND NOT (agent_id=? AND agent_generation=?)) AS workspace_bytes,
      (SELECT COUNT(*) FROM agent_log_chunks WHERE owner_id=? AND workspace_id=? AND NOT (agent_id=? AND agent_generation=?)) AS workspace_rows`)
      .get(
        ownerId, workspaceId, agentId, generation, ownerId, workspaceId, agentId, generation,
        ownerId, workspaceId, agentId, generation, ownerId, workspaceId, agentId, generation,
        ownerId, workspaceId, agentId, generation, ownerId, workspaceId, agentId, generation
      ) as {
        global_bytes: number; global_rows: number; principal_bytes: number; principal_rows: number;
        workspace_bytes: number; workspace_rows: number;
      };
    const byteCap = Math.max(0, Math.min(
      this.limits.maxLogBytesPerAgent,
      this.limits.globalRetainedBytes - other.global_bytes,
      this.limits.principalRetainedBytes - other.principal_bytes,
      this.limits.workspaceRetainedBytes - other.workspace_bytes
    ));
    const rowCap = Math.max(0, Math.min(
      this.limits.maxLogEventsPerAgent,
      this.limits.globalRetainedRows - other.global_rows,
      this.limits.principalRetainedRows - other.principal_rows,
      this.limits.workspaceRetainedRows - other.workspace_rows
    ));
    let watermark = this.database.prepare(`SELECT retained_bytes, retained_events FROM agent_log_watermarks
      WHERE owner_id=? AND workspace_id=? AND agent_id=? AND agent_generation=?`)
      .get(ownerId, workspaceId, agentId, generation) as { retained_bytes: number; retained_events: number };
    while (watermark.retained_bytes > byteCap || watermark.retained_events > rowCap) {
      const oldest = this.database.prepare(`SELECT cursor_end, byte_length FROM agent_log_chunks
        WHERE owner_id=? AND workspace_id=? AND agent_id=? AND agent_generation=? ORDER BY cursor_start ASC LIMIT 1`)
        .get(ownerId, workspaceId, agentId, generation) as { cursor_end: number; byte_length: number } | undefined;
      if (!oldest) break;
      this.database.prepare(`DELETE FROM agent_log_chunks
        WHERE owner_id=? AND workspace_id=? AND agent_id=? AND agent_generation=? AND cursor_end=?`)
        .run(ownerId, workspaceId, agentId, generation, oldest.cursor_end);
      this.database.prepare(`UPDATE agent_log_watermarks SET retained_base_cursor=?, retained_bytes=retained_bytes-?, retained_events=retained_events-1
        WHERE owner_id=? AND workspace_id=? AND agent_id=? AND agent_generation=?`)
        .run(oldest.cursor_end, oldest.byte_length, ownerId, workspaceId, agentId, generation);
      watermark = { retained_bytes: watermark.retained_bytes - oldest.byte_length, retained_events: watermark.retained_events - 1 };
    }
  }
}

export const AGENT_ACTIVE_STATUSES = ACTIVE_STATUSES;
export const AGENT_TERMINAL_STATUSES = TERMINAL_STATUSES;
