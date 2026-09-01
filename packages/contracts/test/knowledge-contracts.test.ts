import { describe, it, expect } from 'vitest';
import {
  KnowledgeItemSchema,
  KnowledgeLinkSchema,
  KnowledgeGraphResultSchema,
  KnowledgeSearchResultItemSchema,
  TOOL_SCHEMA_BY_NAME,
  MetadataRunnerRequestSchema
} from '../src/index.js';

describe('Knowledge Contracts & Schemas', () => {
  it('validates a well-formed owner memory item', () => {
    const memory = KnowledgeItemSchema.parse({
      id: 'kn_mem1234567890',
      principalId: 'p_owner1',
      kind: 'memory',
      scope: 'owner',
      title: 'Architecture Guide',
      content: '# Architecture\nDetails here...',
      contentSha256: 'a'.repeat(64),
      generation: 1,
      createdAt: 1725177600000,
      updatedAt: 1725177600000,
      tags: ['arch', 'design']
    });
    expect(memory.id).toBe('kn_mem1234567890');
    expect(memory.kind).toBe('memory');
    expect(memory.scope).toBe('owner');
    expect(memory.projectId).toBeUndefined();
  });

  it('validates a well-formed project journal item', () => {
    const journal = KnowledgeItemSchema.parse({
      id: 'kn_jnl1234567890',
      principalId: 'p_owner1',
      kind: 'journal',
      scope: 'project',
      projectId: 'prj_12345678901234567890',
      title: 'Decision on SQLite Vector KNN',
      content: 'We decided to use local embeddings...',
      contentSha256: 'b'.repeat(64),
      journalType: 'decision-record',
      occurredAt: 1725177600000,
      generation: 1,
      createdAt: 1725177600000,
      updatedAt: 1725177600000,
      tags: ['decision', 'database']
    });
    expect(journal.kind).toBe('journal');
    expect(journal.journalType).toBe('decision-record');
    expect(journal.projectId).toBe('prj_12345678901234567890');
  });

  it('rejects invalid scope / field combinations', () => {
    // Owner with projectId
    expect(() => KnowledgeItemSchema.parse({
      id: 'kn_mem1234567890',
      principalId: 'p_owner1',
      kind: 'memory',
      scope: 'owner',
      projectId: 'prj_12345678901234567890',
      title: 'Invalid',
      content: 'Content',
      contentSha256: 'c'.repeat(64),
      generation: 1,
      createdAt: 1000,
      updatedAt: 1000,
      tags: []
    })).toThrow();

    // Journal without journalType
    expect(() => KnowledgeItemSchema.parse({
      id: 'kn_jnl1234567890',
      principalId: 'p_owner1',
      kind: 'journal',
      scope: 'project',
      projectId: 'prj_12345678901234567890',
      title: 'Invalid Journal',
      content: 'Content',
      contentSha256: 'd'.repeat(64),
      generation: 1,
      createdAt: 1000,
      updatedAt: 1000,
      tags: []
    })).toThrow();

    // Memory with journalType
    expect(() => KnowledgeItemSchema.parse({
      id: 'kn_mem1234567890',
      principalId: 'p_owner1',
      kind: 'memory',
      scope: 'owner',
      title: 'Invalid Memory',
      content: 'Content',
      contentSha256: 'e'.repeat(64),
      journalType: 'engineering-log',
      generation: 1,
      createdAt: 1000,
      updatedAt: 1000,
      tags: []
    })).toThrow();
  });

  it('validates knowledge link schema', () => {
    const link = KnowledgeLinkSchema.parse({
      id: 'knl_link1234567890',
      principalId: 'p_owner1',
      sourceId: 'kn_mem1234567890',
      targetId: 'kn_jnl1234567890',
      relation: 'references',
      origin: 'wikilink',
      createdAt: 1725177600000,
      generation: 1
    });
    expect(link.relation).toBe('references');
    expect(link.origin).toBe('wikilink');
  });

  it('validates knowledge search result item schema', () => {
    const item = KnowledgeItemSchema.parse({
      id: 'kn_mem1234567890',
      principalId: 'p_owner1',
      kind: 'memory',
      scope: 'owner',
      title: 'Search Hit',
      content: 'Important info',
      contentSha256: 'f'.repeat(64),
      generation: 1,
      createdAt: 1000,
      updatedAt: 1000,
      tags: []
    });

    const searchResult = KnowledgeSearchResultItemSchema.parse({
      item,
      relevancePercent: 94.5,
      matchMode: 'hybrid',
      ftsRank: 1,
      semanticRank: 2,
      snippet: 'Found **important** info'
    });
    expect(searchResult.relevancePercent).toBe(94.5);
    expect(searchResult.matchMode).toBe('hybrid');
  });

  it('validates knowledge graph result schema', () => {
    const graph = KnowledgeGraphResultSchema.parse({
      nodes: [
        {
          id: 'kn_mem1234567890',
          kind: 'memory',
          scope: 'owner',
          title: 'Memory 1',
          tags: ['tag1'],
          updatedAt: 1000
        },
        {
          id: 'kn_jnl1234567890',
          kind: 'journal',
          scope: 'project',
          title: 'Journal 1',
          journalType: 'decision-record',
          tags: ['tag2'],
          updatedAt: 2000
        }
      ],
      edges: [
        {
          id: 'knl_link1234567890',
          sourceId: 'kn_mem1234567890',
          targetId: 'kn_jnl1234567890',
          relation: 'supports',
          origin: 'manual'
        }
      ],
      truncated: false
    });
    expect(graph.nodes.length).toBe(2);
    expect(graph.edges.length).toBe(1);
  });

  it('validates all 9 knowledge MCP tool schemas', () => {
    expect(TOOL_SCHEMA_BY_NAME.knowledge_create.parse({
      title: 'New Memory',
      content: 'Hello World',
      scope: 'owner'
    })).toMatchObject({ title: 'New Memory', scope: 'owner', expectedGeneration: 0 });

    expect(TOOL_SCHEMA_BY_NAME.knowledge_read.parse({
      id: 'kn_123456789012'
    })).toMatchObject({ id: 'kn_123456789012' });

    expect(TOOL_SCHEMA_BY_NAME.knowledge_update.parse({
      id: 'kn_123456789012',
      content: 'Updated content',
      expectedGeneration: 2
    })).toMatchObject({ id: 'kn_123456789012', expectedGeneration: 2 });

    expect(TOOL_SCHEMA_BY_NAME.knowledge_delete.parse({
      id: 'kn_123456789012',
      expectedGeneration: 1
    })).toMatchObject({ id: 'kn_123456789012', expectedGeneration: 1 });

    expect(TOOL_SCHEMA_BY_NAME.knowledge_list.parse({
      kind: 'journal',
      journalType: 'engineering-log',
      limit: 25
    })).toMatchObject({ kind: 'journal', limit: 25 });

    expect(TOOL_SCHEMA_BY_NAME.knowledge_search.parse({
      query: 'database architecture',
      kinds: ['memory', 'journal'],
      limit: 10
    })).toMatchObject({ query: 'database architecture', limit: 10 });

    expect(TOOL_SCHEMA_BY_NAME.knowledge_link.parse({
      sourceId: 'kn_123456789012',
      targetId: 'kn_987654321098',
      relation: 'references'
    })).toMatchObject({ relation: 'references' });

    expect(TOOL_SCHEMA_BY_NAME.knowledge_unlink.parse({
      sourceId: 'kn_123456789012',
      targetId: 'kn_987654321098'
    })).toMatchObject({ sourceId: 'kn_123456789012' });

    expect(TOOL_SCHEMA_BY_NAME.knowledge_graph.parse({
      rootId: 'kn_123456789012',
      depth: 2
    })).toMatchObject({ depth: 2 });
  });

  it('validates dashboard metadata requests', () => {
    const listReq = MetadataRunnerRequestSchema.parse({
      version: 2,
      principal: { kind: 'owner', ownerId: 'p_owner1' },
      operation: 'knowledge_dashboard_list',
      input: { kind: 'memory' }
    });
    expect(listReq.operation).toBe('knowledge_dashboard_list');

    const searchReq = MetadataRunnerRequestSchema.parse({
      version: 2,
      principal: { kind: 'owner', ownerId: 'p_owner1' },
      operation: 'knowledge_dashboard_search',
      input: { query: 'hybrid search' }
    });
    expect(searchReq.operation).toBe('knowledge_dashboard_search');
  });
});
