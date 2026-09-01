import { describe, it, expect } from 'vitest';
import {
  renderMarkdown,
  renderMermaidSvg,
  renderKnowledgeIndex,
  renderKnowledgeDetail,
  renderKnowledgeGraph
} from '../dashboard/dashboard-render.js';

describe('Knowledge Dashboard UI Renderers', () => {
  it('renders rich Markdown with headings, tables, task-lists, and wikilinks', () => {
    const md = `
# Main Heading
## Sub Heading
A paragraph with **bold** and *italic* text and \`code\`.

- [ ] Task 1
- [x] Task 2 completed

| Col 1 | Col 2 |
|---|---|
| Val 1 | Val 2 |

Referencing [[kn_mem1234567890|Cache Architecture]] doc.
`;
    const html = renderMarkdown(md);
    expect(html).toContain('<h1>Main Heading</h1>');
    expect(html).toContain('<h2>Sub Heading</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<input type="checkbox"  disabled>');
    expect(html).toContain('<input type="checkbox" checked disabled>');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>Val 1</td>');
    expect(html).toContain('href="/dashboard/knowledge/kn_mem1234567890"');
    expect(html).toContain('>Cache Architecture</a>');
    expect(html).toContain('>Cache Architecture</a>');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('<style>');
  });

  it('renders Mermaid diagrams into CSP-safe SVG with zero <style> tags and zero inline styles', () => {
    const mermaidCode = `
graph TD
  A[Client] --> B[API Server]
  B --> C[SQLite Store]
`;
    const svgHtml = renderMermaidSvg(mermaidCode);
    expect(svgHtml).toContain('<svg');
    expect(svgHtml).toContain('Client');
    expect(svgHtml).toContain('API Server');
    expect(svgHtml).toContain('SQLite Store');
    expect(svgHtml).not.toContain('<style>');
    expect(svgHtml).not.toContain('style=');
    expect(svgHtml).toContain('class="mermaid-node"');
    expect(svgHtml).toContain('class="mermaid-edge"');
  });

  it('renders Knowledge index with tabs and relevance badges', () => {
    const data = {
      results: [
        {
          item: {
            id: 'kn_mem1234567890',
            kind: 'memory',
            scope: 'owner',
            title: 'Test Note',
            content: 'Test content',
            tags: ['test', 'arch'],
            generation: 1,
            updatedAt: 1725177600000
          },
          relevancePercent: 96,
          matchMode: 'hybrid'
        }
      ]
    };
    const html = renderKnowledgeIndex(data, {}, 'all');
    expect(html).toContain('Knowledge Plane');
    expect(html).toContain('Test Note');
    expect(html).toContain('HYBRID 96%');
    expect(html).toContain('test');
    expect(html).toContain('arch');
    expect(html).toContain('arch');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('<style>');
  });

  it('renders Knowledge detail with split editor/preview and backlinks', () => {
    const item = {
      id: 'kn_mem1234567890',
      kind: 'memory',
      scope: 'owner',
      title: 'Detailed Doc',
      content: '# Detailed Doc\nSome text here.',
      generation: 2,
      createdAt: 1000,
      updatedAt: 2000,
      tags: ['doc'],
      outboundLinks: [{ id: 'knl_1', sourceId: 'kn_mem1234567890', targetId: 'kn_jnl1234567890', relation: 'references', origin: 'wikilink', createdAt: 1000, generation: 1 }],
      backlinks: [{ id: 'knl_2', sourceId: 'kn_mem9876543210', targetId: 'kn_mem1234567890', relation: 'supports', origin: 'manual', createdAt: 1000, generation: 1 }]
    };
    const html = renderKnowledgeDetail(item);
    expect(html).toContain('Detailed Doc');
    expect(html).toContain('id="knowledge-editor-input"');
    expect(html).toContain('id="knowledge-preview-output"');
    expect(html).toContain('Outgoing Relations');
    expect(html).toContain('kn_jnl1234567890');
    expect(html).toContain('Backlinks');
    expect(html).toContain('kn_mem9876543210');
    expect(html).toContain('kn_mem9876543210');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('<style>');
  });

  it('renders Knowledge Graph with SVG nodes and accessible fallback', () => {
    const graphData = {
      nodes: [
        { id: 'kn_1', kind: 'memory', scope: 'owner', title: 'Node 1', tags: ['t1'], updatedAt: 1000 },
        { id: 'kn_2', kind: 'journal', scope: 'project', title: 'Node 2', journalType: 'engineering-log', tags: ['t2'], updatedAt: 2000 }
      ],
      edges: [
        { id: 'knl_1', sourceId: 'kn_1', targetId: 'kn_2', relation: 'references', origin: 'manual' }
      ],
      truncated: false
    };
    const html = renderKnowledgeGraph(graphData);
    expect(html).toContain('<svg class="knowledge-graph-svg"');
    expect(html).toContain('data-node-id="kn_1"');
    expect(html).toContain('data-node-id="kn_2"');
    expect(html).toContain('Accessible Graph Edge List');
    expect(html).toContain('<strong>kn_1</strong> references <strong>kn_2</strong>');
    expect(html).toContain('<strong>kn_1</strong> references <strong>kn_2</strong>');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('<style>');
  });
});
