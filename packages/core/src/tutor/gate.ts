/**
 * When the project tutor is allowed to write code for the learner.
 *
 * The tutor answers freely from the first message — it explains, it points at
 * the right idea, it reads their actual code and tells them what is wrong with
 * it. What it withholds is the code itself, because writing the code is the
 * entire product. A tutor that hands over a working function on request is a
 * faster way to not learn programming than having no tutor at all.
 *
 * So the reveal is earned, and earning it has two independent parts.
 *
 * PREREQUISITES are things that must all be true. They are the floor: they say
 * the learner has actually engaged with this step rather than opened it and
 * asked. Failing attempts is the load-bearing one — you cannot fail a
 * checkpoint without having written something and submitted it.
 *
 * The SCORE is a weighted total on top of that floor, so effort in one form
 * partly substitutes for another. Someone who has failed five times and asked
 * twice is as stuck as someone who failed three times, asked four times and
 * spent twenty minutes, and a rule made of hard thresholds alone cannot say so.
 *
 * Neither half is enough on its own. The floor alone is gameable by rushing;
 * the score alone can be reached by waiting. Together they need real work.
 *
 * Everything here is a pure function of counters the server already stores, and
 * it is evaluated server-side from those rows — never from anything the browser
 * reports. A gate the client can assert its way past is not a gate.
 */

/** What the server knows about how this step has gone. */
export interface StuckSignals {
  /** Submissions that were graded and did not pass. Refused junk is not here. */
  failedAttempts: number;
  /** Questions asked to the tutor on this step. */
  asksThisStep: number;
  /** Hint tiers already opened. */
  hintTiersSpent: number;
  /** Hint tiers this step has at all — a step with none cannot require any. */
  hintTiersAvailable: number;
  /** Time since the first attempt on this step. Zero before they submit. */
  msOnStep: number;
}

export interface GateState {
  unlocked: boolean;
  score: number;
  threshold: number;
  /**
   * What is still missing, in the learner's words.
   *
   * The composite score's one real weakness is that it is opaque — a number
   * going up tells nobody what to do. This is what the panel shows instead, so
   * the tutor never has to say "no" without saying "not yet, because".
   */
  missing: string[];
}

/* ------------------------------------------------------------------ *
 * Calibration
 * ------------------------------------------------------------------ */

/**
 * Moderate: roughly three failed attempts, two questions, the hints spent, and
 * fifteen-odd minutes of real work.
 *
 * Deliberately reachable within one sitting. A learner who is genuinely stuck
 * and cannot get unstuck abandons the project, and an abandoned project teaches
 * nothing at all — the gate is there to make the code the last resort, not to
 * make it unreachable.
 */
export const PREREQUISITES = {
  failedAttempts: 3,
  asksThisStep: 2,
} as const;

/**
 * The bar, before the step's own hints are added to it.
 *
 * The threshold has to sit ABOVE what the prerequisites alone produce, or the
 * score decides nothing: meeting the floor would carry you over it by itself.
 * The bare floor on a three-hint step is 11 - three failed attempts, two asks,
 * three hints, no time - so a flat 10 made the gate the prerequisites wearing
 * a number, which is what the tests caught.
 *
 * It scales with the hints the step actually has for a second reason. A step
 * whose expansion produced none caps several points lower than one with three,
 * so a fixed bar would quietly make the steps offering least help the hardest
 * ones to unlock.
 */
export const SCORE_THRESHOLD_BASE = 10;

/** The bar for a step, given how much help that step has to offer. */
export function thresholdFor(hintTiersAvailable: number): number {
  return SCORE_THRESHOLD_BASE + Math.max(0, hintTiersAvailable);
}

/** Time counts, but only up to a point: waiting is not working. */
export const MAX_TIME_POINTS = 4;
export const MINUTES_PER_POINT = 5;

/* ------------------------------------------------------------------ */

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The weighted total.
 *
 * A failed attempt is worth double anything else because it is the only signal
 * that cannot be produced without writing code and submitting it. Asking and
 * reading hints are worth one each; they are engagement, but cheap engagement.
 * Time is capped at four points so a step left open over lunch does not unlock
 * itself.
 */
export function stuckScore(signals: StuckSignals): number {
  const timePoints = Math.min(
    MAX_TIME_POINTS,
    Math.floor(signals.msOnStep / (MINUTES_PER_POINT * 60_000)),
  );

  return (
    2 * signals.failedAttempts + signals.asksThisStep + signals.hintTiersSpent + timePoints
  );
}

/**
 * Whether the tutor may write code, and what is left if not.
 *
 * `hintTiersAvailable` is respected rather than assumed: a step whose expansion
 * produced no hints cannot require the learner to have spent any, and demanding
 * it would make the reveal permanently unreachable on that step.
 */
export function evaluateGate(signals: StuckSignals): GateState {
  const score = stuckScore(signals);
  const threshold = thresholdFor(signals.hintTiersAvailable);
  const missing: string[] = [];

  const attemptsShort = PREREQUISITES.failedAttempts - signals.failedAttempts;
  if (attemptsShort > 0) {
    missing.push(
      `${plural(attemptsShort, 'more attempt', 'more attempts')} at the checkpoint`,
    );
  }

  const asksShort = PREREQUISITES.asksThisStep - signals.asksThisStep;
  if (asksShort > 0) {
    missing.push(`${plural(asksShort, 'more question', 'more questions')} about this step`);
  }

  const hintsShort = signals.hintTiersAvailable - signals.hintTiersSpent;
  if (hintsShort > 0) {
    missing.push(`${plural(hintsShort, 'unopened hint', 'unopened hints')}`);
  }

  /*
   * The score is only mentioned once the floor is met.
   *
   * Listing "5 more points" beside three concrete things to do would be the
   * one item on the list nobody can act on, and it would be the item people
   * remember. While anything concrete is outstanding, that is the whole answer.
   */
  if (missing.length === 0 && score < threshold) {
    missing.push('a little more time on this step');
  }

  return {
    unlocked: missing.length === 0 && score >= threshold,
    score,
    threshold,
    missing,
  };
}

/**
 * Whether a message is asking for the code rather than for help.
 *
 * Used only to decide whether a refusal needs explaining. The tutor answers
 * every message either way — this is what tells the panel to show the learner
 * how close they are instead of letting the model improvise a refusal, which is
 * where a model will eventually improvise its way into just writing the code.
 */
const CODE_REQUEST =
  /\b(give|show|write|just tell|tell me|paste|provide|share|do)\b[^.?!]{0,40}\b(the |this |my )?(code|answer|solution|implementation|function|method|body)\b/i;

export function looksLikeCodeRequest(message: string): boolean {
  return CODE_REQUEST.test(message);
}
