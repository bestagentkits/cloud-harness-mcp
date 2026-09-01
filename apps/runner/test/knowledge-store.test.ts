import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { StateStore } from '../src/state-store.js';

const tempDbPath = () => join(tmpdir(), `test-knowledge-store-${randomBytes(8).toString('hex')}.sqlite`);

describe('KnowledgeStore in StateStore', () => {
  it('creates, reads, updates, and deletes owner memory items with CAS', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    try {
      store.database.prepare("INSERT INTO principals (id, issuer, subject, created_at, updated_at) VALUES ('p_user1', 'https://auth.example.com', 'user1', 1000, 1000)").run();

      // Create owner memory
      const item = store.knowledge.createItem({
        principalId: 'p_user1',
        kind: 'memory',
        scope: 'owner',
        title: 'System Architecture',
        content: '# Overview\nCore design here.',
        tags: ['arch', 'system']
      });

      expect(item.id).toMatch(/^kn_/);
      expect(item.kind).toBe('memory');
      expect(item.scope).toBe('owner');
      expect(item.generation).toBe(1);
      expect(item.tags).toEqual(['arch', 'system']);

      // Read item
      const read = store.knowledge.readItem({ principalId: 'p_user1', id: item.id });
      expect(read).toBeDefined();
      expect(read!.title).toBe('System Architecture');
      expect(read!.content).toBe('# Overview\nCore design here.');
      expect(read!.outboundLinks.length).toBe(0);
      expect(read!.backlinks.length).toBe(0);

      // CAS conflict update with wrong generation
      const conflictUpdate = store.knowledge.updateItem({
        principalId: 'p_user1',
        id: item.id,
        expectedGeneration: 99,
        content: 'Should not update'
      });
      expect(conflictUpdate.success).toBe(false);
      if (!conflictUpdate.success) {
        expect(conflictUpdate.conflict.currentGeneration).toBe(1);
        expect(conflictUpdate.conflict.currentContent).toBe('# Overview\nCore design here.');
      }

      // Successful CAS update
      const validUpdate = store.knowledge.updateItem({
        principalId: 'p_user1',
        id: item.id,
        expectedGeneration: 1,
        content: '# Overview\nUpdated core design.',
        tags: ['arch', 'v2']
      });
      expect(validUpdate.success).toBe(true);
      if (validUpdate.success) {
        expect(validUpdate.item.generation).toBe(2);
        expect(validUpdate.item.content).toBe('# Overview\nUpdated core design.');
        expect(validUpdate.item.tags).toEqual(['arch', 'v2']);
      }

      // Read updated
      const readV2 = store.knowledge.readItem({ principalId: 'p_user1', id: item.id });
      expect(readV2!.generation).toBe(2);
      expect(readV2!.tags).toEqual(['arch', 'v2']);

      // Delete with wrong generation -> conflict
      const conflictDelete = store.knowledge.deleteItem({
        principalId: 'p_user1',
        id: item.id,
        expectedGeneration: 1
      });
      expect(conflictDelete.success).toBe(false);

      // Delete with generation 2 -> success
      const validDelete = store.knowledge.deleteItem({
        principalId: 'p_user1',
        id: item.id,
        expectedGeneration: 2
      });
      expect(validDelete.success).toBe(true);

      // Read after delete returns null
      const readAfterDelete = store.knowledge.readItem({ principalId: 'p_user1', id: item.id });
      expect(readAfterDelete).toBeNull();
    } finally {
      store.close();
    }
  });

  it('creates and lists chronological journals with project scope and tags filtering', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    try {
      store.database.prepare("INSERT INTO principals (id, issuer, subject, created_at, updated_at) VALUES ('p_user2', 'https://auth.example.com', 'user2', 1000, 1000)").run();

      const jnl1 = store.knowledge.createItem({
        principalId: 'p_user2',
        kind: 'journal',
        scope: 'project',
        projectId: 'prj_project1',
        title: 'Initial Sprint Log',
        content: 'Sprint 1 kickoff...',
        journalType: 'engineering-log',
        occurredAt: 1000,
        tags: ['sprint1', 'frontend']
      });

      const jnl2 = store.knowledge.createItem({
        principalId: 'p_user2',
        kind: 'journal',
        scope: 'project',
        projectId: 'prj_project1',
        title: 'ADR: Local Vector Embedding',
        content: 'Decision on SQLite Vec...',
        journalType: 'decision-record',
        occurredAt: 2000,
        tags: ['adr', 'backend']
      });

      const jnl3 = store.knowledge.createItem({
        principalId: 'p_user2',
        kind: 'journal',
        scope: 'project',
        projectId: 'prj_project2',
        title: 'Project 2 Log',
        content: 'Unrelated project log',
        journalType: 'engineering-log',
        occurredAt: 3000,
        tags: ['project2']
      });
      expect(jnl3.id).toBeDefined();

      // List all journals for project 1
      const listPrj1 = store.knowledge.listItems({
        principalId: 'p_user2',
        kind: 'journal',
        projectId: 'prj_project1'
      });
      expect(listPrj1.items.length).toBe(2);
      // Order should be occurredAt DESC
      expect(listPrj1.items[0].id).toBe(jnl2.id);
      expect(listPrj1.items[1].id).toBe(jnl1.id);

      // Filter by journalType
      const listAdr = store.knowledge.listItems({
        principalId: 'p_user2',
        kind: 'journal',
        journalType: 'decision-record'
      });
      expect(listAdr.items.length).toBe(1);
      expect(listAdr.items[0].id).toBe(jnl2.id);

      // Filter by tag
      const listTag = store.knowledge.listItems({
        principalId: 'p_user2',
        tags: ['sprint1']
      });
      expect(listTag.items.length).toBe(1);
      expect(listTag.items[0].id).toBe(jnl1.id);
    } finally {
      store.close();
    }
  });

  it('manages manual links and automatic wikilink extraction between items', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    try {
      store.database.prepare("INSERT INTO principals (id, issuer, subject, created_at, updated_at) VALUES ('p_user3', 'https://auth.example.com', 'user3', 1000, 1000)").run();

      const mem1 = store.knowledge.createItem({
        principalId: 'p_user3',
        kind: 'memory',
        scope: 'owner',
        title: 'Cache Policy',
        content: 'Cache TTL is 60s.'
      });

      const jnl1 = store.knowledge.createItem({
        principalId: 'p_user3',
        kind: 'journal',
        scope: 'project',
        projectId: 'prj_ch',
        title: 'Cache Bugfix Postmortem',
        content: `Refactored caching based on [[${mem1.id}|Cache Policy]] doc.`,
        journalType: 'engineering-log'
      });

      // mem1 should now have a backlink from jnl1
      const readMem1 = store.knowledge.readItem({ principalId: 'p_user3', id: mem1.id });
      expect(readMem1!.backlinks.length).toBe(1);
      expect(readMem1!.backlinks[0].sourceId).toBe(jnl1.id);
      expect(readMem1!.backlinks[0].origin).toBe('wikilink');

      // jnl1 should have outbound link to mem1
      const readJnl1 = store.knowledge.readItem({ principalId: 'p_user3', id: jnl1.id });
      expect(readJnl1!.outboundLinks.length).toBe(1);
      expect(readJnl1!.outboundLinks[0].targetId).toBe(mem1.id);

      // Add a manual link with relation 'supports'
      const manualLink = store.knowledge.createLink({
        principalId: 'p_user3',
        sourceId: mem1.id,
        targetId: jnl1.id,
        relation: 'supports'
      });
      expect(manualLink.relation).toBe('supports');
      expect(manualLink.origin).toBe('manual');

      // Self-link is rejected
      expect(() => store.knowledge.createLink({
        principalId: 'p_user3',
        sourceId: mem1.id,
        targetId: mem1.id
      })).toThrow('cannot link a knowledge item to itself');

      // Cross-principal linking is rejected
      expect(() => store.knowledge.createLink({
        principalId: 'p_foreign',
        sourceId: mem1.id,
        targetId: jnl1.id
      })).toThrow();

      // Delete manual link
      const unlinked = store.knowledge.deleteLink({
        principalId: 'p_user3',
        sourceId: mem1.id,
        targetId: jnl1.id,
        relation: 'supports'
      });
      expect(unlinked).toBe(true);
    } finally {
      store.close();
    }
  });
});
