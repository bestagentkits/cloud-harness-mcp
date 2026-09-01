import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { StateStore } from '../src/state-store.js';

const tempDbPath = () => join(tmpdir(), `test-knowledge-search-graph-${randomBytes(8).toString('hex')}.sqlite`);

describe('Knowledge Search Engine and Graph Service', () => {
  it('performs FTS5 lexical matching, semantic scoring, and RRF rank fusion', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    try {
      store.database.prepare("INSERT INTO principals (id, issuer, subject, created_at, updated_at) VALUES ('p_search_user', 'https://auth.example.com', 'search-user', 1000, 1000)").run();

      // Seed knowledge items
      const item1 = store.knowledge.createItem({
        principalId: 'p_search_user',
        kind: 'memory',
        scope: 'owner',
        title: 'PostgreSQL Connection Pooling',
        content: 'Configure PgBouncer with transaction mode and max client connections set to 100.',
        tags: ['postgres', 'database']
      });

      const item2 = store.knowledge.createItem({
        principalId: 'p_search_user',
        kind: 'journal',
        scope: 'project',
        projectId: 'prj_backend',
        title: 'Database Latency Investigation',
        content: 'Investigated query bottlenecks and connection timeouts on database clusters.',
        journalType: 'engineering-log',
        tags: ['performance', 'database']
      });

      const item3 = store.knowledge.createItem({
        principalId: 'p_search_user',
        kind: 'memory',
        scope: 'owner',
        title: 'Frontend State Management',
        content: 'Zustand and React context patterns for UI state synchronization.',
        tags: ['react', 'frontend']
      });
      expect(item3.id).toBeDefined();
      // Verify automatic embedding indexing happened on item creation
      const embRows = store.database.prepare("SELECT count(*) as count FROM knowledge_embeddings WHERE principal_id = 'p_search_user'").get() as { count: number };
      expect(embRows.count).toBeGreaterThanOrEqual(3);
      // 1. Exact Lexical Match
      const searchExact = store.knowledge.searchItems({
        principalId: 'p_search_user',
        query: 'PgBouncer'
      });
      expect(searchExact.results.length).toBeGreaterThanOrEqual(1);
      expect(searchExact.results[0].item.id).toBe(item1.id);
      expect(searchExact.results[0].relevancePercent).toBeGreaterThan(0);
      expect(['hybrid', 'lexical', 'lexical_fallback']).toContain(searchExact.results[0].matchMode);

      // 2. Semantic Search with paraphrase
      const searchSemantic = store.knowledge.searchItems({
        principalId: 'p_search_user',
        query: 'connection timeouts on database clusters'
      });
      expect(searchSemantic.results.length).toBeGreaterThanOrEqual(1);
      expect(searchSemantic.results[0].item.id).toBe(item2.id);
      expect(searchSemantic.results[0].relevancePercent).toBeGreaterThan(0);

      // 3. Filtered Search by project
      const searchProject = store.knowledge.searchItems({
        principalId: 'p_search_user',
        query: 'database',
        projectId: 'prj_backend'
      });
      expect(searchProject.results.length).toBe(1);
      expect(searchProject.results[0].item.id).toBe(item2.id);

      // 4. Cross-principal isolation: other principal finds nothing
      const searchForeign = store.knowledge.searchItems({
        principalId: 'p_foreign_user',
        query: 'database'
      });
      expect(searchForeign.results.length).toBe(0);
    } finally {
      store.close();
    }
  });

  it('traverses bounded knowledge graph and handles cycles safely', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    try {
      store.database.prepare("INSERT INTO principals (id, issuer, subject, created_at, updated_at) VALUES ('p_graph_user', 'https://auth.example.com', 'graph-user', 1000, 1000)").run();

      const n1 = store.knowledge.createItem({
        principalId: 'p_graph_user',
        kind: 'memory',
        scope: 'owner',
        title: 'Node 1: Auth Architecture',
        content: 'Auth fundamentals.'
      });

      const n2 = store.knowledge.createItem({
        principalId: 'p_graph_user',
        kind: 'journal',
        scope: 'project',
        projectId: 'prj_app',
        title: 'Node 2: OAuth Implementation',
        content: 'Implemented OAuth.',
        journalType: 'engineering-log'
      });

      const n3 = store.knowledge.createItem({
        principalId: 'p_graph_user',
        kind: 'journal',
        scope: 'project',
        projectId: 'prj_app',
        title: 'Node 3: Session Security Review',
        content: 'Security audit findings.',
        journalType: 'decision-record'
      });

      // Link n1 -> n2 -> n3 -> n1 (cycle)
      store.knowledge.createLink({
        principalId: 'p_graph_user',
        sourceId: n1.id,
        targetId: n2.id,
        relation: 'references'
      });

      store.knowledge.createLink({
        principalId: 'p_graph_user',
        sourceId: n2.id,
        targetId: n3.id,
        relation: 'supports'
      });

      store.knowledge.createLink({
        principalId: 'p_graph_user',
        sourceId: n3.id,
        targetId: n1.id,
        relation: 'relates-to'
      });

      // Query graph rooted at n1 with depth 2
      const graph = store.knowledge.getGraph({
        principalId: 'p_graph_user',
        rootId: n1.id,
        depth: 2
      });

      expect(graph.nodes.length).toBe(3);
      expect(graph.edges.length).toBe(3);
      expect(graph.truncated).toBe(false);

      const nodeIds = graph.nodes.map((n) => n.id);
      expect(nodeIds).toContain(n1.id);
      expect(nodeIds).toContain(n2.id);
      expect(nodeIds).toContain(n3.id);

      // Query full graph with maxNodes = 2
      const limitedGraph = store.knowledge.getGraph({
        principalId: 'p_graph_user',
        maxNodes: 2
      });
      expect(limitedGraph.nodes.length).toBe(2);
      expect(limitedGraph.truncated).toBe(true);
    } finally {
      store.close();
    }
  });
});
