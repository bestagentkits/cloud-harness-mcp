import { createHash, randomBytes } from 'node:crypto';
import { KnowledgeSearchEngine, type SearchKnowledgeParams } from './knowledge-search-engine.js';
import { KnowledgeGraphService, type KnowledgeGraphQueryParams } from './knowledge-graph-service.js';
import type { KnowledgeSearchResultItem, KnowledgeGraphResult } from '@cloud-harness/contracts';
import type { DatabaseSync } from 'node:sqlite';
import type {
  JournalType,
  KnowledgeItem,
  KnowledgeKind,
  KnowledgeLink,
  KnowledgeRelation,
  KnowledgeScope,
  Provenance
} from '@cloud-harness/contracts';

export interface CreateKnowledgeItemParams {
  principalId: string;
  kind?: KnowledgeKind;
  scope?: KnowledgeScope;
  projectId?: string | null;
  workspaceId?: string | null;
  title: string;
  content: string;
  journalType?: JournalType | null;
  occurredAt?: number | null;
  tags?: string[];
  retentionSeconds?: number | null;
  expectedGeneration?: number;
  idempotencyKey?: string | null;
  provenance?: Provenance;
}

export interface UpdateKnowledgeItemParams {
  principalId: string;
  id: string;
  expectedGeneration: number;
  title?: string;
  content?: string;
  journalType?: JournalType | null;
  occurredAt?: number | null;
  tags?: string[];
  retentionSeconds?: number | null;
  provenance?: Provenance;
}

export interface DeleteKnowledgeItemParams {
  principalId: string;
  id: string;
  expectedGeneration: number;
}

export interface ListKnowledgeItemsParams {
  principalId: string;
  kind?: KnowledgeKind;
  scope?: KnowledgeScope;
  projectId?: string | null;
  workspaceId?: string | null;
  journalType?: JournalType | null;
  tags?: string[];
  tagMatch?: 'all' | 'any';
  since?: number;
  until?: number;
  limit?: number;
  cursor?: string;
}

export interface CreateKnowledgeLinkParams {
  principalId: string;
  sourceId: string;
  targetId: string;
  relation?: KnowledgeRelation;
  origin?: 'manual' | 'wikilink';
  expectedGeneration?: number;
}

export interface DeleteKnowledgeLinkParams {
  principalId: string;
  linkId?: string;
  sourceId?: string;
  targetId?: string;
  relation?: KnowledgeRelation;
  expectedGeneration?: number;
}

export interface KnowledgeItemWithLinks extends KnowledgeItem {
  outboundLinks: KnowledgeLink[];
  backlinks: KnowledgeLink[];
}

export class KnowledgeStore {
  readonly searchEngine: KnowledgeSearchEngine;
  readonly graphService: KnowledgeGraphService;

