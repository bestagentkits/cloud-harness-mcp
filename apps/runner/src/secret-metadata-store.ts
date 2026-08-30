import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { validateSecretDescription, validateSecretName, validateSecretValue, type SecretPurpose } from '@cloud-harness/contracts';
import { appendAudit, opaqueId, secretView, transaction, type SecretView } from './metadata-records.js';
import type { EncryptedSecret, SecretKeyring } from './secret-keyring.js';

type VersionRow = {
  principal_id: string;
  secret_reference_id: string;
  environment_id: string;
  name: string;
  version: number;
  key_version: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  auth_tag: Uint8Array;
  generation: number;
};

type GlobalVersionRow = {
  principal_id: string;
  secret_reference_id: string;
  name: string;
  version: number;
  key_version: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  auth_tag: Uint8Array;
  generation: number;
};

const normalizedName = (name: string): string => {
  const validation = validateSecretName(name);
  if (!validation.ok) throw new Error(validation.error);
  return validation.name;
};

const envelope = (row: VersionRow | GlobalVersionRow): EncryptedSecret => ({
  keyVersion: row.key_version,
  nonce: Buffer.from(row.nonce),
  ciphertext: Buffer.from(row.ciphertext),
  authTag: Buffer.from(row.auth_tag)
});

export class SecretMetadataStore {
  constructor(private readonly database: DatabaseSync, private readonly keyring: SecretKeyring) {
    const versions = database.prepare('SELECT DISTINCT key_version FROM secret_versions').all() as { key_version: number }[];
    const globalVersions = database.prepare('SELECT DISTINCT key_version FROM global_secret_versions').all() as { key_version: number }[];
    const allVersions = Array.from(new Set([...versions, ...globalVersions].map((row) => row.key_version)));
    keyring.assertAvailableVersions(allVersions);
  }

  list(principalId: string, environmentId: string): SecretView[] {
    const rows = this.database.prepare(`SELECT refs.* FROM secret_references refs
      JOIN environments env ON env.principal_id = refs.principal_id AND env.id = refs.environment_id
      JOIN projects ON projects.principal_id = env.principal_id AND projects.id = env.project_id
      WHERE refs.principal_id = ? AND refs.environment_id = ? AND refs.state = 'ACTIVE'
        AND env.state = 'ACTIVE' AND projects.state = 'ACTIVE'
      ORDER BY refs.updated_at DESC, refs.id`).all(principalId, environmentId);
    return (rows as Parameters<typeof secretView>[0][]).map(secretView);
  }

  environmentValues(principalId: string, environmentId: string): Record<string, string> {
    const snapshot = this.environmentSecretSnapshot(principalId, environmentId);
    return this.snapshotValues(principalId, environmentId, snapshot);
  }

  environmentSecretSnapshot(principalId: string, environmentId: string): Array<{ secretReferenceId: string; name: string; version: number }> {
    if (!this.hasActiveEnvironment(principalId, environmentId)) return [];
    const rows = this.database.prepare(`SELECT refs.id AS secret_reference_id, refs.name, refs.current_version AS version
      FROM secret_references refs
      WHERE refs.principal_id = ? AND refs.environment_id = ? AND refs.state = 'ACTIVE'
      ORDER BY refs.name`).all(principalId, environmentId) as Array<{ secret_reference_id: string; name: string; version: number }>;
    return rows.map((r) => ({
      secretReferenceId: r.secret_reference_id,
      name: r.name,
      version: r.version
    }));
  }

  environmentSecretEnvelopes(principalId: string, environmentId: string): Array<{ name: string; version: number; envelope: EncryptedSecret }> {
    if (!this.hasActiveEnvironment(principalId, environmentId)) return [];
    const rows = this.database.prepare(`SELECT versions.*, refs.environment_id, refs.name, refs.generation
      FROM secret_references refs JOIN secret_versions versions
        ON versions.principal_id = refs.principal_id AND versions.secret_reference_id = refs.id
        AND versions.version = refs.current_version
      WHERE refs.principal_id = ? AND refs.environment_id = ? AND refs.state = 'ACTIVE' AND refs.purpose = 'runtime'
      ORDER BY refs.name`).all(principalId, environmentId) as VersionRow[];
    return rows.map((r) => ({
      name: r.name,
      version: r.version,
      envelope: envelope(r)
    }));
  }

