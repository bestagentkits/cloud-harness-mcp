import type { DatabaseSync } from 'node:sqlite';
import type {
  McpGatewayOAuthRegistrationMode,
  McpGatewayOAuthState,
  McpGatewayOAuthStatus
} from '@cloud-harness/contracts';
import { appendAudit, opaqueId, transaction } from './metadata-records.js';
import type { EncryptedSecret, SecretKeyring } from './secret-keyring.js';

/**
 * Principal-scoped, encrypted storage for downstream MCP OAuth state.
 *
 * Two logical records exist and both keep every secret inside one AES-GCM envelope:
 * - a grant (registered client information, tokens, discovery state), one per
 *   principal + server, replaced atomically with a generation compare-and-swap so a
 *   stale refresh can never overwrite a rotated token;
 * - a pending flow (PKCE verifier, discovery state), single-use and short-lived,
 *   addressed only by the SHA-256 of the high-entropy `state`.
 *
 * Decrypted blobs leave this module only through `loadGrant` and `consumeFlow`, which
 * are reachable solely from the internal runner API. No view type here carries a
 * secret.
 */

export const MCP_OAUTH_GRANT_CONTEXT = 'mcp_oauth_grant';
export const MCP_OAUTH_FLOW_CONTEXT = 'mcp_oauth_flow';
export const MCP_OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_STORED_ERROR_CHARS = 500;

export class McpOAuthStoreError extends Error {
  readonly code: 'NOT_FOUND' | 'CONFLICT' | 'EXPIRED';

  constructor(code: 'NOT_FOUND' | 'CONFLICT' | 'EXPIRED', message: string) {
    super(message);
    this.name = 'McpOAuthStoreError';
    this.code = code;
  }
}

type GrantRow = {
  principal_id: string;
  server_id: string;
  issuer: string;
  registration_mode: McpGatewayOAuthRegistrationMode;
  requested_scopes: string | null;
  granted_scopes: string | null;
  state: 'authorizing' | 'connected' | 'reauthorization_required' | 'error';
  last_error: string | null;
  authorized_at: number;
  expires_at: number | null;
  last_refresh_at: number | null;
  generation: number;
  key_version: number;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
  updated_at: number;
};

type FlowRow = {
  id: string;
  principal_id: string;
  server_id: string;
  expected_issuer: string;
  scopes: string | null;
  expires_at: number;
  key_version: number;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
};

export type McpOAuthGrantRecord = {
  blob: string;
  generation: number;
  issuer: string;
  registrationMode: McpGatewayOAuthRegistrationMode;
  grantedScopes: string | null;
  state: GrantRow['state'];
};

export type McpOAuthFlowRecord = {
  serverId: string;
  blob: string;
  expectedIssuer: string;
  scopes: string | null;
};

export type McpOAuthGrantInput = {
  expectedGeneration: number;
  issuer: string;
  registrationMode: McpGatewayOAuthRegistrationMode;
  grantedScopes: string | null;
  requestedScopes: string | null;
  expiresAt: number | null;
  refreshed: boolean;
  blob: string;
};

export function scrubOAuthError(text: string): string {
  return text
    .replace(/\b(?:access_token|refresh_token|client_secret|code|code_verifier|id_token)\b\s*[=:]\s*"?[^\s"&,}]+/gi, '$1=[REDACTED]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\p{Cc}/gu, ' ')
    .slice(0, MAX_STORED_ERROR_CHARS);
}

export class McpOAuthStore {
  constructor(
    readonly database: DatabaseSync,
    private readonly keyring: SecretKeyring,
    private readonly now: () => number = () => Date.now()
  ) {}

  private seal(context: string, principalId: string, name: string, version: number, value: string): EncryptedSecret {
    return this.keyring.encrypt(value, { principalId, environmentId: context, name, version });
  }

  private open(context: string, principalId: string, name: string, version: number, row: {
    key_version: number; nonce: string; ciphertext: string; auth_tag: string;
  }): string {
    return this.keyring.decrypt({
      keyVersion: row.key_version,
      nonce: Buffer.from(row.nonce, 'hex'),
      ciphertext: Buffer.from(row.ciphertext, 'hex'),
      authTag: Buffer.from(row.auth_tag, 'hex')
    }, { principalId, environmentId: context, name, version });
  }

