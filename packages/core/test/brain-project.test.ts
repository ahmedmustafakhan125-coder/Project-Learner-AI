import { describe, expect, it } from 'vitest';

import { NO_MASTERY, afterCheckpoint, afterQuestion, afterViva, roundMastery } from '../src/brain/mastery.js';
import { brainNodeId, projectBrain } from '../src/brain/project.js';
import { parseBrainEvent } from '../src/brain/types.js';
import type { BrainEvent, BrainEventKind, BrainEventPayload, BrainProjection } from '../src/brain/types.js';

/**
 * The projection is the brain's one load-bearing promise: the stored graph is
 * nothing but a function of the event log. These tests hold it to that —
 * same log in, same bytes out, however the log arrives.
 */

const THREAD_A = '00000000-0000-4000-8000-00000000000a';
const THREAD_B = '00000000-0000-4000-8000-00000000000b';
const PROJECT = '00000000-0000-4000-8000-0000000000p1';
const STEP = '00000000-0000-4000-8000-0000000000s1';
const ASSESS_1 = '00000000-0000-4000-8000-0000000000x1';
const ASSESS_2 = '00000000-0000-4000-8000-0000000000x2';

let counter = 0;

/** One event at minute `minute` of a fixed day. Ids are sequential and unique. */
function ev<K extends BrainEventKind>(
  kind: K,
  minute: number,
  payload: BrainEventPayload<K>,
  extra: { sourceKind?: BrainEvent['sourceKind']; sourceId?: string; dedupeKey?: string } = {},
): BrainEvent {
  counter += 1;
  const id = `evt-${String(counter).padStart(4, '0')}`;
  return {
    id,
    kind,
    sourceKind: extra.sourceKind ?? 'thread',
    sourceId: extra.sourceId ?? THREAD_A,
    dedupeKey: extra.dedupeKey ?? `${kind}:${id}`,
    createdAt: new Date(Date.UTC(2026, 9, 21, 9, minute)).toISOString(),
    payload,
  } as BrainEvent;
}

function asked(threadId: string, minute: number, query: string, fingerprint: string, messageId = `msg-${minute}`) {
  return ev('question_asked', minute, {
    threadId,
    messageId,
    canonical: query.toLowerCase(),
    fingerprint,
    query,
  }, { sourceId: threadId });
}

function distilled(
  threadId: string,
  minute: number,
  concepts: string[],
  extra: Partial<BrainEventPayload<'qa_distilled'>['extraction']> = {},
) {
  return ev('qa_distilled', minute, {
    threadId,
    messageId: `msg-${minute}`,
    extraction: {
      concepts: concepts.map((label) => ({ label, okfPath: null })),
      insights: extra.insights ?? [],
      mistakes: extra.mistakes ?? [],
    },
  }, { sourceId: threadId });
}

function checkpoint(minute: number, passed: boolean, attemptNo: number) {
  return ev('checkpoint_result', minute, {
    projectId: PROJECT,
    projectTitle: 'Todo API',
    stepId: STEP,
    stepIndex: 0,
    stepTitle: 'Routes',
    concepts: ['Closures', 'HTTP routing'],
    passed,
    failedLayer: passed ? null : 'tests',
    attemptNo,
  }, { sourceKind: 'project', sourceId: PROJECT, dedupeKey: `checkpoint:${STEP}:${attemptNo}` });
}

function viva(minute: number, assessmentId: string, vivaScore: number, attemptNumber: number, missed: string[] = []) {
  return ev('viva_score', minute, {
    assessmentId,
    conceptKey: 'closures',
    conceptLabel: 'Closures',
    attemptNumber,
    mcqScore: 4,
    vivaScore,
    rubricSnapshot: [{ question: 1, criteria: ['identifies the captured variable'] }],
    missedCriteria: missed.map((text, i) => ({ questionIndex: i, criterionId: `c${i}`, text })),
  }, { sourceKind: 'assessment', sourceId: assessmentId });
}

