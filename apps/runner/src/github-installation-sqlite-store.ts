import type { DatabaseSync } from 'node:sqlite';
import { HarnessError } from '@cloud-harness/contracts';
import type {
  GitHubInstallationRecord,
  GitHubInstallationMutationAudit,
  GitHubInstallationStore,
  GitHubRepositoryGrantRecord,
  VerifiedGitHubInstallation
} from './github-installation-store.js';

type InstallationRow = {
  principal_id: string; app_id: string; installation_id: string; account_id: string; account_login: string;
  status: GitHubInstallationRecord['status']; generation: number; created_at: number; updated_at: number; checked_at: number;
};
type GrantRow = {
  principal_id: string; installation_id: string; owner: string; repository: string;
  contents: GitHubRepositoryGrantRecord['contents']; status: GitHubRepositoryGrantRecord['status'];
  generation: number; created_at: number; updated_at: number; checked_at: number;
};

const installation = (row: InstallationRow): GitHubInstallationRecord => ({
  principalId: row.principal_id, appId: row.app_id, installationId: row.installation_id,
  accountId: row.account_id, accountLogin: row.account_login, status: row.status,
  generation: row.generation, createdAt: row.created_at, updatedAt: row.updated_at, checkedAt: row.checked_at
});
const grant = (row: GrantRow): GitHubRepositoryGrantRecord => ({
  principalId: row.principal_id, installationId: row.installation_id, owner: row.owner,
  repository: row.repository, contents: row.contents, status: row.status, generation: row.generation,
  createdAt: row.created_at, updatedAt: row.updated_at, checkedAt: row.checked_at
});

