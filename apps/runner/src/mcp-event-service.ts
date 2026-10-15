import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  MCP_EVENT_DEFINITION_BY_NAME,
  MCP_EVENTS_LIMITS,
  McpEventCallbackErrorSchema,
  McpEventsRunnerDataSchemas,
  McpEventsRunnerRequestSchema,
  type McpEventCallbackError,
  type McpEventClaimedDelivery,
  type McpEventDeliveryStatus,
  type McpEventName,
  type McpEventSubscriptionSummary,
  type McpEventsRunnerErrorCode,
  type McpEventsRunnerRequest,
  type McpEventsRunnerResponse,
  type RunnerPrincipalSelector
} from '@cloud-harness/contracts';
import type { EncryptedSecret, SecretKeyring } from './secret-keyring.js';

/** Retry schedule after a failed attempt; the attempt after the last entry is final. */
export const MCP_EVENT_RETRY_DELAYS_MS = [15_000, 60_000, 180_000, 480_000] as const;
/** No retry is scheduled once a delivery has been pending this long (the receiver's dedupe horizon). */
export const MCP_EVENT_RETRY_WINDOW_MS = 15 * 60_000;
/** Completed deliveries, events and lapsed subscriptions are kept this long for inspection. */
export const MCP_EVENT_RETENTION_MS = 7 * 86_400_000;
const PURGE_INTERVAL_MS = 60_000;
const RECENT_DELIVERIES = 5;
const LIST_LIMIT = 200;
const SECRET_CONTEXT = 'mcp-event-subscription';
const MAX_ATTEMPTS = MCP_EVENT_RETRY_DELAYS_MS.length + 1;

export class McpEventsError extends Error {
  constructor(readonly code: McpEventsRunnerErrorCode, message: string) {
    super(message);
  }
}

export type McpEventAudit = (
  database: DatabaseSync,
  principalId: string,
  action: string,
  subscriptionId: string,
  generation: number,
  details: Record<string, string | number | boolean>
) => void;

export type McpEventServiceOptions = {
  database: DatabaseSync;
  resolvePrincipal: (selector: RunnerPrincipalSelector) => string;
  keyring?: SecretKeyring | undefined;
  audit?: McpEventAudit;
  now?: () => number;
};

type SealedSecret = { generation: number; keyVersion: number; nonce: string; ciphertext: string; authTag: string };

type SubscriptionRow = {
  id: string; owner_id: string; name: McpEventName; arguments_json: string; url: string; api_key_id: string | null;
  state: 'ACTIVE' | 'REVOKED'; secret_generation: number; secret_json: string; previous_secret_json: string | null;
  previous_secret_until: number | null; expires_at: number; last_delivery_at: number | null; last_error: string | null;
  failed_since: number | null; revoked_at: number | null; created_at: number; updated_at: number;
};

type ClaimRow = {
  delivery_id: string; event_id: string; attempts: number; delivery_created_at: number;
  event_name: string; occurred_at: number; payload_json: string;
} & SubscriptionRow;

const iso = (value: number): string => new Date(value).toISOString();

/** Canonical JSON with sorted keys: the subscription identity must not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

/** Deterministic subscription id over (principal, url, name, canonical arguments). */
export function subscriptionIdFor(principalId: string, url: string, name: string, argumentsJson: string): string {
  return `sub_${createHash('sha256').update(JSON.stringify([principalId, url, name, argumentsJson]), 'utf8').digest('hex').slice(0, 32)}`;
}

