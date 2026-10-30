import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownView, safeHref } from './knowledge-markdown';
import { parseMermaid } from './mermaid-diagram';

// The router `Link` needs a router; a plain anchor with the resolved path is enough here.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, className }: { to: string; params: Record<string, string>; children: ReactNode; className?: string }) => (
    <a className={className} href={`/dashboard${to.replace('$knowledgeId', params.knowledgeId ?? '')}`}>{children}</a>
  )
}));

function renderPreview(source: string) {
  return render(<MarkdownView source={source} />).container;
}

/** Every attribute name and value in the rendered subtree. */
function attributes(root: Element): Array<[string, string]> {
  return [root, ...root.querySelectorAll('*')].flatMap((element) => [...element.attributes].map((attribute): [string, string] => [attribute.name, attribute.value]));
}

describe('knowledge Markdown preview', () => {
  it('renders the supported subset as elements with roles and text', () => {
    renderPreview([
      '# Main Heading',
      '## Sub Heading',
      'A paragraph with **bold** and *italic* text and `code`.',
      '',
      '- [ ] Task 1',
      '- [x] Task 2 completed',
      '',
      '| Col 1 | Col 2 |',
      '|---|---|',
      '| Val 1 | Val 2 |',
      '',
      'Referencing [[kn_mem1234567890|Cache Architecture]] doc and [the docs](https://example.com/guide).'
    ].join('\n'));
    expect(screen.getByRole('heading', { name: 'Main Heading', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sub Heading', level: 4 })).toBeInTheDocument();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('italic').tagName).toBe('EM');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getByRole('checkbox', { name: 'Task 1' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Task 2 completed' })).toBeChecked();
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Col 1' })).toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: 'Val 1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cache Architecture' })).toHaveAttribute('href', '/dashboard/knowledge/kn_mem1234567890');
    const external = screen.getByRole('link', { name: 'the docs' });
    expect(external).toHaveAttribute('href', 'https://example.com/guide');
    expect(external).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  });

  it('escapes hostile markup: it stays text and never becomes an element, handler or style', () => {
    const hostile = [
      '<script>window.__pwned = 1</script>',
      '<img src=x onerror="window.__pwned = 1">',
      '<div style="background:url(javascript:alert(1))">styled</div>',
      '<style>body { display: none }</style>',
      '# <svg onload=alert(1)>',
      '[click](javascript:alert(1))',
      '[tab](java\tscript:alert(1))',
      '[data](data:text/html;base64,PHNjcmlwdD4=)',
      '[proto](//evil.example/x)',
      '**<iframe src="https://evil.example">**',
      '| <b onmouseover=alert(1)>x</b> | y |',
      '|---|---|',
      '| `<script>` | [[kn_<script>]] |',
      '```mermaid',
      'A[<script>alert(1)</script>] --> B[ok]',
      '```'
    ].join('\n');
    const root = renderPreview(hostile);
    expect(root.querySelectorAll('script, img, iframe, style, object, embed, b, svg[onload], foreignObject')).toHaveLength(0);
    expect(root.querySelectorAll('[style]')).toHaveLength(0);
    for (const [name, value] of attributes(root)) {
      expect(name.startsWith('on'), `${name} handler`).toBe(false);
      expect(/^\s*(javascript|data|vbscript):/i.test(value), `${name}=${value}`).toBe(false);
    }
    // Every link left is http(s) or a same-site path.
    for (const link of root.querySelectorAll('a')) expect(link.getAttribute('href')).toMatch(/^(https?:\/\/|\/(?!\/))/);
    // The payload is visible as text, escaped.
    expect(root.textContent).toContain('<script>window.__pwned = 1</script>');
    expect(root.innerHTML).toContain('&lt;img src=x onerror="window.__pwned = 1"&gt;');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('accepts only http(s) and same-site link targets', () => {
    expect(safeHref('https://example.com/a?b=1')).toEqual({ href: 'https://example.com/a?b=1', external: true });
    expect(safeHref('/dashboard/knowledge')).toEqual({ href: '/dashboard/knowledge', external: false });
    for (const refused of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:alert(1)', 'java\nscript:x', 'data:text/html,x', 'vbscript:x', '//evil.example', '/\\evil.example', 'mailto:a@b.c', 'relative/path', '']) {
      expect(safeHref(refused), refused).toBeUndefined();
    }
  });

  it('renders an empty note for blank content and keeps an unterminated fence as code', () => {
    expect(renderPreview('   ').textContent).toBe('No content.');
    const root = renderPreview('```\n**not bold**');
    expect(root.querySelector('pre code')?.textContent).toBe('**not bold**');
    expect(root.querySelector('strong')).toBeNull();
  });

  it('draws a mermaid flowchart as an SVG image with a text alternative', () => {
    renderPreview('```mermaid\ngraph TD\n  A[Client] --> B[API Server]\n  B --> C[SQLite Store]\n```');
    const diagram = screen.getByRole('img', { name: /Client to API Server; API Server to SQLite Store/ });
    expect(diagram.querySelectorAll('[data-mermaid=node]')).toHaveLength(3);
    expect(diagram.querySelectorAll('[data-mermaid=edge]')).toHaveLength(2);
    expect(diagram.querySelectorAll('[style], style')).toHaveLength(0);
    expect(parseMermaid('sequenceDiagram\nfoo')).toEqual({ nodes: [], edges: [] });
  });
});
