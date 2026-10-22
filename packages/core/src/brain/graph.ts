import type { BrainEdge, BrainEdgeKind, BrainNode, BrainNodeKind } from './types.js';

/**
 * What the brain view is given to draw.
 *
 * The canvas is deliberately dumb: it receives nodes, links and a style per
 * node, and decides nothing. Which nodes make the cut, how big and how bright
 * each one is, which concepts a session's wire runs through — all of that is
 * decided here, in pure code, so it is tested once and identical on web and on
 * a future mobile client.
 */

/** Hard ceilings on one response. A graph past these stops being readable anyway. */
export const GRAPH_LIMITS = { maxNodes: 500, maxEdges: 1500 } as const;

/** Past this many nodes the view turns hover highlighting off to hold its frame rate. */
export const HOVER_NODE_LIMIT = 400;

export type NodeTone = 'concept' | 'insight' | 'mistake' | 'session' | 'project' | 'pass' | 'fail';

export interface NodeStyle {
  /** Radius in graph units, before the view's zoom. */
  radius: number;
  tone: NodeTone;
  /** 0..1 — mastery for concepts, recency for insights, severity for mistakes. */
  brightness: number;
  /** Touched in the last day: the view pulses it. */
  recent: boolean;
}

export interface GraphNode extends BrainNode {
  style: NodeStyle;
}

export interface GraphLink {
  source: string;
  target: string;
  kind: BrainEdgeKind;
  weight: number;
  /** ACTIVATED links only: where this concept falls along the session's wire. */
  order?: number;
}

export interface GraphView {
  nodes: GraphNode[];
  links: GraphLink[];
  meta: {
    /** Nodes that matched the window and focus, before the cap. */
    total: number;
    /** True when the cap cut nodes or links — the view must say so. */
    truncated: boolean;
    focus: string | null;
  };
}

export interface GraphQuery {
  /** The caller's clock, passed in so this stays pure. */
  now: string;
  /** Only nodes seen in the last N days. Null or absent for all time. */
  windowDays?: number | null;
  /** Centre the view on one node and its neighbourhood. */
  focus?: string | null;
  /** How many hops from `focus` to include. */
  depth?: number;
  maxNodes?: number;
  maxEdges?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/* ------------------------------------------------------------------ *
 * Styling
 * ------------------------------------------------------------------ */

/**
 * How one node is drawn. Size and brightness carry meaning per kind:
 *
 *   concept     size and brightness ∝ mastery
 *   insight     small, brightness ∝ recency (fades over about a month)
 *   mistake     size ∝ occurrences, brightness ∝ severity
 *   session     tiny and grey — sessions are read as wires, not as dots
 *   project     fixed, medium
 *   checkpoint  tiny, green when passed and red when not
 */
export function styleFor(node: BrainNode, now: string): NodeStyle {
  const ageDays = Math.max(0, (timeOf(now) - timeOf(node.lastSeenAt)) / DAY_MS);
  const recent = ageDays < 1;

  const styles: Record<BrainNodeKind, () => Omit<NodeStyle, 'recent'>> = {
    concept: () => {
      const mastery = clamp01(node.score ?? 0);
      return { radius: 5 + 9 * mastery, tone: 'concept', brightness: 0.35 + 0.65 * mastery };
    },
    insight: () => ({ radius: 3.5, tone: 'insight', brightness: 0.3 + 0.7 * Math.exp(-ageDays / 30) }),
    mistake: () => {
      const occurrences = Math.max(1, num(node.metadata['occurrences']));
      return {
        radius: 4 + Math.min(8, (occurrences - 1) * 2),
        tone: 'mistake',
        brightness: clamp01(0.45 + 0.15 * (occurrences - 1)),
      };
    },
    session: () => ({ radius: 2.5, tone: 'session', brightness: 0.6 }),
    project: () => ({ radius: 8, tone: 'project', brightness: 0.85 }),
    checkpoint: () => ({
      radius: 2.5,
      tone: node.metadata['passed'] === true ? 'pass' : 'fail',
      brightness: 0.8,
    }),
  };

  return { ...styles[node.kind](), recent };
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

/** Every node within `depth` hops of `focus`, treating edges as undirected. */
function neighbourhood(focus: string, edges: readonly BrainEdge[], depth: number, allowed: ReadonlySet<string>): Set<string> {
  const adjacent = new Map<string, string[]>();
  const connect = (from: string, to: string): void => {
    const list = adjacent.get(from);
    if (list) list.push(to);
    else adjacent.set(from, [to]);
  };
  for (const edge of edges) {
    if (!allowed.has(edge.src) || !allowed.has(edge.dst)) continue;
    connect(edge.src, edge.dst);
    connect(edge.dst, edge.src);
  }

  const reached = new Set([focus]);
  let frontier = [focus];
  for (let hop = 0; hop < depth && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbour of adjacent.get(id) ?? []) {
        if (!reached.has(neighbour)) {
          reached.add(neighbour);
          next.push(neighbour);
        }
      }
    }
    frontier = next;
  }
  return reached;
}

