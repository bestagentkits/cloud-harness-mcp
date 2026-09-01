import type { DatabaseSync } from 'node:sqlite';
import type {
  JournalType,
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgeGraphResult,
  KnowledgeKind,
  KnowledgeLinkOrigin,
  KnowledgeRelation,
  KnowledgeScope
} from '@cloud-harness/contracts';

export interface KnowledgeGraphQueryParams {
  principalId: string;
  rootId?: string;
  depth?: number;
  maxNodes?: number;
  kinds?: KnowledgeKind[];
  projectId?: string | null;
}

export class KnowledgeGraphService {
  constructor(readonly database: DatabaseSync) {}

  getGraph(params: KnowledgeGraphQueryParams): KnowledgeGraphResult {
    const depthLimit = Math.min(Math.max(params.depth ?? 1, 1), 3);
    const maxNodes = Math.min(Math.max(params.maxNodes ?? 50, 1), 200);
    const now = Date.now();

    interface RawNodeRow {
      id: string;
      principal_id: string;
      kind: KnowledgeKind;
      scope: KnowledgeScope;
      project_id: string | null;
      workspace_id: string | null;
      title: string;
      journal_type: JournalType | null;
      updated_at: number;
    }

    interface RawEdgeRow {
      id: string;
      principal_id: string;
      source_id: string;
      target_id: string;
      relation: KnowledgeRelation;
      origin: KnowledgeLinkOrigin;
    }

    const nodeMap = new Map<string, KnowledgeGraphNode>();
    const edgeMap = new Map<string, KnowledgeGraphEdge>();
    let truncated = false;

    const getNode = (id: string): KnowledgeGraphNode | null => {
      if (nodeMap.has(id)) return nodeMap.get(id)!;
      const row = this.database.prepare(`
        SELECT id, principal_id, kind, scope, project_id, workspace_id, title, journal_type, updated_at
        FROM knowledge_items
        WHERE id = ? AND principal_id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
      `).get(id, params.principalId, now) as unknown as RawNodeRow | undefined;

      if (!row) return null;

      // Filter by kinds if specified
      if (params.kinds && params.kinds.length > 0 && !params.kinds.includes(row.kind)) {
        return null;
      }
      // Filter by projectId if specified
      if (params.projectId !== undefined && row.project_id !== params.projectId) {
        return null;
      }

      const tagRows = this.database.prepare(`
        SELECT tag FROM knowledge_tags WHERE principal_id = ? AND item_id = ?
      `).all(params.principalId, row.id) as unknown as { tag: string }[];

      const node: KnowledgeGraphNode = {
        id: row.id,
        kind: row.kind,
        scope: row.scope,
        title: row.title,
        journalType: row.journal_type,
        tags: tagRows.map((t) => t.tag),
        updatedAt: row.updated_at
      };
      nodeMap.set(node.id, node);
      return node;
    };

    if (params.rootId) {
      const root = getNode(params.rootId);
      if (!root) {
        return { nodes: [], edges: [], truncated: false };
      }

      let currentLevel = [root.id];
      const visited = new Set<string>([root.id]);

      for (let d = 0; d < depthLimit; d++) {
        const nextLevel: string[] = [];
        for (const currentId of currentLevel) {
          if (nodeMap.size >= maxNodes) {
            truncated = true;
            break;
          }

          // Outbound and inbound links
          const incidentEdges = this.database.prepare(`
            SELECT id, principal_id, source_id, target_id, relation, origin
            FROM knowledge_links
            WHERE principal_id = ? AND (source_id = ? OR target_id = ?)
          `).all(params.principalId, currentId, currentId) as unknown as RawEdgeRow[];

          for (const edge of incidentEdges) {
            const neighborId = edge.source_id === currentId ? edge.target_id : edge.source_id;
            const neighborNode = getNode(neighborId);
            if (!neighborNode) continue;

            const edgeKey = `${edge.source_id}->${edge.target_id}:${edge.relation}`;
            if (!edgeMap.has(edgeKey)) {
              edgeMap.set(edgeKey, {
                id: edge.id,
                sourceId: edge.source_id,
                targetId: edge.target_id,
                relation: edge.relation,
                origin: edge.origin
              });
            }

            if (!visited.has(neighborId)) {
              visited.add(neighborId);
              nextLevel.push(neighborId);
            }
          }
        }
        currentLevel = nextLevel;
        if (currentLevel.length === 0 || nodeMap.size >= maxNodes) break;
      }
    } else {
      // Return top nodes and incident edges
      let sql = `
        SELECT id, principal_id, kind, scope, project_id, workspace_id, title, journal_type, updated_at
        FROM knowledge_items
        WHERE principal_id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
      `;
      const args: (string | number | null)[] = [params.principalId, now];

      if (params.kinds && params.kinds.length > 0) {
        const placeholders = params.kinds.map(() => '?').join(',');
        sql += ` AND kind IN (${placeholders})`;
        args.push(...params.kinds);
      }
      if (params.projectId !== undefined) {
        if (params.projectId === null) sql += ' AND project_id IS NULL';
        else {
          sql += ' AND project_id = ?';
          args.push(params.projectId);
        }
      }
      sql += ' ORDER BY updated_at DESC LIMIT ?';
      args.push(maxNodes + 1);

      const rows = this.database.prepare(sql).all(...args) as unknown as RawNodeRow[];
      if (rows.length > maxNodes) {
        truncated = true;
      }
      const selectedRows = rows.slice(0, maxNodes);

      for (const row of selectedRows) {
        const tagRows = this.database.prepare(`
          SELECT tag FROM knowledge_tags WHERE principal_id = ? AND item_id = ?
        `).all(params.principalId, row.id) as unknown as { tag: string }[];

        nodeMap.set(row.id, {
          id: row.id,
          kind: row.kind,
          scope: row.scope,
          title: row.title,
          journalType: row.journal_type,
          tags: tagRows.map((t) => t.tag),
          updatedAt: row.updated_at
        });
      }

      const nodeIds = Array.from(nodeMap.keys());
      if (nodeIds.length > 0) {
        const placeholders = nodeIds.map(() => '?').join(',');
        const edgeRows = this.database.prepare(`
          SELECT id, principal_id, source_id, target_id, relation, origin
          FROM knowledge_links
          WHERE principal_id = ? AND source_id IN (${placeholders}) AND target_id IN (${placeholders})
        `).all(params.principalId, ...nodeIds, ...nodeIds) as unknown as RawEdgeRow[];

        for (const edge of edgeRows) {
          const edgeKey = `${edge.source_id}->${edge.target_id}:${edge.relation}`;
          edgeMap.set(edgeKey, {
            id: edge.id,
            sourceId: edge.source_id,
            targetId: edge.target_id,
            relation: edge.relation,
            origin: edge.origin
          });
        }
      }
    }

    return {
      nodes: Array.from(nodeMap.values()),
      edges: Array.from(edgeMap.values()),
      truncated
    };
  }
}
