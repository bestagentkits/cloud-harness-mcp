import { Buffer } from 'node:buffer';
import type { DatabaseSync } from 'node:sqlite';
import {
  AgentProxyOperationSchema,
  HarnessError,
  type AgentBudget,
  type AgentMessageDeliveryState,
  type AgentMessageMode,
  type AgentProxyOperation,
  type AgentStatus,
  type AgentUsage,
  type RunnerAgentLimits
} from '@cloud-harness/contracts';

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
  idempotencyKey: string;
  payloadHash: string;
  mode: AgentMessageMode;
  state: AgentMessageDeliveryState;
  createdAt: number;
  updatedAt: number;
  error: string | null;
};

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
  now: number;
  expiresAt: number;
};

export type AgentStatusTransition = {
  ownerId: string;
  workspaceId: string;
  agentId: string;
  generation: number;
  expectedStatuses: AgentStatus[];
  status: AgentStatus;
  now: number;
  terminalReason?: string | null;
  cleanupReason?: string | null;
  outcomeUnknown?: boolean;
};


export type AgentUsageDelta = Partial<AgentUsage>;

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
    private readonly limits: RunnerAgentLimits
  ) {}

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
      const workspace = this.database.prepare(`SELECT id, generation, status, network_mode, expires_at FROM workspaces
        WHERE owner_id=? AND id=? AND generation=?`)
        .get(input.ownerId, input.workspaceId, input.workspaceGeneration) as {
          id: string; generation: number; status: string; network_mode: string; expires_at: number;
        } | undefined;
      if (!workspace) throw new HarnessError('NOT_FOUND', 'workspace was not found', 404, false);
      if (workspace.status !== 'ACTIVE' || workspace.network_mode !== 'none') {
        throw new HarnessError('CONFLICT', 'workspace is not eligible for agent admission', 409, false);
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

      this.database.prepare(`INSERT INTO agents
        (id, owner_id, workspace_id, workspace_generation, parent_agent_id, parent_generation,
         idempotency_key, payload_hash, prompt_hash, profile_id, proxy_operations_json,
         max_ttl_seconds, max_output_bytes, max_input_tokens, max_output_tokens, max_cost_micros,
         container_name, network_name, gateway_lease_id, status, generation, spawn_admission_open, message_admission_open,
         created_at, started_at, terminal_at, expires_at, terminal_reason, cleanup_reason, outcome_unknown)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SPAWNING', 1, 1, 1, ?, NULL, NULL, ?, NULL, NULL, 0)`)
        .run(
          input.id, input.ownerId, input.workspaceId, input.workspaceGeneration, input.parentAgentId ?? null, parentGeneration,
          input.idempotencyKey, input.payloadHash, input.promptHash, input.profileId, JSON.stringify(proxyOperations),
          input.budget.ttlSeconds, input.budget.maxOutputBytes, input.budget.maxInputTokens, input.budget.maxOutputTokens,
          input.budget.maxCostMicros, input.containerName, input.networkName, input.gatewayLeaseId, input.now, input.expiresAt
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
    const result = this.database.prepare(`UPDATE agents SET status=?,
      started_at=CASE WHEN ?='RUNNING' AND started_at IS NULL THEN ? ELSE started_at END,
      terminal_at=CASE WHEN ?=1 THEN ? ELSE terminal_at END,
      terminal_reason=COALESCE(?, terminal_reason), cleanup_reason=COALESCE(?, cleanup_reason),
      outcome_unknown=CASE WHEN ? IS NULL THEN outcome_unknown ELSE ? END,
      spawn_admission_open=CASE WHEN ?=1 THEN 0 ELSE spawn_admission_open END,
      message_admission_open=CASE WHEN ?=1 THEN 0 ELSE message_admission_open END
      WHERE owner_id=? AND workspace_id=? AND id=? AND generation=? AND status IN (${placeholders})`)
      .run(
        input.status, input.status, input.now, terminal ? 1 : 0, input.now,
        input.terminalReason ?? null, input.cleanupReason ?? null,
        input.outcomeUnknown === undefined ? null : (input.outcomeUnknown ? 1 : 0), input.outcomeUnknown ? 1 : 0,
        closesAdmission ? 1 : 0, closesAdmission ? 1 : 0,
        input.ownerId, input.workspaceId, input.agentId, input.generation, ...input.expectedStatuses
      );
    return result.changes === 1 ? this.findAgent(input.ownerId, input.workspaceId, input.agentId) : undefined;
  }

  closeWorkspaceAdmission(ownerId: string, workspaceId: string, workspaceGeneration: number, now: number): boolean {
    return immediate(this.database, () => {
      const result = this.database.prepare(`UPDATE agent_workspace_admission SET spawn_open=0, message_open=0, updated_at=?
        WHERE owner_id=? AND workspace_id=? AND workspace_generation=?`)
        .run(now, ownerId, workspaceId, workspaceGeneration);
      this.database.prepare(`UPDATE agents SET spawn_admission_open=0, message_admission_open=0
        WHERE owner_id=? AND workspace_id=? AND workspace_generation=? AND status IN ('SPAWNING','RUNNING','CANCELLING')`)
        .run(ownerId, workspaceId, workspaceGeneration);
      return result.changes === 1;
    });
  }

  openWorkspaceAdmission(ownerId: string, workspaceId: string, workspaceGeneration: number, now: number): boolean {
    return immediate(this.database, () => {
      const workspace = this.database.prepare(`SELECT id FROM workspaces
        WHERE owner_id=? AND id=? AND generation=? AND status='ACTIVE' AND network_mode='none'`)
        .get(ownerId, workspaceId, workspaceGeneration);
      if (!workspace) throw new HarnessError('NOT_FOUND', 'workspace was not found', 404, false);
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
    idempotencyKey: string;
    payloadHash: string;
    mode: AgentMessageMode;
    now: number;
  }): { replayed: boolean; message: AgentMessageRecord } {
    return immediate(this.database, () => {
      const agent = this.database.prepare(`SELECT agents.generation, agents.status, agents.message_admission_open FROM agents
        JOIN workspaces ON workspaces.id=agents.workspace_id AND workspaces.owner_id=agents.owner_id
        WHERE agents.owner_id=? AND agents.workspace_id=? AND agents.id=? AND agents.generation=?
          AND workspaces.status='ACTIVE' AND workspaces.generation=agents.workspace_generation AND workspaces.network_mode='none'`)
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
        (owner_id, workspace_id, agent_id, agent_generation, idempotency_key, payload_hash, mode, state, created_at, updated_at, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?, ?, NULL)`)
        .run(input.ownerId, input.workspaceId, input.agentId, input.generation, input.idempotencyKey, input.payloadHash, input.mode, input.now, input.now);
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


  addUsage(ownerId: string, workspaceId: string, agentId: string, generation: number, delta: AgentUsageDelta): AgentUsage {
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