  decryptEnvelope(principalId: string, environmentId: string, name: string, version: number, encrypted: EncryptedSecret): string {
    return this.keyring.decrypt(encrypted, { principalId, environmentId, name, version });
  }

  snapshotValues(
    principalId: string,
    environmentId: string,
    snapshot: Array<{ secretReferenceId: string; name: string; version: number }>
  ): Record<string, string> {
    if (!snapshot.length) return {};
    const results: Record<string, string> = {};
    for (const item of snapshot) {
      const row = this.database.prepare(`SELECT versions.*, refs.environment_id, refs.name, refs.generation
        FROM secret_versions versions JOIN secret_references refs
          ON versions.principal_id = refs.principal_id AND versions.secret_reference_id = refs.id
        WHERE versions.principal_id = ? AND versions.secret_reference_id = ? AND versions.version = ?`).get(
        principalId, item.secretReferenceId, item.version
      ) as VersionRow | undefined;
      if (row) {
        results[item.name] = this.keyring.decrypt(envelope(row), {
          principalId, environmentId, name: item.name, version: item.version
        });
      }
    }
    return results;
  }

  create(
    principalId: string,
    environmentId: string,
    name: string,
    value: string,
    expectedGeneration: 0 = 0,
    description: string | null = null,
    purpose: SecretPurpose = 'runtime'
  ): SecretView | undefined {
    return transaction(this.database, () => this.createInTransaction(principalId, environmentId, name, value, expectedGeneration, description, purpose));
  }

  rotate(
    principalId: string,
    environmentId: string,
    name: string,
    value: string,
    expectedGeneration: number,
    description?: string | null
  ): SecretView | undefined {
    return transaction(this.database, () => this.rotateInTransaction(principalId, environmentId, name, value, expectedGeneration, description));
  }

  updateMetadata(
    principalId: string,
    environmentId: string,
    name: string,
    description: string | null,
    expectedGeneration: number
  ): SecretView | undefined {
    const secretName = normalizedName(name);
    const descCheck = validateSecretDescription(description);
    if (!descCheck.ok) throw new Error(descCheck.error);

    return transaction(this.database, () => {
      if (!this.hasActiveEnvironment(principalId, environmentId)) return undefined;
      const current = this.byName(principalId, environmentId, secretName);
      if (!current || current.state !== 'ACTIVE' || current.generation !== expectedGeneration) return undefined;
      const now = Date.now();
      const result = this.database.prepare(`UPDATE secret_references
        SET description = ?, generation = generation + 1, updated_at = ?
        WHERE principal_id = ? AND id = ? AND generation = ? AND state = 'ACTIVE'`)
        .run(descCheck.description, now, principalId, current.id, expectedGeneration);
      if (result.changes !== 1) throw new Error('secret generation changed during metadata update');
      const updated = this.byName(principalId, environmentId, secretName)!;
      appendAudit(this.database, principalId, 'secret.updated', 'secret', current.id, updated.generation, { environmentId, version: current.version }, now);
      return updated;
    });
  }

  bulkApply(
    principalId: string,
    environmentId: string,
    items: Array<{
      name: string;
      value: string;
      description?: string | null | undefined;
      purpose?: SecretPurpose | undefined;
      action: 'create' | 'rotate';
      expectedGeneration: number;
    }>
  ): SecretView[] {
    return transaction(this.database, () => {
      if (!this.hasActiveEnvironment(principalId, environmentId)) {
        throw new Error('environment is unavailable');
      }
      const results: SecretView[] = [];
      for (const item of items) {
        if (item.action === 'create') {
          const created = this.createInTransaction(principalId, environmentId, item.name, item.value, 0, item.description ?? null, item.purpose ?? 'runtime');
          if (!created) throw new Error(`failed to create secret ${item.name}: already exists or generation conflict`);
          results.push(created);
        } else if (item.action === 'rotate') {
          const rotated = this.rotateInTransaction(principalId, environmentId, item.name, item.value, item.expectedGeneration, item.description);
          if (!rotated) throw new Error(`failed to rotate secret ${item.name}: generation conflict or not found`);
          results.push(rotated);
        }
      }
      return results;
    });
  }

