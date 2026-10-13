import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { EncryptedSecret, SecretKeyring } from './secret-keyring.js';

/**
 * The envelope context. Binding it means a value encrypted for this table cannot be decrypted as
 * something else even when the same keyring produced it.
 */
export const INTEGRATION_CREDENTIAL_CONTEXT = 'integration_credential';

export type IntegrationCredentialStatus = 'ACTIVE' | 'DISABLED' | 'REVOKED';

/** Metadata only. This type has no value field, so no read path can hand one out by accident. */
export type IntegrationCredentialRecord = {
  id: string;
  integration: string;
  label: string;
  status: IntegrationCredentialStatus;
  activeVersion: number;
  generation: number;
  createdAt: number;
  updatedAt: number;
};

export class IntegrationCredentialError extends Error {
  readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT';

  constructor(code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT', message: string) {
    super(message);
    this.name = 'IntegrationCredentialError';
    this.code = code;
  }
}

/**
 * Dedicated integration credentials, stored beside the provider credentials and encrypted with the same
 * versioned keyring envelope. A TypeSafe key is not a gateway provider, so it is deliberately not
 * routed through the model credential tables or the gateway snapshot export.
 */
export class IntegrationCredentialRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly keyring: SecretKeyring
  ) {}

  private encryptValue(principalId: string, id: string, version: number, value: string): EncryptedSecret {
    return this.keyring.encrypt(value, {
      principalId,
      environmentId: INTEGRATION_CREDENTIAL_CONTEXT,
      name: id,
      version
    });
  }

  private insertVersion(principalId: string, id: string, version: number, encrypted: EncryptedSecret, now: number): void {
    this.database.prepare(`INSERT INTO integration_credential_versions
      (principal_id, credential_id, version, key_version, nonce, ciphertext, auth_tag, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(principalId, id, version, encrypted.keyVersion, encrypted.nonce.toString('hex'),
        encrypted.ciphertext.toString('hex'), encrypted.authTag.toString('hex'), now);
  }

  private require(principalId: string, id: string): IntegrationCredentialRecord {
    const row = this.database.prepare(`SELECT id, integration, label, status, active_version, generation, created_at, updated_at
      FROM integration_credentials WHERE principal_id = ? AND id = ?`).get(principalId, id) as Record<string, unknown> | undefined;
    if (!row) throw new IntegrationCredentialError('NOT_FOUND', `integration credential ${id} was not found`);
    return {
      id: String(row.id),
      integration: String(row.integration),
      label: String(row.label),
      status: row.status as IntegrationCredentialStatus,
      activeVersion: Number(row.active_version),
      generation: Number(row.generation),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }

  create(input: { principalId: string; integration: string; label: string; value: string }): IntegrationCredentialRecord {
    if (input.value === '') throw new IntegrationCredentialError('INVALID_INPUT', 'a credential value is required');
    const existing = this.database.prepare('SELECT id FROM integration_credentials WHERE principal_id = ? AND integration = ?')
      .get(input.principalId, input.integration) as { id: string } | undefined;
    if (existing) {
      throw new IntegrationCredentialError('CONFLICT', `a ${input.integration} credential already exists; rotate it instead`);
    }

    const id = `icr_${randomUUID().replaceAll('-', '')}`;
    const now = Date.now();
    const encrypted = this.encryptValue(input.principalId, id, 1, input.value);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`INSERT INTO integration_credentials
        (id, principal_id, integration, label, active_version, status, generation, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 'ACTIVE', 1, ?, ?)`)
        .run(id, input.principalId, input.integration, input.label, now, now);
      this.insertVersion(input.principalId, id, 1, encrypted, now);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.require(input.principalId, id);
  }

  rotate(input: { principalId: string; id: string; value: string; expectedGeneration: number }): IntegrationCredentialRecord {
    const current = this.require(input.principalId, input.id);
    if (current.generation !== input.expectedGeneration) {
      throw new IntegrationCredentialError('CONFLICT', `integration credential ${input.id} is at generation ${current.generation} but rotation expected ${input.expectedGeneration}`);
    }
    if (input.value === '') throw new IntegrationCredentialError('INVALID_INPUT', 'a credential value is required');

    const version = current.activeVersion + 1;
    const now = Date.now();
    const encrypted = this.encryptValue(input.principalId, input.id, version, input.value);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`UPDATE integration_credentials SET active_version = ?, generation = generation + 1, updated_at = ?
        WHERE principal_id = ? AND id = ?`).run(version, now, input.principalId, input.id);
      this.insertVersion(input.principalId, input.id, version, encrypted, now);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.require(input.principalId, input.id);
  }

  delete(input: { principalId: string; id: string; expectedGeneration: number }): void {
    const current = this.require(input.principalId, input.id);
    if (current.generation !== input.expectedGeneration) {
      throw new IntegrationCredentialError('CONFLICT', `integration credential ${input.id} is at generation ${current.generation} but deletion expected ${input.expectedGeneration}`);
    }
    this.database.prepare('DELETE FROM integration_credentials WHERE principal_id = ? AND id = ?').run(input.principalId, input.id);
  }

  list(principalId: string): IntegrationCredentialRecord[] {
    const rows = this.database.prepare('SELECT id FROM integration_credentials WHERE principal_id = ? ORDER BY created_at, id')
      .all(principalId) as Record<string, unknown>[];
    return rows.map((row) => this.require(principalId, String(row.id)));
  }

  /**
   * The only path that decrypts, and the engine is its only caller. It is reachable from no operation,
   * which is what keeps the value write-only from a caller's point of view.
   */
  decryptValue(principalId: string, integration: string): string | undefined {
    const row = this.database.prepare('SELECT id, active_version FROM integration_credentials WHERE principal_id = ? AND integration = ? AND status = ?')
      .get(principalId, integration, 'ACTIVE') as { id: string; active_version: number } | undefined;
    if (!row) return undefined;

    const envelope = this.database.prepare(`SELECT key_version, nonce, ciphertext, auth_tag FROM integration_credential_versions
      WHERE principal_id = ? AND credential_id = ? AND version = ?`)
      .get(principalId, row.id, row.active_version) as Record<string, unknown> | undefined;
    if (!envelope) return undefined;

    return this.keyring.decrypt({
      keyVersion: Number(envelope.key_version),
      nonce: Buffer.from(String(envelope.nonce), 'hex'),
      ciphertext: Buffer.from(String(envelope.ciphertext), 'hex'),
      authTag: Buffer.from(String(envelope.auth_tag), 'hex')
    }, {
      principalId,
      environmentId: INTEGRATION_CREDENTIAL_CONTEXT,
      name: row.id,
      version: row.active_version
    });
  }
}
