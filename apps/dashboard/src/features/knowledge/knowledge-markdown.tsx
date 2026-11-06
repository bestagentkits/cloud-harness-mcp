import { Link } from '@tanstack/react-router';
import { Fragment, type ReactNode } from 'react';
import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';
import { cn } from '@/lib/utils';
import { MermaidDiagram } from './mermaid-diagram';

/**
 * A small Markdown subset rendered straight to React elements, never to an HTML string.
 * React escapes every text node and attribute, so a `<script>`, an `<img onerror>` or a
 * `style=` in the source is only ever text. The parser emits a fixed set of elements with
 * fixed class names; the only attribute that carries source text is a link `href`, and that
 * passes `safeHref` first (absolute http(s) or a same-site path, nothing else).
 *
 * Supported, as in the classic Dashboard renderer: headings (# to ####), paragraphs,
 * bullet and task lists, blockquotes, pipe tables, fenced code (```mermaid becomes a static
 * SVG diagram), **bold**, *italic*, `code` and [[kn_id|Label]] wikilinks; plus
 * [text](url) links.
 */

/** `href` for a Markdown link, or undefined when the target is not an http(s) URL or a same-site path. */
export function safeHref(raw: string): { href: string; external: boolean } | undefined {
  const value = raw.trim();
  // Control characters and whitespace can smuggle a scheme past naive checks (`java\tscript:`).
  // eslint-disable-next-line no-control-regex
  if (!value || /[\u0000- \u007f]/.test(value) || value.includes('\\')) return undefined;
  if (value.startsWith('/') && !value.startsWith('//')) return { href: value, external: false };
  if (value.startsWith('#')) return { href: value, external: false };
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return { href: url.href, external: true };
  } catch {
    return undefined;
  }
  return undefined;
}

const INLINE = /(`[^`]+`)|\[\[(kn_[A-Za-z0-9_-]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;

/** Inline spans of one line: code, wikilinks, links, bold and italic, in that precedence. */
export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index;
    if (start > last) out.push(text.slice(last, start));
    const key = `${keyPrefix}-${index++}`;
    const [whole, code, wikiId, wikiLabel, linkText, linkTarget, bold, italic] = match;
    if (code) {
      out.push(<code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{code.slice(1, -1)}</code>);
    } else if (wikiId) {
      out.push(RESOURCE_ID_PATTERNS.knowledgeId.test(wikiId)
        ? <Link key={key} to="/knowledge/$knowledgeId" params={{ knowledgeId: wikiId }} className="text-primary underline underline-offset-2 hover:no-underline">{wikiLabel ?? wikiId}</Link>
        : <Fragment key={key}>{wikiLabel ?? wikiId}</Fragment>);
    } else if (linkText !== undefined && linkTarget !== undefined) {
      const target = safeHref(linkTarget);
      const label = renderInline(linkText, key);
      out.push(target
        ? <a key={key} href={target.href} className="text-primary underline underline-offset-2 hover:no-underline" {...(target.external ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {})}>{label}</a>
        : <Fragment key={key}>{label}</Fragment>);
    } else if (bold) {
      out.push(<strong key={key}>{renderInline(bold, key)}</strong>);
    } else if (italic) {
      out.push(<em key={key}>{renderInline(italic, key)}</em>);
    } else {
      out.push(whole);
    }
    last = start + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function tableCells(row: string): string[] {
  return row.split('|').map((cell) => cell.trim()).slice(1, -1);
}

function MarkdownTable({ rows, keyPrefix }: { rows: string[]; keyPrefix: string }) {
  const parsed = rows.map(tableCells);
  const header = parsed[0];
  if (!header || parsed.length < 2) return <p>{rows.join('\n')}</p>;
  const body = parsed.slice(2);
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-sm">
        <thead><tr className="border-b">{header.map((cell, index) => <th key={index} scope="col" className="px-2 py-1 text-left font-medium">{renderInline(cell, `${keyPrefix}-h${index}`)}</th>)}</tr></thead>
        <tbody>{body.map((row, rowIndex) => <tr key={rowIndex} className="border-b last:border-0">{row.map((cell, index) => <td key={index} className="px-2 py-1">{renderInline(cell, `${keyPrefix}-${rowIndex}-${index}`)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

type ListItem = { text: string; task?: boolean; checked?: boolean };

/**
 * Markdown headings start at `<h3>`: the preview sits inside the page's own `<h2>` section,
 * so a `# Title` in a note never breaks the page's heading order.
 */