  /**
   * Moves every grant and flow that is not sealed with the active key onto it, for the
   * `secrets:rekey` maintenance command. Each row is updated only while its generation and
   * key version are unchanged, so a concurrent token save is never overwritten. Returns the
   * number of rows re-encrypted.
   */
  reencrypt(signal?: AbortSignal): number {
    const active = this.keyring.activeVersion;
    const encode = (value: EncryptedSecret) => ({
      key_version: value.keyVersion,
      nonce: Buffer.from(value.nonce).toString('hex'),
      ciphertext: Buffer.from(value.ciphertext).toString('hex'),
      auth_tag: Buffer.from(value.authTag).toString('hex')
    });
    const decode = (row: { key_version: number; nonce: string; ciphertext: string; auth_tag: string }): EncryptedSecret => ({
      keyVersion: row.key_version,
      nonce: Buffer.from(row.nonce, 'hex'),
      ciphertext: Buffer.from(row.ciphertext, 'hex'),
      authTag: Buffer.from(row.auth_tag, 'hex')
    });
    let changed = 0;
    const grants = this.database.prepare('SELECT * FROM mcp_oauth_grants WHERE key_version <> ?').all(active) as GrantRow[];
    for (const row of grants) {
      if (signal?.aborted) return changed;
      const next = encode(this.keyring.reencrypt(decode(row), {
        principalId: row.principal_id, environmentId: MCP_OAUTH_GRANT_CONTEXT, name: row.server_id, version: row.generation
      }));
      changed += Number(this.database.prepare(`UPDATE mcp_oauth_grants SET key_version = ?, nonce = ?, ciphertext = ?, auth_tag = ?
        WHERE principal_id = ? AND server_id = ? AND generation = ? AND key_version = ?`)
        .run(next.key_version, next.nonce, next.ciphertext, next.auth_tag, row.principal_id, row.server_id, row.generation, row.key_version).changes);
    }
    const flows = this.database.prepare('SELECT * FROM mcp_oauth_flows WHERE key_version <> ?').all(active) as FlowRow[];
    for (const row of flows) {
      if (signal?.aborted) return changed;
      const next = encode(this.keyring.reencrypt(decode(row), {
        principalId: row.principal_id, environmentId: MCP_OAUTH_FLOW_CONTEXT, name: row.id, version: 1
      }));
      changed += Number(this.database.prepare('UPDATE mcp_oauth_flows SET key_version = ?, nonce = ?, ciphertext = ?, auth_tag = ? WHERE id = ? AND key_version = ?')
        .run(next.key_version, next.nonce, next.ciphertext, next.auth_tag, row.id, row.key_version).changes);
    }
    return changed;
  }

  private grantRow(principalId: string, serverId: string): GrantRow | undefined {
    return this.database.prepare('SELECT * FROM mcp_oauth_grants WHERE principal_id = ? AND server_id = ?')
      .get(principalId, serverId) as GrantRow | undefined;
  }

  /** Safe projection. `configured`/`redirectUrl` come from the caller, never from storage. */
  status(
    principalId: string,
    serverId: string,
    options: { configured: boolean; redirectUrl: string | null; requestedScopes: string | null }
  ): McpGatewayOAuthStatus {
    const row = this.grantRow(principalId, serverId);
    const pending = this.pendingFlowExists(principalId, serverId);
    let state: McpGatewayOAuthState;
    if (!options.configured) state = 'not_configured';
    else if (pending) state = 'authorizing';
    else if (!row) state = 'authorization_required';
    else state = row.state === 'authorizing' ? 'authorization_required' : row.state;
    return {
      serverId,
      enabled: options.configured,
      state,
      issuer: row?.issuer ?? null,
      requestedScopes: row?.requested_scopes ?? options.requestedScopes,
      grantedScopes: row?.granted_scopes ?? null,
      registrationMode: row?.registration_mode ?? null,
      authorizedAt: row?.authorized_at ?? null,
      expiresAt: row?.expires_at ?? null,
      lastRefreshAt: row?.last_refresh_at ?? null,
      lastError: row?.last_error ?? null,
      redirectUrl: options.redirectUrl
    };
  }

  private pendingFlowExists(principalId: string, serverId: string): boolean {
    return Boolean(this.database.prepare(
      'SELECT 1 FROM mcp_oauth_flows WHERE principal_id = ? AND server_id = ? AND expires_at > ? LIMIT 1'
    ).get(principalId, serverId, this.now()));
  }

