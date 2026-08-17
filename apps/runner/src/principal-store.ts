import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  RunnerPrincipalSelectorSchema,
  type ExternalPrincipal,
  type RunnerPrincipalSelector
} from '@cloud-harness/contracts';

export type ExternalPrincipalSelector = ExternalPrincipal & { kind: 'external' };
export type PrincipalSelector = RunnerPrincipalSelector;

export type PrincipalRecord = {
  id: string;
  issuer: string;
  subject: string;
  email: string | null;
  name: string | null;
  legacyOwnerId: string | null;
};

export type PrincipalRelinkMapping = {
  oldIssuer: string;
  oldSubject: string;
  newIssuer: string;
  newSubject: string;
};

export type PrincipalRelinkResult = PrincipalRelinkMapping & {
  principalId: string;
  status: 'applied' | 'already-applied';
};

type PrincipalRow = {
  id: string;
  issuer: string;
  subject: string;
  email: string | null;
  name: string | null;
  legacy_owner_id: string | null;
};

type PrincipalRelinkRow = {
  old_issuer: string;
  old_subject: string;
  new_issuer: string;
  new_subject: string;
  principal_id: string;
};

const fromRow = (row: PrincipalRow): PrincipalRecord => ({
  id: row.id,
  issuer: row.issuer,
  subject: row.subject,
  email: row.email,
  name: row.name,
  legacyOwnerId: row.legacy_owner_id
});

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