  delete(principalId: string, environmentId: string, name: string, expectedGeneration: number): SecretView | undefined {
    return transaction(this.database, () => {
      if (!this.hasActiveEnvironment(principalId, environmentId)) return undefined;
      const secretName = normalizedName(name);
      const current = this.byName(principalId, environmentId, secretName);
      if (!current || current.state !== 'ACTIVE' || current.generation !== expectedGeneration) return undefined;
      const now = Date.now();
      this.database.prepare('DELETE FROM secret_versions WHERE principal_id = ? AND secret_reference_id = ?')
        .run(principalId, current.id);
      const result = this.database.prepare(`DELETE FROM secret_references
        WHERE principal_id = ? AND id = ? AND generation = ? AND state = 'ACTIVE'`)
        .run(principalId, current.id, expectedGeneration);
      if (result.changes !== 1) throw new Error('secret generation changed during deletion');
      const updated: SecretView = { ...current, state: 'DELETED', generation: current.generation + 1, updatedAt: now, deletedAt: now };
      appendAudit(this.database, principalId, 'secret.deleted', 'secret', updated.id, updated.generation, { environmentId, version: updated.version }, now);
      return updated;
    });
  }

  // --- Global Secrets Management ---

  globalList(principalId: string): SecretView[] {
    const rows = this.database.prepare(`SELECT refs.*, 'global' as environment_id FROM global_secret_references refs
      WHERE refs.principal_id = ? AND refs.state = 'ACTIVE'
      ORDER BY refs.updated_at DESC, refs.id`).all(principalId);
    return (rows as Parameters<typeof secretView>[0][]).map(secretView);
  }

  globalCreate(
    principalId: string,
    name: string,
    value: string,
    expectedGeneration: 0 = 0,
    description: string | null = null,
    purpose: SecretPurpose = 'runtime'
  ): SecretView | undefined {
    return transaction(this.database, () => this.globalCreateInTransaction(principalId, name, value, expectedGeneration, description, purpose));
  }

  globalRotate(
    principalId: string,
    name: string,
    value: string,
    expectedGeneration: number,
    description?: string | null
  ): SecretView | undefined {
    return transaction(this.database, () => this.globalRotateInTransaction(principalId, name, value, expectedGeneration, description));
  }

  globalUpdateMetadata(
    principalId: string,
    name: string,
    description: string | null,
    expectedGeneration: number
  ): SecretView | undefined {
    const secretName = normalizedName(name);
    const descCheck = validateSecretDescription(description);
    if (!descCheck.ok) throw new Error(descCheck.error);

    return transaction(this.database, () => {
      const current = this.globalByName(principalId, secretName);
      if (!current || current.state !== 'ACTIVE' || current.generation !== expectedGeneration) return undefined;
      const now = Date.now();
      const result = this.database.prepare(`UPDATE global_secret_references
        SET description = ?, generation = generation + 1, updated_at = ?
        WHERE principal_id = ? AND id = ? AND generation = ? AND state = 'ACTIVE'`)
        .run(descCheck.description, now, principalId, current.id, expectedGeneration);
      if (result.changes !== 1) throw new Error('global secret generation changed during metadata update');
      const updated = this.globalByName(principalId, secretName)!;
      appendAudit(this.database, principalId, 'global_secret.updated', 'global_secret', current.id, updated.generation, { version: current.version }, now);
      return updated;
    });
  }

