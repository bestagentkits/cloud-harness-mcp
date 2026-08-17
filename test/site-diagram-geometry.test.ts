import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Point = [number, number];
type Rect = { x: number; y: number; width: number; height: number; tag: string };
type EdgeContract = {
  source: string;
  sourceSide: string;
  target: string;
  targetSide: string;
  via?: string[];
  start: Point;
  end: Point;
  d: string;
};

const page = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const edges: Record<string, EdgeContract> = {
  'hero-request': { source: 'hero-owner', sourceSide: 'right', target: 'hero-workspace', targetSide: 'left', via: ['hero-runner'], start: [144, 205], end: [360, 205], d: 'M144 205 H360' },
  'hero-result': { source: 'hero-workspace', sourceSide: 'bottom', target: 'hero-owner', targetSide: 'bottom', via: ['hero-runner'], start: [415, 244], end: [96, 244], d: 'M415 244 V268 H272 V236 H176 V268 H96 V244' },
  'process-request': { source: 'process-owner', sourceSide: 'right', target: 'process-runner', targetSide: 'left', via: ['process-ingress', 'process-api'], start: [192, 234], end: [622, 234], d: 'M192 234 H622' },
  'process-result': { source: 'process-executor', sourceSide: 'bottom', target: 'process-owner', targetSide: 'bottom', via: ['process-runner', 'process-api', 'process-ingress'], start: [1002, 220], end: [131, 288], d: 'M1002 220 V232 H794 V266 H218 V320 H131 V288' },
  'process-execute': { source: 'process-runner', sourceSide: 'top', target: 'process-executor', targetSide: 'left', start: [694, 204], end: [920, 178], d: 'M694 204 V178 H920' },
  'workflow-open': { source: 'workflow-open-node', sourceSide: 'right', target: 'workflow-work', targetSide: 'left', start: [224, 232], end: [460, 232], d: 'M224 232 H460' },
  'workflow-close': { source: 'workflow-work', sourceSide: 'left', target: 'workflow-close-node', targetSide: 'right', start: [460, 264], end: [224, 404], d: 'M460 264 H380 V404 H224' },
  'workflow-loop': { source: 'workflow-work', sourceSide: 'bottom', target: 'workflow-work', targetSide: 'bottom', start: [615, 286], end: [512, 286], d: 'M615 286 C700 304 700 408 615 426 C530 444 482 370 512 286' },
  'workflow-transfer': { source: 'workflow-work', sourceSide: 'right', target: 'workflow-origin', targetSide: 'top', via: ['workflow-helper'], start: [666, 234], end: [1070, 140], d: 'M666 234 H836 V182 H1016 V116 H1070 V140' },
  'workflow-transfer-result': { source: 'workflow-origin', sourceSide: 'bottom', target: 'workflow-work', targetSide: 'bottom', via: ['workflow-helper'], start: [1070, 224], end: [563, 286], d: 'M1070 224 V254 H1040 V240 H1016 V200 H852 V320 H563 V286' },
  'architecture-request': { source: 'architecture-owner', sourceSide: 'right', target: 'architecture-executor', targetSide: 'left', via: ['architecture-ingress', 'architecture-api', 'architecture-runner'], start: [136, 244], end: [892, 244], d: 'M136 244 H892' },
  'architecture-result': { source: 'architecture-executor', sourceSide: 'bottom', target: 'architecture-owner', targetSide: 'bottom', via: ['architecture-runner', 'architecture-api', 'architecture-ingress'], start: [975, 300], end: [84, 300], d: 'M975 300 V334 H816 V274 H182 V334 H84 V300' },
  'architecture-state': { source: 'architecture-runner', sourceSide: 'bottom', target: 'architecture-state-node', targetSide: 'top', start: [584, 300], end: [511, 382], d: 'M584 300 V350 H511 V382' },
  'architecture-docker': { source: 'architecture-runner', sourceSide: 'bottom', target: 'architecture-docker-node', targetSide: 'top', start: [620, 300], end: [722, 382], d: 'M620 300 V350 H722 V382' },
  'architecture-helper': { source: 'architecture-runner', sourceSide: 'bottom', target: 'architecture-helper-node', targetSide: 'top', start: [656, 300], end: [640, 466], d: 'M656 300 V350 H640 V466' },
  'architecture-github': { source: 'architecture-helper-node', sourceSide: 'bottom', target: 'architecture-github-node', targetSide: 'left', start: [695, 540], end: [978, 618], d: 'M695 540 V618 H978' },
};