/** A realistic week: questions in two threads, a project step, two vivas. */
function fixture(): BrainEvent[] {
  counter = 0;
  return [
    asked(THREAD_A, 0, 'What is a closure?', 'fp-closure'),
    distilled(THREAD_A, 1, ['Closures', 'Lexical scope'], {
      insights: [{ text: 'A closure keeps its defining scope alive.', concepts: ['Closures'] }],
      mistakes: [{ text: 'Thinks closures copy variables by value', concept: 'Closures' }],
    }),
    asked(THREAD_A, 2, 'closures in loops', 'fp-loops'),
    distilled(THREAD_A, 3, ['Closures', 'Event loop']),
    checkpoint(10, false, 1),
    checkpoint(12, true, 2),
    asked(THREAD_B, 20, 'What is a closure?', 'fp-closure'),
    distilled(THREAD_B, 21, ['closures'], {
      mistakes: [{ text: 'Thinks closures copy variables by value', concept: 'closures' }],
    }),
    viva(30, ASSESS_1, 12, 1, ['explains why the loop variable is shared']),
    viva(40, ASSESS_2, 22, 2),
    ev('offer_dismissed', 41, { conceptKey: 'closures' }),
  ];
}

const nodeOf = (p: BrainProjection, id: string) => p.nodes.find((n) => n.id === id);
const edgesOf = (p: BrainProjection, kind: string) => p.edges.filter((e) => e.kind === kind);

/* ------------------------------------------------------------------ */

describe('determinism (invariant: the brain is rebuildable)', () => {
  it('ten runs over the same log produce byte-identical projections', () => {
    const events = fixture();
    const first = JSON.stringify(projectBrain(events));
    for (let i = 0; i < 10; i += 1) expect(JSON.stringify(projectBrain(events))).toBe(first);
  });

  it('does not depend on the order the log arrives in', () => {
    const events = fixture();
    const expected = JSON.stringify(projectBrain(events));
    const reversed = [...events].reverse();
    const interleaved = events.filter((_, i) => i % 2 === 1).concat(events.filter((_, i) => i % 2 === 0));
    expect(JSON.stringify(projectBrain(reversed))).toBe(expected);
    expect(JSON.stringify(projectBrain(interleaved))).toBe(expected);
  });

  it('is idempotent over a repeated event: one occurrence, one effect', () => {
    const events = fixture();
    const duplicate = { ...events[4], id: 'evt-9999' } as BrainEvent; // same dedupe key, new row
    expect(JSON.stringify(projectBrain([...events, duplicate]))).toBe(JSON.stringify(projectBrain(events)));
  });

  it('an empty log is an empty brain with no watermark', () => {
    expect(projectBrain([])).toEqual({ nodes: [], edges: [], fingerprints: [], watermark: null });
  });

  it('the watermark is the last event folded in', () => {
    const events = fixture();
    const last = events[events.length - 1] as BrainEvent;
    expect(projectBrain(events).watermark).toEqual({ createdAt: last.createdAt, id: last.id });
  });

  it('emits nodes and edges in sorted order', () => {
    const p = projectBrain(fixture());
    expect(p.nodes.map((n) => n.id)).toEqual([...p.nodes.map((n) => n.id)].sort());
    // NUL sorts below every character an id can contain, so this orders by src, then dst, then kind.
    const keys = p.edges.map((e) => `${e.src}\u0000${e.dst}\u0000${e.kind}`);
    expect(keys).toEqual([...keys].sort());
  });
});