  constructor(readonly database: DatabaseSync) {
    this.searchEngine = new KnowledgeSearchEngine(database);
    this.graphService = new KnowledgeGraphService(database);
  }
  private extractWikilinkTargetIds(markdown: string): string[] {
    const matches = markdown.matchAll(/\[\[(kn_[A-Za-z0-9_-]{10,80})(?:\|[^\]]+)?\]\]/g);
    const ids = new Set<string>();
    for (const match of matches) {
      if (match[1]) ids.add(match[1]);
    }
    return Array.from(ids);
  }

  createItem(params: CreateKnowledgeItemParams): KnowledgeItem {
    if (params.expectedGeneration !== undefined && params.expectedGeneration !== 0) {
      throw new Error('expectedGeneration must be 0 for item creation');
    }
    const kind: KnowledgeKind = params.kind ?? 'memory';
    const scope: KnowledgeScope = params.scope ?? 'owner';
    const now = Date.now();
    const id = `kn_${randomBytes(12).toString('hex')}`;
    const content = params.content ?? '';
    const contentSha256 = createHash('sha256').update(content).digest('hex');
    const occurredAt = kind === 'journal' ? (params.occurredAt ?? now) : null;
    const journalType = kind === 'journal' ? (params.journalType ?? 'engineering-log') : null;
    const expiresAt = params.retentionSeconds ? now + params.retentionSeconds * 1000 : null;
    const provenance: Provenance = params.provenance ?? {
      source: scope === 'owner' ? 'owner' : scope === 'workspace' ? 'workspace' : 'repository',
      trust: 'owner-controlled',
      mutableBy: 'owner',
      contentSha256,
      discoveredAt: new Date(now).toISOString()
    };

    // Scope validation
    let projectId = params.projectId ?? null;
    let workspaceId = params.workspaceId ?? null;
    if (scope === 'owner') {
      projectId = null;
      workspaceId = null;
    } else if (scope === 'project') {
      if (!projectId) throw new Error('projectId is required for project-scoped knowledge');
      workspaceId = null;
    } else if (scope === 'workspace') {
      if (!workspaceId) throw new Error('workspaceId is required for workspace-scoped knowledge');
    }

    const cleanTags = Array.from(new Set((params.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)));

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO knowledge_items
        (id, principal_id, kind, scope, project_id, workspace_id, title, content, content_sha256, journal_type, occurred_at, generation, created_at, updated_at, expires_at, deleted_at, provenance_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, ?)
      `).run(
        id, params.principalId, kind, scope, projectId, workspaceId, params.title.trim(), content, contentSha256,
        journalType, occurredAt, now, now, expiresAt, JSON.stringify(provenance)
      );

      // Insert tags
      for (const tag of cleanTags) {
        this.database.prepare(`
          INSERT INTO knowledge_tags (principal_id, item_id, tag)
          VALUES (?, ?, ?)
        `).run(params.principalId, id, tag);
      }

      // Insert into FTS
      this.database.prepare(`
        INSERT INTO knowledge_fts (item_id, title, tags, content)
        VALUES (?, ?, ?, ?)
      `).run(id, params.title.trim(), cleanTags.join(' '), content);

      // Reconcile wikilinks
      const wikilinkTargetIds = this.extractWikilinkTargetIds(content);
      for (const targetId of wikilinkTargetIds) {
        if (targetId === id) continue;
        const targetRow = this.database.prepare(`
          SELECT id FROM knowledge_items
          WHERE id = ? AND principal_id = ? AND deleted_at IS NULL
        `).get(targetId, params.principalId);
        if (targetRow) {
          const linkId = `knl_${randomBytes(12).toString('hex')}`;
          this.database.prepare(`
            INSERT OR IGNORE INTO knowledge_links
            (id, principal_id, source_id, target_id, relation, origin, generation, created_at)
            VALUES (?, ?, ?, ?, 'references', 'wikilink', 1, ?)
          `).run(linkId, params.principalId, id, targetId, now);
        }
      }

      // Enqueue embedding indexing job
      this.database.prepare(`
        INSERT OR REPLACE INTO knowledge_index_jobs
        (principal_id, item_id, target_generation, content_sha256, state, attempts, error_message, created_at, updated_at)
        VALUES (?, ?, 1, ?, 'PENDING', 0, NULL, ?, ?)
      `).run(params.principalId, id, contentSha256, now, now);
      this.database.exec('COMMIT');
      try {
        this.searchEngine.indexItemChunks(params.principalId, id, 1, params.title.trim(), content);
      } catch {
        // Non-blocking index error
      }
      return {
        id,
        principalId: params.principalId,
        kind,
        scope,
        projectId,
        workspaceId,
        title: params.title.trim(),
        content,
        contentSha256,
        journalType,
        occurredAt,
        generation: 1,
        createdAt: now,
        updatedAt: now,
        expiresAt,
        deletedAt: null,
        tags: cleanTags,
        provenance
      };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  readItem(params: { principalId: string; id: string; includeLinks?: boolean }): KnowledgeItemWithLinks | null {
    const now = Date.now();
    interface ItemRow {
      id: string;
      principal_id: string;
      kind: KnowledgeKind;
      scope: KnowledgeScope;
      project_id: string | null;
      workspace_id: string | null;
      title: string;
      content: string;
      content_sha256: string;
      journal_type: JournalType | null;
      occurred_at: number | null;
      generation: number;
      created_at: number;
      updated_at: number;
      expires_at: number | null;
      deleted_at: number | null;
      provenance_json: string;
    }

    const row = this.database.prepare(`
      SELECT * FROM knowledge_items
      WHERE id = ? AND principal_id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
    `).get(params.id, params.principalId, now) as unknown as ItemRow | undefined;

    if (!row) return null;

    const tagRows = this.database.prepare(`
      SELECT tag FROM knowledge_tags
      WHERE principal_id = ? AND item_id = ?
    `).all(params.principalId, row.id) as unknown as { tag: string }[];

    interface LinkRow {
      id: string;
      principal_id: string;
      source_id: string;
      target_id: string;
      relation: KnowledgeRelation;
      origin: 'manual' | 'wikilink';
      generation: number;
      created_at: number;
    }

    const outboundRows = this.database.prepare(`
      SELECT * FROM knowledge_links
      WHERE principal_id = ? AND source_id = ?
    `).all(params.principalId, row.id) as unknown as LinkRow[];

    const backlinkRows = this.database.prepare(`
      SELECT * FROM knowledge_links
      WHERE principal_id = ? AND target_id = ?
    `).all(params.principalId, row.id) as unknown as LinkRow[];

    const outboundLinks: KnowledgeLink[] = outboundRows.map((l) => ({
      id: l.id,
      principalId: l.principal_id,
      sourceId: l.source_id,
      targetId: l.target_id,
      relation: l.relation,
      origin: l.origin,
      createdAt: l.created_at,
      generation: l.generation
    }));

    const backlinks: KnowledgeLink[] = backlinkRows.map((l) => ({
      id: l.id,
      principalId: l.principal_id,
      sourceId: l.source_id,
      targetId: l.target_id,
      relation: l.relation,
      origin: l.origin,
      createdAt: l.created_at,
      generation: l.generation
    }));

    return {
      id: row.id,
      principalId: row.principal_id,
      kind: row.kind,
      scope: row.scope,
      projectId: row.project_id,
      workspaceId: row.workspace_id,
      title: row.title,
      content: row.content,
      contentSha256: row.content_sha256,
      journalType: row.journal_type,
      occurredAt: row.occurred_at,
      generation: row.generation,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      deletedAt: row.deleted_at,
      tags: tagRows.map((t) => t.tag),
      provenance: JSON.parse(row.provenance_json) as Provenance,
      outboundLinks,
      backlinks
    };
  }

  updateItem(params: UpdateKnowledgeItemParams): { success: true; item: KnowledgeItem } | { success: false; conflict: { currentGeneration: number; currentContent: string; currentTitle: string; updatedAt: number } } {
    const now = Date.now();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      interface ExistingRow {
        id: string;
        principal_id: string;
        kind: KnowledgeKind;
        scope: KnowledgeScope;
        project_id: string | null;
        workspace_id: string | null;
        title: string;
        content: string;
        content_sha256: string;
        journal_type: JournalType | null;
        occurred_at: number | null;
        generation: number;
        created_at: number;
        updated_at: number;
        expires_at: number | null;
        provenance_json: string;
      }

      const existing = this.database.prepare(`
        SELECT * FROM knowledge_items
        WHERE id = ? AND principal_id = ? AND deleted_at IS NULL
      `).get(params.id, params.principalId) as unknown as ExistingRow | undefined;

      if (!existing) {
        this.database.exec('ROLLBACK');
        throw new Error('knowledge item not found');
      }

      if (existing.generation !== params.expectedGeneration) {
        this.database.exec('ROLLBACK');
        return {
          success: false,
          conflict: {
            currentGeneration: existing.generation,
            currentContent: existing.content,
            currentTitle: existing.title,
            updatedAt: existing.updated_at
          }
        };
      }

      const nextGeneration = existing.generation + 1;
      const title = params.title !== undefined ? params.title.trim() : existing.title;
      const content = params.content !== undefined ? params.content : existing.content;
      const contentSha256 = createHash('sha256').update(content).digest('hex');
      const journalType = existing.kind === 'journal' ? (params.journalType !== undefined ? params.journalType : existing.journal_type) : null;
      const occurredAt = existing.kind === 'journal' ? (params.occurredAt !== undefined ? params.occurredAt : existing.occurred_at) : null;
      const expiresAt = params.retentionSeconds !== undefined ? (params.retentionSeconds ? now + params.retentionSeconds * 1000 : null) : existing.expires_at;
      const provenance = params.provenance ? JSON.stringify(params.provenance) : existing.provenance_json;

      this.database.prepare(`
        UPDATE knowledge_items
        SET title = ?, content = ?, content_sha256 = ?, journal_type = ?, occurred_at = ?, generation = ?, updated_at = ?, expires_at = ?, provenance_json = ?
        WHERE id = ? AND principal_id = ? AND generation = ?
      `).run(title, content, contentSha256, journalType, occurredAt, nextGeneration, now, expiresAt, provenance, existing.id, params.principalId, existing.generation);

      // Synchronize tags if provided
      let currentTags: string[];
      if (params.tags !== undefined) {
        currentTags = Array.from(new Set(params.tags.map((t) => t.trim().toLowerCase()).filter(Boolean)));
        this.database.prepare('DELETE FROM knowledge_tags WHERE principal_id = ? AND item_id = ?').run(params.principalId, existing.id);
        for (const tag of currentTags) {
          this.database.prepare('INSERT INTO knowledge_tags (principal_id, item_id, tag) VALUES (?, ?, ?)').run(params.principalId, existing.id, tag);
        }
      } else {
        const tagRows = this.database.prepare('SELECT tag FROM knowledge_tags WHERE principal_id = ? AND item_id = ?').all(params.principalId, existing.id) as unknown as { tag: string }[];
        currentTags = tagRows.map((t) => t.tag);
      }

      // Update FTS
      this.database.prepare('DELETE FROM knowledge_fts WHERE item_id = ?').run(existing.id);
      this.database.prepare('INSERT INTO knowledge_fts (item_id, title, tags, content) VALUES (?, ?, ?, ?)').run(existing.id, title, currentTags.join(' '), content);

      // Reconcile wikilinks: remove old wikilink edges and add new
      this.database.prepare("DELETE FROM knowledge_links WHERE principal_id = ? AND source_id = ? AND origin = 'wikilink'").run(params.principalId, existing.id);
      const targetIds = this.extractWikilinkTargetIds(content);
      for (const targetId of targetIds) {
        if (targetId === existing.id) continue;
        const targetRow = this.database.prepare(`
          SELECT id FROM knowledge_items
          WHERE id = ? AND principal_id = ? AND deleted_at IS NULL
        `).get(targetId, params.principalId);
        if (targetRow) {
          const linkId = `knl_${randomBytes(12).toString('hex')}`;
          this.database.prepare(`
            INSERT OR IGNORE INTO knowledge_links
            (id, principal_id, source_id, target_id, relation, origin, generation, created_at)
            VALUES (?, ?, ?, ?, 'references', 'wikilink', 1, ?)
          `).run(linkId, params.principalId, existing.id, targetId, now);
        }
      }

      // Enqueue embedding update
      this.database.prepare(`
        INSERT OR REPLACE INTO knowledge_index_jobs
        (principal_id, item_id, target_generation, content_sha256, state, attempts, error_message, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'PENDING', 0, NULL, ?, ?)
      `).run(params.principalId, existing.id, nextGeneration, contentSha256, now, now);
      this.database.exec('COMMIT');
      try {
        this.searchEngine.indexItemChunks(params.principalId, existing.id, nextGeneration, title, content);
      } catch {
        // Non-blocking index error
      }
      return {
        success: true,
        item: {
          id: existing.id,
          principalId: existing.principal_id,
          kind: existing.kind,
          scope: existing.scope,
          projectId: existing.project_id,
          workspaceId: existing.workspace_id,
          title,
          content,
          contentSha256,
          journalType,
          occurredAt,
          generation: nextGeneration,
          createdAt: existing.created_at,
          updatedAt: now,
          expiresAt,
          deletedAt: null,
          tags: currentTags,
          provenance: JSON.parse(provenance) as Provenance
        }
      };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  deleteItem(params: DeleteKnowledgeItemParams): { success: true } | { success: false; conflict: { currentGeneration: number } } {
    const now = Date.now();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      interface ExistingRow {
        id: string;
        generation: number;
      }
      const existing = this.database.prepare(`
        SELECT id, generation FROM knowledge_items
        WHERE id = ? AND principal_id = ? AND deleted_at IS NULL
      `).get(params.id, params.principalId) as unknown as ExistingRow | undefined;

      if (!existing) {
        this.database.exec('ROLLBACK');
        throw new Error('knowledge item not found');
      }

      if (existing.generation !== params.expectedGeneration) {
        this.database.exec('ROLLBACK');
        return {
          success: false,
          conflict: { currentGeneration: existing.generation }
        };
      }

      // Soft delete item
      this.database.prepare(`
        UPDATE knowledge_items
        SET deleted_at = ?, generation = generation + 1, updated_at = ?
        WHERE id = ? AND principal_id = ?
      `).run(now, now, existing.id, params.principalId);

      // Remove from FTS
      this.database.prepare('DELETE FROM knowledge_fts WHERE item_id = ?').run(existing.id);

      // Remove pending indexing jobs
      this.database.prepare('DELETE FROM knowledge_index_jobs WHERE principal_id = ? AND item_id = ?').run(params.principalId, existing.id);

      // Delete incident links
      this.database.prepare('DELETE FROM knowledge_links WHERE principal_id = ? AND (source_id = ? OR target_id = ?)').run(params.principalId, existing.id, existing.id);

      this.database.exec('COMMIT');
      return { success: true };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  listItems(params: ListKnowledgeItemsParams): { items: KnowledgeItem[]; nextCursor?: string } {
    const now = Date.now();
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
    const offset = Number(params.cursor ?? 0);

    let sql = `
      SELECT * FROM knowledge_items
      WHERE principal_id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
    `;
    const args: (string | number | null)[] = [params.principalId, now];

    if (params.kind) {
      sql += ' AND kind = ?';
      args.push(params.kind);
    }
    if (params.scope) {
      sql += ' AND scope = ?';
      args.push(params.scope);
    }
    if (params.projectId !== undefined) {
      if (params.projectId === null) {
        sql += ' AND project_id IS NULL';
      } else {
        sql += ' AND project_id = ?';
        args.push(params.projectId);
      }
    }
    if (params.workspaceId !== undefined) {
      if (params.workspaceId === null) {
        sql += ' AND workspace_id IS NULL';
      } else {
        sql += ' AND workspace_id = ?';
        args.push(params.workspaceId);
      }
    }
    if (params.journalType) {
      sql += ' AND journal_type = ?';
      args.push(params.journalType);
    }
    if (params.since) {
      sql += ' AND (occurred_at >= ? OR (occurred_at IS NULL AND updated_at >= ?))';
      args.push(params.since, params.since);
    }
    if (params.until) {
      sql += ' AND (occurred_at <= ? OR (occurred_at IS NULL AND updated_at <= ?))';
      args.push(params.until, params.until);
    }

    const cleanTags = (params.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (cleanTags.length > 0) {
      const placeholders = cleanTags.map(() => '?').join(',');
      if (params.tagMatch === 'any') {
        sql += ` AND id IN (SELECT item_id FROM knowledge_tags WHERE principal_id = ? AND tag IN (${placeholders}))`;
        args.push(params.principalId, ...cleanTags);
      } else {
        sql += ` AND id IN (SELECT item_id FROM knowledge_tags WHERE principal_id = ? AND tag IN (${placeholders}) GROUP BY item_id HAVING COUNT(DISTINCT tag) = ${cleanTags.length})`;
        args.push(params.principalId, ...cleanTags);
      }
    }

    // Order: for journals, primary sort is occurred_at DESC, id DESC. For general items: COALESCE(occurred_at, updated_at) DESC, id DESC
    sql += ' ORDER BY COALESCE(occurred_at, updated_at) DESC, id DESC LIMIT ? OFFSET ?';
    args.push(limit + 1, offset);

    interface ItemRow {
      id: string;
      principal_id: string;
      kind: KnowledgeKind;
      scope: KnowledgeScope;
      project_id: string | null;
      workspace_id: string | null;
      title: string;
      content: string;
      content_sha256: string;
      journal_type: JournalType | null;
      occurred_at: number | null;
      generation: number;
      created_at: number;
      updated_at: number;
      expires_at: number | null;
      deleted_at: number | null;
      provenance_json: string;
    }

    const rows = this.database.prepare(sql).all(...args) as unknown as ItemRow[];
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? String(offset + limit) : undefined;

    const items: KnowledgeItem[] = page.map((row) => {
      const tagRows = this.database.prepare(`
        SELECT tag FROM knowledge_tags WHERE principal_id = ? AND item_id = ?
      `).all(params.principalId, row.id) as unknown as { tag: string }[];
      return {
        id: row.id,
        principalId: row.principal_id,
        kind: row.kind,
        scope: row.scope,
        projectId: row.project_id,
        workspaceId: row.workspace_id,
        title: row.title,
        content: row.content,
        contentSha256: row.content_sha256,
        journalType: row.journal_type,
        occurredAt: row.occurred_at,
        generation: row.generation,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at,
        deletedAt: row.deleted_at,
        tags: tagRows.map((t) => t.tag),
        provenance: JSON.parse(row.provenance_json) as Provenance
      };
    });

    return { items, ...(nextCursor ? { nextCursor } : {}) };
  }

  createLink(params: CreateKnowledgeLinkParams): KnowledgeLink {
    if (params.sourceId === params.targetId) {
      throw new Error('cannot link a knowledge item to itself');
    }
    const now = Date.now();
    const relation = params.relation ?? 'relates-to';
    const origin = params.origin ?? 'manual';

    this.database.exec('BEGIN IMMEDIATE');
    try {
      // Validate both endpoints belong to principal and are not deleted
      const source = this.database.prepare(`
        SELECT id FROM knowledge_items
        WHERE id = ? AND principal_id = ? AND deleted_at IS NULL
      `).get(params.sourceId, params.principalId);

      const target = this.database.prepare(`
        SELECT id FROM knowledge_items
        WHERE id = ? AND principal_id = ? AND deleted_at IS NULL
      `).get(params.targetId, params.principalId);

      if (!source || !target) {
        throw new Error('source or target knowledge item not found or inaccessible');
      }

      const linkId = `knl_${randomBytes(12).toString('hex')}`;
      this.database.prepare(`
        INSERT INTO knowledge_links
        (id, principal_id, source_id, target_id, relation, origin, generation, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(principal_id, source_id, target_id, relation) DO UPDATE SET
          origin = excluded.origin,
          generation = knowledge_links.generation + 1
      `).run(linkId, params.principalId, params.sourceId, params.targetId, relation, origin, now);

      interface LinkRow {
        id: string;
        principal_id: string;
        source_id: string;
        target_id: string;
        relation: KnowledgeRelation;
        origin: 'manual' | 'wikilink';
        generation: number;
        created_at: number;
      }

      const row = this.database.prepare(`
        SELECT * FROM knowledge_links
        WHERE principal_id = ? AND source_id = ? AND target_id = ? AND relation = ?
      `).get(params.principalId, params.sourceId, params.targetId, relation) as unknown as LinkRow;

      this.database.exec('COMMIT');

      return {
        id: row.id,
        principalId: row.principal_id,
        sourceId: row.source_id,
        targetId: row.target_id,
        relation: row.relation,
        origin: row.origin,
        createdAt: row.created_at,
        generation: row.generation
      };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  deleteLink(params: DeleteKnowledgeLinkParams): boolean {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (params.linkId) {
        const res = this.database.prepare(`
          DELETE FROM knowledge_links
          WHERE id = ? AND principal_id = ?
        `).run(params.linkId, params.principalId);
        this.database.exec('COMMIT');
        return res.changes > 0;
      }
      if (params.sourceId && params.targetId) {
        let sql = 'DELETE FROM knowledge_links WHERE principal_id = ? AND source_id = ? AND target_id = ?';
        const args: string[] = [params.principalId, params.sourceId, params.targetId];
        if (params.relation) {
          sql += ' AND relation = ?';
          args.push(params.relation);
        }
        const res = this.database.prepare(sql).run(...args);
        this.database.exec('COMMIT');
        return res.changes > 0;
      }
      this.database.exec('ROLLBACK');
      return false;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  searchItems(params: SearchKnowledgeParams): { results: KnowledgeSearchResultItem[]; nextCursor?: string } {
    return this.searchEngine.search(params);
  }

  getGraph(params: KnowledgeGraphQueryParams): KnowledgeGraphResult {
    return this.graphService.getGraph(params);
  }
}