function callbackError(value: string | null): McpEventCallbackError | null {
  const parsed = McpEventCallbackErrorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function transaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const value = action();
    database.exec('COMMIT');
    return value;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Principal-scoped MCP event subscriptions and the leased delivery queue the API egress worker
 * drains. The runner never dials a callback: it only stores, fans out, and hands sealed deliveries
 * to the API over the service channel.
 */
export class McpEventService {
  private readonly database: DatabaseSync;
  private readonly resolvePrincipal: (selector: RunnerPrincipalSelector) => string;
  private readonly keyring: SecretKeyring | undefined;
  private readonly audit: McpEventAudit;
  private readonly now: () => number;
  private lastPurgeAt = 0;
  private apiKeysTablePresent: boolean | undefined;

  constructor(options: McpEventServiceOptions) {
    this.database = options.database;
    this.resolvePrincipal = options.resolvePrincipal;
    this.keyring = options.keyring;
    this.audit = options.audit ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  execute(request: unknown): McpEventsRunnerResponse {
    const parsed = McpEventsRunnerRequestSchema.safeParse(request);
    if (!parsed.success) return { ok: false, error: { code: 'INVALID_INPUT', message: 'invalid events request' } };
    try {
      const data = this.dispatch(parsed.data);
      return { ok: true, data: McpEventsRunnerDataSchemas[parsed.data.operation].parse(data) };
    } catch (error) {
      if (error instanceof McpEventsError) return { ok: false, error: { code: error.code, message: error.message.slice(0, 500) } };
      throw error;
    }
  }

  private dispatch(request: McpEventsRunnerRequest): unknown {
    switch (request.operation) {
      case 'events_prepare':
        return this.prepare(this.resolvePrincipal(request.principal), request.input);
      case 'events_subscribe':
        return this.subscribe(this.resolvePrincipal(request.principal), request.input);
      case 'events_unsubscribe':
        return this.unsubscribe(this.resolvePrincipal(request.principal), request.input);
      case 'events_subscriptions_list':
        return this.list(this.resolvePrincipal(request.principal));
      case 'events_subscription_revoke':
        return { revoked: this.revoke(this.resolvePrincipal(request.principal), request.input.id) };
      case 'events_delivery_claim':
        return { deliveries: this.claim(request.input.limit, request.input.leaseMs) };
      case 'events_delivery_report':
        return { accepted: this.report(request.input.results) };
    }
  }

  /** Validates a subscription request and reports whether its callback needs a fresh challenge. */
  prepare(principalId: string, input: { name: McpEventName; arguments: Record<string, unknown>; url: string }): { id: string; verified: boolean } {
    // Refused before the API sends a verification request it could never act on.
    if (!this.keyring) throw new McpEventsError('UNAVAILABLE', 'event delivery requires the secret keyring');
    const { id } = this.admit(principalId, input);
    return { id, verified: this.isVerified(principalId, input.url) };
  }

  subscribe(principalId: string, input: {
    name: McpEventName; arguments: Record<string, unknown>; url: string; secret: string;
    ttlMs?: number | null | undefined; apiKeyId?: string | undefined; verified: boolean;
  }): { id: string; refreshBefore: string; deliveryStatus?: McpEventDeliveryStatus } {
    const keyring = this.keyring;
    if (!keyring) throw new McpEventsError('UNAVAILABLE', 'event delivery requires the secret keyring');
    return transaction(this.database, () => {
      const now = this.now();
      const { id, argumentsJson } = this.admit(principalId, input);
      if (input.verified) {
        this.database.prepare(`INSERT INTO event_callback_verifications (owner_id, url, verified_at) VALUES (?, ?, ?)
          ON CONFLICT(owner_id, url) DO UPDATE SET verified_at = excluded.verified_at`).run(principalId, input.url, now);
      } else if (!this.isVerified(principalId, input.url)) {
        throw new McpEventsError('INVALID_INPUT', 'callback endpoint has not been verified');
      }
      const ttl = input.ttlMs === undefined ? MCP_EVENTS_LIMITS.defaultTtlMs
        : input.ttlMs === null ? MCP_EVENTS_LIMITS.maxTtlMs
          : Math.min(MCP_EVENTS_LIMITS.maxTtlMs, Math.max(MCP_EVENTS_LIMITS.minTtlMs, input.ttlMs));
      const expiresAt = now + ttl;
      const existing = this.subscriptionRow(principalId, id);
      if (!existing) {
        const sealed = this.seal(keyring, principalId, id, 1, input.secret);
        this.database.prepare(`INSERT INTO event_subscriptions
          (id, owner_id, name, arguments_json, url, api_key_id, state, secret_generation, secret_json, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', 1, ?, ?, ?, ?)`)
          .run(id, principalId, input.name, argumentsJson, input.url, input.apiKeyId ?? null, JSON.stringify(sealed), expiresAt, now, now);
        this.audit(this.database, principalId, 'mcp_event.subscribed', id, 1, { name: input.name, viaApiKey: input.apiKeyId !== undefined });
        return { id, refreshBefore: iso(expiresAt) };
      }
      const reactivated = existing.state !== 'ACTIVE' || existing.expires_at <= now;
      const current = this.unseal(keyring, principalId, id, existing.secret_json);
      const rotated = current === null || !sameSecret(current, input.secret);
      let generation = existing.secret_generation;
      let secretJson = existing.secret_json;
      let previousJson = existing.previous_secret_json;
      let previousUntil = existing.previous_secret_until;
      if (rotated) {
        generation += 1;
        secretJson = JSON.stringify(this.seal(keyring, principalId, id, generation, input.secret));
        // Dual-sign during a short grace window so in-flight receivers keep verifying.
        previousJson = current === null || reactivated ? null : existing.secret_json;
        previousUntil = previousJson === null ? null : now + MCP_EVENTS_LIMITS.secretRotationGraceMs;
      }
      this.database.prepare(`UPDATE event_subscriptions SET state = 'ACTIVE', revoked_at = NULL, api_key_id = ?,
        secret_generation = ?, secret_json = ?, previous_secret_json = ?, previous_secret_until = ?, expires_at = ?, updated_at = ?
        ${reactivated ? ', last_error = NULL, failed_since = NULL' : ''}
        WHERE owner_id = ? AND id = ?`)
        .run(input.apiKeyId ?? null, generation, secretJson, previousJson, previousUntil, expiresAt, now, principalId, id);
      if (reactivated || rotated) {
        this.audit(this.database, principalId, reactivated ? 'mcp_event.subscribed' : 'mcp_event.secret_rotated', id, generation, {
          name: input.name, viaApiKey: input.apiKeyId !== undefined
        });
      }
      const refreshed = this.subscriptionRow(principalId, id)!;
      return { id, refreshBefore: iso(expiresAt), deliveryStatus: this.deliveryStatus(refreshed, now) };
    });
  }

  unsubscribe(principalId: string, input: { name: McpEventName; arguments: Record<string, unknown>; url: string }): { removed: boolean } {
    const argumentsJson = this.validatedArguments(input.name, input.arguments);
    const id = subscriptionIdFor(principalId, input.url, input.name, argumentsJson);
    return transaction(this.database, () => {
      const existing = this.subscriptionRow(principalId, id);
      if (!existing) return { removed: false };
      this.database.prepare('DELETE FROM event_subscriptions WHERE owner_id = ? AND id = ?').run(principalId, id);
      this.audit(this.database, principalId, 'mcp_event.unsubscribed', id, existing.secret_generation, { name: existing.name });
      return { removed: true };
    });
  }

  list(principalId: string): { subscriptions: McpEventSubscriptionSummary[]; truncated: boolean } {
    const now = this.now();
    const rows = this.database.prepare(`SELECT * FROM event_subscriptions WHERE owner_id = ?
      ORDER BY created_at DESC, id LIMIT ${LIST_LIMIT + 1}`).all(principalId) as SubscriptionRow[];
    const page = rows.slice(0, LIST_LIMIT);
    type RecentRow = {
      subscription_id: string; event_id: string; status: 'PENDING' | 'DELIVERED' | 'ABANDONED'; attempts: number;
      last_error: string | null; created_at: number; completed_at: number | null;
    };
    const recentBySubscription = new Map<string, RecentRow[]>();
    if (page.length > 0) {
      const recent = this.database.prepare(`SELECT subscription_id, event_id, status, attempts, last_error, created_at, completed_at FROM (
          SELECT d.*, ROW_NUMBER() OVER (PARTITION BY d.subscription_id ORDER BY d.created_at DESC, d.id) AS position
          FROM event_deliveries d JOIN event_subscriptions s ON s.id = d.subscription_id
          WHERE s.owner_id = ? AND d.subscription_id IN (${page.map(() => '?').join(', ')})
        ) WHERE position <= ${RECENT_DELIVERIES} ORDER BY created_at DESC, id`).all(principalId, ...page.map((row) => row.id)) as RecentRow[];
      for (const row of recent) {
        const list = recentBySubscription.get(row.subscription_id) ?? [];
        list.push(row);
        recentBySubscription.set(row.subscription_id, list);
      }
    }
    const subscriptions = page.map((row) => ({
      id: row.id,
      name: row.name,
      arguments: JSON.parse(row.arguments_json) as Record<string, unknown>,
      callbackOrigin: safeOrigin(row.url),
      viaApiKey: row.api_key_id !== null,
      state: row.state === 'REVOKED' ? 'REVOKED' as const : row.expires_at <= now ? 'EXPIRED' as const : 'ACTIVE' as const,
      createdAt: iso(row.created_at),
      refreshBefore: iso(row.expires_at),
      deliveryStatus: this.deliveryStatus(row, now),
      recentDeliveries: (recentBySubscription.get(row.id) ?? []).map((delivery) => ({
        eventId: delivery.event_id,
        status: delivery.status,
        attempts: delivery.attempts,
        lastError: delivery.last_error,
        createdAt: iso(delivery.created_at),
        completedAt: delivery.completed_at === null ? null : iso(delivery.completed_at)
      }))
    }));
    return { subscriptions, truncated: rows.length > LIST_LIMIT };
  }

  revoke(principalId: string, id: string): boolean {
    return transaction(this.database, () => {
      const now = this.now();
      const existing = this.subscriptionRow(principalId, id);
      if (!existing || existing.state === 'REVOKED') return false;
      this.revokeInTransaction(existing, now, 'revoked');
      this.audit(this.database, principalId, 'mcp_event.revoked', id, existing.secret_generation, { name: existing.name });
      return true;
    });
  }

  /**
   * Leases due deliveries to the API egress worker. Deliveries whose subscription lapsed, was
   * revoked, or whose creating API key is no longer active are abandoned here instead of sent.
   */
  claim(limit: number, leaseMs: number): McpEventClaimedDelivery[] {
    const keyring = this.keyring;
    if (!keyring) return [];
    return transaction(this.database, () => {
      const now = this.now();
      this.purge(now);
      const rows = this.database.prepare(`SELECT d.id AS delivery_id, d.event_id, d.attempts, d.created_at AS delivery_created_at,
          e.name AS event_name, e.occurred_at, e.payload_json, s.*
        FROM event_deliveries d
        JOIN event_outbox e ON e.id = d.event_id
        JOIN event_subscriptions s ON s.id = d.subscription_id
        WHERE d.status = 'PENDING' AND d.next_attempt_at <= ? AND (d.lease_until IS NULL OR d.lease_until <= ?)
        ORDER BY d.next_attempt_at, d.id LIMIT ?`).all(now, now, limit) as ClaimRow[];
      const claimed: McpEventClaimedDelivery[] = [];
      const revoked = new Set<string>();
      for (const row of rows) {
        if (revoked.has(row.id)) continue;
        if (row.state !== 'ACTIVE' || row.expires_at <= now) {
          this.abandon(row.delivery_id, now, 'subscription_inactive');
          continue;
        }
        if (row.api_key_id !== null && !this.apiKeyActive(row.owner_id, row.api_key_id, now)) {
          revoked.add(row.id);
          this.revokeInTransaction(row, now, 'credential_revoked');
          this.audit(this.database, row.owner_id, 'mcp_event.revoked', row.id, row.secret_generation, { name: row.name, reason: 'credential_revoked' });
          continue;
        }
        if (row.attempts > 0 && now - row.delivery_created_at >= MCP_EVENT_RETRY_WINDOW_MS) {
          this.abandon(row.delivery_id, now, 'retry_window_elapsed');
          continue;
        }
        const secrets = [this.unseal(keyring, row.owner_id, row.id, row.secret_json)];
        if (row.previous_secret_json !== null && row.previous_secret_until !== null && row.previous_secret_until > now) {
          secrets.push(this.unseal(keyring, row.owner_id, row.id, row.previous_secret_json));
        }
        const usable = secrets.filter((secret): secret is string => secret !== null);
        if (usable.length === 0) {
          this.abandon(row.delivery_id, now, 'secret_unavailable');
          continue;
        }
        const body = JSON.stringify({
          eventId: row.event_id,
          name: row.event_name,
          timestamp: iso(row.occurred_at),
          data: JSON.parse(row.payload_json) as unknown,
          cursor: null
        });
        if (Buffer.byteLength(body, 'utf8') > MCP_EVENTS_LIMITS.maxBodyBytes) {
          this.abandon(row.delivery_id, now, 'payload_too_large');
          continue;
        }
        const leaseToken = randomBytes(16).toString('base64url');
        // Re-checked: an earlier row in this batch may have revoked the same subscription.
        const leased = this.database.prepare(`UPDATE event_deliveries SET lease_token = ?, lease_until = ?, attempts = attempts + 1,
          first_attempt_at = COALESCE(first_attempt_at, ?) WHERE id = ? AND status = 'PENDING'`)
          .run(leaseToken, now + leaseMs, now, row.delivery_id);
        if (Number(leased.changes) !== 1) continue;
        claimed.push({
          deliveryId: row.delivery_id,
          leaseToken,
          subscriptionId: row.id,
          eventId: row.event_id,
          url: row.url,
          secrets: usable,
          body
        });
      }
      return claimed;
    });
  }

  report(results: { deliveryId: string; leaseToken: string; outcome: 'delivered' | 'failed' | 'rejected'; error?: McpEventCallbackError | undefined }[]): number {
    return transaction(this.database, () => {
      const now = this.now();
      let accepted = 0;
      for (const result of results) {
        const row = this.database.prepare(`SELECT id, subscription_id, attempts, created_at, lease_token FROM event_deliveries
          WHERE id = ? AND status = 'PENDING'`).get(result.deliveryId) as {
          id: string; subscription_id: string; attempts: number; created_at: number; lease_token: string | null;
        } | undefined;
        // A stale lease (re-claimed after expiry) must not overwrite the newer attempt's outcome.
        if (!row || row.lease_token === null || !sameSecret(row.lease_token, result.leaseToken)) continue;
        accepted += 1;
        if (result.outcome === 'delivered') {
          this.database.prepare(`UPDATE event_deliveries SET status = 'DELIVERED', completed_at = ?, lease_token = NULL,
            lease_until = NULL, last_error = NULL WHERE id = ?`).run(now, row.id);
          this.database.prepare(`UPDATE event_subscriptions SET last_delivery_at = ?, last_error = NULL, failed_since = NULL
            WHERE id = ?`).run(now, row.subscription_id);
          continue;
        }
        const error = result.error ?? (result.outcome === 'rejected' ? 'http_4xx' : 'http_5xx');
        const final = result.outcome === 'rejected' || row.attempts >= MAX_ATTEMPTS
          || now - row.created_at >= MCP_EVENT_RETRY_WINDOW_MS;
        if (final) {
          this.database.prepare(`UPDATE event_deliveries SET status = 'ABANDONED', completed_at = ?, lease_token = NULL,
            lease_until = NULL, last_error = ? WHERE id = ?`).run(now, error, row.id);
        } else {
          const delay = MCP_EVENT_RETRY_DELAYS_MS[Math.min(row.attempts, MCP_EVENT_RETRY_DELAYS_MS.length) - 1] ?? MCP_EVENT_RETRY_DELAYS_MS[0];
          this.database.prepare(`UPDATE event_deliveries SET next_attempt_at = ?, lease_token = NULL, lease_until = NULL,
            last_error = ? WHERE id = ?`).run(now + delay, error, row.id);
        }
        this.database.prepare(`UPDATE event_subscriptions SET last_error = ?, failed_since = COALESCE(failed_since, ?)
          WHERE id = ?`).run(error, now, row.subscription_id);
      }
      return accepted;
    });
  }

  /** Re-seals stored webhook secrets under the active key version. Returns the rows changed. */
  reencrypt(signal?: AbortSignal): number {
    const keyring = this.keyring;
    if (!keyring) throw new Error('secret keyring is required for re-encryption');
    const rows = this.database.prepare('SELECT * FROM event_subscriptions').all() as SubscriptionRow[];
    let changed = 0;
    for (const row of rows) {
      if (signal?.aborted) return changed;
      const current = this.reseal(keyring, row.owner_id, row.id, row.secret_json);
      const previous = row.previous_secret_json === null ? null : this.reseal(keyring, row.owner_id, row.id, row.previous_secret_json);
      if (current === row.secret_json && previous === row.previous_secret_json) continue;
      changed += Number(this.database.prepare(`UPDATE event_subscriptions SET secret_json = ?, previous_secret_json = ?
        WHERE id = ? AND secret_json = ? AND previous_secret_json IS ?`)
        .run(current, previous, row.id, row.secret_json, row.previous_secret_json).changes);
    }
    return changed;
  }

  private admit(principalId: string, input: { name: McpEventName; arguments: Record<string, unknown>; url: string }): { id: string; argumentsJson: string } {
    const argumentsJson = this.validatedArguments(input.name, input.arguments);
    const filter = JSON.parse(argumentsJson) as { workspaceId?: string; taskId?: string; agentId?: string };
    if (filter.workspaceId !== undefined && !this.owns('SELECT 1 FROM workspaces WHERE owner_id = ? AND id = ?', principalId, filter.workspaceId)) {
      throw new McpEventsError('FORBIDDEN', 'workspace is not accessible to this principal');
    }
    if (filter.taskId !== undefined && !this.owns('SELECT 1 FROM durable_tasks WHERE owner_id = ? AND id = ?', principalId, filter.taskId)) {
      throw new McpEventsError('FORBIDDEN', 'task is not accessible to this principal');
    }
    if (filter.agentId !== undefined && !this.owns('SELECT 1 FROM agents WHERE owner_id = ? AND id = ?', principalId, filter.agentId)) {
      throw new McpEventsError('FORBIDDEN', 'agent is not accessible to this principal');
    }
    const id = subscriptionIdFor(principalId, input.url, input.name, argumentsJson);
    const now = this.now();
    const active = this.database.prepare(`SELECT count(*) AS count FROM event_subscriptions
      WHERE owner_id = ? AND state = 'ACTIVE' AND expires_at > ? AND id <> ?`).get(principalId, now, id) as { count: number };
    if (active.count >= MCP_EVENTS_LIMITS.maxSubscriptionsPerPrincipal) {
      throw new McpEventsError('RESOURCE_EXHAUSTED', 'active event subscription limit reached');
    }
    // Expired and revoked rows are retained for visibility; bound them too so short-TTL churn cannot grow state.
    const retained = this.database.prepare('SELECT count(*) AS count FROM event_subscriptions WHERE owner_id = ? AND id <> ?')
      .get(principalId, id) as { count: number };
    if (retained.count >= MCP_EVENTS_LIMITS.maxRetainedSubscriptionsPerPrincipal) {
      throw new McpEventsError('RESOURCE_EXHAUSTED', 'retained event subscription limit reached');
    }
    return { id, argumentsJson };
  }

  private validatedArguments(name: McpEventName, value: Record<string, unknown>): string {
    const definition = MCP_EVENT_DEFINITION_BY_NAME.get(name);
    if (!definition) throw new McpEventsError('NOT_FOUND', 'unknown event');
    const parsed = definition.arguments.safeParse(value);
    if (!parsed.success) throw new McpEventsError('INVALID_INPUT', 'invalid event arguments');
    return canonicalJson(parsed.data);
  }

  private owns(sql: string, principalId: string, id: string): boolean {
    return this.database.prepare(sql).get(principalId, id) !== undefined;
  }

  private isVerified(principalId: string, url: string): boolean {
    const row = this.database.prepare('SELECT verified_at FROM event_callback_verifications WHERE owner_id = ? AND url = ?')
      .get(principalId, url) as { verified_at: number } | undefined;
    return row !== undefined && this.now() - row.verified_at < MCP_EVENTS_LIMITS.verificationCacheMs;
  }

  private subscriptionRow(principalId: string, id: string): SubscriptionRow | undefined {
    return this.database.prepare('SELECT * FROM event_subscriptions WHERE owner_id = ? AND id = ?').get(principalId, id) as SubscriptionRow | undefined;
  }

  private deliveryStatus(row: SubscriptionRow, now: number): McpEventDeliveryStatus {
    const status: McpEventDeliveryStatus = {
      active: row.state === 'ACTIVE' && row.expires_at > now,
      lastDeliveryAt: row.last_delivery_at === null ? null : iso(row.last_delivery_at),
      lastError: callbackError(row.last_error)
    };
    if (row.failed_since !== null) status.failedSince = iso(row.failed_since);
    return status;
  }

  private revokeInTransaction(row: SubscriptionRow, now: number, reason: string): void {
    this.database.prepare(`UPDATE event_subscriptions SET state = 'REVOKED', revoked_at = ?, updated_at = ?,
      previous_secret_json = NULL, previous_secret_until = NULL WHERE id = ?`).run(now, now, row.id);
    this.database.prepare(`UPDATE event_deliveries SET status = 'ABANDONED', completed_at = ?, lease_token = NULL,
      lease_until = NULL, last_error = ? WHERE subscription_id = ? AND status = 'PENDING'`).run(now, reason, row.id);
  }

  private abandon(deliveryId: string, now: number, reason: string): void {
    this.database.prepare(`UPDATE event_deliveries SET status = 'ABANDONED', completed_at = ?, lease_token = NULL,
      lease_until = NULL, last_error = ? WHERE id = ?`).run(now, reason, deliveryId);
  }

  private apiKeyActive(principalId: string, apiKeyId: string, now: number): boolean {
    // Only a positive answer is cached: a table created by a later metadata migration must still be found.
    if (!this.apiKeysTablePresent) {
      this.apiKeysTablePresent = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'").get() !== undefined;
    }
    if (!this.apiKeysTablePresent) return false;
    return this.database.prepare("SELECT 1 FROM api_keys WHERE principal_id = ? AND id = ? AND state = 'ACTIVE' AND expires_at > ?")
      .get(principalId, apiKeyId, now) !== undefined;
  }

  private purge(now: number): void {
    if (now - this.lastPurgeAt < PURGE_INTERVAL_MS) return;
    this.lastPurgeAt = now;
    const horizon = now - MCP_EVENT_RETENTION_MS;
    this.database.prepare("DELETE FROM event_deliveries WHERE status <> 'PENDING' AND completed_at < ?").run(horizon);
    this.database.prepare(`DELETE FROM event_outbox WHERE created_at < ?
      AND NOT EXISTS (SELECT 1 FROM event_deliveries d WHERE d.event_id = event_outbox.id AND d.status = 'PENDING')`).run(horizon);
    this.database.prepare(`DELETE FROM event_subscriptions WHERE (state = 'REVOKED' AND revoked_at < ?)
      OR (state = 'ACTIVE' AND expires_at < ?)`).run(horizon, horizon);
    this.database.prepare('DELETE FROM event_callback_verifications WHERE verified_at < ?')
      .run(now - MCP_EVENTS_LIMITS.verificationCacheMs);
  }

  private seal(keyring: SecretKeyring, principalId: string, id: string, generation: number, secret: string): SealedSecret {
    const sealed = keyring.encrypt(secret, { principalId, environmentId: SECRET_CONTEXT, name: id, version: generation });
    return {
      generation,
      keyVersion: sealed.keyVersion,
      nonce: sealed.nonce.toString('hex'),
      ciphertext: sealed.ciphertext.toString('hex'),
      authTag: sealed.authTag.toString('hex')
    };
  }

  private decode(json: string): SealedSecret | null {
    try {
      return JSON.parse(json) as SealedSecret;
    } catch {
      return null;
    }
  }

  private envelope(sealed: SealedSecret): EncryptedSecret {
    return {
      keyVersion: sealed.keyVersion,
      nonce: Buffer.from(sealed.nonce, 'hex'),
      ciphertext: Buffer.from(sealed.ciphertext, 'hex'),
      authTag: Buffer.from(sealed.authTag, 'hex')
    };
  }

  private unseal(keyring: SecretKeyring, principalId: string, id: string, json: string): string | null {
    const sealed = this.decode(json);
    if (!sealed) return null;
    try {
      return keyring.decrypt(this.envelope(sealed), { principalId, environmentId: SECRET_CONTEXT, name: id, version: sealed.generation });
    } catch {
      return null;
    }
  }

  private reseal(keyring: SecretKeyring, principalId: string, id: string, json: string): string {
    const sealed = this.decode(json);
    if (!sealed || sealed.keyVersion === keyring.activeVersion) return json;
    const next = keyring.reencrypt(this.envelope(sealed), { principalId, environmentId: SECRET_CONTEXT, name: id, version: sealed.generation });
    return JSON.stringify({
      generation: sealed.generation,
      keyVersion: next.keyVersion,
      nonce: next.nonce.toString('hex'),
      ciphertext: next.ciphertext.toString('hex'),
      authTag: next.authTag.toString('hex')
    } satisfies SealedSecret);
  }
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Only the origin is shown: callback paths can carry receiver-side routing tokens. */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'invalid';
  }
}