describe('questions and distillation', () => {
  it('a thread becomes a session node labelled with its first question', () => {
    const p = projectBrain(fixture());
    const session = nodeOf(p, brainNodeId.threadSession(THREAD_A));
    expect(session?.kind).toBe('session');
    expect(session?.label).toBe('What is a closure?');
    expect(session?.metadata['questions']).toBe(2);
  });

  it('concept labels that differ only in case or spacing are one concept', () => {
    const p = projectBrain(fixture());
    expect(p.nodes.filter((n) => n.kind === 'concept' && n.key === 'closures')).toHaveLength(1);
  });

  it('a session wires to its concepts in the order they were first reached', () => {
    const p = projectBrain(fixture());
    const wire = edgesOf(p, 'ACTIVATED')
      .filter((e) => e.src === brainNodeId.threadSession(THREAD_A))
      .sort((a, b) => (a.metadata['order'] as number) - (b.metadata['order'] as number))
      .map((e) => e.dst);
    expect(wire).toEqual(['concept:closures', 'concept:lexical-scope', 'concept:event-loop']);
  });

  it('counts how often a session returned to a concept as the wire weight', () => {
    const p = projectBrain(fixture());
    const edge = p.edges.find(
      (e) => e.kind === 'ACTIVATED' && e.src === brainNodeId.threadSession(THREAD_A) && e.dst === 'concept:closures',
    );
    expect(edge?.weight).toBe(2);
  });

  it('concepts that came up together are related, one edge per pair', () => {
    const p = projectBrain(fixture());
    const related = edgesOf(p, 'RELATED_TO').filter((e) => e.src.startsWith('concept:') && e.dst.startsWith('concept:'));
    for (const edge of related) expect(edge.src < edge.dst).toBe(true);
    expect(related.some((e) => e.src === 'concept:closures' && e.dst === 'concept:lexical-scope')).toBe(true);
  });

  it('an insight hangs off the session that produced it and the concept it is about', () => {
    const p = projectBrain(fixture());
    const insight = p.nodes.find((n) => n.kind === 'insight');
    expect(insight?.label).toBe('A closure keeps its defining scope alive.');
    expect(insight?.metadata['sourceId']).toBe(THREAD_A);
    expect(p.edges.some((e) => e.kind === 'PRODUCED' && e.dst === insight?.id)).toBe(true);
    expect(p.edges.some((e) => e.kind === 'RELATED_TO' && e.src === insight?.id && e.dst === 'concept:closures')).toBe(true);
  });

  it('records the first occurrence of a fingerprint for exact recall', () => {
    const p = projectBrain(fixture());
    const fp = p.fingerprints.find((f) => f.fingerprint === 'fp-closure');
    expect(fp?.threadId).toBe(THREAD_A);
    expect(p.fingerprints).toHaveLength(2);
  });

  it('the same question in a new thread links the threads as a revisit', () => {
    const p = projectBrain(fixture());
    expect(edgesOf(p, 'DUPLICATE_OF')).toEqual([
      expect.objectContaining({
        src: brainNodeId.threadSession(THREAD_B),
        dst: brainNodeId.threadSession(THREAD_A),
      }),
    ]);
  });

  it('repeating a question inside one thread is not a revisit', () => {
    counter = 0;
    const p = projectBrain([asked(THREAD_A, 0, 'x', 'fp-x', 'm1'), asked(THREAD_A, 1, 'x', 'fp-x', 'm2')]);
    expect(edgesOf(p, 'DUPLICATE_OF')).toEqual([]);
  });

  it('a question with no fingerprint (only filler) is never matched', () => {
    counter = 0;
    const p = projectBrain([asked(THREAD_A, 0, 'please', ''), asked(THREAD_B, 1, 'thanks', '')]);
    expect(p.fingerprints).toEqual([]);
    expect(edgesOf(p, 'DUPLICATE_OF')).toEqual([]);
  });
});

describe('mistakes', () => {
  it('a misconception that recurs across two sessions is one node, counted twice, wired to both', () => {
    const p = projectBrain(fixture());
    const mistake = p.nodes.find((n) => n.kind === 'mistake' && n.key.startsWith('qa:'));
    expect(mistake?.metadata['occurrences']).toBe(2);
    const sessions = p.edges
      .filter((e) => e.kind === 'OCCURRED_IN' && e.src === mistake?.id)
      .map((e) => e.dst)
      .sort();
    expect(sessions).toEqual([brainNodeId.threadSession(THREAD_A), brainNodeId.threadSession(THREAD_B)].sort());
  });

  it('a failed checkpoint records a mistake against its project', () => {
    const p = projectBrain(fixture());
    const mistake = nodeOf(p, brainNodeId.mistake(`checkpoint:${STEP}:tests`));
    expect(mistake?.label).toBe('Step 1: Routes — tests failing');
    expect(p.edges.some((e) => e.kind === 'OCCURRED_IN' && e.src === mistake?.id && e.dst === brainNodeId.project(PROJECT))).toBe(true);
  });

  it('a viva criterion that was missed becomes a mistake on that concept', () => {
    const p = projectBrain(fixture());
    const mistake = p.nodes.find((n) => n.kind === 'mistake' && n.key.startsWith('viva:closures:'));
    expect(mistake?.label).toBe('explains why the loop variable is shared');
    expect(p.edges.some((e) => e.kind === 'RELATED_TO' && e.src === mistake?.id && e.dst === 'concept:closures')).toBe(true);
  });
});

