import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiKeyStore } from '../src/api-key-store.js';
import { MetadataStore } from '../src/metadata-store.js';
import { downgradeMetadataSchemaToV1, migrateMetadataSchema } from '../src/metadata-schema.js';
import { StateStore } from '../src/state-store.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(now = 1_800_000_000_000) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-api-keys-'));
  directories.push(directory);
  const path = join(directory, 'state.db');
  const state = new StateStore(path);
  const metadata = new MetadataStore(path);
  const principal = { kind: 'external' as const, issuer: 'https://team.cloudflareaccess.com', subject: 'human-subject' };
  const principalId = state.resolvePrincipal(principal);
  let clock = now;
  const keys = new ApiKeyStore(state.database, (database, owner, action, key) => {
    metadata.recordAuditInTransaction(database, owner, action, 'api_key', key.id, key.generation, { expiresAt: key.expiresAt });
  }, () => clock);
  return { path, state, metadata, principal, principalId, keys, setNow: (value: number) => { clock = value; } };
}

describe('ApiKeyStore', () => {
  it('reveals once, stores only a digest, resolves the durable principal, and revokes immediately', () => {
    const value = fixture();
    const created = value.keys.create(value.principalId, 'CLI', 30);
    expect(created.apiKey).toMatch(/^chm_key_apk_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/);
    expect(value.keys.list(value.principalId)).toEqual([created.key]);
    expect(JSON.stringify(value.keys.list(value.principalId))).not.toContain(created.apiKey);
    expect(value.keys.verify(created.apiKey)).toEqual({ principal: value.principal, keyId: created.key.id });

    const stored = value.state.database.prepare('SELECT secret_hash, display_prefix FROM api_keys WHERE id = ?').get(created.key.id) as { secret_hash: Uint8Array; display_prefix: string };
    expect(Buffer.from(stored.secret_hash)).toHaveLength(32);
    expect(Buffer.from(stored.secret_hash).toString('utf8')).not.toContain(created.apiKey);
    expect(stored.display_prefix).not.toContain(created.apiKey.split('.')[1]);
    expect(readFileSync(value.path)).not.toContain(Buffer.from(created.apiKey));

    const revoked = value.keys.revoke(value.principalId, created.key.id, 1);
    expect(revoked?.state).toBe('REVOKED');
    expect(value.keys.verify(created.apiKey)).toBeUndefined();
    expect(value.metadata.listAudit(value.principalId).map((event) => event.action)).toEqual(['api_key.revoked', 'api_key.created']);
    value.metadata.close(); value.state.close();
  });

  it('rejects malformed, unknown, altered, expired, and foreign revocation uniformly', () => {
    const value = fixture();
    const created = value.keys.create(value.principalId, 'Automation', 1);
    expect(value.keys.verify('not-a-key')).toBeUndefined();
    expect(value.keys.verify(`${created.apiKey.slice(0, -1)}A`)).toBeUndefined();
    expect(value.keys.revoke('prn_foreign', created.key.id, 1)).toBeUndefined();
    value.setNow(created.key.expiresAt);
    expect(value.keys.verify(created.apiKey)).toBeUndefined();
    expect(value.keys.list(value.principalId)[0]?.state).toBe('EXPIRED');
    value.metadata.close(); value.state.close();
  });

  it('enforces ten active unexpired keys per principal', () => {
    const value = fixture();
    for (let index = 0; index < 10; index += 1) value.keys.create(value.principalId, `Key ${index}`, 30);
    expect(() => value.keys.create(value.principalId, 'Eleventh', 30)).toThrow('active API key limit reached');
    expect(value.keys.list(value.principalId)).toHaveLength(10);
    value.metadata.close(); value.state.close();
  });

  it('serializes the active-key cap across independent SQLite connections', () => {
    const value = fixture();
    for (let index = 0; index < 9; index += 1) value.keys.create(value.principalId, `Key ${index}`, 30);
    const secondState = new StateStore(value.path);
    const secondKeys = new ApiKeyStore(secondState.database, () => undefined, () => 1_800_000_000_000);
    value.keys.create(value.principalId, 'Tenth', 30);
    expect(() => secondKeys.create(value.principalId, 'Eleventh', 30)).toThrow('active API key limit reached');
    expect(secondKeys.list(value.principalId)).toHaveLength(10);
    secondState.close(); value.metadata.close(); value.state.close();
  });

  it('retries an opaque key-ID collision without exposing the discarded secret', () => {
    const value = fixture();
    const sequence = [
      Buffer.alloc(18, 1), Buffer.alloc(32, 2),
      Buffer.alloc(18, 1), Buffer.alloc(32, 3),
      Buffer.alloc(18, 4), Buffer.alloc(32, 5)
    ];
    const keys = new ApiKeyStore(value.state.database, () => undefined, () => 1_800_000_000_000, (size) => {
      const next = sequence.shift();
      if (!next || next.length !== size) throw new Error('unexpected random allocation');
      return next;
    });
    const first = keys.create(value.principalId, 'First', 30);
    const second = keys.create(value.principalId, 'Second', 30);
    expect(second.key.id).not.toBe(first.key.id);
    expect(keys.verify(second.apiKey)?.keyId).toBe(second.key.id);
    expect(keys.list(value.principalId)).toHaveLength(2);
    value.metadata.close(); value.state.close();
  });

  it('coalesces last-used writes across connections without using them for authorization', () => {
    const value = fixture();
    const created = value.keys.create(value.principalId, 'Usage', 30);
    expect(value.keys.verify(created.apiKey)?.keyId).toBe(created.key.id);
    const firstUsed = value.keys.list(value.principalId)[0]?.lastUsedAt;
    value.setNow(1_800_000_299_999);
    expect(value.keys.verify(created.apiKey)?.keyId).toBe(created.key.id);
    expect(value.keys.list(value.principalId)[0]?.lastUsedAt).toBe(firstUsed);
    const secondState = new StateStore(value.path);
    const secondKeys = new ApiKeyStore(secondState.database, () => undefined, () => 1_800_000_300_000);
    expect(secondKeys.verify(created.apiKey)?.keyId).toBe(created.key.id);
    expect(secondKeys.list(value.principalId)[0]?.lastUsedAt).toBe(1_800_000_300_000);
    secondState.close(); value.metadata.close(); value.state.close();
  });

  it('authenticates when only the non-authoritative usage write fails', () => {
    const value = fixture();
    const created = value.keys.create(value.principalId, 'Telemetry failure', 30);
    value.state.database.exec(`CREATE TRIGGER reject_api_key_usage_update
      BEFORE UPDATE OF last_used_at ON api_keys
      BEGIN SELECT RAISE(ABORT, 'usage telemetry unavailable'); END`);
    expect(value.keys.verify(created.apiKey)).toEqual({ principal: value.principal, keyId: created.key.id });
    expect(value.keys.list(value.principalId)[0]?.lastUsedAt).toBeNull();
    value.metadata.close(); value.state.close();
  });

  it('keeps key ownership on the durable principal across an exact subject relink', () => {
    const value = fixture();
    const created = value.keys.create(value.principalId, 'Relinked', 30);
    const mapping = {
      oldIssuer: value.principal.issuer,
      oldSubject: value.principal.subject,
      newIssuer: 'https://new-team.cloudflareaccess.com',
      newSubject: 'new-human-subject'
    };
    expect(value.state.applyPrincipalRelinks([mapping])[0]?.principalId).toBe(value.principalId);
    expect(value.keys.verify(created.apiKey)).toEqual({
      principal: { kind: 'external', issuer: mapping.newIssuer, subject: mapping.newSubject },
      keyId: created.key.id
    });
    value.metadata.close(); value.state.close();
  });

  it('downgrades only API-key state and can migrate forward again', () => {
    const value = fixture();
    const project = value.metadata.createProject(value.principalId, 'Preserved', 0);
    value.keys.create(value.principalId, 'Disposable', 30);
    downgradeMetadataSchemaToV1(value.metadata.database);
    expect((value.metadata.database.prepare('SELECT version FROM metadata_schema_meta').get() as { version: number }).version).toBe(1);
    expect(value.metadata.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'").get()).toBeUndefined();
    expect(value.metadata.listProjects(value.principalId)[0]?.id).toBe(project?.id);
    migrateMetadataSchema(value.metadata.database);
    expect((value.metadata.database.prepare('SELECT version FROM metadata_schema_meta').get() as { version: number }).version).toBe(2);
    expect(value.metadata.listProjects(value.principalId)[0]?.id).toBe(project?.id);
    value.metadata.close(); value.state.close();
  });

  it('fails closed for future, conflicting, and invalid downgrade schema states', () => {
    const future = fixture();
    future.metadata.database.prepare('UPDATE metadata_schema_meta SET version = 99 WHERE singleton = 1').run();
    expect(() => migrateMetadataSchema(future.metadata.database)).toThrow('unsupported metadata schema version 99');
    expect((future.metadata.database.prepare('SELECT version FROM metadata_schema_meta').get() as { version: number }).version).toBe(99);
    expect(() => downgradeMetadataSchemaToV1(future.metadata.database)).toThrow('metadata schema must be version 2 before downgrade');
    future.metadata.close(); future.state.close();

    const conflicting = fixture();
    downgradeMetadataSchemaToV1(conflicting.metadata.database);
    conflicting.metadata.database.exec('CREATE TABLE api_keys (unexpected TEXT)');
    expect(() => migrateMetadataSchema(conflicting.metadata.database)).toThrow();
    expect((conflicting.metadata.database.prepare('SELECT version FROM metadata_schema_meta').get() as { version: number }).version).toBe(1);
    expect((conflicting.metadata.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'").get() as { sql: string }).sql)
      .toContain('unexpected TEXT');
    conflicting.metadata.close(); conflicting.state.close();
  });
});
