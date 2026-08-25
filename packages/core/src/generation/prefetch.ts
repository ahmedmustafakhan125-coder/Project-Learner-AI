/**
 * Which step to expand next, and when.
 *
 * Expanding lazily is what keeps pacing possible, but expanding *only* on
 * demand would make the learner wait for a model call every time they finish a
 * step. The compromise: expand the step they need now, and quietly expand the
 * next one while they work.
 *
 * Pure and synchronous — the caller performs the work. That keeps the policy
 * testable without a network and identical on web and mobile.
 */

export interface StepExpansionState {
  index: number;
  /** True once Phase B has produced content for this step. */
  expanded: boolean;
  /** True while an expansion request is in flight. */
  expanding: boolean;
}

export interface PrefetchPlan {
  /** Must be expanded before the learner can continue. Blocks the UI. */
  blocking: number | null;
  /** Worth expanding in the background now. Never blocks. */
  background: number[];
}

/** How far ahead to run. One step is enough to hide the latency. */
export const PREFETCH_DEPTH = 1;

/**
 * `currentIndex` is the step the learner is on right now.
 *
 * A step already in flight is never returned again — without that check a
 * component re-rendering while a request is pending would fire duplicate
 * expansions and bill twice for the same step.
 */
export function planExpansion(
  steps: StepExpansionState[],
  currentIndex: number,
): PrefetchPlan {
  const at = (index: number): StepExpansionState | undefined =>
    steps.find((step) => step.index === index);

  const current = at(currentIndex);
  const blocking = current && !current.expanded && !current.expanding ? currentIndex : null;

  const background: number[] = [];
  for (let offset = 1; offset <= PREFETCH_DEPTH; offset += 1) {
    const next = at(currentIndex + offset);
    if (!next) break;
    // Stop at the first gap: expanding step N+2 before N+1 would produce a
    // later step written without knowing what came before it.
    if (next.expanded || next.expanding) continue;
    background.push(next.index);
    break;
  }

  return { blocking, background };
}

/**
 * Whether the learner can move to `targetIndex`.
 *
 * Only guards *generation* readiness. Whether they have earned the right to
 * advance is the checkpoint's business (P3), not this function's.
 */
export function canNavigateTo(steps: StepExpansionState[], targetIndex: number): boolean {
  const target = steps.find((step) => step.index === targetIndex);
  return Boolean(target?.expanded);
}

/** Fraction of the project expanded so far — drives the generation progress bar. */
export function expansionProgress(steps: StepExpansionState[]): number {
  if (steps.length === 0) return 0;
  return steps.filter((step) => step.expanded).length / steps.length;
}
