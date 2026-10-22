import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from 'd3-force';
import type { ForceCollide, Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import type { BrainGraphLink, BrainGraphNode } from '@ai-edu/api-client';

/**
 * Geometry for the brain view: the force layout, hit testing, and the zoom
 * transform. No DOM in here — `brainRenderer.ts` owns the canvas — so the parts
 * that decide where things are can be tested without a browser.
 */

export interface LayoutNode extends SimulationNodeDatum {
  id: string;
  node: BrainGraphNode;
  radius: number;
}

export interface LayoutLink extends SimulationLinkDatum<LayoutNode> {
  kind: BrainGraphLink['kind'];
  weight: number;
}

export interface Layout {
  nodes: LayoutNode[];
  links: LayoutLink[];
  byId: Map<string, LayoutNode>;
  simulation: Simulation<LayoutNode, LayoutLink>;
  /** Held aside so warming can run without it; see `warm`. */
  collide: ForceCollide<LayoutNode>;
}

/** Screen = graph · k + (x, y). */
export interface ViewTransform {
  k: number;
  x: number;
  y: number;
}

/**
 * Ticks run before the first frame. Enough that the graph appears already in
 * its broad shape rather than exploding out of a point, few enough that 200
 * nodes stay inside the first-render budget. The rest of the settling happens
 * on screen, which reads as the graph coming alive rather than as lag.
 */
export const WARM_TICKS = 50;

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 4;

/** How far apart each kind of link wants its ends. Wires are short, cross-links long. */
const LINK_DISTANCE: Record<BrainGraphLink['kind'], number> = {
  ACTIVATED: 46,
  RELATED_TO: 64,
  PRODUCED: 30,
  OCCURRED_IN: 40,
  CONTAINS: 28,
  ASSESSED: 44,
  DUPLICATE_OF: 80,
};

/**
 * Build a layout. Nodes that were already on screen keep their positions, so
 * changing the time window or refetching does not throw the whole graph into
 * a new arrangement.
 */
export function createLayout(
  nodes: readonly BrainGraphNode[],
  links: readonly BrainGraphLink[],
  previous?: ReadonlyMap<string, { x?: number; y?: number }>,
): Layout {
  const layoutNodes: LayoutNode[] = nodes.map((node) => {
    const before = previous?.get(node.id);
    return {
      id: node.id,
      node,
      radius: node.style.radius,
      ...(before?.x !== undefined && before?.y !== undefined ? { x: before.x, y: before.y } : {}),
    };
  });
  const byId = new Map(layoutNodes.map((n) => [n.id, n]));

  const layoutLinks: LayoutLink[] = links
    .filter((link) => byId.has(link.source) && byId.has(link.target))
    .map((link) => ({ source: link.source, target: link.target, kind: link.kind, weight: link.weight }));

  const collide = forceCollide<LayoutNode>((n) => n.radius + 3);
  const simulation = forceSimulation<LayoutNode, LayoutLink>(layoutNodes)
    .force(
      'link',
      forceLink<LayoutNode, LayoutLink>(layoutLinks)
        .id((n) => n.id)
        .distance((l) => LINK_DISTANCE[l.kind])
        .strength((l) => Math.min(1, 0.25 + 0.1 * l.weight)),
    )
    .force('charge', forceManyBody<LayoutNode>().strength((n) => -24 - n.radius * 4).distanceMax(420))
    .force('collide', collide)
    // A gentle pull to the middle instead of forceCenter, so islands drift in
    // rather than flying off to the edge of the canvas. Pulled harder
    // vertically: the view is always wider than tall, and a square layout
    // fitted into it leaves both sides empty.
    .force('x', forceX<LayoutNode>(0).strength(0.03))
    .force('y', forceY<LayoutNode>(0).strength(0.07))
    // Ticked by hand from the renderer's frame loop, never by d3's own timer.
    .stop();

  return { nodes: layoutNodes, links: layoutLinks, byId, simulation, collide };
}

/**
 * Run the layout ahead of the first frame.
 *
 * Collision is left out while warming: measured on 200 nodes it costs as much
 * as the charge force, and what it fixes — dots overlapping by a few pixels —
 * is invisible in a graph that is still moving. It is back for the on-screen
 * ticks that follow, which is where overlaps would actually be seen.
 */
export function warm(layout: Layout, ticks: number = WARM_TICKS): void {
  layout.simulation.force('collide', null);
  layout.simulation.tick(ticks);
  layout.simulation.force('collide', layout.collide);
}

export function settled(layout: Layout): boolean {
  return layout.simulation.alpha() < layout.simulation.alphaMin();
}

/** Every node within one hop of `id`. */
export function neighboursOf(layout: Layout): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    const set = out.get(a);
    if (set) set.add(b);
    else out.set(a, new Set([b]));
  };
  for (const link of layout.links) {
    const s = endpointId(link.source);
    const t = endpointId(link.target);
    add(s, t);
    add(t, s);
  }
  return out;
}

