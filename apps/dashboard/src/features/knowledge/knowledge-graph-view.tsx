import { Link, useNavigate } from '@tanstack/react-router';
import { MinusIcon, PlusIcon, RotateCcwIcon, WaypointsIcon } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { EmptyState } from '@/components/feedback/empty-state';
import { TruncationNotice } from '@/components/data/truncation-notice';
import { Button } from '@/components/ui/button';
import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';
import { itemTitle, type KnowledgeGraph } from './knowledge-model';

const WIDTH = 800;
const HEIGHT = 500;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

/** Nodes on a circle, as the classic graph laid them out. */
export function layoutGraph(graph: KnowledgeGraph) {
  const radius = Math.min(WIDTH, HEIGHT) * 0.38;
  return graph.nodes.map((node, index) => {
    const angle = (index / Math.max(graph.nodes.length, 1)) * 2 * Math.PI;
    return { ...node, x: WIDTH / 2 + radius * Math.cos(angle), y: HEIGHT / 2 + radius * Math.sin(angle) };
  });
}

/** The visible region for a zoom level, centred: zoom changes the `viewBox`, never a CSS transform. */
export function graphViewBox(zoom: number): string {
  const width = WIDTH / zoom;
  const height = HEIGHT / zoom;
  return `${(WIDTH - width) / 2} ${(HEIGHT - height) / 2} ${width} ${height}`;
}

/**
 * The knowledge graph. Every node is a keyboard-reachable button (Tab to it, Enter or Space
 * opens the entry, as in the classic graph); zoom works on the SVG `viewBox`, so nothing
 * needs an inline style. The edge list below is the text alternative of the drawing.
 */
export function KnowledgeGraphView({ graph }: { graph: KnowledgeGraph }) {
  const navigate = useNavigate();
  const [zoom, setZoom] = useState(1);
  if (!graph.nodes.length) {
    return <EmptyState icon={WaypointsIcon} title="The knowledge graph is empty" description="Create memories, journals, or links between them to see their relationships." />;
  }
  const nodes = layoutGraph(graph);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const titleOf = (id: string | undefined) => { const node = id ? byId.get(id) : undefined; return node ? itemTitle(node) : id ?? '—'; };
  const open = (id: string) => {
    if (RESOURCE_ID_PATTERNS.knowledgeId.test(id)) void navigate({ to: '/knowledge/$knowledgeId', params: { knowledgeId: id } });
  };
  const onKeyDown = (event: KeyboardEvent<SVGGElement>, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(id); }
  };

  return (
    <div className="grid gap-3 animate-in fade-in-0 motion-reduce:animate-none">
      <TruncationNotice truncated={graph.truncated} what="graph nodes" />
      <div className="flex items-center justify-end gap-1" role="group" aria-label="Graph zoom">
        <Button size="icon" variant="outline" aria-label="Zoom out" disabled={zoom <= ZOOM_MIN} onClick={() => setZoom((value) => Math.max(value / 1.25, ZOOM_MIN))}><MinusIcon aria-hidden="true" /></Button>
        <Button size="icon" variant="outline" aria-label="Zoom in" disabled={zoom >= ZOOM_MAX} onClick={() => setZoom((value) => Math.min(value * 1.25, ZOOM_MAX))}><PlusIcon aria-hidden="true" /></Button>
        <Button size="sm" variant="outline" disabled={zoom === 1} onClick={() => setZoom(1)}><RotateCcwIcon aria-hidden="true" />Reset view</Button>
      </div>
      <div className="overflow-hidden rounded-lg border bg-surface">
        <svg viewBox={graphViewBox(zoom)} className="h-auto w-full transition-all duration-(--motion-base)" role="group" aria-label={`Knowledge graph: ${nodes.length} entries, ${graph.edges.length} links`}>
          {graph.edges.map((edge) => {
            const from = edge.sourceId ? byId.get(edge.sourceId) : undefined;
            const to = edge.targetId ? byId.get(edge.targetId) : undefined;
            return from && to ? <line key={edge.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className="stroke-border" strokeWidth="1.5" aria-hidden="true" /> : null;
          })}
          {nodes.map((node) => {
            const title = itemTitle(node);
            return (
              <g key={node.id} transform={`translate(${node.x} ${node.y})`}>
                <g
                  role="button"
                  tabIndex={0}
                  aria-label={`Open ${title}`}
                  className="group cursor-pointer outline-none"
                  onClick={() => open(node.id)}
                  onKeyDown={(event) => onKeyDown(event, node.id)}
                  data-node-id={node.id}
                >
                  <circle r="9" className="fill-primary stroke-surface transition-colors group-hover:fill-info group-focus-visible:stroke-ring" strokeWidth="3" />
                </g>
                {/* The visible caption sits outside the button: it is a truncated copy of the button's name. */}
                <text y="24" textAnchor="middle" aria-hidden="true" className="pointer-events-none fill-foreground text-xs">{title.length > 16 ? `${title.slice(0, 16)}…` : title}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <details className="rounded-lg border bg-surface p-3 text-sm">
        <summary className="cursor-pointer font-medium">Entries and links as a list ({nodes.length} entries, {graph.edges.length} links)</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <ul className="grid gap-1" aria-label="Graph entries">
            {nodes.map((node) => (
              <li key={node.id}>
                {RESOURCE_ID_PATTERNS.knowledgeId.test(node.id)
                  ? <Link to="/knowledge/$knowledgeId" params={{ knowledgeId: node.id }} className="underline hover:no-underline">{itemTitle(node)}</Link>
                  : itemTitle(node)}
              </li>
            ))}
          </ul>
          <ul className="grid gap-1" aria-label="Graph links">
            {graph.edges.length === 0 ? <li className="text-muted-foreground">No links.</li> : graph.edges.map((edge) => (
              <li key={edge.id}><strong>{titleOf(edge.sourceId)}</strong> {edge.relation ?? 'relates to'} <strong>{titleOf(edge.targetId)}</strong>{edge.origin ? <span className="text-muted-foreground"> ({edge.origin})</span> : null}</li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}
