import { z } from 'zod';

import type { PaceState } from './types.js';

/**
 * Reading a stored pace state back.
 *
 * The column is `pace_state jsonb not null default '{}'::jsonb`, and both
 * callers used to write:
 *
 *     const paceState = (enrollment?.pace_state as PaceState) ?? EMPTY;
 *
 * `??` only fires on null and undefined. `{}` is neither, so every enrollment
 * ever created walked its literal database default straight into `scorePacing`,
 * where the first line spreads `state.recentAttemptCounts` and throws
 * "state.recentAttemptCounts is not iterable". The cast is what hid it: it told
 * TypeScript the value was already a PaceState, so nothing checked and the
 * fallback branch was unreachable in practice.
 *
 * It could never recover on its own, either. Writing a real state requires
 * scoring to finish, scoring cannot finish while the state is `{}`, and `{}` is
 * where every row starts — so the first advance past step 1 failed, and went on
 * failing for the life of the enrollment.
 *
 * So the schema does the reading, not a cast. Every field falls back on its own,
 * because a pace state is advisory: a corrupt streak counter should cost that
 * counter, not the learner's whole history, and never a 500 on a route whose
 * real job is somewhere else.
 */

/**
 * A fresh empty state, built new on every call.
 *
 * A function rather than a constant because zod's `.catch(value)` hands back
 * the SAME value on every parse - so a shared fallback means two enrollments
 * reading a corrupt row get one array between them, and whichever pushes to it
 * first silently edits the other's history. Cheap to build, and the alternative
 * is a bug that only appears under concurrency.
 */
function emptyPaceState(): PaceState {
  return {
    recentAttemptCounts: [],
    recentDurations: [],
    recentHints: [],
    hintsUsedTotal: 0,
    streakPassed: 0,
    streakFailed: 0,
  };
}

/**
 * The zero state, for comparison.
 *
 * Frozen all the way down, arrays included. It is a shared module-level value,
 * and a shallow freeze would still let a caller push into the window arrays and
 * change what every later comparison means. Frozen, that attempt throws where
 * it happens instead of surfacing as a wrong pacing decision much later.
 */
export const EMPTY_PACE_STATE: PaceState = (() => {
  const zero = emptyPaceState();
  Object.freeze(zero.recentAttemptCounts);
  Object.freeze(zero.recentDurations);
  Object.freeze(zero.recentHints);
  return Object.freeze(zero);
})();

/*
 * Deliberately separate from the `PaceState` schema in types.ts.
 *
 * That one is the contract: it should reject nonsense, because anything failing
 * it is a bug in the writer. This one is the reader, and it is pointed at rows
 * written by every earlier version of the writer that has ever run. Merging the
 * two would mean accepting garbage on the way in as well.
 */
const rollingWindow = z.array(z.number().finite().nonnegative()).catch(() => []);
const counter = z.number().finite().nonnegative().catch(0);

const StoredPaceState = z
  .object({
    recentAttemptCounts: rollingWindow,
    recentDurations: rollingWindow,
    recentHints: rollingWindow,
    hintsUsedTotal: counter,
    streakPassed: counter,
    streakFailed: counter,
  })
  .catch(() => emptyPaceState());

/**
 * A usable pace state from whatever the column happens to hold.
 *
 * Total by construction: `{}`, null, a partial row from before `recentHints`
 * existed, a string, an array, a field of the wrong type — each yields a state
 * scoring can run on rather than an exception.
 */
export function readPaceState(stored: unknown): PaceState {
  return StoredPaceState.parse(stored);
}