  globalBulkApply(
    principalId: string,
    items: Array<{
      name: string;
      value: string;
      description?: string | null | undefined;
      purpose?: SecretPurpose | undefined;
      action: 'create' | 'rotate';
      expectedGeneration: number;
    }>
  ): SecretView[] {
    return transaction(this.database, () => {
      const results: SecretView[] = [];
      for (const item of items) {
        if (item.action === 'create') {
          const created = this.globalCreateInTransaction(principalId, item.name, item.value, 0, item.description ?? null, item.purpose ?? 'runtime');
          if (!created) throw new Error(`failed to create global secret ${item.name}: already exists or generation conflict`);
          results.push(created);
        } else if (item.action === 'rotate') {
          const rotated = this.globalRotateInTransaction(principalId, item.name, item.value, item.expectedGeneration, item.description);
          if (!rotated) throw new Error(`failed to rotate global secret ${item.name}: generation conflict or not found`);
          results.push(rotated);
        }
      }
      return results;
    });
  }

  globalDelete(principalId: string, name: string, expectedGeneration: number): SecretView | undefined {
    return transaction(this.database, () => {
      const secretName = normalizedName(name);
      const current = this.globalByName(principalId, secretName);
      if (!current || current.state !== 'ACTIVE' || current.generation !== expectedGeneration) return undefined;
      const now = Date.now();
      this.database.prepare('DELETE FROM global_secret_versions WHERE principal_id = ? AND secret_reference_id = ?')
        .run(principalId, current.id);
      const result = this.database.prepare(`DELETE FROM global_secret_references
        WHERE principal_id = ? AND id = ? AND generation = ? AND state = 'ACTIVE'`)
        .run(principalId, current.id, expectedGeneration);
      if (result.changes !== 1) throw new Error('global secret generation changed during deletion');
      const updated: SecretView = { ...current, state: 'DELETED', generation: current.generation + 1, updatedAt: now, deletedAt: now };
      appendAudit(this.database, principalId, 'global_secret.deleted', 'global_secret', updated.id, updated.generation, { version: updated.version }, now);
      return updated;
    });
  }

  globalSecretEnvelopes(principalId: string): Array<{ name: string; version: number; envelope: EncryptedSecret }> {
    const rows = this.database.prepare(`SELECT versions.*, refs.name, refs.generation
      FROM global_secret_references refs JOIN global_secret_versions versions
        ON versions.principal_id = refs.principal_id AND versions.secret_reference_id = refs.id
        AND versions.version = refs.current_version
      WHERE refs.principal_id = ? AND refs.state = 'ACTIVE' AND refs.purpose = 'runtime'
      ORDER BY refs.name`).all(principalId) as GlobalVersionRow[];
    return rows.map((r) => ({
      name: r.name,
      version: r.version,
      envelope: envelope(r)
    }));
  }

  consumeProvisioningSecret(
    principalId: string,
    scope: 'global' | 'environment',
    environmentId: string | undefined,
    name: string
  ): { secretReferenceId: string; name: string; version: number; plaintext: string } {
    const secretName = normalizedName(name);
    let row: (VersionRow & { purpose?: string }) | undefined;
    if (scope === 'global') {
      row = this.database.prepare(`
        SELECT versions.*, refs.name, refs.purpose, refs.id as secret_reference_id
        FROM global_secret_references refs
        JOIN global_secret_versions versions
          ON versions.principal_id = refs.principal_id AND versions.secret_reference_id = refs.id
          AND versions.version = refs.current_version
        WHERE refs.principal_id = ? AND refs.name = ? AND refs.state = 'ACTIVE' AND refs.purpose = 'provisioning'
      `).get(principalId, secretName) as (VersionRow & { purpose?: string }) | undefined;
    } else if (environmentId) {
      row = this.database.prepare(`
        SELECT versions.*, refs.name, refs.purpose, refs.id as secret_reference_id, refs.environment_id
        FROM secret_references refs
        JOIN secret_versions versions
          ON versions.principal_id = refs.principal_id AND versions.secret_reference_id = refs.id
          AND versions.version = refs.current_version
        WHERE refs.principal_id = ? AND refs.environment_id = ? AND refs.name = ? AND refs.state = 'ACTIVE' AND refs.purpose = 'provisioning'
      `).get(principalId, environmentId, secretName) as (VersionRow & { purpose?: string }) | undefined;
    }

    if (!row) {
      throw new Error(`Provisioning secret ${name} not found or not marked purpose 'provisioning'`);
    }

    const plaintext = this.keyring.decrypt(envelope(row), {
      principalId,
      environmentId: scope === 'global' ? 'global' : environmentId!,
      name: row.name,
      version: row.version
    });

    return {
      secretReferenceId: row.secret_reference_id,
      name: row.name,
      version: row.version,
      plaintext
    };
  }