export function migrateGitHubInstallationSchema(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    const tableExists = database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='github_installations'"
    ).get() as { name: string } | undefined;

    if (tableExists) {
      const columns = database.prepare("PRAGMA table_info(github_installations)").all() as Array<{ name: string; pk: number }>;
      const principalPk = columns.find((c) => c.name === 'principal_id')?.pk ?? 0;
      const installationPk = columns.find((c) => c.name === 'installation_id')?.pk ?? 0;

      if (principalPk === 1 && installationPk === 0) {
        database.exec(`
          CREATE TABLE IF NOT EXISTS github_installations_v2 (
            principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
            app_id TEXT NOT NULL, installation_id TEXT NOT NULL, account_id TEXT NOT NULL, account_login TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active','suspended','uninstalled')),
            generation INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, checked_at INTEGER NOT NULL,
            PRIMARY KEY(principal_id, installation_id)
          );
          INSERT OR IGNORE INTO github_installations_v2
            (principal_id, app_id, installation_id, account_id, account_login, status, generation, created_at, updated_at, checked_at)
            SELECT principal_id, app_id, installation_id, account_id, account_login, status, generation, created_at, updated_at, checked_at
            FROM github_installations;
          DROP TABLE github_installations;
          ALTER TABLE github_installations_v2 RENAME TO github_installations;
        `);
      }
    } else {
      database.exec(`
        CREATE TABLE IF NOT EXISTS github_installations (
          principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
          app_id TEXT NOT NULL, installation_id TEXT NOT NULL, account_id TEXT NOT NULL, account_login TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active','suspended','uninstalled')),
          generation INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, checked_at INTEGER NOT NULL,
          PRIMARY KEY(principal_id, installation_id)
        );
      `);
    }

    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS github_installations_principal_account
        ON github_installations(principal_id, account_id);
      CREATE UNIQUE INDEX IF NOT EXISTS github_installations_installation_identity
        ON github_installations(installation_id);
      CREATE TABLE IF NOT EXISTS github_repository_grants (
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        installation_id TEXT NOT NULL, owner TEXT NOT NULL, repository TEXT NOT NULL,
        contents TEXT NOT NULL CHECK(contents IN ('read','write')),
        status TEXT NOT NULL CHECK(status IN ('granted','removed')),
        generation INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, checked_at INTEGER NOT NULL,
        PRIMARY KEY(principal_id, owner, repository)
      );
      CREATE INDEX IF NOT EXISTS github_repository_grants_principal_status
        ON github_repository_grants(principal_id, status, owner, repository);
      CREATE INDEX IF NOT EXISTS github_repository_grants_principal_installation
        ON github_repository_grants(principal_id, installation_id);
    `);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export class SqliteGitHubInstallationStore implements GitHubInstallationStore {
  constructor(private readonly database: DatabaseSync) { migrateGitHubInstallationSchema(database); }

  replaceVerified(
    principalId: string,
    verified: VerifiedGitHubInstallation,
    checkedAt: number,
    audit?: GitHubInstallationMutationAudit
  ): GitHubInstallationRecord {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const installationId = String(verified.installationId);
      const duplicate = this.database.prepare(
        'SELECT principal_id FROM github_installations WHERE installation_id=? AND principal_id<>?'
      ).get(installationId, principalId) as { principal_id: string } | undefined;
      if (duplicate) throw new HarnessError('CONFLICT', 'GitHub installation is already bound', 409, false);

      const accountId = String(verified.accountId);
      const sameAccount = this.database.prepare(
        'SELECT installation_id FROM github_installations WHERE principal_id=? AND account_id=? AND installation_id<>?'
      ).get(principalId, accountId, installationId) as { installation_id: string } | undefined;
      if (sameAccount) {
        this.database.prepare(
          'DELETE FROM github_installations WHERE principal_id=? AND installation_id=?'
        ).run(principalId, sameAccount.installation_id);
        this.database.prepare(
          `UPDATE github_repository_grants SET status='removed',generation=generation+1,updated_at=?,checked_at=?
           WHERE principal_id=? AND installation_id=? AND status<>'removed'`
        ).run(checkedAt, checkedAt, principalId, sameAccount.installation_id);
      }
      const prior = this.getInstallation(principalId, installationId);
      const record: GitHubInstallationRecord = {
        principalId, appId: String(verified.appId), installationId,
        accountId, accountLogin: verified.accountLogin, status: verified.status,
        generation: (prior?.generation ?? 0) + 1, createdAt: prior?.createdAt ?? checkedAt,
        updatedAt: checkedAt, checkedAt
      };
      this.database.prepare(`INSERT INTO github_installations
        (principal_id,app_id,installation_id,account_id,account_login,status,generation,created_at,updated_at,checked_at)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(principal_id, installation_id) DO UPDATE SET
        app_id=excluded.app_id,account_id=excluded.account_id,account_login=excluded.account_login,
        status=excluded.status,generation=excluded.generation,updated_at=excluded.updated_at,checked_at=excluded.checked_at`)
        .run(principalId, record.appId, record.installationId, record.accountId, record.accountLogin, record.status,
          record.generation, record.createdAt, record.updatedAt, record.checkedAt);

      const current = new Set<string>();
      if (verified.status === 'active') {
        for (const repository of verified.repositories) {
          const owner = repository.owner.toLowerCase();
          const name = repository.repository.toLowerCase();
          current.add(`${owner}\0${name}`);
          const previous = this.getRepositoryGrant(principalId, owner, name);
          this.database.prepare(`INSERT INTO github_repository_grants
            (principal_id,installation_id,owner,repository,contents,status,generation,created_at,updated_at,checked_at)
            VALUES (?,?,?,?,?,'granted',?,?,?,?) ON CONFLICT(principal_id,owner,repository) DO UPDATE SET
            installation_id=excluded.installation_id,contents=excluded.contents,status='granted',generation=excluded.generation,
            updated_at=excluded.updated_at,checked_at=excluded.checked_at`)
            .run(principalId, record.installationId, owner, name, repository.contents,
              (previous?.generation ?? 0) + 1, previous?.createdAt ?? checkedAt, checkedAt, checkedAt);
        }
      }

      const existingGrants = this.listRepositoryGrants(principalId, record.installationId);
      for (const existing of existingGrants) {
        if (existing.status !== 'removed' && !current.has(`${existing.owner}\0${existing.repository}`)) {
          this.database.prepare(`UPDATE github_repository_grants SET status='removed',generation=generation+1,updated_at=?,checked_at=?
            WHERE principal_id=? AND installation_id=? AND owner=? AND repository=?`)
            .run(checkedAt, checkedAt, principalId, record.installationId, existing.owner, existing.repository);
        }
      }
      audit?.(record);
      this.database.exec('COMMIT');
      return record;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  markUninstalled(
    principalId: string,
    installationId: string | number,
    checkedAt: number,
    audit?: GitHubInstallationMutationAudit
  ): GitHubInstallationRecord | undefined {
    const current = this.getInstallation(principalId, installationId);
    if (!current) return undefined;
    return this.replaceVerified(principalId, {
      appId: current.appId,
      installationId: current.installationId,
      accountId: current.accountId,
      accountLogin: current.accountLogin,
      status: 'uninstalled',
      repositories: []
    }, checkedAt, audit);
  }

  removeInstallation(
    principalId: string,
    installationId: string | number,
    checkedAt: number,
    audit?: GitHubInstallationMutationAudit
  ): boolean {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const id = String(installationId);
      const current = this.getInstallation(principalId, id);
      if (!current) {
        this.database.exec('ROLLBACK');
        return false;
      }
      this.database.prepare('DELETE FROM github_installations WHERE principal_id=? AND installation_id=?')
        .run(principalId, id);
      this.database.prepare(`UPDATE github_repository_grants SET status='removed',generation=generation+1,updated_at=?,checked_at=?
        WHERE principal_id=? AND installation_id=? AND status<>'removed'`)
        .run(checkedAt, checkedAt, principalId, id);
      audit?.(current);
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getInstallation(principalId: string, installationId?: string | number): GitHubInstallationRecord | undefined {
    if (installationId !== undefined) {
      const row = this.database.prepare(
        'SELECT * FROM github_installations WHERE principal_id=? AND installation_id=?'
      ).get(principalId, String(installationId)) as InstallationRow | undefined;
      return row ? installation(row) : undefined;
    }
    const row = this.database.prepare(
      "SELECT * FROM github_installations WHERE principal_id=? ORDER BY (CASE status WHEN 'active' THEN 0 WHEN 'suspended' THEN 1 ELSE 2 END), created_at ASC LIMIT 1"
    ).get(principalId) as InstallationRow | undefined;
    return row ? installation(row) : undefined;
  }

  listInstallations(principalId: string): GitHubInstallationRecord[] {
    const rows = this.database.prepare(
      'SELECT * FROM github_installations WHERE principal_id=? ORDER BY created_at ASC'
    ).all(principalId) as InstallationRow[];
    return rows.map(installation);
  }

  getRepositoryGrant(principalId: string, owner: string, repository: string): GitHubRepositoryGrantRecord | undefined {
    const row = this.database.prepare('SELECT * FROM github_repository_grants WHERE principal_id=? AND owner=? AND repository=?')
      .get(principalId, owner.toLowerCase(), repository.toLowerCase()) as GrantRow | undefined;
    return row ? grant(row) : undefined;
  }

  listRepositoryGrants(principalId: string, installationId?: string | number): GitHubRepositoryGrantRecord[] {
    if (installationId !== undefined) {
      return (this.database.prepare('SELECT * FROM github_repository_grants WHERE principal_id=? AND installation_id=? ORDER BY owner,repository')
        .all(principalId, String(installationId)) as GrantRow[]).map(grant);
    }
    return (this.database.prepare('SELECT * FROM github_repository_grants WHERE principal_id=? ORDER BY owner,repository')
      .all(principalId) as GrantRow[]).map(grant);
  }
}
