import { describe, expect, it } from 'vitest';

import type { BrainEdge, BrainNode } from '../src/brain/types.js';
import { RECOMMEND_RULES, recommendNext, type RecommendInput } from '../src/nav/recommend.js';
import type { NavProject, NavThread } from '../src/nav/types.js';

/**
 * The "For you" rules. Each rule is pinned on its own, then the list-level
 * guarantees: one per target, a cap per kind, a cap in all, and the same
 * answer for the same history.
 */

const NOW = '2026-10-22T12:00:00.000Z';
const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

function concept(key: string, score: number | null, lastSeenDaysAgo = 1, metadata: Record<string, unknown> = {}): BrainNode {
  return {
    id: `concept:${key}`,
    kind: 'concept',
    key,
    label: key,
    score,
    confidence: null,
    metadata,
    firstSeenAt: daysAgo(lastSeenDaysAgo),
    lastSeenAt: daysAgo(lastSeenDaysAgo),
  };
}

function activated(src: string, key: string, order = 0): BrainEdge {
  return { src, dst: `concept:${key}`, kind: 'ACTIVATED', weight: 1, sourceId: null, metadata: { order }, createdAt: NOW };
}

/** `n` distinct thread sessions reaching `key`. */
function reachedIn(key: string, n: number, prefix = key): BrainEdge[] {
  return Array.from({ length: n }, (_, i) => activated(`session:thread:${prefix}-${i}`, key));
}

function project(id: string, status: string, updatedDaysAgo: number, step: [number, number] | null = null): NavProject {
  return {
    id,
    title: `Project ${id}`,
    status,
    updatedAt: daysAgo(updatedDaysAgo),
    currentStep: step ? step[0] : null,
    stepCount: step ? step[1] : null,
  };
}

function thread(id: string, updatedDaysAgo: number): NavThread {
  return { id, title: `Thread ${id}`, updatedAt: daysAgo(updatedDaysAgo), messageCount: 2 };
}

const input = (over: Partial<RecommendInput>): RecommendInput => ({
  nodes: [],
  edges: [],
  projects: [],
  threads: [],
  now: NOW,
  ...over,
});

const kinds = (list: ReturnType<typeof recommendNext>) => list.map((r) => r.kind);