  beginFlow(
    principalId: string,
    serverId: string,
    input: { stateHash: string; expectedIssuer: string; scopes: string | null; blob: string }
  ): { expiresAt: number } {
    return transaction(this.database, () => {
      const now = this.now();
      // Expired flows are removed on every begin, and a server holds one pending flow:
      // a fresh explicit Connect supersedes an abandoned one.
      this.database.prepare('DELETE FROM mcp_oauth_flows WHERE expires_at <= ?').run(now);
      this.database.prepare('DELETE FROM mcp_oauth_flows WHERE principal_id = ? AND server_id = ?').run(principalId, serverId);
      const id = opaqueId('mcpf');
      const sealed = this.seal(MCP_OAUTH_FLOW_CONTEXT, principalId, id, 1, input.blob);
      const expiresAt = now + MCP_OAUTH_FLOW_TTL_MS;
      this.database.prepare(`INSERT INTO mcp_oauth_flows
        (id, principal_id, server_id, state_hash, expected_issuer, scopes, created_at, expires_at,
         key_version, nonce, ciphertext, auth_tag)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, principalId, serverId, input.stateHash, input.expectedIssuer, input.scopes, now, expiresAt,
        sealed.keyVersion, sealed.nonce.toString('hex'), sealed.ciphertext.toString('hex'), sealed.authTag.toString('hex')
      );
      appendAudit(this.database, principalId, 'mcp_oauth.authorization_started', 'mcp_server', serverId, 1, {
        issuer: input.expectedIssuer,
        scopes: input.scopes ?? ''
      }, now);
      return { expiresAt };
    });
  }

  /**
   * Single use: the row is deleted in the same transaction that reads it. The flow, not the
   * browser, names the server. A `state` that belongs to another principal is
   * indistinguishable from an unknown one and leaves the owner's flow untouched, so another
   * principal cannot burn it. Expired flows are swept on the next begin.
   */
  consumeFlow(principalId: string, stateHash: string): McpOAuthFlowRecord {
    return transaction(this.database, () => {
      const now = this.now();
      const row = this.database.prepare('SELECT * FROM mcp_oauth_flows WHERE state_hash = ?').get(stateHash) as FlowRow | undefined;
      if (!row || row.principal_id !== principalId) {
        throw new McpOAuthStoreError('NOT_FOUND', 'authorization flow is unknown or already used');
      }
      this.database.prepare('DELETE FROM mcp_oauth_flows WHERE id = ?').run(row.id);
      if (row.expires_at <= now) throw new McpOAuthStoreError('EXPIRED', 'authorization flow expired');
      return {
        serverId: row.server_id,
        blob: this.open(MCP_OAUTH_FLOW_CONTEXT, principalId, row.id, 1, row),
        expectedIssuer: row.expected_issuer,
        scopes: row.scopes
      };
    });
  }

  /** Issuer of the stored grant without decrypting it, for audit records. */
  loadGrantIssuer(principalId: string, serverId: string): string | undefined {
    return this.grantRow(principalId, serverId)?.issuer;
  }

  loadGrant(principalId: string, serverId: string): McpOAuthGrantRecord | undefined {
    const row = this.grantRow(principalId, serverId);
    if (!row) return undefined;
    return {
      blob: this.open(MCP_OAUTH_GRANT_CONTEXT, principalId, serverId, row.generation, row),
      generation: row.generation,
      issuer: row.issuer,
      registrationMode: row.registration_mode,
      grantedScopes: row.granted_scopes,
      state: row.state
    };
  }

  /** Compare-and-swap on `generation`: 0 creates, N replaces generation N. */
  saveGrant(principalId: string, serverId: string, input: McpOAuthGrantInput): number {
    return transaction(this.database, () => {
      const now = this.now();
      const current = this.grantRow(principalId, serverId);
      const currentGeneration = current?.generation ?? 0;
      if (currentGeneration !== input.expectedGeneration) {
        throw new McpOAuthStoreError('CONFLICT', 'OAuth grant changed since it was read');
      }
      const generation = currentGeneration + 1;
      const sealed = this.seal(MCP_OAUTH_GRANT_CONTEXT, principalId, serverId, generation, input.blob);
      const envelope = [sealed.keyVersion, sealed.nonce.toString('hex'), sealed.ciphertext.toString('hex'), sealed.authTag.toString('hex')] as const;
      if (current) {
        this.database.prepare(`UPDATE mcp_oauth_grants SET
          issuer = ?, registration_mode = ?, requested_scopes = ?, granted_scopes = ?, state = 'connected',
          last_error = NULL, expires_at = ?, last_refresh_at = ?, generation = ?, updated_at = ?,
          key_version = ?, nonce = ?, ciphertext = ?, auth_tag = ?,
          authorized_at = CASE WHEN ? = 1 THEN authorized_at ELSE ? END
          WHERE principal_id = ? AND server_id = ?`).run(
          input.issuer, input.registrationMode, input.requestedScopes, input.grantedScopes, input.expiresAt,
          input.refreshed ? now : current.last_refresh_at, generation, now, ...envelope,
          input.refreshed ? 1 : 0, now, principalId, serverId
        );
      } else {
        this.database.prepare(`INSERT INTO mcp_oauth_grants
          (principal_id, server_id, issuer, registration_mode, requested_scopes, granted_scopes, state, last_error,
           authorized_at, expires_at, last_refresh_at, generation, updated_at, key_version, nonce, ciphertext, auth_tag)
          VALUES (?, ?, ?, ?, ?, ?, 'connected', NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`).run(
          principalId, serverId, input.issuer, input.registrationMode, input.requestedScopes, input.grantedScopes,
          now, input.expiresAt, generation, now, ...envelope
        );
      }
      appendAudit(
        this.database, principalId,
        input.refreshed ? 'mcp_oauth.token_refreshed' : 'mcp_oauth.authorization_completed',
        'mcp_server', serverId, generation,
        { issuer: input.issuer, registrationMode: input.registrationMode, scopes: input.grantedScopes ?? '' }, now
      );
      return generation;
    });
  }

  /**
   * Records a state transition while keeping the grant's diagnostic metadata. `error` comes
   * from a failed or declined interactive Connect, which never touches the stored tokens: a
   * grant that still works (or already needs reauthorization) keeps its state and only
   * records the failure as its last error.
   */
  markGrant(principalId: string, serverId: string, state: 'authorizing' | 'reauthorization_required' | 'error', error: string | null): boolean {
    return transaction(this.database, () => {
      const row = this.grantRow(principalId, serverId);
      if (!row) return false;
      const now = this.now();
      const message = error ? scrubOAuthError(error) : null;
      const next = state === 'error' && (row.state === 'connected' || row.state === 'reauthorization_required') ? row.state : state;
      this.database.prepare(
        'UPDATE mcp_oauth_grants SET state = ?, last_error = ?, updated_at = ? WHERE principal_id = ? AND server_id = ?'
      ).run(next, message, now, principalId, serverId);
      appendAudit(
        this.database, principalId,
        state === 'reauthorization_required' ? 'mcp_oauth.reauthorization_required' : 'mcp_oauth.authorization_failed',
        'mcp_server', serverId, row.generation, { issuer: row.issuer, state: next }, now
      );
      return true;
    });
  }

  recordFailure(principalId: string, serverId: string, error: string): void {
    appendAudit(this.database, principalId, 'mcp_oauth.authorization_failed', 'mcp_server', serverId, 1, {
      error: scrubOAuthError(error).slice(0, 200)
    }, this.now());
  }

  recordRevocationAttempt(principalId: string, serverId: string, issuer: string, outcome: 'attempted' | 'unsupported' | 'failed'): void {
    appendAudit(this.database, principalId, 'mcp_oauth.revocation_attempted', 'mcp_server', serverId, 1, { issuer, outcome }, this.now());
  }

  /** Removes the grant and every pending flow for one server. Returns whether anything existed. */
  disconnect(principalId: string, serverId: string): boolean {
    return transaction(this.database, () => {
      const row = this.grantRow(principalId, serverId);
      const flows = this.database.prepare('DELETE FROM mcp_oauth_flows WHERE principal_id = ? AND server_id = ?').run(principalId, serverId);
      this.database.prepare('DELETE FROM mcp_oauth_grants WHERE principal_id = ? AND server_id = ?').run(principalId, serverId);
      if (!row && Number(flows.changes) === 0) return false;
      appendAudit(this.database, principalId, 'mcp_oauth.disconnected', 'mcp_server', serverId, row?.generation ?? 1, {
        issuer: row?.issuer ?? ''
      }, this.now());
      return true;
    });
  }
}
