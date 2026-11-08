import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubUserAuthorizationStore } from '../src/github-user-authorization-store.js';
import { downgradeStateDbToV7 } from '../src/metadata-schema-down-v7.js';
import { downgradeMetadataSchemaToV7, migrateMetadataSchema } from '../src/metadata-schema.js';
import { MetadataStore } from '../src/metadata-store.js';
import { rekeySecrets } from '../src/secret-rekey.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore } from '../src/state-store.js';
import { pair } from './github-user-fixtures.js';

const key1 = randomBytes(32);
const key2 = randomBytes(32);
const closers: Array<() => void> = [];
const directories: string[] = [];

afterEach(() => {
  for (const close of closers.splice(0)) {
    try { close(); } catch { /* already closed */ }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function open(keyring = new SecretKeyring(1, [{ version: 1, key: key1 }])) {
  const directory = mkdtempSync(join(tmpdir(), 'ch-github-user-store-'));
  directories.push(directory);
  const path = join(directory, 'state.db');
  const state = new StateStore(path);
  const metadata = new MetadataStore(path, keyring);
  closers.push(() => metadata.close(), () => state.close());
  const principalId = state.resolvePrincipal({ kind: 'owner', ownerId: 'principal_1' });
  const clock = { now: 1_000_000 };
  const store = new GitHubUserAuthorizationStore(metadata.database, keyring, () => clock.now);
  const connect = (suffix: string) => store.connect(principalId, { ...pair(clock.now, suffix), githubUserId: '789', login: 'alice' });
  const rows = () => metadata.database.prepare('SELECT * FROM github_user_authorizations').all() as Array<Record<string, unknown>>;
  const audit = (action: string) => metadata.listAudit(principalId, 100).filter((event) => event.action === action);
  return { path, state, metadata, principalId, clock, store, keyring, connect, rows, audit };
}

describe('GitHub user authorization store', () => {
  it('keeps one encrypted pair per principal and never puts a token in a view, a row, or an audit entry', () => {
    const { store, principalId, connect, rows, audit } = open();
    const first = connect('one');
    expect(first.record).toMatchObject({ principalId, generation: 1, status: 'connected', githubUserId: '789', login: 'alice', reasonCode: null });
    expect(first.replaced).toBeUndefined();
    expect(store.load(principalId)).toMatchObject({
      record: { generation: 1 }, tokens: { accessToken: 'ghu_access_one', refreshToken: 'ghr_refresh_one' }
    });
    expect(JSON.stringify(store.get(principalId))).not.toMatch(/ghu_|ghr_/);
    const serialized = JSON.stringify(rows(), (_key, value) => (value instanceof Uint8Array ? Buffer.from(value).toString('latin1') : value));
    expect(serialized).not.toMatch(/ghu_|ghr_/);
    expect(audit('github.user_authorized')).toEqual([expect.objectContaining({
      subjectType: 'github_user_authorization', subjectId: '789', subjectGeneration: 1, details: { login: 'alice', githubUserId: '789' }
    })]);
    expect(JSON.stringify(audit('github.user_authorized'))).not.toMatch(/ghu_|ghr_/);
    // One row per principal is a constraint, not a convention.
    expect(() => store.database.prepare(`INSERT INTO github_user_authorizations
      (principal_id, generation, status, github_user_id, github_login, created_at, updated_at)
      VALUES (?, 1, 'revoked', '1', 'x', 1, 1)`).run(principalId)).toThrow(/UNIQUE/);
  });

  it('writes only at the expected generation, so a stale writer changes nothing', () => {
    const { store, principalId, clock, connect, audit } = open();
    connect('one');
    expect(store.rotate(principalId, 1, pair(clock.now, 'two'))).toMatchObject({ generation: 2 });
    expect(store.rotate(principalId, 1, pair(clock.now, 'stale'))).toBeUndefined();
    expect(store.markRevoked(principalId, 1, 'bad_refresh_token')).toBeUndefined();
    expect(store.load(principalId)).toMatchObject({
      record: { generation: 2, status: 'connected' }, tokens: { accessToken: 'ghu_access_two' }
    });
    expect(audit('github.user_authorization_revoked')).toHaveLength(0);
    expect(store.markRevoked(principalId, 2, 'bad_refresh_token')).toMatchObject({ generation: 3, status: 'revoked', reasonCode: 'bad_refresh_token' });
    // Nothing rotates or revokes a row that is no longer connected.
    expect(store.rotate(principalId, 3, pair(clock.now, 'late'))).toBeUndefined();
    expect(store.markRevoked(principalId, 3, 'refresh_token_expired')).toBeUndefined();
    expect(audit('github.user_authorization_revoked')).toEqual([expect.objectContaining({ details: { reasonCode: 'bad_refresh_token' } })]);
    // A refresh is not audited.
    expect(audit('github.user_token_refreshed')).toHaveLength(0);
  });

  it('clears the envelope when revoked or disconnected, and keeps the non-secret status', () => {
    const { store, principalId, metadata, clock, connect, rows, audit } = open();
    connect('one');
    store.markRevoked(principalId, 1, 'bad_refresh_token');
    expect(store.load(principalId)).toEqual({ record: expect.objectContaining({ status: 'revoked', reasonCode: 'bad_refresh_token', login: 'alice', githubUserId: '789', accessExpiresAt: null, refreshExpiresAt: null }) });
    expect(rows()[0]).toMatchObject({ key_version: null, nonce: null, ciphertext: null, auth_tag: null, access_expires_at: null, refresh_expires_at: null });
    // The table itself refuses token material on a row that is not connected, and a connected row without any.
    expect(() => metadata.database.prepare("UPDATE github_user_authorizations SET ciphertext = x'00'").run()).toThrow(/CHECK/);
    expect(() => metadata.database.prepare("UPDATE github_user_authorizations SET status = 'connected'").run()).toThrow(/CHECK/);

    // Only Disconnect leaves revoked; reconnecting is the only way back to connected.
    const disconnected = store.disconnect(principalId);
    expect(disconnected).toMatchObject({ record: { status: 'disconnected', generation: 3, reasonCode: null } });
    expect(disconnected?.removed).toBeUndefined();
    expect(store.disconnect(principalId)).toMatchObject({ record: { generation: 3 } });
    expect(audit('github.user_disconnected')).toHaveLength(1);
    const reconnected = connect('two');
    expect(reconnected.record).toMatchObject({ status: 'connected', generation: 4, reasonCode: null });
    expect(reconnected.replaced).toBeUndefined();

    // A connected pair that is disconnected is handed back once so it can be revoked at GitHub.
    const removed = store.disconnect(principalId);
    expect(removed).toMatchObject({ record: { status: 'disconnected', generation: 5 }, removed: { accessToken: 'ghu_access_two', refreshToken: 'ghr_refresh_two' } });
    expect(rows()[0]).toMatchObject({ key_version: null, nonce: null, ciphertext: null, auth_tag: null });
    // Reconnecting over a connected pair returns the pair it replaced.
    connect('three');
    clock.now += 1;
    expect(connect('four').replaced).toEqual({ accessToken: 'ghu_access_three', refreshToken: 'ghr_refresh_three' });
  });

  it('is covered by the rekey command and refuses a keyring that lost a key it still needs', () => {
    const { path, state, principalId, store, connect, rows } = open();
    connect('one');
    store.rotate(principalId, 1, pair(1, 'two'));
    const before = rows()[0]!;
    expect(before.key_version).toBe(1);

    const rotated = new SecretKeyring(2, [{ version: 1, key: key1 }, { version: 2, key: key2 }]);
    const metadata = new MetadataStore(path, rotated);
    closers.push(() => metadata.close());
    return rekeySecrets({ state, metadata, keyring: rotated }).then((counts) => {
      expect(counts.githubUserAuthorizations).toBe(1);
      const after = metadata.database.prepare('SELECT * FROM github_user_authorizations').get() as Record<string, unknown>;
      expect(after).toMatchObject({ key_version: 2, generation: 2 });
      expect(Buffer.from(after.ciphertext as Uint8Array).equals(Buffer.from(before.ciphertext as Uint8Array))).toBe(false);
      // Re-encryption does not change the plaintext or the generation, so an in-flight refresh still wins its own CAS.
      expect(new GitHubUserAuthorizationStore(metadata.database, rotated).load(principalId)).toMatchObject({
        record: { generation: 2 }, tokens: { accessToken: 'ghu_access_two', refreshToken: 'ghr_refresh_two' }
      });
      expect(metadata.githubUserAuthorizations.reencrypt()).toBe(0);

      const dropped = new SecretKeyring(2, [{ version: 2, key: key2 }]);
      // Stored under key 1 and dropped from the keyring: every secret surface is unavailable, so no
      // global-secret credential can stand in for a token that cannot be opened.
      expect(() => new GitHubUserAuthorizationStore(metadata.database, dropped)).not.toThrow();
      metadata.database.prepare('UPDATE github_user_authorizations SET key_version = 1').run();
      expect(() => new GitHubUserAuthorizationStore(metadata.database, dropped)).toThrow(/unknown secret key version 1/);
      const unavailable = new MetadataStore(path, dropped);
      closers.push(() => unavailable.close());
      expect(unavailable.secretReadiness()).toMatchObject({ ready: false });
      expect(() => unavailable.githubUserAuthorizations).toThrow();
      expect(() => unavailable.secrets).toThrow();
    });
  });

  it('migrates to v8, rolls back to v7 without touching the rest, and migrates again', () => {
    const { path, metadata, principalId, connect } = open();
    const version = () => (metadata.database.prepare('SELECT version FROM metadata_schema_meta').get() as { version: number }).version;
    const table = () => metadata.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'github_user_authorizations'").get();
    expect(version()).toBe(8);
    expect(table()).toBeDefined();
    migrateMetadataSchema(metadata.database);
    expect(version()).toBe(8);
    connect('one');
    const project = metadata.createProject(principalId, 'Kept', 0);

    downgradeMetadataSchemaToV7(metadata.database);
    expect(version()).toBe(7);
    expect(table()).toBeUndefined();
    expect(metadata.listProjects(principalId)[0]?.id).toBe(project?.id);
    expect(() => downgradeMetadataSchemaToV7(metadata.database)).toThrow('metadata schema must be version 8 before downgrade');

    migrateMetadataSchema(metadata.database);
    expect(version()).toBe(8);
    expect(metadata.database.prepare('SELECT count(*) AS count FROM github_user_authorizations').get()).toEqual({ count: 0 });

    // The bounded operator entry point drops only this table and refuses any other version.
    metadata.close();
    const out: string[] = [];
    const errors: string[] = [];
    const io = { out: (line: string) => out.push(line), error: (line: string) => errors.push(line) };
    expect(downgradeStateDbToV7(path, io)).toBe(0);
    expect(out).toEqual(['metadata-schema-version=7']);
    expect(downgradeStateDbToV7(path, io)).toBe(1);
    expect(errors[0]).toContain('must be version 8');
  });

  it('removes the row explicitly, because principals are ON DELETE RESTRICT', () => {
    const { store, principalId, metadata, connect } = open();
    connect('one');
    // The audit trail also references the principal; clear it so only this table is under test.
    metadata.database.prepare('DELETE FROM audit_events WHERE principal_id = ?').run(principalId);
    expect(() => metadata.database.prepare('DELETE FROM principals WHERE id = ?').run(principalId)).toThrow(/FOREIGN KEY/);
    expect(store.deleteForPrincipal(principalId)).toBe(true);
    expect(store.get(principalId)).toBeUndefined();
    expect(store.deleteForPrincipal(principalId)).toBe(false);
    expect(Number(metadata.database.prepare('DELETE FROM principals WHERE id = ?').run(principalId).changes)).toBe(1);
  });
});
