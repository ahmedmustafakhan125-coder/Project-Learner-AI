import { describe, expect, it } from 'vitest';

import { isUnlocked, lockStates, mayExpand, unlockedThrough } from '../src/index.js';

const steps = (passed: boolean[]) => passed.map((p, index) => ({ index, passed: p }));

describe('unlockedThrough', () => {
  it('opens only the first step on a fresh project', () => {
    expect(unlockedThrough(steps([false, false, false, false]))).toBe(0);
  });

  it('opens the next step once the current one passes', () => {
    expect(unlockedThrough(steps([true, false, false, false]))).toBe(1);
    expect(unlockedThrough(steps([true, true, false, false]))).toBe(2);
  });

  it('never opens past the last step', () => {
    expect(unlockedThrough(steps([true, true, true]))).toBe(2);
  });

  it('does not lock a learner out of work they already reached', () => {
    // current_step_index never moved before this shipped, so someone could
    // legitimately be on step 4 with nothing recorded as passed. Sending them
    // back to step 1 on an update they did not ask for is not acceptable.
    expect(unlockedThrough(steps([false, false, false, false, false]), 3)).toBe(3);
  });

  it('takes the most generous of the two signals', () => {
    expect(unlockedThrough(steps([true, true, false, false]), 1)).toBe(2);
    expect(unlockedThrough(steps([true, false, false, false]), 3)).toBe(3);
  });

  it('recovers from legacy out-of-order passes rather than stranding them', () => {
    // Impossible under the lock, reachable in data written before it existed.
    expect(unlockedThrough(steps([true, false, true, false]))).toBe(3);
  });

  it('handles a project with no steps without throwing', () => {
    expect(unlockedThrough([])).toBe(0);
  });
});

describe('isUnlocked', () => {
  it('gates each step on the one before it', () => {
    const project = steps([true, false, false]);
    expect(isUnlocked(project, 0)).toBe(true);
    expect(isUnlocked(project, 1)).toBe(true);
    expect(isUnlocked(project, 2)).toBe(false);
  });
});

describe('lockStates', () => {
  it('names the step that has to be passed first', () => {
    const result = lockStates(steps([true, false, false]));

    expect(result[1]).toEqual({ index: 1, unlocked: true, reason: 'unlocked', blockedBy: null });
    expect(result[2]).toEqual({
      index: 2,
      unlocked: false,
      reason: 'needs_previous',
      blockedBy: 1,
    });
  });

  it('returns steps in index order however they arrive', () => {
    const shuffled = [
      { index: 2, passed: false },
      { index: 0, passed: true },
      { index: 1, passed: false },
    ];
    expect(lockStates(shuffled).map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it('keeps a passed step open so it can be revisited', () => {
    const result = lockStates(steps([true, true, false]));
    expect(result[0]?.unlocked).toBe(true);
    expect(result[1]?.unlocked).toBe(true);
  });
});

describe('mayExpand', () => {
  it('allows one step past the frontier so the next one is prefetched', () => {
    const project = steps([true, false, false, false]);
    expect(mayExpand(project, 1)).toBe(true);
    expect(mayExpand(project, 2)).toBe(true);
    // Two ahead would bill for a step the learner cannot act on, and a step
    // written this early can no longer be reshaped by how they are doing.
    expect(mayExpand(project, 3)).toBe(false);
  });

  it('allows the first two steps on a fresh project', () => {
    const project = steps([false, false, false]);
    expect(mayExpand(project, 0)).toBe(true);
    expect(mayExpand(project, 1)).toBe(true);
    expect(mayExpand(project, 2)).toBe(false);
  });
});
