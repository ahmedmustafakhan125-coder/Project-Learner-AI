import { PaceState, AttemptSummary, PacingDirective, PacingAdjustment } from './types.js';

// ── Thresholds ────────────────────────────────────────────────────────────────
const WINDOW_SIZE = 3;
const SCAFFOLD_ATTEMPT_THRESHOLD = 3;
const SCAFFOLD_HINT_THRESHOLD = 2;
const MICRO_STEP_STREAK_THRESHOLD = 2;
const COMPRESS_STREAK_THRESHOLD = 2;
/** Latest duration < 50% of the window average → learner is moving fast. */
const COMPRESS_DURATION_RATIO = 0.5;
const STRETCH_STREAK_THRESHOLD = 3;

// ── Public API ────────────────────────────────────────────────────────────────

export interface ScoringResult {
  newState: PaceState;
  directive: PacingDirective;
}

/**
 * Score a single attempt and return the updated pace state plus a directive for
 * the next step.  Pure function — no side effects, no DOM, no I/O.
 */
export function scorePacing(state: PaceState, current: AttemptSummary): ScoringResult {
  // 1. Update rolling window state ────────────────────────────────────────────
  const recentAttemptCounts = [...state.recentAttemptCounts, current.attempts].slice(-WINDOW_SIZE);
  const recentDurations = [...state.recentDurations, current.durationMs].slice(-WINDOW_SIZE);
  const recentHints = [...(state.recentHints ?? []), current.hintsUsed].slice(-WINDOW_SIZE);
  const hintsUsedTotal = state.hintsUsedTotal + current.hintsUsed;

  // 2. Update streaks ─────────────────────────────────────────────────────────
  let streakPassed = state.streakPassed;
  let streakFailed = state.streakFailed;

  if (current.attempts === 1 && current.passed) {
    streakPassed += 1;
    streakFailed = 0;
  } else if (current.attempts > 1) {
    streakFailed += 1;
    streakPassed = 0;
  }
  // attempts === 1 && !passed leaves both streaks unchanged (edge case: gave up)

  const newState: PaceState = {
    recentAttemptCounts,
    recentDurations,
    recentHints,
    hintsUsedTotal,
    streakPassed,
    streakFailed,
  };

  // 3. Determine adjustment (priority order: most severe → least severe) ──────
  let adjustment: PacingAdjustment;
  let reason: string;

  if (streakFailed >= MICRO_STEP_STREAK_THRESHOLD) {
    adjustment = 'insert_micro_step';
    reason =
      'The last few steps have been challenging — adding a smaller warm-up exercise before the next one.';
  } else if (
    current.attempts >= SCAFFOLD_ATTEMPT_THRESHOLD &&
    current.hintsUsed >= SCAFFOLD_HINT_THRESHOLD
  ) {
    adjustment = 'scaffold';
    reason =
      'You needed several attempts and hints on this step, so the next one will break things down more.';
  } else if (
    streakPassed >= STRETCH_STREAK_THRESHOLD &&
    recentHints.every((h) => h === 0)
  ) {
    // Stretch requires a clean streak with zero hints across the WINDOW, not
    // across all time — a learner who needed one hint early is still allowed to
    // pull ahead later.
    adjustment = 'stretch';
    reason =
      "You're well ahead — the next step will include an optional extension challenge.";
  } else if (
    streakPassed >= COMPRESS_STREAK_THRESHOLD &&
    isFastLearner(recentDurations)
  ) {
    adjustment = 'compress';
    reason =
      "You're moving quickly — the next step will assume more and leave a bigger gap for you to figure out.";
  } else {
    adjustment = 'hold';
    reason = 'On track.';
  }

  const directive: PacingDirective = { adjustment, reason, notes: [] };

  return { newState, directive };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true when the most recent duration is less than
 * `COMPRESS_DURATION_RATIO` × the window average, signalling the learner is
 * finishing steps noticeably faster than their own recent pace.
 */
function isFastLearner(durations: number[]): boolean {
  if (durations.length === 0) return false;
  const avg = durations.reduce((sum, d) => sum + d, 0) / durations.length;
  if (avg === 0) return false; // all zero-duration → no signal
  const latest = durations[durations.length - 1] ?? 0;
  return latest < COMPRESS_DURATION_RATIO * avg;
}