export function migratePrincipalSchema(database: DatabaseSync): void {
  const rows = database.prepare('SELECT version FROM schema_meta').all() as { version: number }[];
  if (rows.length !== 1) throw new Error('invalid state schema metadata');
  if (rows[0]!.version === 1) {
    transaction(database, () => {
      database.exec(`
        CREATE TABLE principals (
          id TEXT PRIMARY KEY,
          issuer TEXT NOT NULL,
          subject TEXT NOT NULL,
          email TEXT,
          name TEXT,
          legacy_owner_id TEXT UNIQUE,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(issuer, subject)
        );
        UPDATE schema_meta SET version = 2;
      `);
    });
  }
  const version = (database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version;
  if (version === 2) {
    transaction(database, () => {
      database.exec(`
        CREATE TABLE principal_relinks (
          old_issuer TEXT NOT NULL,
          old_subject TEXT NOT NULL,
          new_issuer TEXT NOT NULL,
          new_subject TEXT NOT NULL,
          principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
          applied_at INTEGER NOT NULL,
          PRIMARY KEY(old_issuer, old_subject),
          UNIQUE(new_issuer, new_subject)
        );
        UPDATE schema_meta SET version = 3;
      `);
    });
    return;
  }
  if (version !== 3) throw new Error(`unsupported state schema version ${version}`);
}

export function applyPrincipalRelinks(
  database: DatabaseSync,
  mappings: PrincipalRelinkMapping[],
  onApplied?: (database: DatabaseSync, result: PrincipalRelinkResult) => void
): PrincipalRelinkResult[] {
  return transaction(database, () => mappings.map((mapping) => {
    const result = applyPrincipalRelinkInTransaction(database, mapping);
    if (result.status === 'applied') onApplied?.(database, result);
    return result;
  }));
}

function applyPrincipalRelinkInTransaction(
  database: DatabaseSync,
  mapping: PrincipalRelinkMapping
): PrincipalRelinkResult {
  const prior = database.prepare('SELECT * FROM principal_relinks WHERE old_issuer = ? AND old_subject = ?')
    .get(mapping.oldIssuer, mapping.oldSubject) as PrincipalRelinkRow | undefined;
  if (prior) {
    if (prior.new_issuer !== mapping.newIssuer || prior.new_subject !== mapping.newSubject) {
      throw new Error('principal relink source was already mapped to a different target');
    }
    if (!database.prepare('SELECT 1 FROM principals WHERE id = ?').get(prior.principal_id)) {
      throw new Error('principal relink ledger references a missing principal');
    }
    return { ...mapping, principalId: prior.principal_id, status: 'already-applied' };
  }

  const source = principalByExternalIdentity(database, { issuer: mapping.oldIssuer, subject: mapping.oldSubject });
  if (!source) throw new Error('principal relink source identity does not exist');
  if (principalByExternalIdentity(database, { issuer: mapping.newIssuer, subject: mapping.newSubject })) {
    throw new Error('principal relink target identity already exists');
  }

  const now = Date.now();
  database.prepare('UPDATE principals SET issuer = ?, subject = ?, updated_at = ? WHERE id = ?')
    .run(mapping.newIssuer, mapping.newSubject, now, source.id);
  database.prepare(`INSERT INTO principal_relinks
    (old_issuer, old_subject, new_issuer, new_subject, principal_id, applied_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    mapping.oldIssuer, mapping.oldSubject, mapping.newIssuer, mapping.newSubject, source.id, now
  );
  return { ...mapping, principalId: source.id, status: 'applied' };
}

export function principalByExternalIdentity(
  database: DatabaseSync,
  selector: Pick<ExternalPrincipalSelector, 'issuer' | 'subject'>
): PrincipalRecord | undefined {
  const row = database.prepare('SELECT * FROM principals WHERE issuer = ? AND subject = ?')
    .get(selector.issuer, selector.subject) as PrincipalRow | undefined;
  return row ? fromRow(row) : undefined;
}

export function principalByLegacyOwnerId(database: DatabaseSync, legacyOwnerId: string): PrincipalRecord | undefined {
  const row = database.prepare('SELECT * FROM principals WHERE legacy_owner_id = ?')
    .get(legacyOwnerId) as PrincipalRow | undefined;
  return row ? fromRow(row) : undefined;
}

export function resolveExternalPrincipal(
  database: DatabaseSync,
  selector: ExternalPrincipalSelector,
  options: { legacyOwnerId?: string } = {}
): string {
  const parsed = RunnerPrincipalSelectorSchema.parse(selector) as ExternalPrincipalSelector;
  const legacyOwnerId = options.legacyOwnerId;
  if (legacyOwnerId !== undefined && (!legacyOwnerId || legacyOwnerId.length > 100)) throw new Error('invalid legacy owner mapping');

  return transaction(database, () => resolveExternalPrincipalInTransaction(database, parsed, legacyOwnerId));
}

function resolveExternalPrincipalInTransaction(
  database: DatabaseSync,
  selector: ExternalPrincipalSelector,
  legacyOwnerId?: string
): string {
  const existing = principalByExternalIdentity(database, selector);
  if (legacyOwnerId !== undefined && existing?.legacyOwnerId && existing.legacyOwnerId !== legacyOwnerId) {
    throw new Error('external identity is already mapped to a different legacy owner');
  }
  const now = Date.now();
  if (existing) {
    database.prepare(`UPDATE principals
      SET email = COALESCE(?, email), name = COALESCE(?, name), updated_at = ?
      WHERE id = ?`).run(selector.email ?? null, selector.name ?? null, now, existing.id);
    if (legacyOwnerId && !existing.legacyOwnerId) {
      database.prepare('UPDATE principals SET legacy_owner_id = ?, updated_at = ? WHERE id = ?')
        .run(legacyOwnerId, now, existing.id);
      database.prepare('UPDATE workspaces SET owner_id = ? WHERE owner_id = ?').run(existing.id, legacyOwnerId);
    }
    return existing.id;
  }

  const principalId = `prn_${randomBytes(24).toString('base64url')}`;
  database.prepare(`INSERT INTO principals
    (id, issuer, subject, email, name, legacy_owner_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    principalId, selector.issuer, selector.subject, selector.email ?? null, selector.name ?? null,
    legacyOwnerId ?? null, now, now
  );
  if (legacyOwnerId) database.prepare('UPDATE workspaces SET owner_id = ? WHERE owner_id = ?').run(principalId, legacyOwnerId);
  return principalId;
}

export function applyLegacyPrincipalMapping(
  database: DatabaseSync,
  mapping: { legacyOwnerId: string; issuer: string; subject: string }
): string {
  const selector = RunnerPrincipalSelectorSchema.parse({
    kind: 'external', issuer: mapping.issuer, subject: mapping.subject
  }) as ExternalPrincipalSelector;
  if (!mapping.legacyOwnerId || mapping.legacyOwnerId.length > 100) throw new Error('invalid legacy owner mapping');
  return transaction(database, () => {
    const principalId = resolveExternalPrincipalInTransaction(database, selector, mapping.legacyOwnerId);
    const unmapped = database.prepare(`SELECT 1
      FROM workspaces
      LEFT JOIN principals ON principals.id = workspaces.owner_id
      WHERE principals.id IS NULL
      LIMIT 1`).get();
    if (unmapped) throw new Error('unmapped legacy workspace owners remain');
    return principalId;
  });
}