const HEADINGS = [
  { prefix: '#### ', Tag: 'h6', className: 'text-sm font-semibold' },
  { prefix: '### ', Tag: 'h5', className: 'text-sm font-semibold' },
  { prefix: '## ', Tag: 'h4', className: 'text-base font-semibold' },
  { prefix: '# ', Tag: 'h3', className: 'text-lg font-semibold' }
] as const;

/** Markdown source to React blocks. Empty input renders a "No content." note. */
export function renderMarkdown(source: string): ReactNode {
  if (!source.trim()) return <p className="text-sm text-muted-foreground">No content.</p>;
  const lines = source.split('\n');
  const blocks: ReactNode[] = [];
  let list: ListItem[] | null = null;
  let table: string[] | null = null;
  let code: { lang: string; lines: string[] } | null = null;

  const key = () => `b${blocks.length}`;
  const flushList = () => {
    if (!list) return;
    const items = list;
    const k = key();
    const isTask = items.some((item) => item.task);
    blocks.push(
      <ul key={k} className={isTask ? 'grid gap-1' : 'ml-5 grid list-disc gap-1'}>
        {items.map((item, index) => (
          <li key={index}>
            {item.task
              ? <label className="inline-flex items-start gap-2"><input type="checkbox" checked={item.checked ?? false} disabled readOnly className="mt-1" /><span>{renderInline(item.text, `${k}-${index}`)}</span></label>
              : renderInline(item.text, `${k}-${index}`)}
          </li>
        ))}
      </ul>
    );
    list = null;
  };
  const flushTable = () => {
    if (!table) return;
    const k = key();
    blocks.push(<MarkdownTable key={k} rows={table} keyPrefix={k} />);
    table = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      if (code) {
        const k = key();
        const text = code.lines.join('\n');
        blocks.push(code.lang.toLowerCase() === 'mermaid'
          ? <MermaidDiagram key={k} source={text} />
          : <pre key={k} className="overflow-x-auto rounded-md bg-muted p-3 text-xs"><code>{text}</code></pre>);
        code = null;
      } else {
        flushList();
        flushTable();
        code = { lang: trimmed.slice(3).trim(), lines: [] };
      }
      continue;
    }
    if (code) { code.lines.push(line); continue; }

    if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 1) {
      flushList();
      (table ??= []).push(trimmed);
      continue;
    }
    flushTable();

    if (!trimmed) { flushList(); continue; }

    const heading = HEADINGS.find((candidate) => line.startsWith(candidate.prefix));
    if (heading) {
      flushList();
      const k = key();
      blocks.push(<heading.Tag key={k} className={heading.className}>{renderInline(line.slice(heading.prefix.length), k)}</heading.Tag>);
      continue;
    }
    if (line.startsWith('> ')) {
      flushList();
      const k = key();
      blocks.push(<blockquote key={k} className="border-l-2 pl-3 text-muted-foreground">{renderInline(line.slice(2), k)}</blockquote>);
      continue;
    }
    const task = /^- \[( |x)\] (.*)$/.exec(trimmed);
    if (task) {
      (list ??= []).push({ text: task[2] ?? '', task: true, checked: task[1] === 'x' });
      continue;
    }
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      (list ??= []).push({ text: trimmed.slice(2) });
      continue;
    }
    flushList();
    const k = key();
    blocks.push(<p key={k}>{renderInline(line, k)}</p>);
  }
  // An unterminated fence still renders as code (never as Markdown).
  if (code) {
    const pending: { lang: string; lines: string[] } = code;
    blocks.push(<pre key={key()} className="overflow-x-auto rounded-md bg-muted p-3 text-xs"><code>{pending.lines.join('\n')}</code></pre>);
  }
  flushList();
  flushTable();
  return blocks;
}

/** The rendered preview container: prose spacing through classes only. */
export function MarkdownView({ source, className }: { source: string; className?: string }) {
  return <div className={cn('grid gap-3 text-sm leading-relaxed break-words', className)}>{renderMarkdown(source)}</div>;
}
