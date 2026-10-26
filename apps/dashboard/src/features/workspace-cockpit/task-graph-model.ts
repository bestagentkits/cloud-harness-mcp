/**
 * The task dependency graph's layout (`GET /workspaces/:id/tasks/graph`), ported from the
 * classic `taskGraphLayout` (`apps/api/dashboard/dashboard-render.js`). Nodes are laid out
 * by dependency depth; the walk is cycle-guarded so a malformed graph cannot hang it, and
 * an edge to an unknown node is simply not drawn.
 */
import type { RuntimeTask } from './runtime-model';

export type TaskGraphEdge = { from: string; to: string };
export type TaskGraph = { nodes: RuntimeTask[]; edges: TaskGraphEdge[] };
export type TaskGraphLayout = {
  nodes: RuntimeTask[];
  edges: TaskGraphEdge[];
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
};

export const NODE_WIDTH = 190;
export const NODE_HEIGHT = 60;
const COLUMN = 240;
const ROW = 92;
const MARGIN = 20;

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];
}

export function taskGraphOf(data: unknown): TaskGraph {
  const body = (data ?? {}) as { nodes?: unknown; edges?: unknown };
  return {
    nodes: records(body.nodes).filter((node) => typeof node.id === 'string') as RuntimeTask[],
    edges: records(body.edges)
      .filter((edge) => typeof edge.from === 'string' && typeof edge.to === 'string')
      .map((edge) => ({ from: edge.from as string, to: edge.to as string }))
  };
}

export function taskGraphLayout({ nodes, edges }: TaskGraph): TaskGraphLayout {
  const known = new Set(nodes.map((node) => node.id));
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const parents = edges.filter((edge) => edge.to === id && known.has(edge.from)).map((edge) => edge.from);
    const value = parents.length ? Math.max(...parents.map((parent) => depthOf(parent, seen) + 1)) : 0;
    depth.set(id, value);
    return value;
  };
  for (const node of nodes) depthOf(node.id, new Set());
  const layers: RuntimeTask[][] = [];
  for (const node of nodes) {
    const level = depth.get(node.id) ?? 0;
    (layers[level] ??= []).push(node);
  }
  const positions = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, level) => layer.forEach((node, index) => positions.set(node.id, { x: MARGIN + level * COLUMN, y: MARGIN + index * ROW })));
  const tallest = Math.max(1, ...layers.map((layer) => layer?.length ?? 0));
  return {
    nodes,
    edges: edges.filter((edge) => positions.has(edge.from) && positions.has(edge.to)),
    positions,
    width: Math.max(340, layers.length * COLUMN + MARGIN),
    height: Math.max(120, tallest * ROW + MARGIN)
  };
}
