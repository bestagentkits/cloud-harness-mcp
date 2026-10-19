import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  AGENT_POLICY_LIMITS,
  GlobalExecutionPolicySchema,
  ProjectExecutionPolicySchema,
  type AgentPolicyRevision,
  type AgentPolicyRevisionSummary,
  type AgentPolicyScope,
  type GlobalExecutionPolicy,
  type ProjectExecutionPolicy
} from '@cloud-harness/contracts';
import { withEventSavepoint } from '../event-outbox.js';
import { canonicalJson, sha256 } from './policy-merge.js';
import { initializeAgentPolicySchema } from './policy-schema.js';

export class PolicyStoreError extends Error {
  constructor(readonly code: 'CONFLICT' | 'NOT_FOUND' | 'INTERNAL', message: string) {
    super(message);
  }
}

type RevisionRow = {
  revision_id: string;
  principal_id: string;
  scope: AgentPolicyScope;
  project_id: string;
  version: number;
  document_json: string;
  digest: string;
  created_at: number;
  created_by: 'owner';
  rollback_of: string | null;
  note: string | null;
};

type HeadRow = { principal_id: string; scope: AgentPolicyScope; project_id: string; revision_id: string; version: number; updated_at: number };

export type PolicyHeadSummary = { revisionId: string; version: number; digest: string; updatedAt: string };

const projectKey = (projectId: string | null) => projectId ?? '';
const iso = (epochMs: number) => new Date(epochMs).toISOString();

/**
 * Immutable policy revisions with a compare-and-swap head per (principal, scope, project).
 * Every method takes the principal explicitly; there is no query that crosses principals.
 * Writes run inside a savepoint so the caller can add its audit row to the same transaction.
 */
export class PolicyStore {
  constructor(readonly database: DatabaseSync, private readonly now: () => number = Date.now) {
    initializeAgentPolicySchema(database);
  }

  head(principalId: string, scope: AgentPolicyScope, projectId: string | null): AgentPolicyRevision | null {
    const row = this.database.prepare(`SELECT r.* FROM agent_policy_heads h
      JOIN agent_policy_revisions r ON r.revision_id = h.revision_id AND r.principal_id = h.principal_id
      WHERE h.principal_id = ? AND h.scope = ? AND h.project_id = ?`).get(principalId, scope, projectKey(projectId)) as RevisionRow | undefined;
    return row ? this.toRevision(row) : null;
  }

  headSummary(principalId: string, scope: AgentPolicyScope, projectId: string | null): PolicyHeadSummary | null {
    const row = this.database.prepare(`SELECT h.revision_id, h.version, h.updated_at, r.digest FROM agent_policy_heads h
      JOIN agent_policy_revisions r ON r.revision_id = h.revision_id
      WHERE h.principal_id = ? AND h.scope = ? AND h.project_id = ?`).get(principalId, scope, projectKey(projectId)) as
      { revision_id: string; version: number; updated_at: number; digest: string } | undefined;
    return row ? { revisionId: row.revision_id, version: row.version, digest: row.digest, updatedAt: iso(row.updated_at) } : null;
  }

  /** Project heads of one principal, most recently changed first, at most limit of them. */
  projectHeads(principalId: string, limit = 1_000): Array<{ projectId: string; head: PolicyHeadSummary }> {
    const rows = this.database.prepare(`SELECT h.project_id, h.revision_id, h.version, h.updated_at, r.digest FROM agent_policy_heads h
      JOIN agent_policy_revisions r ON r.revision_id = h.revision_id
      WHERE h.principal_id = ? AND h.scope = 'project' ORDER BY h.updated_at DESC, h.project_id LIMIT ?`).all(principalId, limit) as
      Array<{ project_id: string; revision_id: string; version: number; updated_at: number; digest: string }>;
    return rows.map((row) => ({ projectId: row.project_id, head: { revisionId: row.revision_id, version: row.version, digest: row.digest, updatedAt: iso(row.updated_at) } }));
  }

  revision(principalId: string, revisionId: string): AgentPolicyRevision | null {
    const row = this.database.prepare('SELECT * FROM agent_policy_revisions WHERE principal_id = ? AND revision_id = ?')
      .get(principalId, revisionId) as RevisionRow | undefined;
    return row ? this.toRevision(row) : null;
  }

  history(principalId: string, scope: AgentPolicyScope, projectId: string | null, beforeVersion: number | undefined, limit: number): { revisions: AgentPolicyRevisionSummary[]; nextBeforeVersion: number | null } {
    const rows = this.database.prepare(`SELECT * FROM agent_policy_revisions
      WHERE principal_id = ? AND scope = ? AND project_id = ? AND version < ?
      ORDER BY version DESC LIMIT ?`).all(principalId, scope, projectKey(projectId), beforeVersion ?? Number.MAX_SAFE_INTEGER, limit + 1) as RevisionRow[];
    const page = rows.slice(0, limit);
    return {
      revisions: page.map((row) => this.toSummary(row)),
      nextBeforeVersion: rows.length > limit ? (page.at(-1)?.version ?? null) : null
    };
  }

