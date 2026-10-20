import { describe, expect, it } from 'vitest';
import { pageReadQuery } from '@/lib/page-read';
import { clearDraft, readDraft, writeDraft } from './knowledge-draft';
import { CREATE_DEFAULTS, createBody, knowledgeGraph, knowledgeRows, parseTags, searchBody } from './knowledge-model';
import { createKnowledgeSchema } from './knowledge-form-schema';
import { knowledgeListQuery, knowledgeSearchQuery } from './knowledge-queries';
import { graphViewBox, layoutGraph } from './knowledge-graph-view';

const PROJECT = `prj_${'a'.repeat(24)}`;
const WORKSPACE = `ws_${'b'.repeat(24)}`;

describe('knowledge model', () => {
  it('reads list rows from both the list and the search answers', () => {
    expect(knowledgeRows({ data: { items: [{ id: 'kn_a1234567890', title: 'A' }, { title: 'no id' }] } })).toEqual([{ item: { id: 'kn_a1234567890', title: 'A' } }]);
    expect(knowledgeRows({ data: { results: [{ item: { id: 'kn_b1234567890' }, relevancePercent: 96, matchMode: 'hybrid' }, { item: null }] } }))
      .toEqual([{ item: { id: 'kn_b1234567890' }, match: { relevancePercent: 96, matchMode: 'hybrid' } }]);
    expect(knowledgeRows({ data: { items: 'nope' } })).toEqual([]);
    expect(knowledgeRows(undefined)).toEqual([]);
  });

  it('keeps only well-formed graph nodes and edges', () => {
    const graph = knowledgeGraph({ data: { nodes: [{ id: 'kn_1' }, {}], edges: [{ id: 'knl_1', sourceId: 'kn_1', targetId: 'kn_2' }, { id: 'knl_2' }], truncated: true } });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(1);
    expect(graph.truncated).toBe(true);
    expect(layoutGraph(graph)[0]).toMatchObject({ id: 'kn_1' });
    expect(graphViewBox(1)).toBe('0 0 800 500');
    expect(graphViewBox(2)).toBe('200 125 400 250');
  });

  it('sends the classic search body and maps filters to it', () => {
    expect(searchBody({ q: 'pool', kind: 'memory', scope: 'project', projectId: PROJECT, cursor: 'c1' })).toEqual({ query: 'pool', kinds: ['memory'], scope: 'project', projectId: PROJECT, cursor: 'c1' });
    expect(searchBody({ q: 'pool' })).toEqual({ query: 'pool' });
  });

  it('shares the unfiltered list key with the registry read, so the warm prefetch is reused', () => {
    expect(knowledgeListQuery({}).queryKey).toEqual(pageReadQuery('knowledge', {}).queryKey);
    expect(knowledgeListQuery({ kind: 'journal' }).queryKey).not.toEqual(pageReadQuery('knowledge', {}).queryKey);
    expect(knowledgeSearchQuery({ q: 'a' }).queryKey).not.toEqual(knowledgeSearchQuery({ q: 'b' }).queryKey);
  });

  it('builds a strict create body with scope ids only for their scope', () => {
    expect(createBody({ ...CREATE_DEFAULTS, title: ' Pooling ', tags: 'pg, cache, pg,', content: '# Hi', projectId: PROJECT, workspaceId: WORKSPACE }))
      .toEqual({ kind: 'memory', scope: 'owner', title: 'Pooling', content: '# Hi', tags: ['pg', 'cache'], expectedGeneration: 0 });
    expect(createBody({ ...CREATE_DEFAULTS, kind: 'journal', journalType: 'decision-record', scope: 'project', projectId: PROJECT, title: 'ADR' }))
      .toEqual({ kind: 'journal', scope: 'project', projectId: PROJECT, title: 'ADR', content: '', journalType: 'decision-record', tags: [], expectedGeneration: 0 });
    expect(createBody({ ...CREATE_DEFAULTS, scope: 'workspace', workspaceId: ` ${WORKSPACE} `, title: 'W' })).toMatchObject({ scope: 'workspace', workspaceId: WORKSPACE });
  });

  it('mirrors the server bounds in the create form', () => {
    const valid = { ...CREATE_DEFAULTS, title: 'T' };
    expect(createKnowledgeSchema.safeParse(valid).success).toBe(true);
    expect(createKnowledgeSchema.safeParse({ ...valid, title: '  ' }).success).toBe(false);
    expect(createKnowledgeSchema.safeParse({ ...valid, title: 'x'.repeat(121) }).success).toBe(false);
    expect(createKnowledgeSchema.safeParse({ ...valid, tags: 'bad tag!' }).success).toBe(false);
    expect(createKnowledgeSchema.safeParse({ ...valid, tags: Array.from({ length: 17 }, (_, index) => `t${index}`).join(',') }).success).toBe(false);
    expect(createKnowledgeSchema.safeParse({ ...valid, scope: 'project' }).success).toBe(false);
    expect(createKnowledgeSchema.safeParse({ ...valid, scope: 'project', projectId: PROJECT }).success).toBe(true);
    expect(createKnowledgeSchema.safeParse({ ...valid, scope: 'workspace', workspaceId: 'ws_short' }).success).toBe(false);
    expect(parseTags(' a , ,b,a ')).toEqual(['a', 'b']);
  });
});

describe('knowledge draft restore', () => {
  it('round-trips a draft in session storage and refuses malformed records', () => {
    writeDraft('kn_x1234567890', { generation: 3, content: 'draft' });
    expect(readDraft('kn_x1234567890')).toEqual({ generation: 3, content: 'draft' });
    expect(localStorage.length).toBe(0);
    clearDraft('kn_x1234567890');
    expect(readDraft('kn_x1234567890')).toBeUndefined();
    sessionStorage.setItem('cloud-harness:knowledge-draft:kn_y1234567890', '{"generation":0,"content":"x"}');
    expect(readDraft('kn_y1234567890')).toBeUndefined();
    sessionStorage.setItem('cloud-harness:knowledge-draft:kn_y1234567890', 'not json');
    expect(readDraft('kn_y1234567890')).toBeUndefined();
    sessionStorage.clear();
  });
});