describe('checkpoints', () => {
  it('a project contains its checkpoint, which stays passed once passed', () => {
    const p = projectBrain(fixture());
    const step = nodeOf(p, brainNodeId.checkpoint(STEP));
    expect(step?.metadata).toMatchObject({ attempts: 2, passed: true, stepIndex: 0 });
    expect(p.edges.some((e) => e.kind === 'CONTAINS' && e.src === brainNodeId.project(PROJECT) && e.dst === step?.id)).toBe(true);
  });

  it('moves mastery for the step’s concepts on every graded attempt', () => {
    counter = 0;
    const p = projectBrain([checkpoint(0, false, 1), checkpoint(1, true, 2)]);
    const expected = afterCheckpoint(afterCheckpoint(NO_MASTERY, false), true);
    expect(nodeOf(p, 'concept:http-routing')?.score).toBe(roundMastery(expected.score));
    expect(nodeOf(p, 'concept:http-routing')?.confidence).toBe(roundMastery(expected.confidence));
  });
});

describe('assessments', () => {
  it('every ASSESSED edge carries its rubric snapshot and attempt number (invariant 7.3)', () => {
    const p = projectBrain(fixture());
    const assessed = edgesOf(p, 'ASSESSED');
    expect(assessed).toHaveLength(2);
    for (const edge of assessed) {
      expect(edge.metadata).toHaveProperty('rubric_snapshot');
      expect(edge.metadata).toHaveProperty('attempt_number');
    }
  });

  it('keeps first, best and latest scores — a retake never erases the first attempt', () => {
    const p = projectBrain(fixture());
    const second = p.edges.find((e) => e.kind === 'ASSESSED' && e.src === brainNodeId.assessmentSession(ASSESS_2));
    expect(second?.metadata).toMatchObject({ first_score: 12, best_score: 22, latest_score: 22, attempt_number: 2 });
    expect(nodeOf(p, 'concept:closures')?.metadata).toMatchObject({ firstScore: 12, bestScore: 22, latestScore: 22, assessments: 2 });
  });

  it('applies the viva formula on top of everything learned before', () => {
    const events = fixture();
    let m = NO_MASTERY;
    m = afterQuestion(m); // thread A, first distillation
    m = afterQuestion(m); // thread A, second
    m = afterCheckpoint(m, false);
    m = afterCheckpoint(m, true);
    m = afterQuestion(m); // thread B
    m = afterViva(m, 12, 1);
    m = afterViva(m, 22, 2);
    const closures = nodeOf(projectBrain(events), 'concept:closures');
    expect(closures?.score).toBe(roundMastery(m.score));
    expect(closures?.confidence).toBe(roundMastery(m.confidence));
  });

  it('counts dismissed offers without treating them as learning', () => {
    const p = projectBrain(fixture());
    const closures = nodeOf(p, 'concept:closures');
    expect(closures?.metadata['offerDismissals']).toBe(1);
    // last seen at the second viva (minute 40), not the dismissal (minute 41)
    expect(closures?.lastSeenAt).toBe(new Date(Date.UTC(2026, 9, 21, 9, 40)).toISOString());
  });
});

describe('parseBrainEvent', () => {
  const row = {
    id: 'e1',
    kind: 'offer_dismissed',
    source_kind: 'thread',
    source_id: THREAD_A,
    dedupe_key: 'dismiss:1',
    payload: { conceptKey: 'closures' },
    created_at: '2026-10-21T09:00:00+00:00',
  };

  it('maps a stored row to an event', () => {
    expect(parseBrainEvent(row)).toMatchObject({ id: 'e1', kind: 'offer_dismissed', dedupeKey: 'dismiss:1' });
  });

  it('returns null rather than throwing for a payload that no longer validates', () => {
    expect(parseBrainEvent({ ...row, payload: { nope: true } })).toBeNull();
    expect(parseBrainEvent({ ...row, kind: 'not_a_kind' })).toBeNull();
  });
});