  /**
   * Appends a revision and moves the head. `expectedVersion` is 0 when no head exists, otherwise the
   * current head version; anything else is a CONFLICT. The caller has already validated `document`.
   */
  put(
    principalId: string,
    scope: AgentPolicyScope,
    projectId: string | null,
    document: GlobalExecutionPolicy | ProjectExecutionPolicy,
    expectedVersion: number,
    options: { rollbackOf?: string | null; note?: string | null } = {}
  ): AgentPolicyRevision {
    if ((scope === 'project') !== (projectId !== null)) throw new PolicyStoreError('INTERNAL', 'scope and project do not agree');
    return withEventSavepoint(this.database, () => {
      const key = projectKey(projectId);
      const head = this.database.prepare('SELECT * FROM agent_policy_heads WHERE principal_id = ? AND scope = ? AND project_id = ?')
        .get(principalId, scope, key) as HeadRow | undefined;
      if ((head?.version ?? 0) !== expectedVersion) throw new PolicyStoreError('CONFLICT', 'the policy changed; reload and retry');
      const latest = this.database.prepare('SELECT MAX(version) AS version FROM agent_policy_revisions WHERE principal_id = ? AND scope = ? AND project_id = ?')
        .get(principalId, scope, key) as { version: number | null };
      const version = Math.max(latest.version ?? 0, head?.version ?? 0) + 1;
      const json = canonicalJson(document);
      const revisionId = `apr_${randomBytes(16).toString('hex')}`;
      const now = this.now();
      this.database.prepare(`INSERT INTO agent_policy_revisions
        (revision_id, principal_id, scope, project_id, version, document_json, digest, created_at, created_by, rollback_of, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'owner', ?, ?)`)
        .run(revisionId, principalId, scope, key, version, json, sha256(json), now, options.rollbackOf ?? null, options.note ?? null);
      this.database.prepare(`INSERT INTO agent_policy_heads (principal_id, scope, project_id, revision_id, version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(principal_id, scope, project_id) DO UPDATE SET revision_id = excluded.revision_id, version = excluded.version, updated_at = excluded.updated_at`)
        .run(principalId, scope, key, revisionId, version, now);
      this.prune(principalId, scope, key, revisionId);
      const stored = this.revision(principalId, revisionId);
      if (!stored) throw new PolicyStoreError('INTERNAL', 'stored revision could not be read back');
      return stored;
    });
  }

  /** Removes a project head (the project falls back to the global policy). Revisions stay for history. */
  deleteProjectHead(principalId: string, projectId: string, expectedVersion: number): void {
    withEventSavepoint(this.database, () => {
      const result = this.database.prepare("DELETE FROM agent_policy_heads WHERE principal_id = ? AND scope = 'project' AND project_id = ? AND version = ?")
        .run(principalId, projectId, expectedVersion);
      if (result.changes === 1) return;
      const exists = this.database.prepare("SELECT 1 FROM agent_policy_heads WHERE principal_id = ? AND scope = 'project' AND project_id = ?").get(principalId, projectId);
      throw exists ? new PolicyStoreError('CONFLICT', 'the policy changed; reload and retry') : new PolicyStoreError('NOT_FOUND', 'the project has no policy');
    });
  }

  /** Keeps the newest revisions per scope; the head is never pruned. */
  private prune(principalId: string, scope: AgentPolicyScope, key: string, headRevisionId: string): void {
    this.database.prepare(`DELETE FROM agent_policy_revisions
      WHERE principal_id = ? AND scope = ? AND project_id = ? AND revision_id <> ?
        AND revision_id NOT IN (
          SELECT revision_id FROM agent_policy_revisions WHERE principal_id = ? AND scope = ? AND project_id = ?
          ORDER BY version DESC LIMIT ?
        )`).run(principalId, scope, key, headRevisionId, principalId, scope, key, AGENT_POLICY_LIMITS.maxRevisionsPerScope);
  }

  private toSummary(row: RevisionRow): AgentPolicyRevisionSummary {
    return {
      revisionId: row.revision_id,
      scope: row.scope,
      projectId: row.scope === 'project' ? row.project_id : null,
      version: row.version,
      digest: row.digest,
      createdAt: iso(row.created_at),
      createdBy: row.created_by,
      rollbackOf: row.rollback_of,
      note: row.note
    };
  }

  /** Stored documents are re-validated on read; a row that no longer parses fails closed. */
  private toRevision(row: RevisionRow): AgentPolicyRevision {
    let raw: unknown;
    try {
      raw = JSON.parse(row.document_json);
    } catch {
      throw new PolicyStoreError('INTERNAL', 'a stored policy revision is unreadable');
    }
    const parsed = row.scope === 'global' ? GlobalExecutionPolicySchema.safeParse(raw) : ProjectExecutionPolicySchema.safeParse(raw);
    if (!parsed.success) throw new PolicyStoreError('INTERNAL', 'a stored policy revision is invalid');
    return { ...this.toSummary(row), document: parsed.data };
  }
}
