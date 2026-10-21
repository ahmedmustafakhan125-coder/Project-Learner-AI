import { describe, expect, it } from 'vitest';

import { scoreMcq } from '../src/assessment/mcq.js';
import {
  OFFER_RULES,
  assessmentOffers,
  isStuck,
  retakeCooldownMs,
  retakeReady,
  shouldOfferAssessment,
} from '../src/assessment/triggers.js';
import { projectBrain } from '../src/brain/project.js';
import type { BrainEvent, BrainNode } from '../src/brain/types.js';

const HOUR = 60 * 60 * 1000;
const NOW = '2026-10-22T12:00:00.000Z';
const ago = (days: number) => new Date(Date.parse(NOW) - days * 24 * HOUR).toISOString();

function concept(extra: Partial<BrainNode> & { metadata?: Record<string, unknown> } = {}): BrainNode {
  return {
    id: 'concept:closures',
    kind: 'concept',
    key: 'closures',
    label: 'Closures',
    score: 0.7,
    confidence: 0.4,
    firstSeenAt: ago(20),
    lastSeenAt: ago(1),
    ...extra,
    metadata: { lastEvidence: 'question', ...(extra.metadata ?? {}) },
  };
}

describe('scoreMcq', () => {
  it('marks by option index and passes at four of five', () => {
    expect(scoreMcq({ correctIndexes: [0, 1, 2, 3, 0] }, [0, 1, 2, 3, 1])).toEqual({
      score: 4,
      total: 5,
      passed: true,
      correct: [true, true, true, true, false],
    });
    expect(scoreMcq({ correctIndexes: [0, 1, 2, 3, 0] }, [0, 1, 2, 0, 1]).passed).toBe(false);
  });

  it('counts an unanswered question as wrong', () => {
    expect(scoreMcq({ correctIndexes: [0, 1, 2, 3, 0] }, [0, 1]).score).toBe(2);
  });
});

describe('retake timing', () => {
  it('is 24 hours, doubling per attempt, capped at a week', () => {
    expect(retakeCooldownMs(1)).toBe(24 * HOUR);
    expect(retakeCooldownMs(2)).toBe(48 * HOUR);
    expect(retakeCooldownMs(3)).toBe(96 * HOUR);
    expect(retakeCooldownMs(4)).toBe(168 * HOUR);
    expect(retakeCooldownMs(10)).toBe(168 * HOUR);
  });

  it('calls the fourth sitting stuck — a signal, not a block', () => {
    expect(isStuck(3)).toBe(false);
    expect(isStuck(4)).toBe(true);
  });
});

describe('shouldOfferAssessment', () => {
  it('offers a well-engaged concept that has not been tested', () => {
    expect(shouldOfferAssessment(concept(), NOW)).toBe(true);
  });

  it.each([
    ['mastery below the threshold', concept({ score: OFFER_RULES.minScore - 0.01 })],
    ['tested within the week', concept({ metadata: { lastAssessedAt: ago(3) } })],
    ['dismissed twice', concept({ metadata: { offerDismissals: 2 } })],
    ['the latest evidence a failed checkpoint', concept({ metadata: { lastEvidence: 'checkpoint_fail' } })],
    ['a retake cooldown still running', concept({ metadata: { retakeAfter: new Date(Date.parse(NOW) + HOUR).toISOString() } })],
    ['not a concept at all', { ...concept(), kind: 'mistake' as const }],
  ])('does not offer with %s', (_, node) => {
    expect(shouldOfferAssessment(node, NOW)).toBe(false);
  });

  it('offers again once the week has passed', () => {
    expect(shouldOfferAssessment(concept({ metadata: { lastAssessedAt: ago(8) } }), NOW)).toBe(true);
  });

  it('lists the strongest offers first, at most three', () => {
    const nodes = [0.61, 0.95, 0.4, 0.8, 0.7].map((score, i) => concept({ id: `concept:c${i}`, score }));
    expect(assessmentOffers(nodes, NOW).map((n) => n.score)).toEqual([0.95, 0.8, 0.7]);
  });
});

describe('retakes in the projection', () => {
  const at = (h: number) => new Date(Date.parse('2026-10-20T09:00:00Z') + h * HOUR).toISOString();
  let n = 0;
  const event = (kind: BrainEvent['kind'], when: string, payload: unknown): BrainEvent =>
    ({ id: `e${++n}`, kind, sourceKind: 'assessment', sourceId: 'a1', dedupeKey: `k${n}`, createdAt: when, payload }) as BrainEvent;
  const mcq = (when: string, passed: boolean) =>
    event('mcq_attempt', when, { assessmentId: `a${n}`, conceptKey: 'closures', conceptLabel: 'Closures', attemptNumber: 1, score: passed ? 4 : 2, total: 5, passed });
  const viva = (when: string, vivaScore: number, attemptNumber: number) =>
    event('viva_score', when, {
      assessmentId: `v${n}`, conceptKey: 'closures', conceptLabel: 'Closures', attemptNumber,
      mcqScore: 4, vivaScore, rubricSnapshot: [], missedCriteria: [],
    });
  const closures = (events: BrainEvent[]) => projectBrain(events).nodes.find((x) => x.id === 'concept:closures');

  it('a failed gate reopens 24 hours after it was sat', () => {
    expect(closures([mcq(at(0), false)])?.metadata['retakeAfter']).toBe(at(24));
  });

  it('a viva below 15 opens a retake after the attempt’s cooldown', () => {
    expect(closures([viva(at(0), 12, 2)])?.metadata['retakeAfter']).toBe(at(48));
  });

  it('a pass closes any retake still pending', () => {
    expect(closures([viva(at(0), 10, 1), viva(at(30), 21, 2)])?.metadata['retakeAfter']).toBeUndefined();
  });

  it('a retake is ready once its cooldown has run out', () => {
    const node = closures([viva(at(0), 12, 1)]) as BrainNode;
    expect(retakeReady(node, at(23))).toBe(false);
    expect(retakeReady(node, at(25))).toBe(true);
  });
});
