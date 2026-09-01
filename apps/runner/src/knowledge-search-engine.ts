import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  JournalType,
  KnowledgeItem,
  KnowledgeKind,
  KnowledgeScope,
  KnowledgeSearchMatchMode,
  KnowledgeSearchResultItem,
  Provenance
} from '@cloud-harness/contracts';

export interface SearchKnowledgeParams {
  principalId: string;
  query: string;
  kinds?: KnowledgeKind[];
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
  queryVector?: number[];
}

export class KnowledgeSearchEngine {
  constructor(readonly database: DatabaseSync) {}

  private sanitizeFtsQuery(raw: string): string {
    const tokens = raw.replace(/[^\p{L}\p{N}_-]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return '';
    return tokens.map((t) => `"${t}"*`).join(' OR ');
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      const aVal = a[i] ?? 0;
      const bVal = b[i] ?? 0;
      dot += aVal * bVal;
      normA += aVal * aVal;
      normB += bVal * bVal;
    }
    if (normA <= 0 || normB <= 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // Token-based TF-IDF semantic approximation vector generator for local zero-cloud fallback
  generateLocalEmbeddingVector(text: string, dimensions = 128): Float32Array {
    const vector = new Float32Array(dimensions);
    const tokens = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return vector;

    for (const token of tokens) {
      const hash = createHash('sha256').update(token).digest();
      const bucket = hash.readUInt16BE(0) % dimensions;
      const sign = (hash.readUInt8(2) % 2 === 0) ? 1 : -1;
      vector[bucket] = (vector[bucket] ?? 0) + sign * (1 / Math.sqrt(tokens.length));
    }

    // Normalize
    let norm = 0;
    for (let i = 0; i < dimensions; i++) {
      const v = vector[i] ?? 0;
      norm += v * v;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < dimensions; i++) {
        vector[i] = (vector[i] ?? 0) / norm;
      }
    }
    return vector;
  }

  search(params: SearchKnowledgeParams): { results: KnowledgeSearchResultItem[]; nextCursor?: string } {
    const now = Date.now();
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
    const offset = Number(params.cursor ?? 0);
    const ftsQuery = this.sanitizeFtsQuery(params.query);

    // 1. Lexical candidate search with FTS5
    interface FtsCandidate {
      item_id: string;
      score: number;
      snippet: string;
    }

    const ftsCandidates: Map<string, { rank: number; score: number; snippet: string }> = new Map();
    if (ftsQuery) {
      try {
        const rows = this.database.prepare(`
          SELECT item_id, bm25(knowledge_fts, 3.0, 2.0, 1.0) as score, snippet(knowledge_fts, 3, '<mark>', '</mark>', '...', 16) as snippet
          FROM knowledge_fts
          WHERE knowledge_fts MATCH ?
          ORDER BY bm25(knowledge_fts, 3.0, 2.0, 1.0) ASC
          LIMIT 100
        `).all(ftsQuery) as unknown as FtsCandidate[];

        rows.forEach((r, idx) => {
          ftsCandidates.set(r.item_id, { rank: idx + 1, score: r.score, snippet: r.snippet });
        });
      } catch {
        // Fallback on malformed FTS query
      }
    }

    // 2. Fetch and filter candidate items matching metadata constraints
    let sql = `
      SELECT * FROM knowledge_items
      WHERE principal_id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
    `;
    const args: (string | number | null)[] = [params.principalId, now];

    if (params.kinds && params.kinds.length > 0) {
      const placeholders = params.kinds.map(() => '?').join(',');
      sql += ` AND kind IN (${placeholders})`;
      args.push(...params.kinds);
    }
    if (params.scope) {
      sql += ' AND scope = ?';
      args.push(params.scope);
    }
    if (params.projectId !== undefined) {
      if (params.projectId === null) sql += ' AND project_id IS NULL';
      else {
        sql += ' AND project_id = ?';
        args.push(params.projectId);
      }
    }
    if (params.workspaceId !== undefined) {
      if (params.workspaceId === null) sql += ' AND workspace_id IS NULL';
      else {
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

    const candidateRows = this.database.prepare(sql).all(...args) as unknown as ItemRow[];
    if (candidateRows.length === 0) {
      return { results: [] };
    }

    // 3. Semantic candidates via vector cosine similarity
    const queryVector = params.queryVector ? Float32Array.from(params.queryVector) : this.generateLocalEmbeddingVector(params.query);
    const semanticScores = new Map<string, number>();

    interface EmbeddingRow {
      item_id: string;
      vector_blob: Buffer;
      dimensions: number;
    }

    const candidateIds = candidateRows.map((r) => r.id);
    const idPlaceholders = candidateIds.map(() => '?').join(',');
    const embeddingRows = this.database.prepare(`
      SELECT item_id, vector_blob, dimensions FROM knowledge_embeddings
      WHERE principal_id = ? AND item_id IN (${idPlaceholders})
    `).all(params.principalId, ...candidateIds) as unknown as EmbeddingRow[];

    for (const row of embeddingRows) {
      const docVector = new Float32Array(row.vector_blob.buffer, row.vector_blob.byteOffset, row.vector_blob.byteLength / 4);
      const similarity = this.cosineSimilarity(queryVector, docVector);
      const prev = semanticScores.get(row.item_id) ?? -1;
      if (similarity > prev) {
        semanticScores.set(row.item_id, similarity);
      }
    }

    // Rank semantic candidates
    const semanticSorted = Array.from(semanticScores.entries())
      .filter(([, sim]) => sim > 0.05)
      .sort((a, b) => b[1] - a[1]);
    const semanticCandidates: Map<string, { rank: number; similarity: number }> = new Map();
    semanticSorted.forEach(([id, sim], idx) => {
      semanticCandidates.set(id, { rank: idx + 1, similarity: sim });
    });

    // 4. Rank Fusion (RRF) & Relevance Score Calculation
    const RRF_K = 60;
    const scoredResults: Array<{
      itemRow: ItemRow;
      relevancePercent: number;
      matchMode: KnowledgeSearchMatchMode;
      ftsRank?: number;
      semanticRank?: number;
      snippet?: string;
    }> = [];

    const hasSemanticData = semanticCandidates.size > 0;

    for (const row of candidateRows) {
      const fts = ftsCandidates.get(row.id);
      const sem = semanticCandidates.get(row.id);

      if (!fts && !sem && ftsQuery) {
        // Did not match either channel
        continue;
      }

      let rrfScore = 0;
      let matchMode: KnowledgeSearchMatchMode = 'hybrid';

      if (fts && sem) {
        rrfScore = (0.5 / (RRF_K + fts.rank)) + (0.5 / (RRF_K + sem.rank));
        matchMode = 'hybrid';
      } else if (fts) {
        rrfScore = (0.5 / (RRF_K + fts.rank));
        matchMode = hasSemanticData ? 'lexical' : 'lexical_fallback';
      } else if (sem) {
        rrfScore = (0.5 / (RRF_K + sem.rank));
        matchMode = 'semantic';
      } else {
        // Fallback for empty query browsing
        rrfScore = 0.01;
        matchMode = 'lexical_fallback';
      }

      // Max theoretical RRF score with equal weights (0.5 + 0.5) is 1 / (60 + 1) = 1/61
      const normalizedRelevance = Math.min(100, Math.max(0, Math.round(rrfScore * 61 * 100)));

      scoredResults.push({
        itemRow: row,
        relevancePercent: normalizedRelevance,
        matchMode,
        ...(fts?.rank !== undefined ? { ftsRank: fts.rank } : {}),
        ...(sem?.rank !== undefined ? { semanticRank: sem.rank } : {}),
        ...(fts?.snippet !== undefined ? { snippet: fts.snippet } : {})
      });
    }

    // Sort by relevancePercent DESC, occurred_at/updated_at DESC, id DESC
    scoredResults.sort((a, b) => {
      if (b.relevancePercent !== a.relevancePercent) return b.relevancePercent - a.relevancePercent;
      const timeA = a.itemRow.occurred_at ?? a.itemRow.updated_at;
      const timeB = b.itemRow.occurred_at ?? b.itemRow.updated_at;
      if (timeB !== timeA) return timeB - timeA;
      return b.itemRow.id.localeCompare(a.itemRow.id);
    });

    const page = scoredResults.slice(offset, offset + limit);
    const nextCursor = scoredResults.length > offset + limit ? String(offset + limit) : undefined;

    const results: KnowledgeSearchResultItem[] = page.map((res) => {
      const tagRows = this.database.prepare(`
        SELECT tag FROM knowledge_tags WHERE principal_id = ? AND item_id = ?
      `).all(params.principalId, res.itemRow.id) as unknown as { tag: string }[];

      const item: KnowledgeItem = {
        id: res.itemRow.id,
        principalId: res.itemRow.principal_id,
        kind: res.itemRow.kind,
        scope: res.itemRow.scope,
        projectId: res.itemRow.project_id,
        workspaceId: res.itemRow.workspace_id,
        title: res.itemRow.title,
        content: res.itemRow.content,
        contentSha256: res.itemRow.content_sha256,
        journalType: res.itemRow.journal_type,
        occurredAt: res.itemRow.occurred_at,
        generation: res.itemRow.generation,
        createdAt: res.itemRow.created_at,
        updatedAt: res.itemRow.updated_at,
        expiresAt: res.itemRow.expires_at,
        deletedAt: res.itemRow.deleted_at,
        tags: tagRows.map((t) => t.tag),
        provenance: JSON.parse(res.itemRow.provenance_json) as Provenance
      };

      return {
        item,
        relevancePercent: res.relevancePercent,
        matchMode: res.matchMode,
        ftsRank: res.ftsRank,
        semanticRank: res.semanticRank,
        snippet: res.snippet
      };
    });

    return { results, ...(nextCursor ? { nextCursor } : {}) };
  }
}
