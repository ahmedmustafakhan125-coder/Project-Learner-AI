import { projectBrain } from './project.js';
import type { GraphLink } from './graph.js';
import type { BrainEdge, BrainEvent, BrainNode, BrainProjection } from './types.js';

/**
 * The brain over time.
 *
 * Because the projection is a pure fold over the event log, the brain as it
 * stood on any past day is just the fold over the events up to that day. That
 * is all replay is — no snapshots, no history tables — and it is cheap enough
 * to run in the browser for every step of the scrubber.
 */

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** The brain as it stood at `until` (inclusive). */
export function projectAt(events: readonly BrainEvent[], until: string): BrainProjection {
  const cutoff = timeOf(until);
  return projectBrain(events.filter((event) => timeOf(event.createdAt) <= cutoff));
}

export interface ActivityDay {
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  /** The last instant of that day — the `until` to project at to see it. */
  until: string;
  /** Events that happened that day. Zero for a quiet day inside the range. */
  count: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One entry per calendar day from the first event to the last, quiet days
 * included, so a scrubber over it moves through time evenly rather than
 * jumping across gaps.
 */
export function activityTimeline(events: readonly BrainEvent[]): ActivityDay[] {
  if (events.length === 0) return [];
  const times = events.map((event) => timeOf(event.createdAt));
  const startDay = Math.floor(Math.min(...times) / DAY_MS);
  const endDay = Math.floor(Math.max(...times) / DAY_MS);

  const counts = new Map<number, number>();
  for (const t of times) {
    const day = Math.floor(t / DAY_MS);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }

  const days: ActivityDay[] = [];
  for (let day = startDay; day <= endDay; day += 1) {
    days.push({
      day: new Date(day * DAY_MS).toISOString().slice(0, 10),
      until: new Date((day + 1) * DAY_MS - 1).toISOString(),
      count: counts.get(day) ?? 0,
    });
  }
  return days;
}

export interface RecurringMistake {
  id: string;
  label: string;
  occurrences: number;
  /** How many different sessions it came up in. Two or more is a pattern. */
  sessions: number;
  lastSeenAt: string;
}

/**
 * Mistakes made more than once, most frequent first — the list worth a
 * learner's attention. Takes either stored edges or the view's links.
 */
export function recurringMistakes(
  nodes: readonly BrainNode[],
  links: ReadonlyArray<GraphLink | BrainEdge>,
  limit = 5,
): RecurringMistake[] {
  const sessionsOf = new Map<string, Set<string>>();
  for (const link of links) {
    const [src, dst, kind] = 'source' in link ? [link.source, link.target, link.kind] : [link.src, link.dst, link.kind];
    if (kind !== 'OCCURRED_IN') continue;
    const set = sessionsOf.get(src);
    if (set) set.add(dst);
    else sessionsOf.set(src, new Set([dst]));
  }

  return nodes
    .filter((node) => node.kind === 'mistake')
    .map((node) => ({
      id: node.id,
      label: node.label,
      occurrences: typeof node.metadata['occurrences'] === 'number' ? node.metadata['occurrences'] : 1,
      sessions: sessionsOf.get(node.id)?.size ?? 0,
      lastSeenAt: node.lastSeenAt,
    }))
    .filter((mistake) => mistake.occurrences > 1)
    .sort(
      (a, b) =>
        b.occurrences - a.occurrences ||
        b.sessions - a.sessions ||
        timeOf(b.lastSeenAt) - timeOf(a.lastSeenAt) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .slice(0, limit);
}
