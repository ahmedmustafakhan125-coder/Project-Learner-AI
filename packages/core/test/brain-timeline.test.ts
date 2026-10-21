import { describe, expect, it } from 'vitest';

import { projectGraph } from '../src/brain/graph.js';
import { projectBrain } from '../src/brain/project.js';
import { activityTimeline, projectAt, recurringMistakes } from '../src/brain/timeline.js';
import type { BrainEvent } from '../src/brain/types.js';

const THREAD_A = '00000000-0000-4000-8000-00000000000a';
const THREAD_B = '00000000-0000-4000-8000-00000000000b';
const PROJECT = '00000000-0000-4000-8000-0000000000p1';
const STEP = '00000000-0000-4000-8000-0000000000s1';

const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 9, day, hour)).toISOString();
let n = 0;

function distilled(threadId: string, when: string, concepts: string[], mistakes: string[] = []): BrainEvent {
  n += 1;
  return {
    id: `e${String(n).padStart(3, '0')}`,
    kind: 'qa_distilled',
    sourceKind: 'thread',
    sourceId: threadId,
    dedupeKey: `d${n}`,
    createdAt: when,
    payload: {
      threadId,
      messageId: `m${n}`,
      extraction: {
        concepts: concepts.map((label) => ({ label, okfPath: null })),
        insights: [],
        mistakes: mistakes.map((text) => ({ text, concept: concepts[0] ?? null })),
      },
    },
  };
}

function failed(when: string, attemptNo: number): BrainEvent {
  n += 1;
  return {
    id: `e${String(n).padStart(3, '0')}`,
    kind: 'checkpoint_result',
    sourceKind: 'project',
    sourceId: PROJECT,
    dedupeKey: `c${attemptNo}`,
    createdAt: when,
    payload: {
      projectId: PROJECT, projectTitle: 'Todo API', stepId: STEP, stepIndex: 0, stepTitle: 'Routes',
      concepts: ['HTTP routing'], passed: false, failedLayer: 'tests', attemptNo,
    },
  };
}

/** A week: closures on day 1, routing failures on day 3, closures again on day 6. */
function week(): BrainEvent[] {
  n = 0;
  return [
    distilled(THREAD_A, at(1), ['Closures'], ['Thinks closures copy variables by value']),
    failed(at(3), 1),
    failed(at(3, 11), 2),
    distilled(THREAD_B, at(6), ['Closures', 'Event loop'], ['Thinks closures copy variables by value']),
  ];
}

describe('projectAt', () => {
  it('is the brain as it stood that day — later learning is not there yet', () => {
    const early = projectAt(week(), at(2));
    expect(early.nodes.map((node) => node.id)).toContain('concept:closures');
    expect(early.nodes.map((node) => node.id)).not.toContain('concept:event-loop');
    expect(early.nodes.map((node) => node.id)).not.toContain('concept:http-routing');
  });

  it('includes events at the cutoff instant itself', () => {
    expect(projectAt(week(), at(3)).nodes.map((node) => node.id)).toContain('concept:http-routing');
  });

  it('at or after the last event, is exactly the live brain', () => {
    const events = week();
    expect(projectAt(events, at(30))).toEqual(projectBrain(events));
  });

  it('shows mastery growing as the replay moves forward', () => {
    const events = week();
    const before = projectAt(events, at(2)).nodes.find((node) => node.id === 'concept:closures');
    const after = projectAt(events, at(7)).nodes.find((node) => node.id === 'concept:closures');
    expect(after?.score).toBeGreaterThan(before?.score ?? 1);
  });
});

describe('activityTimeline', () => {
  it('has one entry per day from first to last event, quiet days included', () => {
    const days = activityTimeline(week());
    expect(days.map((d) => d.day)).toEqual([
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06',
    ]);
    expect(days.map((d) => d.count)).toEqual([1, 0, 2, 0, 0, 1]);
  });

  it('gives each day the last instant of that day to project at', () => {
    const [first] = activityTimeline(week());
    expect(first?.until).toBe('2026-10-01T23:59:59.999Z');
  });

  it('is empty for an empty log', () => {
    expect(activityTimeline([])).toEqual([]);
  });
});

describe('recurring mistakes (phase 4 exit: recurrence visible across sessions)', () => {
  it('surfaces a misconception that came back in a second conversation, counted in both', () => {
    const { nodes, edges } = projectBrain(week());
    const [top] = recurringMistakes(nodes, edges);
    expect(top).toMatchObject({ label: 'Thinks closures copy variables by value', occurrences: 2, sessions: 2 });
  });

  it('also surfaces a step failed twice, as one session with two occurrences', () => {
    const { nodes, edges } = projectBrain(week());
    expect(recurringMistakes(nodes, edges)).toContainEqual(
      expect.objectContaining({ label: 'Step 1: Routes — tests failing', occurrences: 2, sessions: 1 }),
    );
  });

  it('ranks the pattern across more sessions first when counts tie', () => {
    const { nodes, edges } = projectBrain(week());
    expect(recurringMistakes(nodes, edges).map((m) => m.sessions)).toEqual([2, 1]);
  });

  it('reads the view’s links the same as the stored edges', () => {
    const { nodes, edges } = projectBrain(week());
    const view = projectGraph(nodes, edges, { now: at(30) });
    expect(recurringMistakes(view.nodes, view.links)).toEqual(recurringMistakes(nodes, edges));
  });

  it('leaves out a mistake made only once', () => {
    const { nodes, edges } = projectBrain(week().slice(0, 1));
    expect(recurringMistakes(nodes, edges)).toEqual([]);
  });
});
