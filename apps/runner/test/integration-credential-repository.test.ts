import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IntegrationCredentialError, IntegrationCredentialRepository } from '../src/integration-credential-repository.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore } from '../src/state-store.js';

const STAMP = 1_700_000_000_000;
const OWNER = 'p_owner';
const OTHER_OWNER = 'p_other';
const SECRET = 'ts_live_do_not_log_this_value';

const openStores: StateStore[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) {
    try { store.close(); } catch { /* ignore cleanup error */ }
  }
});

/** The state store owns schema creation, so the repository is built on the database it migrates. */
function openRepository() {
  const store = new StateStore(join(tmpdir(), `test-integration-credential-${randomBytes(8).toString('hex')}.sqlite`));
  openStores.push(store);
  const database = store.database;
  const insertPrincipal = database.prepare('INSERT INTO principals (id, issuer, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  insertPrincipal.run(OWNER, 'https://auth.example.com', OWNER, STAMP, STAMP);
  insertPrincipal.run(OTHER_OWNER, 'https://auth.example.com', OTHER_OWNER, STAMP, STAMP);
  const keyring = new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]);
  return { database, repository: new IntegrationCredentialRepository(database, keyring) };
}

describe('integration credential repository', () => {
  it('stores the value encrypted, so the plaintext never appears in the row', () => {
    const { database, repository } = openRepository();
    const created = repository.create({ principalId: OWNER, integration: 'typesafe', label: 'TypeSafe', value: SECRET });

    const stored = database.prepare('SELECT ciphertext, nonce, auth_tag, key_version FROM integration_credential_versions WHERE credential_id = ?')
      .get(created.id) as Record<string, unknown>;

    expect(String(stored.ciphertext)).not.toContain(SECRET);
    expect(Number(stored.key_version)).toBe(1);
    expect(String(stored.nonce).length).toBeGreaterThan(0);
    expect(JSON.stringify(created)).not.toContain(SECRET);
  });

  it('decrypts through the engine path and confirms the envelope is bound to the record', () => {
    const { repository } = openRepository();
    repository.create({ principalId: OWNER, integration: 'typesafe', label: 'TypeSafe', value: SECRET });

    expect(repository.decryptValue(OWNER, 'typesafe')).toBe(SECRET);
    // Another owner has no credential, so the lookup is scoped rather than global.
    expect(repository.decryptValue(OTHER_OWNER, 'typesafe')).toBeUndefined();
  });

  it('never returns a value from the list path', () => {
    const { repository } = openRepository();
    repository.create({ principalId: OWNER, integration: 'typesafe', label: 'TypeSafe', value: SECRET });

    const listed = repository.list(OWNER);
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0]!)).not.toContain('value');
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    expect(repository.list(OTHER_OWNER)).toEqual([]);
  });

  it('refuses a second credential for the same integration instead of silently replacing it', () => {
    const { repository } = openRepository();
    repository.create({ principalId: OWNER, integration: 'typesafe', label: 'TypeSafe', value: SECRET });

    expect(() => repository.create({ principalId: OWNER, integration: 'typesafe', label: 'again', value: 'second' }))
      .toThrow(IntegrationCredentialError);
    try {
      repository.create({ principalId: OWNER, integration: 'typesafe', label: 'again', value: 'second' });
    } catch (error) {
      expect((error as IntegrationCredentialError).code).toBe('CONFLICT');
    }
  });

  it('rotates at the current generation, adding a version and changing what decrypts', () => {
    const { repository } = openRepository();
    const created = repository.create({ principalId: OWNER, integration: 'typesafe', label: 'TypeSafe', value: SECRET });

    const rotated = repository.rotate({ principalId: OWNER, id: created.id, value: 'ts_live_rotated', expectedGeneration: created.generation });

    expect(rotated.generation).toBe(created.generation + 1);
    expect(rotated.activeVersion).toBe(2);
    expect(repository.decryptValue(OWNER, 'typesafe')).toBe('ts_live_rotated');
  });

  it('refuses a rotation from a stale generation', () => {
    const { repository } = openRepository();
    const created = repository.create({ principalId: OWNER, integration: 'typesafe', label: 'TypeSafe', value: SECRET });
    repository.rotate({ principalId: OWNER, id: created.id, value: 'ts_live_rotated', expectedGeneration: created.generation });

    try {
      repository.rotate({ principalId: OWNER, id: created.id, value: 'third', expectedGeneration: created.generation });
      throw new Error('a stale rotation should have been refused');
    } catch (error) {
      expect((error as IntegrationCredentialError).code).toBe('CONFLICT');
    }
    // The refused rotation changed nothing, so the previous value still decrypts.
    expect(repository.decryptValue(OWNER, 'typesafe')).toBe('ts_live_rotated');
  });

  it('deletes at the current generation and refuses a stale deletion', () => {
    const { repository } = openRepository();
    const created = repository.create({ principalId: OWNER, integration: 'typesafe', label: 'TypeSafe', value: SECRET });

    try {
      repository.delete({ principalId: OWNER, id: created.id, expectedGeneration: created.generation + 5 });
      throw new Error('a stale deletion should have been refused');
    } catch (error) {
      expect((error as IntegrationCredentialError).code).toBe('CONFLICT');
    }

    repository.delete({ principalId: OWNER, id: created.id, expectedGeneration: created.generation });
    expect(repository.list(OWNER)).toEqual([]);
    expect(repository.decryptValue(OWNER, 'typesafe')).toBeUndefined();
  });

  it('refuses an empty value and a missing credential', () => {
    const { repository } = openRepository();
    try {
      repository.create({ principalId: OWNER, integration: 'typesafe', label: 'TypeSafe', value: '' });
      throw new Error('an empty value should have been refused');
    } catch (error) {
      expect((error as IntegrationCredentialError).code).toBe('INVALID_INPUT');
    }
    expect(() => repository.rotate({ principalId: OWNER, id: 'icr_missing', value: 'x', expectedGeneration: 1 }))
      .toThrow(IntegrationCredentialError);
  });
});
