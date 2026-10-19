import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_POLICY_LIMITS, DEFAULT_GLOBAL_EXECUTION_POLICY, type GlobalExecutionPolicy } from '@cloud-harness/contracts';
import { initializeAgentPolicySchema } from '../src/agent-governance/policy-schema.js';
import { PolicyStore, PolicyStoreError } from '../src/agent-governance/policy-store.js';

const PROJECT = `prj_${'p'.repeat(32)}`;
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function setup() {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  let clock = 1_000;
  return { database, store: new PolicyStore(database, () => (clock += 1)) };
}

const globalWith = (ttlSeconds: number): GlobalExecutionPolicy => ({ ...structuredClone(DEFAULT_GLOBAL_EXECUTION_POLICY), approval: { ttlSeconds, approverRoles: ['owner'] } });

function expectStoreError(action: () => unknown, code: PolicyStoreError['code']) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyStoreError);
    expect((error as PolicyStoreError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('PolicyStore', () => {
  it('initializes idempotently and keeps existing rows', () => {
    const { database, store } = setup();
    store.put('owner', 'global', null, globalWith(600), 0);
    initializeAgentPolicySchema(database);
    initializeAgentPolicySchema(database);
    expect(new PolicyStore(database).head('owner', 'global', null)?.version).toBe(1);
  });

  it('appends immutable revisions and moves the head under compare-and-swap', () => {
    const { database, store } = setup();
    const first = store.put('owner', 'global', null, globalWith(600), 0, { note: 'first' });
    const second = store.put('owner', 'global', null, globalWith(900), 1);
    expect(first).toMatchObject({ version: 1, scope: 'global', projectId: null, createdBy: 'owner', note: 'first', rollbackOf: null });
    expect(second.version).toBe(2);
    expect(store.head('owner', 'global', null)?.revisionId).toBe(second.revisionId);
    // The first revision is untouched.
    expect(store.revision('owner', first.revisionId)).toEqual(first);
    expect(first.digest).not.toBe(second.digest);
    expectStoreError(() => store.put('owner', 'global', null, globalWith(1200), 1), 'CONFLICT');
    expectStoreError(() => store.put('owner', 'global', null, globalWith(1200), 0), 'CONFLICT');
    expect((database.prepare('SELECT COUNT(*) AS count FROM agent_policy_revisions').get() as { count: number }).count).toBe(2);
  });

  it('rolls back by appending a new revision that points at its source', () => {
    const { store } = setup();
    const first = store.put('owner', 'global', null, globalWith(600), 0);
    store.put('owner', 'global', null, globalWith(900), 1);
    const rolled = store.put('owner', 'global', null, first.document, 2, { rollbackOf: first.revisionId });
    expect(rolled).toMatchObject({ version: 3, rollbackOf: first.revisionId, digest: first.digest });
    expect(rolled.revisionId).not.toBe(first.revisionId);
  });

  it('pages history newest first', () => {
    const { store } = setup();
    for (let version = 0; version < 5; version += 1) store.put('owner', 'global', null, globalWith(600 + version), version);
    const page = store.history('owner', 'global', null, undefined, 2);
    expect(page.revisions.map((revision) => revision.version)).toEqual([5, 4]);
    expect(page.nextBeforeVersion).toBe(4);
    const next = store.history('owner', 'global', null, 4, 10);
    expect(next.revisions.map((revision) => revision.version)).toEqual([3, 2, 1]);
    expect(next.nextBeforeVersion).toBeNull();
  });

  it('isolates principals and scopes', () => {
    const { store } = setup();
    const mine = store.put('owner', 'global', null, globalWith(600), 0);
    store.put('owner', 'project', PROJECT, { version: 1, hardDeny: ['edit'] }, 0);
    expect(store.head('other', 'global', null)).toBeNull();
    expect(store.revision('other', mine.revisionId)).toBeNull();
    expect(store.history('other', 'global', null, undefined, 10).revisions).toEqual([]);
    expect(store.projectHeads('other')).toEqual([]);
    expectStoreError(() => store.deleteProjectHead('other', PROJECT, 1), 'NOT_FOUND');
    // Another principal starts its own version line.
    expect(store.put('other', 'global', null, globalWith(600), 0).version).toBe(1);
    expect(store.projectHeads('owner').map((entry) => entry.projectId)).toEqual([PROJECT]);
  });

  it('deletes a project head under compare-and-swap and keeps its history', () => {
    const { store } = setup();
    store.put('owner', 'project', PROJECT, { version: 1, hardDeny: ['edit'] }, 0);
    expectStoreError(() => store.deleteProjectHead('owner', PROJECT, 2), 'CONFLICT');
    store.deleteProjectHead('owner', PROJECT, 1);
    expect(store.head('owner', 'project', PROJECT)).toBeNull();
    expect(store.history('owner', 'project', PROJECT, undefined, 10).revisions).toHaveLength(1);
    // Re-creating starts from "no head" and continues the version line.
    expect(store.put('owner', 'project', PROJECT, { version: 1 }, 0).version).toBe(2);
  });

  it('rejects a scope/project mismatch', () => {
    const { store } = setup();
    expectStoreError(() => store.put('owner', 'project', null, { version: 1 }, 0), 'INTERNAL');
    expectStoreError(() => store.put('owner', 'global', PROJECT, globalWith(600), 0), 'INTERNAL');
  });

  it('prunes old revisions but never the head', () => {
    const { store } = setup();
    const total = AGENT_POLICY_LIMITS.maxRevisionsPerScope + 5;
    for (let version = 0; version < total; version += 1) store.put('owner', 'global', null, globalWith(600 + version), version);
    const all = store.history('owner', 'global', null, undefined, AGENT_POLICY_LIMITS.maxHistoryLimit);
    expect(all.revisions[0]?.version).toBe(total);
    let count = 0;
    let before: number | undefined;
    for (;;) {
      const page = store.history('owner', 'global', null, before, AGENT_POLICY_LIMITS.maxHistoryLimit);
      count += page.revisions.length;
      if (page.nextBeforeVersion === null) break;
      before = page.nextBeforeVersion;
    }
    expect(count).toBe(AGENT_POLICY_LIMITS.maxRevisionsPerScope);
    expect(store.head('owner', 'global', null)?.version).toBe(total);
  });

  it('fails closed when a stored document no longer validates', () => {
    const { database, store } = setup();
    const head = store.put('owner', 'global', null, globalWith(600), 0);
    database.prepare('UPDATE agent_policy_revisions SET document_json = ? WHERE revision_id = ?').run('{"version":1,"hardDeny":"all"}', head.revisionId);
    expectStoreError(() => store.head('owner', 'global', null), 'INTERNAL');
  });
});
