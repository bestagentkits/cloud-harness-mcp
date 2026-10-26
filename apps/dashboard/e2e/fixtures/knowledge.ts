/** Realistic knowledge projections (`knowledgeItemKeys`, search results, graph) for the Knowledge pages. */
export const ENTRY_ID = 'kn_mem1234567890';
export const JOURNAL_ID = 'kn_jnl1234567890';
export const PROJECT_ID = `prj_${'a'.repeat(24)}`;

const now = Date.now();

export const memoryEntry = {
  id: ENTRY_ID, kind: 'memory', scope: 'owner', projectId: null, workspaceId: null, title: 'Cache architecture',
  content: '# Cache architecture\nWe use **write-through** caching. See [[kn_jnl1234567890|the decision]].\n\n- [x] Measured\n- [ ] Tuned\n\n<script>window.__pwned = 1</script>\n<img src=x onerror="window.__pwned = 1">\n[bad](javascript:alert(1))',
  contentSha256: 'a'.repeat(64), journalType: null, occurredAt: null, generation: 2, createdAt: now - 86_400_000, updatedAt: now - 3_600_000, expiresAt: null,
  tags: ['cache', 'arch'], provenance: null,
  outboundLinks: [{ id: 'knl_out1234567890', sourceId: ENTRY_ID, targetId: JOURNAL_ID, relation: 'references', origin: 'wikilink', generation: 1, createdAt: now }],
  backlinks: []
};

export const journalEntry = {
  ...memoryEntry, id: JOURNAL_ID, kind: 'journal', scope: 'project', projectId: PROJECT_ID, title: 'Use write-through', journalType: 'decision-record',
  content: 'Decision: write-through.', generation: 1, tags: ['adr'], outboundLinks: [], backlinks: []
};

export const knowledgeList = { data: { items: [memoryEntry, journalEntry] }, truncated: false, cursor: 'next.page-2' };
export const knowledgePage2 = { data: { items: [{ ...journalEntry, id: 'kn_old1234567890', title: 'Older note' }] }, truncated: false };
export const knowledgeSearch = { data: { results: [{ item: memoryEntry, relevancePercent: 96, matchMode: 'hybrid' }] }, truncated: false };
export const knowledgeGraph = {
  data: {
    nodes: [
      { id: ENTRY_ID, kind: 'memory', scope: 'owner', title: 'Cache architecture', tags: ['cache'], updatedAt: now },
      { id: JOURNAL_ID, kind: 'journal', scope: 'project', title: 'Use write-through', journalType: 'decision-record', tags: [], updatedAt: now }
    ],
    edges: [{ id: 'knl_out1234567890', sourceId: ENTRY_ID, targetId: JOURNAL_ID, relation: 'references', origin: 'wikilink', generation: 1, createdAt: now }],
    truncated: false
  },
  truncated: false
};
export const projectsForDialog = { data: { projects: [{ id: PROJECT_ID, name: 'Rocket', state: 'ACTIVE', generation: 2 }] } };
