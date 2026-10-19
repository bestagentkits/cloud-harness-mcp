import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelProfileIdSchema } from '@cloud-harness/contracts';
import { ModelProfileStateRepository, initializeModelProfilePricingColumns } from '../src/model-profile-state-repository.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore, downgradeStateSchemaToV13 } from '../src/state-store.js';

const PRICING_COLUMNS = [
  'cache_read_micros_per_million',
  'cache_write_micros_per_million',
  'price_tiers_json',
  'price_source',
  'price_source_model_id',
  'price_retrieved_at',
  'price_confidence',
  'price_is_override'
];

const USER_OVERRIDE = { source: 'user', sourceModelId: null, retrievedAt: null, confidence: 'unknown', isOverride: true };

const schemaVersion = (database: DatabaseSync) => (database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version;
const revisionColumns = (database: DatabaseSync) =>
  (database.prepare('PRAGMA table_info(agent_model_profile_revisions)').all() as Array<{ name: string }>).map((column) => column.name);

// The revision INSERT a runner released before the pricing columns issues.
function insertLegacyRevision(database: DatabaseSync, principalId: string, revisionId: string, credentialId: string): void {
  database.prepare(`
    INSERT INTO agent_model_profile_revisions (
      id, profile_id, principal_id, credential_id, model, api_mode, downstream_path, upstream_url,
      input_micros_per_million, output_micros_per_million, max_input_tokens, max_output_tokens, max_cost_micros,
      max_proxy_operations_json, digest, created_at
    ) VALUES (?, 'legacy', ?, ?, 'gpt-legacy', 'chat-completions', '/v1/chat/completions',
      'https://api.openai.com/v1/chat/completions', 1500, 6000, 1000, 100, 5000, '["files_read"]', 'sha256:legacy', 1)
  `).run(revisionId, principalId, credentialId);
}

describe('model profile revision pricing columns', () => {
  const directories: string[] = [];
  const stores: StateStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) {
      try { store.close(); } catch { /* already closed */ }
    }
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function open(path?: string): { store: StateStore; path: string } {
    let databasePath = path;
    if (!databasePath) {
      const directory = mkdtempSync(join(tmpdir(), 'model-pricing-columns-'));
      directories.push(directory);
      databasePath = join(directory, 'state.sqlite');
    }
    const store = new StateStore(databasePath);
    stores.push(store);
    return { store, path: databasePath };
  }

  const keyring = () => new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]);

  // A head-schema (v14) database written by a runner without the pricing columns:
  // one credential, one profile, and one revision inserted the old way.
  function seedLegacy(database: DatabaseSync, principalId: string): { credentialId: string; revisionId: string } {
    const credentialId = `cred_${randomBytes(16).toString('hex')}`;
    const revisionId = `rev_${randomBytes(16).toString('hex')}`;
    database.prepare(`
      INSERT INTO model_provider_credentials (id, principal_id, label, provider, auth_mode, status, created_at, updated_at)
      VALUES (?, ?, 'Legacy', 'openai', 'bearer', 'ACTIVE', 1, 1)
    `).run(credentialId, principalId);
    database.prepare(`
      INSERT INTO agent_model_profiles (id, principal_id, display_name, credential_id, desired_revision_id, active_revision_id, status, created_at, updated_at)
      VALUES ('legacy', ?, 'Legacy', ?, ?, ?, 'ACTIVE', 1, 1)
    `).run(principalId, credentialId, revisionId, revisionId);
    insertLegacyRevision(database, principalId, revisionId, credentialId);
    return { credentialId, revisionId };
  }

  it('adds the columns to a fresh database idempotently without a schema version bump', () => {
    const { store } = open();
    expect(revisionColumns(store.database)).not.toContain('price_source');
    new ModelProfileStateRepository(store.database, keyring());
    initializeModelProfilePricingColumns(store.database);
    const columns = revisionColumns(store.database);
    for (const column of PRICING_COLUMNS) expect(columns).toContain(column);
    expect(columns.filter((column) => PRICING_COLUMNS.includes(column))).toHaveLength(PRICING_COLUMNS.length);
    expect(schemaVersion(store.database)).toBe(16);
  });

  it('reads revisions of a legacy database back as user overrides with their prices unchanged', () => {
    const { store } = open();
    const principalId = store.resolvePrincipal({ kind: 'owner', ownerId: 'legacy-owner' });
    const { revisionId } = seedLegacy(store.database, principalId);
    expect(schemaVersion(store.database)).toBe(16);

    const repo = new ModelProfileStateRepository(store.database, keyring());
    new ModelProfileStateRepository(store.database, keyring());
    initializeModelProfilePricingColumns(store.database);

    const [profile] = repo.listProfiles(principalId);
    expect(profile?.activeRevision?.id).toBe(revisionId);
    expect(profile?.activeRevision?.pricing).toEqual({ inputMicrosPerMillionTokens: 1500, outputMicrosPerMillionTokens: 6000 });
    expect(profile?.activeRevision?.priceProvenance).toEqual(USER_OVERRIDE);
    expect(profile?.activeRevision?.digest).toBe('sha256:legacy');
    expect(schemaVersion(store.database)).toBe(16);
  });

  it('accepts an explicit-column insert from an older runner after the upgrade, with default provenance', () => {
    const { store } = open();
    const principalId = store.resolvePrincipal({ kind: 'owner', ownerId: 'rollback-owner' });
    const { credentialId } = seedLegacy(store.database, principalId);
    const repo = new ModelProfileStateRepository(store.database, keyring());

    const rolledBackRevision = `rev_${randomBytes(16).toString('hex')}`;
    insertLegacyRevision(store.database, principalId, rolledBackRevision, credentialId);
    store.database.prepare('UPDATE agent_model_profiles SET active_revision_id = ? WHERE id = ?').run(rolledBackRevision, 'legacy');

    const row = store.database.prepare(`
      SELECT cache_read_micros_per_million, cache_write_micros_per_million, price_tiers_json,
             price_source, price_source_model_id, price_retrieved_at, price_confidence, price_is_override
      FROM agent_model_profile_revisions WHERE id = ?
    `).get(rolledBackRevision);
    expect(row).toEqual({
      cache_read_micros_per_million: null,
      cache_write_micros_per_million: null,
      price_tiers_json: null,
      price_source: 'user',
      price_source_model_id: null,
      price_retrieved_at: null,
      price_confidence: 'unknown',
      price_is_override: 1
    });
    expect(repo.listProfiles(principalId)[0]?.activeRevision?.priceProvenance).toEqual(USER_OVERRIDE);
  });

  it('adds all of the columns or none of them', () => {
    const { store } = open();
    const database = store.database;
    let alters = 0;
    // Fails the fourth column addition, as a crash or a full disk would mid-upgrade.
    const failing = new Proxy(database, {
      get(target, property) {
        if (property === 'exec') {
          return (sql: string) => {
            if (sql.startsWith('ALTER TABLE') && ++alters === 4) throw new Error('simulated failure');
            return target.exec(sql);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    // The proxy forwards every DatabaseSync member, intercepting only exec.
    expect(() => initializeModelProfilePricingColumns(failing as DatabaseSync)).toThrow('simulated failure');
    expect(revisionColumns(database).filter((column) => PRICING_COLUMNS.includes(column))).toEqual([]);
    expect(database.prepare('SELECT 1 AS ok').get()).toEqual({ ok: 1 });

    initializeModelProfilePricingColumns(database);
    expect(revisionColumns(database).filter((column) => PRICING_COLUMNS.includes(column))).toHaveLength(PRICING_COLUMNS.length);
  });

  it('rejects provenance values outside the allowed sets', () => {
    const { store } = open();
    const principalId = store.resolvePrincipal({ kind: 'owner', ownerId: 'check-owner' });
    const { revisionId } = seedLegacy(store.database, principalId);
    new ModelProfileStateRepository(store.database, keyring());
    const update = (assignment: string) => () => store.database.prepare(`UPDATE agent_model_profile_revisions SET ${assignment} WHERE id = ?`).run(revisionId);
    expect(update("price_source = 'catalog'")).toThrow();
    expect(update("price_confidence = 'guess'")).toThrow();
    expect(update('price_is_override = 2')).toThrow();
    expect(update("price_source = 'openrouter', price_confidence = 'exact', price_is_override = 0")).not.toThrow();
  });

  it('keeps the v13 downgrade and the later re-upgrade working with the columns present', () => {
    const { store, path } = open();
    const principalId = store.resolvePrincipal({ kind: 'owner', ownerId: 'downgrade-owner' });
    const repo = new ModelProfileStateRepository(store.database, keyring());
    const credential = repo.createCredential(principalId, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-downgrade' });
    const created = repo.createProfile(principalId, {
      profileId: ModelProfileIdSchema.parse('downgrade'),
      displayName: 'Downgrade',
      credentialId: credential.id,
      model: 'gpt-5',
      apiMode: 'chat-completions',
      pricing: { inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000, cacheReadMicrosPerMillionTokens: 100 },
      limits: { maxInputTokens: 1000, maxOutputTokens: 100, maxCostMicros: 1000 },
      maxProxyOperations: ['files_read']
    });

    downgradeStateSchemaToV13(store.database);
    expect(schemaVersion(store.database)).toBe(13);
    store.close();

    const reopened = open(path).store;
    expect(schemaVersion(reopened.database)).toBe(16);
    const reopenedRepo = new ModelProfileStateRepository(reopened.database, keyring());
    expect(reopenedRepo.listProfiles(principalId)[0]?.activeRevision).toEqual(created.activeRevision);
  });
});
