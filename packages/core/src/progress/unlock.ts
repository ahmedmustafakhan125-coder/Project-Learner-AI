/**
 * Which steps the learner has earned the right to work on.
 *
 * Generation readiness and *earning* a step are different questions.
 * `canNavigateTo` in `prefetch.ts` answers the first — has Phase B written this
 * step yet — and says in its own comment that whether the learner may advance
 * is the checkpoint's business. This is that business.
 *
 * It matters more than it used to. Each step is now written against the code
 * the previous one produced, so a learner who jumps to step 6 is handed starter
 * files that continue work they never did. The gate is not there to be strict;
 * it is there because the sequence is now real.
 *
 * Pure and synchronous, and used on both sides: the server enforces it, the UI
 * renders it. Two implementations of this rule would eventually disagree, and
 * the disagreement would look like a bug in whichever one the learner saw.
 */

export interface StepPassState {
  index: number;
  /** True once any attempt on this step has passed. */
  passed: boolean;
}

export type LockReason =
  /** Open: earned, or the first step. */
  | 'unlocked'
  /** The step before it has not been passed. */
  | 'needs_previous';

export interface StepLockState {
  index: number;
  unlocked: boolean;
  reason: LockReason;
  /** The step that must be passed first. Null when unlocked. */
  blockedBy: number | null;
}

/**
 * The highest step index the learner may work on.
 *
 * Three things can unlock a step, and the most generous wins:
 *
 *   - it is the first step, which is always open;
 *   - the step before it has been passed;
 *   - the enrollment already reached it.
 *
 * That last clause is what stops this locking people out of their own work.
 * `current_step_index` never moved before this shipped, so it contributes
 * nothing for most projects — but a learner who legitimately reached step 5
 * under the old rules keeps step 5, rather than being sent back to step 1 by an
 * update they did not ask for.
 */
export function unlockedThrough(steps: StepPassState[], furthestReached = 0): number {
  const passed = steps.filter((step) => step.passed).map((step) => step.index);
  const afterLastPass = passed.length > 0 ? Math.max(...passed) + 1 : 0;
  const last = steps.length > 0 ? Math.max(...steps.map((step) => step.index)) : 0;

  return Math.min(last, Math.max(0, afterLastPass, furthestReached));
}

/** Whether one step is open. */
export function isUnlocked(
  steps: StepPassState[],
  index: number,
  furthestReached = 0,
): boolean {
  return index <= unlockedThrough(steps, furthestReached);
}

/** Lock state for every step, in index order — what the navigator renders from. */
export function lockStates(steps: StepPassState[], furthestReached = 0): StepLockState[] {
  const limit = unlockedThrough(steps, furthestReached);

  return [...steps]
    .sort((a, b) => a.index - b.index)
    .map((step) => ({
      index: step.index,
      unlocked: step.index <= limit,
      reason: step.index <= limit ? ('unlocked' as const) : ('needs_previous' as const),
      // Always the immediately preceding step: that is the one whose code this
      // step continues, and naming it is more useful than "finish the earlier
      // steps".
      blockedBy: step.index <= limit ? null : step.index - 1,
    }));
}

/**
 * How far generation may run ahead.
 *
 * One step past the frontier, matching the existing prefetch depth: the next
 * step is written while the learner works on the current one, so finishing does
 * not mean waiting for a model call. Anything beyond that is refused — it would
 * bill for content the learner cannot act on, and a step written too early
 * cannot be reshaped by how they are actually doing, which is the entire reason
 * expansion is lazy.
 */
export function mayExpand(
  steps: StepPassState[],
  index: number,
  furthestReached = 0,
): boolean {
  return index <= unlockedThrough(steps, furthestReached) + 1;
}