  async reencrypt(signal?: AbortSignal): Promise<number> {
    const rows = this.database.prepare(`SELECT versions.*, refs.environment_id, refs.name, refs.generation
      FROM secret_versions versions
      JOIN secret_references refs ON refs.principal_id = versions.principal_id AND refs.id = versions.secret_reference_id
      WHERE versions.key_version != ? ORDER BY versions.principal_id, versions.secret_reference_id, versions.version`)
      .all(this.keyring.activeVersion) as VersionRow[];

    const globalRows = this.database.prepare(`SELECT versions.*, refs.name, refs.generation
      FROM global_secret_versions versions
      JOIN global_secret_references refs ON refs.principal_id = versions.principal_id AND refs.id = versions.secret_reference_id
      WHERE versions.key_version != ? ORDER BY versions.principal_id, versions.secret_reference_id, versions.version`)
      .all(this.keyring.activeVersion) as GlobalVersionRow[];

    let changed = 0;
    for (const row of rows) {
      if (signal?.aborted) return changed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal?.aborted) return changed;
      const context = { principalId: row.principal_id, environmentId: row.environment_id, name: row.name, version: row.version };
      const encrypted = this.keyring.reencrypt(envelope(row), context);
      transaction(this.database, () => {
        const result = this.database.prepare(`UPDATE secret_versions SET key_version = ?, nonce = ?, ciphertext = ?, auth_tag = ?
          WHERE principal_id = ? AND secret_reference_id = ? AND version = ? AND key_version = ?`)
          .run(encrypted.keyVersion, encrypted.nonce, encrypted.ciphertext, encrypted.authTag,
            row.principal_id, row.secret_reference_id, row.version, row.key_version);
        if (result.changes === 1) {
          const reference = this.database.prepare(`SELECT generation FROM secret_references
            WHERE principal_id = ? AND id = ?`).get(row.principal_id, row.secret_reference_id) as { generation: number };
          appendAudit(this.database, row.principal_id, 'secret.reencrypted', 'secret', row.secret_reference_id,
            reference.generation, { version: row.version, keyVersion: encrypted.keyVersion }, Date.now());
          changed += 1;
        }
      });
    }