export function endpointId(end: LayoutLink['source']): string {
  return typeof end === 'object' ? end.id : String(end);
}

/* ------------------------------------------------------------------ *
 * Transform
 * ------------------------------------------------------------------ */

export function toGraph(t: ViewTransform, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - t.x) / t.k, y: (sy - t.y) / t.k };
}

export function toScreen(t: ViewTransform, gx: number, gy: number): { x: number; y: number } {
  return { x: gx * t.k + t.x, y: gy * t.k + t.y };
}

/** Zoom by `factor` keeping the graph point under (sx, sy) fixed on screen. */
export function zoomAt(t: ViewTransform, sx: number, sy: number, factor: number): ViewTransform {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, t.k * factor));
  const anchor = toGraph(t, sx, sy);
  return { k, x: sx - anchor.x * k, y: sy - anchor.y * k };
}

/** The transform that fits every node inside a `width` × `height` view. */
export function fitTransform(layout: Layout, width: number, height: number, padding = 48): ViewTransform {
  if (layout.nodes.length === 0 || width <= 0 || height <= 0) {
    return { k: 1, x: width / 2, y: height / 2 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of layout.nodes) {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    minX = Math.min(minX, x - n.radius);
    minY = Math.min(minY, y - n.radius);
    maxX = Math.max(maxX, x + n.radius);
    maxY = Math.max(maxY, y + n.radius);
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const k = Math.min(
    2,
    Math.max(MIN_ZOOM, Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY)),
  );
  return {
    k,
    x: width / 2 - ((minX + maxX) / 2) * k,
    y: height / 2 - ((minY + maxY) / 2) * k,
  };
}

/* ------------------------------------------------------------------ *
 * Picking
 * ------------------------------------------------------------------ */

/** Extra reach around a node, in screen pixels, so small dots are still clickable. */
const HIT_SLOP_PX = 4;

/**
 * The node under a screen point, or null. When dots overlap the nearest
 * centre wins, so the one you aimed at is the one you get.
 */
export function hitTest(layout: Layout, t: ViewTransform, sx: number, sy: number): LayoutNode | null {
  const p = toGraph(t, sx, sy);
  const slop = HIT_SLOP_PX / t.k;
  let best: LayoutNode | null = null;
  let bestDistance = Infinity;
  for (const n of layout.nodes) {
    const dx = (n.x ?? 0) - p.x;
    const dy = (n.y ?? 0) - p.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= n.radius + slop && distance < bestDistance) {
      best = n;
      bestDistance = distance;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Wires
 * ------------------------------------------------------------------ */

/** The point `fraction` (0..1) of the way along a polyline, by length. */
export function pointAlong(points: ReadonlyArray<{ x: number; y: number }>, fraction: number): { x: number; y: number } | null {
  if (points.length === 0) return null;
  if (points.length === 1) return { ...(points[0] as { x: number; y: number }) };

  const segments: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1] as { x: number; y: number };
    const b = points[i] as { x: number; y: number };
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    segments.push(length);
    total += length;
  }
  if (total === 0) return { ...(points[0] as { x: number; y: number }) };

  let remaining = Math.min(1, Math.max(0, fraction)) * total;
  for (let i = 0; i < segments.length; i += 1) {
    const length = segments[i] as number;
    const a = points[i] as { x: number; y: number };
    const b = points[i + 1] as { x: number; y: number };
    if (remaining <= length || i === segments.length - 1) {
      const f = length === 0 ? 0 : Math.min(1, remaining / length);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    remaining -= length;
  }
  return { ...(points[points.length - 1] as { x: number; y: number }) };
}
