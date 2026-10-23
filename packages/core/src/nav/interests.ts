import type { BrainEdge, BrainNode } from '../brain/types.js';
import type { NavInterest } from './types.js';

/**
 * A learner's interests, read off the brain.
 *
 * Nothing is declared: an interest is a concept the learner keeps coming back
 * to. Volume is how often it was reached (the ACTIVATED weights, from
 * conversations and from project checkpoints alike), and it fades with a
 * half-life so last month's topic gives way to this week's.
 *
 * Pure, with the clock passed in, like the rest of the brain's read side.
 */

export const INTEREST_RULES = {
  limit: 6,
  /** Days for a concept's pull to halve after it was last seen. */
  halfLifeDays: 14,
  /** Related concepts listed under each interest. */
  related: 3,
} as const;

const DAY_MS = 86_400_000;
const THREAD_SESSION = 'session:thread:';
const PROJECT_NODE = 'project:';

/** 1 at `now`, halving every `halfLifeDays`. 0 for a timestamp that does not parse. */
export function halfLifeDecay(iso: string, now: string, halfLifeDays: number): number {
  const age = (Date.parse(now) - Date.parse(iso)) / DAY_MS;
  if (!Number.isFinite(age)) return 0;
  return 0.5 ** (Math.max(0, age) / halfLifeDays);
}

export interface ConceptActivity {
  /** Thread sessions that reached the concept. */
  sessions: Set<string>;
  /** Project nodes whose checkpoints exercised it. */
  projects: Set<string>;
  volume: number;
}

/** ACTIVATED edges folded per concept. Assessments link by ASSESSED and are not activity. */
export function conceptActivity(edges: readonly BrainEdge[]): Map<string, ConceptActivity> {
  const activity = new Map<string, ConceptActivity>();
  for (const edge of edges) {
    if (edge.kind !== 'ACTIVATED') continue;
    let entry = activity.get(edge.dst);
    if (!entry) {
      entry = { sessions: new Set(), projects: new Set(), volume: 0 };
      activity.set(edge.dst, entry);
    }
    if (edge.src.startsWith(THREAD_SESSION)) entry.sessions.add(edge.src);
    else if (edge.src.startsWith(PROJECT_NODE)) entry.projects.add(edge.src);
    entry.volume += edge.weight;
  }
  return activity;
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function topInterests(
  nodes: readonly BrainNode[],
  edges: readonly BrainEdge[],
  now: string,
  limit: number = INTEREST_RULES.limit,
): NavInterest[] {
  const concepts = new Map(nodes.filter((node) => node.kind === 'concept').map((node) => [node.id, node]));
  const activity = conceptActivity(edges);

  const ranked = [...concepts.values()]
    .map((node) => ({
      node,
      pull: (activity.get(node.id)?.volume ?? 0) * halfLifeDecay(node.lastSeenAt, now, INTEREST_RULES.halfLifeDays),
    }))
    .filter((entry) => entry.pull > 0)
    .sort(
      (a, b) =>
        b.pull - a.pull ||
        Date.parse(b.node.lastSeenAt) - Date.parse(a.node.lastSeenAt) ||
        byId(a.node, b.node),
    )
    .slice(0, Math.max(0, limit));

  return ranked.map(({ node }) => ({
    nodeId: node.id,
    label: node.label,
    mastery: node.score,
    sessions: activity.get(node.id)?.sessions.size ?? 0,
    lastSeenAt: node.lastSeenAt,
    related: relatedConcepts(node.id, concepts, edges),
  }));
}

/** RELATED_TO neighbours that are concepts, heaviest link first. */
function relatedConcepts(
  id: string,
  concepts: ReadonlyMap<string, BrainNode>,
  edges: readonly BrainEdge[],
): { nodeId: string; label: string }[] {
  const weights = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind !== 'RELATED_TO') continue;
    const other = edge.src === id ? edge.dst : edge.dst === id ? edge.src : null;
    if (!other || other === id || !concepts.has(other)) continue;
    weights.set(other, (weights.get(other) ?? 0) + edge.weight);
  }
  return [...weights.entries()]
    .sort(([a, wa], [b, wb]) => wb - wa || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, INTEREST_RULES.related)
    .map(([nodeId]) => ({ nodeId, label: (concepts.get(nodeId) as BrainNode).label }));
}
