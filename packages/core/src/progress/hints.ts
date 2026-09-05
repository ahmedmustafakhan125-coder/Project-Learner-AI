/**
 * When a hint tier opens.
 *
 * The rule lived in two places — a `TIER_THRESHOLDS` table in `HintDrawer` and
 * an inline calculation in the hints route — which is the arrangement that
 * produces "the hint says it is available and the server says it is not". They
 * happened to agree; nothing made them, and every change to one was a chance to
 * find out they no longer did.
 *
 * The elapsed half of the rule was also dead for the case it exists for. Time
 * was measured from the learner's FIRST ATTEMPT, so someone who had not worked
 * out how to begin had no clock running at all — and not knowing how to begin
 * is precisely when a timed hint should arrive. The only way to reach a hint on
 * time was to have already made the attempts that would have unlocked it
 * anyway. It now runs from when the step was opened.
 */

/** Tier N wants N attempts, or N × 5 minutes. */
export const MINUTES_PER_TIER = 5;

export interface HintTierSignals {
  /** 1-based. */
  tier: number;
  /** Checkpoint runs recorded on this step. */
  attemptCount: number;
  /** Since the learner opened the step — not since their first attempt. */
  elapsedMs: number;
  /**
   * True once the step's checkpoint has passed.
   *
   * Opens everything. The ladder exists so nobody reads the answer before
   * thinking about the problem; passing spends that reason, and the later tiers
   * are often the clearest account of the technique in the whole step.
   */
  passed?: boolean;
}

export interface HintTierState {
  unlocked: boolean;
  /** Attempts still needed, if that is the shorter road. Zero when met. */
  attemptsRemaining: number;
  /** Whole minutes still needed, if that is the shorter road. Zero when met. */
  minutesRemaining: number;
}

export function attemptsRequiredFor(tier: number): number {
  return Math.max(1, tier);
}

export function msRequiredFor(tier: number): number {
  return Math.max(1, tier) * MINUTES_PER_TIER * 60_000;
}

/**
 * Whether this tier is open, and what is left if not.
 *
 * Either road alone is enough: a learner who has failed three times has earned
 * tier 3 in one minute, and a learner who has sat with it for fifteen has
 * earned it without submitting anything.
 */
export function hintTierState(signals: HintTierSignals): HintTierState {
  const requiredAttempts = attemptsRequiredFor(signals.tier);
  const requiredMs = msRequiredFor(signals.tier);

  const attemptsRemaining = Math.max(0, requiredAttempts - signals.attemptCount);
  const minutesRemaining = Math.max(0, Math.ceil((requiredMs - signals.elapsedMs) / 60_000));

  const unlocked =
    signals.passed === true ||
    signals.attemptCount >= requiredAttempts ||
    signals.elapsedMs >= requiredMs;

  return { unlocked, attemptsRemaining, minutesRemaining };
}

/**
 * "Available after 2 more attempts or 7 min", assembled once.
 *
 * Lives here rather than in the component because it has to stay true to the
 * rule above it, and a sentence that drifts from the gate it describes is how a
 * learner ends up waiting for something that already opened.
 */
export function describeHintLock(state: HintTierState): string {
  const parts: string[] = [];

  if (state.attemptsRemaining > 0) {
    parts.push(
      `${state.attemptsRemaining} more attempt${state.attemptsRemaining === 1 ? '' : 's'}`,
    );
  }
  if (state.minutesRemaining > 0) {
    parts.push(`${state.minutesRemaining} min`);
  }

  // Both roads met is `unlocked`, so this is only reachable if a caller asks
  // for the copy anyway. Saying "available now" beats an empty sentence.
  if (parts.length === 0) return 'Available now';

  return `Available after ${parts.join(' or ')}`;
}