describe('recommendNext', () => {
  it('suggests nothing to a learner with no history', () => {
    expect(recommendNext(input({}))).toEqual([]);
  });

  describe('continue_project', () => {
    it('picks the newest active project only, with its step', () => {
      const list = recommendNext(
        input({
          projects: [
            project('old', 'active', 5),
            project('new', 'active', 1, [2, 8]),
            project('done', 'completed', 0),
            project('draft', 'draft', 0),
          ],
        }),
      );
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: 'continue_project:new',
        title: 'Continue Project new',
        reason: 'Step 3 of 8 · last worked on yesterday',
        target: { type: 'project', id: 'new' },
      });
    });

    it('is skipped, not guessed, when projects failed to load', () => {
      expect(recommendNext(input({ projects: null }))).toEqual([]);
    });
  });

  describe('assess', () => {
    it('follows assessmentOffers', () => {
      const nodes = [concept('recursion', 0.7), concept('dismissed', 0.9, 1, { offerDismissals: 2 })];
      const list = recommendNext(input({ nodes }));
      expect(list.map((r) => r.id)).toEqual(['assess:concept:recursion']);
      expect(list[0]?.reason).toBe('Mastery 70% — ready to check it stuck');
    });
  });

  describe('strengthen', () => {
    const rule = RECOMMEND_RULES.strengthen;

    it('needs mastery below the band, enough conversations, and recent activity', () => {
      const nodes = [
        concept('weak', 0.3),
        concept('strong', rule.below),
        concept('once', 0.3),
        concept('stale', 0.3, rule.withinDays + 1),
      ];
      const edges = [
        ...reachedIn('weak', rule.minSessions),
        ...reachedIn('strong', rule.minSessions),
        ...reachedIn('once', rule.minSessions - 1),
        ...reachedIn('stale', rule.minSessions),
      ];
      const list = recommendNext(input({ nodes, edges }));
      expect(list.map((r) => r.id)).toEqual(['strengthen:concept:weak']);
      expect(list[0]?.reason).toBe('Asked about in 2 conversations · mastery 30%');
    });

    it('counts project checkpoints as activity but not as conversations', () => {
      const nodes = [concept('loops', 0.2)];
      const edges = [activated('session:thread:t1', 'loops'), activated('project:p1', 'loops')];
      expect(recommendNext(input({ nodes, edges }))).toEqual([]);
    });
  });

  describe('revisit_thread', () => {
    const nodes = [concept('promises', 0.2)];
    const edges = [activated('session:thread:idle', 'promises'), activated('session:thread:fresh', 'promises')];

    it('offers an idle conversation that reached a concept worth strengthening', () => {
      const list = recommendNext(input({ nodes, edges, threads: [thread('idle', 5), thread('fresh', 1)] }));
      const revisit = list.filter((r) => r.kind === 'revisit_thread');
      expect(revisit.map((r) => r.target.id)).toEqual(['idle']);
      expect(revisit[0]).toMatchObject({
        title: 'Pick up “Thread idle”',
        reason: 'Covers promises · last opened 5 days ago',
      });
    });

    it('names the same concept whatever order the edges arrive in', () => {
      const two = [concept('alpha', 0.2), concept('beta', 0.2)];
      const wires = [
        activated('session:thread:idle', 'beta', 0),
        activated('session:thread:idle', 'alpha', 0),
        ...reachedIn('alpha', 1),
        ...reachedIn('beta', 1),
      ];
      const reasonFor = (list: ReturnType<typeof recommendNext>) =>
        list.find((r) => r.kind === 'revisit_thread')?.reason;
      const forward = recommendNext(input({ nodes: two, edges: wires, threads: [thread('idle', 5)] }));
      const backward = recommendNext(input({ nodes: two, edges: [...wires].reverse(), threads: [thread('idle', 5)] }));
      expect(reasonFor(forward)).toBe('Covers alpha · last opened 5 days ago');
      expect(reasonFor(backward)).toBe(reasonFor(forward));
    });

    it('needs the threads to have loaded', () => {
      expect(kinds(recommendNext(input({ nodes, edges, threads: null })))).not.toContain('revisit_thread');
    });
  });

  describe('next_project', () => {
    const rule = RECOMMEND_RULES.nextProject;

    it('suggests building with a well-asked concept no project has exercised', () => {
      const nodes = [concept('hash-maps', rule.atLeast + 0.05), concept('built', rule.atLeast + 0.05)];
      const edges = [
        ...reachedIn('hash-maps', rule.minSessions),
        ...reachedIn('built', rule.minSessions),
        activated('project:p1', 'built'),
      ];
      const list = recommendNext(input({ nodes, edges }));
      expect(list.filter((r) => r.kind === 'next_project').map((r) => r.id)).toEqual(['next_project:concept:hash-maps']);
    });
  });

  describe('the list', () => {
    /** Ten weak concepts and one active project. */
    const crowded = (): RecommendInput => {
      const keys = Array.from({ length: 10 }, (_, i) => `weak-${i}`);
      return input({
        nodes: keys.map((key, i) => concept(key, 0.1 + i * 0.02)),
        edges: keys.flatMap((key) => reachedIn(key, 2)),
        projects: [project('p', 'active', 30)],
      });
    };

    it(`keeps at most ${RECOMMEND_RULES.perKind} of a kind, so other kinds still show`, () => {
      const list = recommendNext(crowded());
      expect(list.filter((r) => r.kind === 'strengthen')).toHaveLength(RECOMMEND_RULES.perKind);
      expect(kinds(list)).toContain('continue_project');
    });

    it(`never exceeds ${RECOMMEND_RULES.limit}`, () => {
      const keys = Array.from({ length: 6 }, (_, i) => `k${i}`);
      const nodes = [
        ...keys.map((key) => concept(key, 0.2)),
        ...keys.map((key) => concept(`t-${key}`, 0.7)),
        ...keys.map((key) => concept(`b-${key}`, 0.6)),
      ];
      const edges = [...keys.flatMap((key) => reachedIn(key, 2)), ...keys.flatMap((key) => reachedIn(`b-${key}`, 3))];
      const threads = keys.flatMap((key) => [thread(`${key}-0`, 5), thread(`${key}-1`, 5)]);
      const list = recommendNext(input({ nodes, edges, threads, projects: [project('p', 'active', 0)] }));
      expect(list.length).toBe(RECOMMEND_RULES.limit);
    });

    it('sorts best first and keeps one entry per target', () => {
      const list = recommendNext(crowded());
      const scores = list.map((r) => r.score);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
      const targets = list.map((r) => `${r.target.type}:${r.target.id}`);
      expect(new Set(targets).size).toBe(targets.length);
    });

    it('gives the same list for the same history, whatever the input order', () => {
      const a = crowded();
      const b = { ...a, nodes: [...a.nodes].reverse(), edges: [...a.edges].reverse() };
      expect(recommendNext(b)).toEqual(recommendNext(a));
    });

    it('lets the clock decide how much a stale project counts', () => {
      const fresh = recommendNext(input({ projects: [project('p', 'active', 0)] }))[0]?.score ?? 0;
      const stale = recommendNext(input({ projects: [project('p', 'active', 14)] }))[0]?.score ?? 0;
      expect(fresh).toBe(RECOMMEND_RULES.continueProject.weight);
      expect(stale).toBeCloseTo(fresh / 4, 3);
    });
  });
});
