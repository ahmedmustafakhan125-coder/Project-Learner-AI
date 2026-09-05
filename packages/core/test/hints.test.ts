import { describe, expect, it } from 'vitest';

import {
  attemptsRequiredFor,
  describeHintLock,
  hintTierState,
  msRequiredFor,
} from '../src/progress/hints.js';

/**
 * The hint ladder.
 *
 * Two bugs live behind these tests. The rule existed in two places — a table in
 * the component and an inline calculation in the route — so the two could
 * disagree and the learner would be told a hint was available that the server
 * then refused. And the elapsed half was measured from the learner's first
 * ATTEMPT, which made it unreachable for the person it was written for: someone
 * who cannot work out how to start has submitted nothing, so no clock was
 * running and no hint ever opened on time.
 */

const minutes = (n: number) => n * 60_000;

describe('either road is enough on its own', () => {
  it('opens tier 1 after one attempt, with no time passed', () => {
    expect(hintTierState({ tier: 1, attemptCount: 1, elapsedMs: 0 }).unlocked).toBe(true);
  });

  it('opens tier 1 after five minutes, with no attempt made', () => {
    // The case that never worked. With the clock starting at the first attempt,
    // elapsed was always 0 here and this hint stayed shut forever.
    expect(hintTierState({ tier: 1, attemptCount: 0, elapsedMs: minutes(5) }).unlocked).toBe(true);
  });

  it('opens tier 3 after fifteen minutes, with no attempt made', () => {
    expect(hintTierState({ tier: 3, attemptCount: 0, elapsedMs: minutes(15) }).unlocked).toBe(true);
  });

  it('keeps tier 3 shut at fourteen minutes and two attempts', () => {
    const state = hintTierState({ tier: 3, attemptCount: 2, elapsedMs: minutes(14) });
    expect(state.unlocked).toBe(false);
    expect(state.attemptsRemaining).toBe(1);
    expect(state.minutesRemaining).toBe(1);
  });
});

describe('a step that has been passed', () => {
  it('opens every tier immediately', () => {
    // The ladder is there so nobody reads the answer before thinking about the
    // problem. Passing spends that reason.
    for (const tier of [1, 2, 3]) {
      expect(hintTierState({ tier, attemptCount: 0, elapsedMs: 0, passed: true }).unlocked).toBe(
        true,
      );
    }
  });
});

describe('the thresholds themselves', () => {
  it('scale with the tier', () => {
    expect(attemptsRequiredFor(1)).toBe(1);
    expect(attemptsRequiredFor(3)).toBe(3);
    expect(msRequiredFor(1)).toBe(minutes(5));
    expect(msRequiredFor(3)).toBe(minutes(15));
  });

  it('never demand less than tier 1 does, whatever they are handed', () => {
    // A checkpoint with a tier-0 hint would otherwise be open before the
    // learner had read the step.
    expect(attemptsRequiredFor(0)).toBe(1);
    expect(msRequiredFor(0)).toBe(minutes(5));
    expect(hintTierState({ tier: 0, attemptCount: 0, elapsedMs: 0 }).unlocked).toBe(false);
  });
});

describe('what the learner is told while waiting', () => {
  it('names both roads while both are open', () => {
    const state = hintTierState({ tier: 2, attemptCount: 0, elapsedMs: 0 });
    expect(describeHintLock(state)).toBe('Available after 2 more attempts or 10 min');
  });

  it('drops the attempts road once it is met', () => {
    // Telling someone they need "0 more attempts" is worse than saying nothing.
    const state = hintTierState({ tier: 2, attemptCount: 2, elapsedMs: 0 });
    expect(state.unlocked).toBe(true);
    expect(describeHintLock(state)).not.toContain('attempt');
  });

  it('drops the time road once it is met', () => {
    const state = hintTierState({ tier: 2, attemptCount: 0, elapsedMs: minutes(10) });
    expect(describeHintLock(state)).not.toContain('min');
  });

  it('uses the singular for one attempt, because it is read every time', () => {
    const state = hintTierState({ tier: 1, attemptCount: 0, elapsedMs: minutes(4) });
    expect(describeHintLock(state)).toBe('Available after 1 more attempt or 1 min');
  });

  it('rounds part-minutes up, so the countdown never says zero while locked', () => {
    // Rounding down would show "0 min" on a hint that is still shut, which
    // reads as broken rather than as nearly ready.
    const state = hintTierState({ tier: 1, attemptCount: 0, elapsedMs: minutes(4.5) });
    expect(state.minutesRemaining).toBe(1);
  });
});
