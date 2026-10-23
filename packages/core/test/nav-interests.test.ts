import { describe, expect, it } from 'vitest';

import type { BrainEdge, BrainNode } from '../src/brain/types.js';
import { conceptActivity, halfLifeDecay, INTEREST_RULES, topInterests } from '../src/nav/interests.js';

/**
 * Interests are read off the brain: what the learner keeps reaching, fading
 * with time. These pin the ranking, the tie-breaks and what counts as reach.
 */

const NOW = '2026-10-22T12:00:00.000Z';
const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

function concept(key: string, lastSeenDaysAgo: number, score: number | null = null): BrainNode {
  return {
    id: `concept:${key}`,
    kind: 'concept',
    key,
    label: key,
    score,
    confidence: null,
    metadata: {},
    firstSeenAt: daysAgo(lastSeenDaysAgo),
    lastSeenAt: daysAgo(lastSeenDaysAgo),
  };
}

function edge(src: string, dst: string, kind: BrainEdge['kind'], weight = 1): BrainEdge {
  return { src, dst, kind, weight, sourceId: null, metadata: {}, createdAt: NOW };
}

const activated = (session: string, key: string, weight = 1) =>
  edge(`session:thread:${session}`, `concept:${key}`, 'ACTIVATED', weight);

describe('halfLifeDecay', () => {
  it('is 1 now, 0.5 after one half-life, and 0 for a bad timestamp', () => {
    expect(halfLifeDecay(NOW, NOW, 14)).toBe(1);
    expect(halfLifeDecay(daysAgo(14), NOW, 14)).toBeCloseTo(0.5, 10);
    expect(halfLifeDecay('not a date', NOW, 14)).toBe(0);
  });

  it('treats a future timestamp as now rather than growing past 1', () => {
    expect(halfLifeDecay(daysAgo(-3), NOW, 14)).toBe(1);
  });
});

describe('conceptActivity', () => {
  it('counts thread sessions and projects apart, and ignores ASSESSED', () => {
    const activity = conceptActivity([
      activated('t1', 'closures'),
      activated('t2', 'closures', 2),
      edge('project:p1', 'concept:closures', 'ACTIVATED'),
      edge('session:assessment:a1', 'concept:closures', 'ASSESSED'),
    ]);
    const closures = activity.get('concept:closures');
    expect(closures?.sessions.size).toBe(2);
    expect(closures?.projects.size).toBe(1);
    expect(closures?.volume).toBe(4);
  });
});

describe('topInterests', () => {
  it('returns nothing for an empty brain', () => {
    expect(topInterests([], [], NOW)).toEqual([]);
  });

  it('ranks by volume times decay, so recent beats merely frequent', () => {
    const nodes = [concept('old-favourite', 60), concept('this-week', 1)];
    const edges = [activated('t1', 'old-favourite', 5), activated('t2', 'this-week', 2)];
    expect(topInterests(nodes, edges, NOW).map((i) => i.nodeId)).toEqual([
      'concept:this-week',
      'concept:old-favourite',
    ]);
  });

  it('leaves out concepts nothing ever reached', () => {
    const nodes = [concept('reached', 1), concept('never', 1)];
    expect(topInterests(nodes, [activated('t1', 'reached')], NOW).map((i) => i.nodeId)).toEqual(['concept:reached']);
  });

  it('breaks ties by last seen, then by id', () => {
    const nodes = [concept('b', 2), concept('a', 2), concept('c', 2)];
    const edges = [activated('t1', 'a'), activated('t1', 'b'), activated('t1', 'c')];
    expect(topInterests(nodes, edges, NOW).map((i) => i.nodeId)).toEqual(['concept:a', 'concept:b', 'concept:c']);
  });

  it(`caps at ${INTEREST_RULES.limit} by default`, () => {
    const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
    const nodes = keys.map((key) => concept(key, 1));
    const edges = keys.map((key) => activated('t1', key));
    expect(topInterests(nodes, edges, NOW)).toHaveLength(INTEREST_RULES.limit);
  });

  it('lists related concepts, heaviest link first, concepts only', () => {
    const nodes = [concept('closures', 1, 0.4), concept('scope', 1), concept('hoisting', 1)];
    const edges = [
      activated('t1', 'closures'),
      activated('t2', 'closures'),
      edge('concept:closures', 'concept:hoisting', 'RELATED_TO', 1),
      edge('concept:closures', 'concept:scope', 'RELATED_TO', 3),
      edge('checkpoint:s1', 'concept:closures', 'RELATED_TO', 5),
    ];
    const [closures] = topInterests(nodes, edges, NOW);
    expect(closures).toMatchObject({ nodeId: 'concept:closures', mastery: 0.4, sessions: 2 });
    expect(closures?.related).toEqual([
      { nodeId: 'concept:scope', label: 'scope' },
      { nodeId: 'concept:hoisting', label: 'hoisting' },
    ]);
  });
});