/**
 * Choose and style what the view shows.
 *
 * Order of operations: the time window first, then the focus neighbourhood,
 * then the cap — newest first, ties by id, with the focus node always kept. A
 * cut graph says so in `meta.truncated`, so the view can be honest about it.
 */
export function projectGraph(
  nodes: readonly BrainNode[],
  edges: readonly BrainEdge[],
  query: GraphQuery,
): GraphView {
  const maxNodes = query.maxNodes ?? GRAPH_LIMITS.maxNodes;
  const maxEdges = query.maxEdges ?? GRAPH_LIMITS.maxEdges;
  const now = timeOf(query.now);

  let candidates = [...nodes];
  if (query.windowDays && query.windowDays > 0) {
    const since = now - query.windowDays * DAY_MS;
    candidates = candidates.filter((node) => timeOf(node.lastSeenAt) >= since);
  }

  const known = new Set(candidates.map((node) => node.id));
  const focus = query.focus && known.has(query.focus) ? query.focus : null;
  if (focus) {
    const near = neighbourhood(focus, edges, Math.max(0, query.depth ?? 2), known);
    candidates = candidates.filter((node) => near.has(node.id));
  }

  const total = candidates.length;
  const ranked = candidates.sort(
    (a, b) =>
      Number(b.id === focus) - Number(a.id === focus) ||
      timeOf(b.lastSeenAt) - timeOf(a.lastSeenAt) ||
      byId(a, b),
  );
  const kept = ranked.slice(0, maxNodes).sort(byId);
  const keptIds = new Set(kept.map((node) => node.id));

  const between = edges.filter((edge) => keptIds.has(edge.src) && keptIds.has(edge.dst));
  // The strongest links survive a cut; ties fall back to a fixed order.
  const links = [...between]
    .sort(
      (a, b) =>
        b.weight - a.weight ||
        (a.src < b.src ? -1 : a.src > b.src ? 1 : 0) ||
        (a.dst < b.dst ? -1 : a.dst > b.dst ? 1 : 0) ||
        (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
    )
    .slice(0, maxEdges)
    .map((edge): GraphLink => ({
      source: edge.src,
      target: edge.dst,
      kind: edge.kind,
      weight: edge.weight,
      ...(edge.kind === 'ACTIVATED' ? { order: num(edge.metadata['order']) } : {}),
    }));

  return {
    nodes: kept.map((node) => ({ ...node, style: styleFor(node, query.now) })),
    links,
    meta: {
      total,
      truncated: kept.length < total || links.length < between.length,
      focus,
    },
  };
}

/* ------------------------------------------------------------------ *
 * The wire a session drew
 * ------------------------------------------------------------------ */

/**
 * The concepts one session (a thread, a project, an assessment) reached, in
 * the order it first reached them. Clicking a session in the view animates
 * along this path — a session is a trail through the graph, not a place.
 */
export function sessionPath(sessionId: string, links: ReadonlyArray<GraphLink | BrainEdge>): string[] {
  return links
    .map((link) =>
      'source' in link
        ? { src: link.source, dst: link.target, kind: link.kind, order: num(link.order) }
        : { src: link.src, dst: link.dst, kind: link.kind, order: num(link.metadata['order']) },
    )
    .filter((link) => link.kind === 'ACTIVATED' && link.src === sessionId)
    .sort((a, b) => a.order - b.order || (a.dst < b.dst ? -1 : a.dst > b.dst ? 1 : 0))
    .map((link) => link.dst);
}

/* ------------------------------------------------------------------ *
 * Node detail
 * ------------------------------------------------------------------ */

export interface NodeRef {
  id: string;
  kind: BrainNodeKind;
  label: string;
}

export interface SessionRef extends NodeRef {
  /** Where the learner can go to see it again. */
  source: 'thread' | 'project' | 'assessment';
  sourceId: string;
  lastSeenAt: string;
}

export interface AssessmentRef {
  sessionId: string;
  attemptNumber: number;
  vivaScore: number;
  mcqScore: number;
  at: string;
}

export interface BrainNodeDetail {
  node: BrainNode;
  /** For a session: the concepts it reached, in order. For a concept: empty. */
  path: NodeRef[];
  sessions: SessionRef[];
  concepts: NodeRef[];
  insights: NodeRef[];
  mistakes: Array<NodeRef & { occurrences: number }>;
  assessments: AssessmentRef[];
}

function sessionRef(node: BrainNode): SessionRef | null {
  if (node.kind === 'project') {
    return { id: node.id, kind: node.kind, label: node.label, source: 'project', sourceId: node.key, lastSeenAt: node.lastSeenAt };
  }
  if (node.kind !== 'session') return null;
  const [source, ...rest] = node.key.split(':');
  if (source !== 'thread' && source !== 'assessment') return null;
  return { id: node.id, kind: node.kind, label: node.label, source, sourceId: rest.join(':'), lastSeenAt: node.lastSeenAt };
}

const ref = (node: BrainNode): NodeRef => ({ id: node.id, kind: node.kind, label: node.label });

/**
 * Everything the side panel shows for one node: the sessions it came up in,
 * its neighbours by kind, and — for a concept — its assessment history with
 * every attempt kept. Null for an id the learner does not have.
 */
export function nodeDetail(
  id: string,
  nodes: readonly BrainNode[],
  edges: readonly BrainEdge[],
): BrainNodeDetail | null {
  const index = new Map(nodes.map((node) => [node.id, node]));
  const node = index.get(id);
  if (!node) return null;

  const touching = edges.filter((edge) => edge.src === id || edge.dst === id);
  const neighbours = new Map<string, BrainNode>();
  for (const edge of touching) {
    const other = index.get(edge.src === id ? edge.dst : edge.src);
    if (other && other.id !== id) neighbours.set(other.id, other);
  }
  const all = [...neighbours.values()].sort(byId);

  const sessions = all
    .map(sessionRef)
    .filter((s): s is SessionRef => s !== null)
    .sort((a, b) => timeOf(b.lastSeenAt) - timeOf(a.lastSeenAt) || byId(a, b));

  const assessments: AssessmentRef[] = touching
    .filter((edge) => edge.kind === 'ASSESSED')
    .map((edge) => ({
      sessionId: edge.src === id ? edge.dst : edge.src,
      attemptNumber: num(edge.metadata['attempt_number']),
      vivaScore: num(edge.metadata['viva_score']),
      mcqScore: num(edge.metadata['mcq_score']),
      at: edge.createdAt,
    }))
    .sort((a, b) => a.attemptNumber - b.attemptNumber || timeOf(a.at) - timeOf(b.at));

  const path =
    node.kind === 'session' || node.kind === 'project'
      ? sessionPath(id, edges)
          .map((conceptId) => index.get(conceptId))
          .filter((n): n is BrainNode => Boolean(n))
          .map(ref)
      : [];

  return {
    node,
    path,
    sessions,
    concepts: all.filter((n) => n.kind === 'concept').map(ref),
    insights: all.filter((n) => n.kind === 'insight').map(ref),
    mistakes: all
      .filter((n) => n.kind === 'mistake')
      .map((n) => ({ ...ref(n), occurrences: Math.max(1, num(n.metadata['occurrences'])) }))
      .sort((a, b) => b.occurrences - a.occurrences || byId(a, b)),
    assessments,
  };
}