function attribute(tag: string, name: string) {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

function tags(pattern: RegExp) {
  return [...page.matchAll(pattern)].map((match) => match[0]);
}

const nodeTags = tags(/<g\b[^>]*data-node="[^"]+"[^>]*>[\s\S]*?<\/g>/g);
const nodes = new Map(nodeTags.map((tag) => {
  const rect = tag.match(/<rect\b[^>]*>/)?.[0];
  if (!rect) throw new Error('Diagram node is missing its rectangle');
  return [attribute(tag, 'data-node')!, {
    x: Number(attribute(rect, 'x')),
    y: Number(attribute(rect, 'y')),
    width: Number(attribute(rect, 'width')),
    height: Number(attribute(rect, 'height')),
    tag,
  } satisfies Rect];
}));
const edgeTags = tags(/<path\b[^>]*data-edge="[^"]+"[^>]*>/g);
const edgeById = new Map(edgeTags.map((tag) => [attribute(tag, 'data-edge')!, tag]));
const animatedEdges = ['architecture-helper', 'architecture-request', 'architecture-result', 'hero-request', 'hero-result', 'process-execute', 'process-request', 'process-result', 'workflow-close', 'workflow-open', 'workflow-transfer'];

function samplePath(d: string) {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+/g) ?? [];
  const points: Point[] = [];
  let command = '', index = 0, x = 0, y = 0;
  const number = () => Number(tokens[index++]);
  const line = (nextX: number, nextY: number) => {
    const fromX = x, fromY = y;
    for (let step = 1; step <= 20; step++) points.push([fromX + (nextX - fromX) * step / 20, fromY + (nextY - fromY) * step / 20]);
    x = nextX; y = nextY;
  };
  while (index < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[index])) command = tokens[index++];
    if (command === 'M') { x = number(); y = number(); points.push([x, y]); command = 'L'; }
    else if (command === 'L') line(number(), number());
    else if (command === 'H') line(number(), y);
    else if (command === 'V') line(x, number());
    else if (command === 'C') {
      const fromX = x, fromY = y, c1x = number(), c1y = number(), c2x = number(), c2y = number(), nextX = number(), nextY = number();
      for (let step = 1; step <= 32; step++) {
        const t = step / 32, u = 1 - t;
        points.push([u ** 3 * fromX + 3 * u ** 2 * t * c1x + 3 * u * t ** 2 * c2x + t ** 3 * nextX, u ** 3 * fromY + 3 * u ** 2 * t * c1y + 3 * u * t ** 2 * c2y + t ** 3 * nextY]);
      }
      x = nextX; y = nextY;
    } else throw new Error(`Unsupported path command ${command}`);
  }
  return points;
}

function onSide([x, y]: Point, rect: Rect, side: string) {
  const withinX = x >= rect.x && x <= rect.x + rect.width;
  const withinY = y >= rect.y && y <= rect.y + rect.height;
  if (side === 'left') return x === rect.x && withinY;
  if (side === 'right') return x === rect.x + rect.width && withinY;
  if (side === 'top') return y === rect.y && withinX;
  return y === rect.y + rect.height && withinX;
}

function strictlyInside([x, y]: Point, rect: Rect) {
  return x > rect.x + 0.01 && x < rect.x + rect.width - 0.01 && y > rect.y + 0.01 && y < rect.y + rect.height - 0.01;
}

