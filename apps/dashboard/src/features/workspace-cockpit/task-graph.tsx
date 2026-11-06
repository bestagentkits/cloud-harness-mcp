import { useQuery } from '@tanstack/react-query';
import { AsyncStatus } from '@/components/feedback/async-status';
import { Section } from '@/components/data/section';
import { bffPath, bffQuery } from '@/lib/bff-query';
import { taskDuration, taskStatusLabel } from './runtime-model';
import { NODE_HEIGHT, NODE_WIDTH, taskGraphLayout, taskGraphOf } from './task-graph-model';

const STATE_STROKE: Record<string, string> = {
  succeeded: 'stroke-success',
  failed: 'stroke-destructive',
  timedOut: 'stroke-destructive',
  running: 'stroke-primary'
};

/**
 * The task dependency graph (classic `renderTaskGraph`). Each node writes its state as
 * text, so colour is never the only signal; nodes are focusable list items whose label
 * carries the full description, and the task table beside it is the text fallback. Loaded
 * lazily by the Runtime tab so the graph never weighs on the tab's first paint.
 */
export default function TaskGraph({ workspaceId }: { workspaceId: string }) {
  const read = useQuery(bffQuery<unknown>(`${bffPath('workspaces', workspaceId)}/tasks/graph`, {}));
  return (
    <Section title="Task graph" description="Dependencies between the workspace's tasks, by run order.">
      <AsyncStatus query={read} label="task graph">
        {(body) => {
          const layout = taskGraphLayout(taskGraphOf(body.data));
          if (!layout.nodes.length) return <p className="text-sm text-muted-foreground">No tasks have run in this workspace yet.</p>;
          const now = read.dataUpdatedAt;
          return (
            <figure className="grid gap-2">
              <div className="overflow-x-auto rounded-md border bg-muted/30">
                <svg viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} role="list" aria-label="Task dependency graph" data-testid="task-graph">
                  {layout.edges.map((edge) => {
                    const from = layout.positions.get(edge.from);
                    const to = layout.positions.get(edge.to);
                    if (!from || !to) return null;
                    return <line key={`${edge.from}->${edge.to}`} aria-hidden="true" className="stroke-muted-foreground" strokeWidth={1.5} x1={from.x + NODE_WIDTH} y1={from.y + NODE_HEIGHT / 2} x2={to.x} y2={to.y + NODE_HEIGHT / 2} />;
                  })}
                  {layout.nodes.map((node) => {
                    const spot = layout.positions.get(node.id) ?? { x: 0, y: 0 };
                    const name = node.name ?? node.id;
                    const state = taskStatusLabel(node.status);
                    const duration = taskDuration(node, now);
                    return (
                      <g key={node.id} transform={`translate(${spot.x},${spot.y})`} tabIndex={0} role="listitem" aria-label={`${name}: ${state}, ${duration}, exit ${node.exitCode ?? 'none'}`} className="outline-none [&:focus-visible>rect]:stroke-ring [&:focus-visible>rect]:stroke-[3]">
                        <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx={6} className={`fill-card ${STATE_STROKE[String(node.status)] ?? 'stroke-border'}`} strokeWidth={1.5} />
                        <text x={10} y={24} className="fill-foreground text-[13px] font-medium">{name.length > 24 ? `${name.slice(0, 23)}…` : name}</text>
                        <text x={10} y={44} className="fill-muted-foreground text-xs">{`${state} · ${duration}`}</text>
                      </g>
                    );
                  })}
                </svg>
              </div>
              <figcaption className="text-xs text-muted-foreground">Node state is written in each node; the task table below carries the same facts.</figcaption>
            </figure>
          );
        }}
      </AsyncStatus>
    </Section>
  );
}
