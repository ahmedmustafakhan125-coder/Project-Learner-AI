import { describe, expect, it } from 'vitest';

import { scorePacing } from '../src/pacing/score.js';
import { EMPTY_PACE_STATE, readPaceState } from '../src/pacing/state.js';
import type { AttemptSummary } from '../src/pacing/types.js';

/**
 * Reading a pace state back out of the database.
 *
 * The bug these cover reached every learner. `pace_state` is declared
 * `jsonb not null default '{}'::jsonb`, and both routes read it as
 * `(row.pace_state as PaceState) ?? EMPTY`. `{}` is not null, so the fallback
 * never ran, and `scorePacing` threw on its first line the moment a learner
 * finished their first step. It could not heal: the only thing that overwrites
 * `{}` is a successful scoring run, and scoring could not succeed while the
 * value was `{}`.
 */

const summary: AttemptSummary = {
  attempts: 2,
  durationMs: 60_000,
  hintsUsed: 1,
  passed: true,
};

describe('the shape the database actually starts with', () => {
  it('reads the column default as an empty state', () => {
    // The whole bug, in one line.
    expect(readPaceState({})).toEqual(EMPTY_PACE_STATE);
  });

  it('lets scoring run on it instead of throwing', () => {
    expect(() => scorePacing(readPaceState({}), summary)).not.toThrow();
    expect(scorePacing(readPaceState({}), summary).newState.recentAttemptCounts).toEqual([2]);
  });

  it('still throws without the reader, so this test knows what it is protecting', () => {
    // If this ever stops throwing, the guard above has become decorative and
    // someone should find out why before deleting it.
    expect(() => scorePacing({} as never, summary)).toThrow();
  });
});

describe('rows written by older versions of the writer', () => {
  it('fills in recentHints, which was added after the first states were stored', () => {
    const state = readPaceState({
      recentAttemptCounts: [1, 2],
      recentDurations: [1000, 2000],
      hintsUsedTotal: 3,
      streakPassed: 0,
      streakFailed: 2,
    });

    expect(state.recentHints).toEqual([]);
    // Everything that WAS stored survives - a missing field must not cost the
    // learner the history that made the pacing worth having.
    expect(state.recentAttemptCounts).toEqual([1, 2]);
    expect(state.streakFailed).toBe(2);
  });

  it('keeps a complete state exactly as it was', () => {
    const stored = {
      recentAttemptCounts: [1, 2, 3],
      recentDurations: [10, 20, 30],
      recentHints: [0, 1, 0],
      hintsUsedTotal: 1,
      streakPassed: 2,
      streakFailed: 0,
    };
    expect(readPaceState(stored)).toEqual(stored);
  });
});

describe('values that are not a pace state at all', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'corrupt'],
    ['a number', 7],
    ['an array', [1, 2, 3]],
    ['a boolean', true],
  ])('reads %s as an empty state', (_label, value) => {
    expect(readPaceState(value)).toEqual(EMPTY_PACE_STATE);
  });

  it('never hands back a shared reference that a caller could mutate', () => {
    const a = readPaceState(null);
    const b = readPaceState(null);
    a.recentAttemptCounts.push(99);
    expect(b.recentAttemptCounts).toEqual([]);
    expect(EMPTY_PACE_STATE.recentAttemptCounts).toEqual([]);
  });
});

describe('one bad field', () => {
  it('costs that field and nothing else', () => {
    const state = readPaceState({
      recentAttemptCounts: 'not an array',
      recentDurations: [10, 20],
      recentHints: [1],
      hintsUsedTotal: 4,
      streakPassed: 1,
      streakFailed: 0,
    });

    expect(state.recentAttemptCounts).toEqual([]);
    expect(state.recentDurations).toEqual([10, 20]);
    expect(state.hintsUsedTotal).toBe(4);
  });

  it.each([
    ['a null element', [1, null, 3]],
    ['a string element', [1, '2', 3]],
    ['NaN', [Number.NaN]],
    ['Infinity', [Number.POSITIVE_INFINITY]],
    ['a negative duration', [-5]],
  ])('drops a window containing %s rather than averaging nonsense', (_label, value) => {
    // These reach `reduce` and a division inside scorePacing. A NaN in the
    // window silently disables the compress branch for the rest of the
    // project, which is far harder to notice than starting the window again.
    expect(readPaceState({ recentDurations: value }).recentDurations).toEqual([]);
  });

  it('resets a counter that is not a usable number', () => {
    expect(readPaceState({ hintsUsedTotal: -1 }).hintsUsedTotal).toBe(0);
    expect(readPaceState({ streakPassed: Number.NaN }).streakPassed).toBe(0);
    expect(readPaceState({ streakFailed: 'many' }).streakFailed).toBe(0);
  });
});

describe('what comes back is always safe to score', () => {
  it.each([[{}], [null], ['junk'], [{ recentAttemptCounts: 5 }], [[]], [{ streakPassed: 'x' }]])(
    'scores %j without throwing',
    (stored) => {
      expect(() => scorePacing(readPaceState(stored), summary)).not.toThrow();
    },
  );
});