describe('site diagram geometry', () => {
  it('matches the locked topology and boundary anchors', () => {
    expect([...edgeById.keys()].filter((id) => !id.endsWith('blocked-egress')).sort()).toEqual(Object.keys(edges).sort());
    for (const [id, contract] of Object.entries(edges)) {
      const tag = edgeById.get(id)!;
      expect(attribute(tag, 'data-source')).toBe(contract.source);
      expect(attribute(tag, 'data-source-side')).toBe(contract.sourceSide);
      expect(attribute(tag, 'data-target')).toBe(contract.target);
      expect(attribute(tag, 'data-target-side')).toBe(contract.targetSide);
      expect((attribute(tag, 'data-via') ?? '').split(' ').filter(Boolean)).toEqual(contract.via ?? []);
      expect(attribute(tag, 'd')).toBe(contract.d);
      expect(attribute(tag, 'marker-end')).toMatch(/^url\(#.+\)$/);
      const points = samplePath(contract.d);
      expect(points[0]).toEqual(contract.start);
      expect(points.at(-1)).toEqual(contract.end);
      expect(onSide(contract.start, nodes.get(contract.source)!, contract.sourceSide)).toBe(true);
      expect(onSide(contract.end, nodes.get(contract.target)!, contract.targetSide)).toBe(true);
      for (const via of contract.via ?? []) expect(points.some((point) => strictlyInside(point, nodes.get(via)!))).toBe(true);
      const allowed = new Set([contract.source, contract.target, ...(contract.via ?? [])]);
      for (const nodeId of allowed) expect(page.indexOf(tag)).toBeLessThan(page.indexOf(nodes.get(nodeId)!.tag));
      for (const [nodeId, rect] of nodes) {
        const sameDiagram = nodeId.startsWith(`${id.split('-')[0]}-`);
        if (sameDiagram && !allowed.has(nodeId)) expect(points.some((point) => strictlyInside(point, rect)), `${id} crosses ${nodeId}`).toBe(false);
      }
    }
  });

  it('keeps marker tips, motion paths, paint order, and references consistent', () => {
    expect(new Set(nodes.keys()).size).toBe(nodeTags.length);
    expect(new Set(edgeById.keys()).size).toBe(edgeTags.length);
    for (const marker of tags(/<marker\b[^>]*>[\s\S]*?<\/marker>/g)) {
      const tip = Math.max(...[...marker.matchAll(/[ML]\s*([0-9.]+)/g)].map((match) => Number(match[1])));
      expect(Number(attribute(marker, 'refX'))).toBe(tip);
    }
    const packets = tags(/<circle\b[^>]*data-motion-for="[^"]+"[^>]*>[\s\S]*?<\/circle>/g);
    const packetEdges = packets.map((packet) => attribute(packet, 'data-motion-for')!);
    expect(packetEdges.sort()).toEqual(animatedEdges);
    expect(new Set(packetEdges).size).toBe(packetEdges.length);
    for (const packet of packets) {
      const edgeId = attribute(packet, 'data-motion-for')!;
      const edge = edgeById.get(edgeId)!;
      const visibility = packet.match(/<set\b[^>]*attributeName="visibility"[^>]*\/>/)?.[0] ?? '';
      const motion = packet.match(/<animateMotion\b[\s\S]*?\/>/)?.[0] ?? '';
      expect(attribute(motion, 'path')).toBe(attribute(edge, 'd'));
      expect(attribute(visibility, 'begin') ?? '0s').toBe(attribute(motion, 'begin') ?? '0s');
      expect(page.indexOf(edge)).toBeLessThan(page.indexOf(packet));
      for (const nodeId of [edges[edgeId].source, edges[edgeId].target, ...(edges[edgeId].via ?? [])]) {
        expect(page.indexOf(packet)).toBeLessThan(page.indexOf(nodes.get(nodeId)!.tag));
      }
    }
    const blocked = edgeById.get('architecture-blocked-egress')!;
    expect(attribute(blocked, 'data-source')).toBe('architecture-executor');
    expect(attribute(blocked, 'data-source-side')).toBe('right');
    expect(attribute(blocked, 'data-target')).toBeUndefined();
    expect(attribute(blocked, 'data-via')).toBeUndefined();
    expect(blocked).toContain('data-blocked-stub');
    expect(attribute(blocked, 'd')).toBe('M1058 258 H1114');
    expect(onSide([1058, 258], nodes.get('architecture-executor')!, 'right')).toBe(true);
    const helper = nodes.get('workflow-helper')!;
    const origin = nodes.get('workflow-origin')!;
    expect(origin.x - (helper.x + helper.width)).toBe(2);
  });
});
