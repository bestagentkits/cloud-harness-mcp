import { useId } from 'react';

type MermaidNode = { id: string; label: string };
type MermaidGraph = { nodes: MermaidNode[]; edges: Array<{ from: string; to: string }> };

const ARROW = /^([A-Za-z0-9_-]+)(?:\[([^\]]+)\])?\s*-->\s*([A-Za-z0-9_-]+)(?:\[([^\]]+)\])?$/;
const SINGLE = /^([A-Za-z0-9_-]+)\[([^\]]+)\]$/;
/** Bounds what a pasted diagram can make the page lay out. */
const MAX_NODES = 60;

/**
 * The flowchart subset the classic renderer understood (`A[Label] --> B[Label]` and lone
 * `A[Label]` lines). Anything else is ignored; no nodes means the source shows as code.
 */
export function parseMermaid(source: string): MermaidGraph {
  const nodes: MermaidNode[] = [];
  const edges: MermaidGraph['edges'] = [];
  const add = (id: string, label: string | undefined) => {
    if (nodes.length < MAX_NODES && !nodes.some((node) => node.id === id)) nodes.push({ id, label: label ?? id });
  };
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line || /^(graph|flowchart)\b|^sequenceDiagram|^%%/.test(line)) continue;
    const arrow = ARROW.exec(line);
    if (arrow) {
      const [, from = '', fromLabel, to = '', toLabel] = arrow;
      add(from, fromLabel);
      add(to, toLabel);
      edges.push({ from, to });
      continue;
    }
    const single = SINGLE.exec(line);
    if (single) add(single[1] ?? '', single[2]);
  }
  return { nodes, edges };
}

const NODE_W = 140;
const NODE_H = 40;
const GAP_X = 180;
const GAP_Y = 80;

/**
 * A static SVG for a ```mermaid block. Geometry is SVG attributes and colours are classes,
 * so the diagram needs no inline style and no runtime stylesheet (strict CSP). The labels
 * are text nodes; the diagram is an image with a text alternative listing its edges.
 */
export function MermaidDiagram({ source }: { source: string }) {
  const markerId = useId().replace(/:/g, '');
  const graph = parseMermaid(source);
  if (!graph.nodes.length) return <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs"><code>{source}</code></pre>;
  const placed = graph.nodes.map((node, index) => ({ ...node, x: 20 + (index % 3) * GAP_X, y: 20 + Math.floor(index / 3) * GAP_Y }));
  const byId = new Map(placed.map((node) => [node.id, node]));
  const width = 40 + Math.min(placed.length, 3) * GAP_X;
  const height = 40 + Math.ceil(placed.length / 3) * GAP_Y;
  const description = graph.edges.length
    ? graph.edges.map((edge) => `${byId.get(edge.from)?.label ?? edge.from} to ${byId.get(edge.to)?.label ?? edge.to}`).join('; ')
    : placed.map((node) => node.label).join(', ');
  return (
    <figure className="overflow-x-auto rounded-md border bg-surface p-2">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full max-w-2xl" role="img" aria-label={`Diagram: ${description}`}>
        <defs>
          <marker id={markerId} viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 8 5 L 0 9 z" className="fill-muted-foreground" />
          </marker>
        </defs>
        {graph.edges.map((edge, index) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          if (!from || !to) return null;
          const x1 = from.x + NODE_W / 2;
          const y1 = from.y + NODE_H;
          const x2 = to.x + NODE_W / 2;
          const y2 = to.y;
          const mid = (y1 + y2) / 2;
          return <path key={index} d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`} className="fill-none stroke-muted-foreground" strokeWidth="1.5" markerEnd={`url(#${markerId})`} data-mermaid="edge" />;
        })}
        {placed.map((node) => (
          <g key={node.id} transform={`translate(${node.x} ${node.y})`} data-mermaid="node">
            <rect width={NODE_W} height={NODE_H} rx="4" className="fill-muted stroke-border" />
            <text x={NODE_W / 2} y={NODE_H / 2 + 4} textAnchor="middle" className="fill-foreground text-xs">{node.label.length > 20 ? `${node.label.slice(0, 19)}…` : node.label}</text>
          </g>
        ))}
      </svg>
    </figure>
  );
}