    for (const row of globalRows) {
      if (signal?.aborted) return changed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal?.aborted) return changed;
      const context = { principalId: row.principal_id, environmentId: 'global', name: row.name, version: row.version };
      const encrypted = this.keyring.reencrypt(envelope(row), context);
      transaction(this.database, () => {
        const result = this.database.prepare(`UPDATE global_secret_versions SET key_version = ?, nonce = ?, ciphertext = ?, auth_tag = ?
          WHERE principal_id = ? AND secret_reference_id = ? AND version = ? AND key_version = ?`)
          .run(encrypted.keyVersion, encrypted.nonce, encrypted.ciphertext, encrypted.authTag,
            row.principal_id, row.secret_reference_id, row.version, row.key_version);
        if (result.changes === 1) {
          const reference = this.database.prepare(`SELECT generation FROM global_secret_references
            WHERE principal_id = ? AND id = ?`).get(row.principal_id, row.secret_reference_id) as { generation: number };
          appendAudit(this.database, row.principal_id, 'global_secret.reencrypted', 'global_secret', row.secret_reference_id,
            reference.generation, { version: row.version, keyVersion: encrypted.keyVersion }, Date.now());
          changed += 1;
        }
      });
    }

    return changed;
  }

  reencryptSnapshotItem(item: {
    environmentId: string;
    ownerId: string;
    name: string;
    version: number;
    envelope: EncryptedSecret;
  }): EncryptedSecret {
    if (item.envelope.keyVersion === this.keyring.activeVersion) {
      return item.envelope;
    }
    return this.keyring.reencrypt(item.envelope, {
      principalId: item.ownerId,
      environmentId: item.environmentId,
      name: item.name,
      version: item.version
    });
  }

  private createInTransaction(
    principalId: string,
    environmentId: string,
    name: string,
    value: string,
    expectedGeneration: 0 = 0,
    description: string | null = null,
    purpose: SecretPurpose = 'runtime'
  ): SecretView | undefined {
    if (expectedGeneration !== 0) return undefined;
    const secretName = normalizedName(name);
    const valCheck = validateSecretValue(value);
    if (!valCheck.ok) throw new Error(valCheck.error);
    const descCheck = validateSecretDescription(description);
    if (!descCheck.ok) throw new Error(descCheck.error);

    if (!this.hasActiveEnvironment(principalId, environmentId)) return undefined;
    if (this.database.prepare('SELECT 1 FROM secret_references WHERE principal_id = ? AND environment_id = ? AND name = ?').get(principalId, environmentId, secretName)) return undefined;
    const id = opaqueId('sec');
    const now = Date.now();
    const encrypted = this.keyring.encrypt(valCheck.value, { principalId, environmentId, name: secretName, version: 1 });
    this.database.prepare(`INSERT INTO secret_references
      (id, principal_id, environment_id, name, description, purpose, state, current_version, generation, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', 1, 1, ?, ?, NULL)`).run(id, principalId, environmentId, secretName, descCheck.description, purpose, now, now);
    this.insertVersion(principalId, id, 1, encrypted, now);
    appendAudit(this.database, principalId, 'secret.created', 'secret', id, 1, { environmentId, version: 1 }, now);
    return this.byName(principalId, environmentId, secretName)!;
  }

  private rotateInTransaction(
    principalId: string,
    environmentId: string,
    name: string,
    value: string,
    expectedGeneration: number,
    description?: string | null
  ): SecretView | undefined {
    const secretName = normalizedName(name);
    const valCheck = validateSecretValue(value);
    if (!valCheck.ok) throw new Error(valCheck.error);
    const descCheck = description !== undefined ? validateSecretDescription(description) : undefined;
    if (descCheck && !descCheck.ok) throw new Error(descCheck.error);

    if (!this.hasActiveEnvironment(principalId, environmentId)) return undefined;
    const current = this.byName(principalId, environmentId, secretName);
    if (!current || current.state !== 'ACTIVE') return undefined;
    if (current.generation !== expectedGeneration) return undefined;
    const version = current.version + 1;
    const now = Date.now();
    const encrypted = this.keyring.encrypt(valCheck.value, { principalId, environmentId, name: secretName, version });
    this.insertVersion(principalId, current.id, version, encrypted, now);
    const finalDesc = descCheck ? descCheck.description : current.description;
    const result = this.database.prepare(`UPDATE secret_references
      SET current_version = ?, description = ?, generation = generation + 1, updated_at = ?
      WHERE principal_id = ? AND id = ? AND generation = ? AND state = 'ACTIVE'`)
      .run(version, finalDesc, now, principalId, current.id, current.generation);
    if (result.changes !== 1) throw new Error('secret generation changed during rotation');
    const updated = this.byName(principalId, environmentId, secretName)!;
    appendAudit(this.database, principalId, 'secret.rotated', 'secret', current.id, updated.generation, { environmentId, version }, now);
    return updated;
  }

  private globalCreateInTransaction(
    principalId: string,
    name: string,
    value: string,
    expectedGeneration: 0 = 0,
    description: string | null = null,
    purpose: SecretPurpose = 'runtime'
  ): SecretView | undefined {
    if (expectedGeneration !== 0) return undefined;
    const secretName = normalizedName(name);
    const valCheck = validateSecretValue(value);
    if (!valCheck.ok) throw new Error(valCheck.error);
    const descCheck = validateSecretDescription(description);
    if (!descCheck.ok) throw new Error(descCheck.error);

    if (this.database.prepare('SELECT 1 FROM global_secret_references WHERE principal_id = ? AND name = ?').get(principalId, secretName)) return undefined;
    const id = opaqueId('gsec');
    const now = Date.now();
    const encrypted = this.keyring.encrypt(valCheck.value, { principalId, environmentId: 'global', name: secretName, version: 1 });
    this.database.prepare(`INSERT INTO global_secret_references
      (id, principal_id, name, description, purpose, state, current_version, generation, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, 'ACTIVE', 1, 1, ?, ?, NULL)`).run(id, principalId, secretName, descCheck.description, purpose, now, now);
    this.insertGlobalVersion(principalId, id, 1, encrypted, now);
    appendAudit(this.database, principalId, 'global_secret.created', 'global_secret', id, 1, { version: 1 }, now);
    return this.globalByName(principalId, secretName)!;
  }

  private globalRotateInTransaction(
    principalId: string,
    name: string,
    value: string,
    expectedGeneration: number,
    description?: string | null
  ): SecretView | undefined {
    const secretName = normalizedName(name);
    const valCheck = validateSecretValue(value);
    if (!valCheck.ok) throw new Error(valCheck.error);
    const descCheck = description !== undefined ? validateSecretDescription(description) : undefined;
    if (descCheck && !descCheck.ok) throw new Error(descCheck.error);

    const current = this.globalByName(principalId, secretName);
    if (!current || current.state !== 'ACTIVE') return undefined;
    if (current.generation !== expectedGeneration) return undefined;
    const version = current.version + 1;
    const now = Date.now();
    const encrypted = this.keyring.encrypt(valCheck.value, { principalId, environmentId: 'global', name: secretName, version });
    this.insertGlobalVersion(principalId, current.id, version, encrypted, now);
    const finalDesc = descCheck ? descCheck.description : current.description;
    const result = this.database.prepare(`UPDATE global_secret_references
      SET current_version = ?, description = ?, generation = generation + 1, updated_at = ?
      WHERE principal_id = ? AND id = ? AND generation = ? AND state = 'ACTIVE'`)
      .run(version, finalDesc, now, principalId, current.id, current.generation);
    if (result.changes !== 1) throw new Error('global secret generation changed during rotation');
    const updated = this.globalByName(principalId, secretName)!;
    appendAudit(this.database, principalId, 'global_secret.rotated', 'global_secret', current.id, updated.generation, { version }, now);
    return updated;
  }

  private byName(principalId: string, environmentId: string, name: string): SecretView | undefined {
    const row = this.database.prepare(`SELECT * FROM secret_references
      WHERE principal_id = ? AND environment_id = ? AND name = ?`).get(principalId, environmentId, name);
    return row ? secretView(row as Parameters<typeof secretView>[0]) : undefined;
  }

  private globalByName(principalId: string, name: string): SecretView | undefined {
    const row = this.database.prepare(`SELECT *, 'global' as environment_id FROM global_secret_references
      WHERE principal_id = ? AND name = ?`).get(principalId, name);
    return row ? secretView(row as Parameters<typeof secretView>[0]) : undefined;
  }

  private hasActiveEnvironment(principalId: string, environmentId: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM environments env
      JOIN projects ON projects.principal_id = env.principal_id AND projects.id = env.project_id
      WHERE env.principal_id = ? AND env.id = ? AND env.state = 'ACTIVE' AND projects.state = 'ACTIVE'`)
      .get(principalId, environmentId));
  }

  private insertVersion(principalId: string, secretId: string, version: number, encrypted: EncryptedSecret, now: number): void {
    this.database.prepare(`INSERT INTO secret_versions
      (principal_id, secret_reference_id, version, key_version, nonce, ciphertext, auth_tag, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(principalId, secretId, version, encrypted.keyVersion,
      encrypted.nonce, encrypted.ciphertext, encrypted.authTag, now);
  }

  private insertGlobalVersion(principalId: string, secretId: string, version: number, encrypted: EncryptedSecret, now: number): void {
    this.database.prepare(`INSERT INTO global_secret_versions
      (principal_id, secret_reference_id, version, key_version, nonce, ciphertext, auth_tag, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(principalId, secretId, version, encrypted.keyVersion,
      encrypted.nonce, encrypted.ciphertext, encrypted.authTag, now);
  }
}
