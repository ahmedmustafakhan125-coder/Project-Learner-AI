import { describe, expect, it } from 'vitest';
import { scorePacing } from '../src/pacing/score.js';
import type { PaceState, AttemptSummary } from '../src/pacing/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const emptyState: PaceState = {
  recentAttemptCounts: [],
  recentDurations: [],
  hintsUsedTotal: 0,
  streakPassed: 0,
  streakFailed: 0,
};

const attempt = (overrides: Partial<AttemptSummary> = {}): AttemptSummary => ({
  attempts: 1,
  durationMs: 10_000,
  hintsUsed: 0,
  passed: true,
  ...overrides,
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('scorePacing', () => {
  it('cold start: empty state + single attempt → hold', () => {
    const { directive } = scorePacing(emptyState, attempt());
    expect(directive.adjustment).toBe('hold');
    expect(directive.reason).toBe('On track.');
  });

  it('scaffold: 3+ attempts with 2+ hints on current step', () => {
    const { directive } = scorePacing(
      emptyState,
      attempt({ attempts: 4, hintsUsed: 3, passed: false }),
    );
    expect(directive.adjustment).toBe('scaffold');
    expect(directive.reason).toContain('several attempts and hints');
  });

  it('insert_micro_step: streak of 2 multi-attempt steps', () => {
    // First multi-attempt step → streakFailed becomes 1 → hold
    const after1 = scorePacing(emptyState, attempt({ attempts: 2, passed: false }));
    expect(after1.directive.adjustment).toBe('hold');

    // Second multi-attempt step → streakFailed becomes 2 → insert_micro_step
    const after2 = scorePacing(after1.newState, attempt({ attempts: 3, passed: false }));
    expect(after2.directive.adjustment).toBe('insert_micro_step');
    expect(after2.directive.reason).toContain('challenging');
  });

  it('compress: 2 consecutive first-try passes with fast duration', () => {
    // First pass: normal duration (10 s)
    const after1 = scorePacing(emptyState, attempt({ durationMs: 10_000 }));
    expect(after1.directive.adjustment).toBe('hold');

    // Second pass: very fast (2 s). avg = (10000+2000)/2 = 6000; 2000 < 0.5*6000 → compress
    const after2 = scorePacing(after1.newState, attempt({ durationMs: 2_000 }));
    expect(after2.directive.adjustment).toBe('compress');
    expect(after2.directive.reason).toContain('quickly');
  });

  it('stretch: 3 consecutive first-try passes with 0 hints', () => {
    let state = emptyState;
    for (let i = 0; i < 2; i++) {
      const result = scorePacing(state, attempt());
      state = result.newState;
    }
    // Third pass → streakPassed = 3, hintsUsedTotal = 0 → stretch
    const { directive } = scorePacing(state, attempt());
    expect(directive.adjustment).toBe('stretch');
    expect(directive.reason).toContain('well ahead');
  });

  it('hold dominates: ambiguous signals that do not meet any threshold', () => {
    // streakFailed = 1 (not enough for micro_step), attempts = 2 (not enough for scaffold)
    const after1 = scorePacing(emptyState, attempt({ attempts: 2, passed: false }));
    const { directive } = scorePacing(
      after1.newState,
      attempt({ attempts: 1, passed: true }), // resets streakFailed → 0, streakPassed → 1
    );
    expect(directive.adjustment).toBe('hold');
  });

  it('window rolling: only last WINDOW_SIZE entries kept in arrays', () => {
    let state = emptyState;
    for (let i = 1; i <= 5; i++) {
      const result = scorePacing(state, attempt({ attempts: i, durationMs: i * 1_000 }));
      state = result.newState;
    }
    expect(state.recentAttemptCounts).toEqual([3, 4, 5]);
    expect(state.recentDurations).toEqual([3_000, 4_000, 5_000]);
  });

  it('state accumulation: hintsUsedTotal increments correctly', () => {
    const after1 = scorePacing(emptyState, attempt({ hintsUsed: 2 }));
    expect(after1.newState.hintsUsedTotal).toBe(2);

    const after2 = scorePacing(after1.newState, attempt({ hintsUsed: 3 }));
    expect(after2.newState.hintsUsedTotal).toBe(5);

    const after3 = scorePacing(after2.newState, attempt({ hintsUsed: 0 }));
    expect(after3.newState.hintsUsedTotal).toBe(5);
  });

  it('stretch is blocked by a hint still inside the window', () => {
    let state = emptyState;
    const after1 = scorePacing(state, attempt({ hintsUsed: 1 }));
    state = after1.newState;
    const after2 = scorePacing(state, attempt());
    state = after2.newState;
    const after3 = scorePacing(state, attempt());
    // streakPassed = 3, but recentHints is still [1, 0, 0].
    expect(after3.directive.adjustment).not.toBe('stretch');
  });

  it('stretch becomes available again once the hint ages out of the window', () => {
    // The regression this guards: hints were tracked as a LIFETIME total, so a
    // single hint on step 1 disabled stretching for the rest of the project. A
    // learner who needed help once and then pulled ahead could never be
    // stretched again, and nothing about that was visible.
    let state = emptyState;
    state = scorePacing(state, attempt({ hintsUsed: 1 })).newState;

    let last = scorePacing(state, attempt());
    for (let i = 0; i < 3; i++) {
      state = last.newState;
      last = scorePacing(state, attempt());
    }

    expect(last.newState.recentHints).toEqual([0, 0, 0]);
    expect(last.newState.hintsUsedTotal).toBe(1);
    expect(last.directive.adjustment).toBe('stretch');
  });

  it('insert_micro_step takes priority over scaffold', () => {
    // Build streakFailed = 1
    const after1 = scorePacing(emptyState, attempt({ attempts: 2, passed: false }));
    // Second multi-attempt step with high hints: streakFailed=2 AND scaffold both apply
    // insert_micro_step should win (checked first)
    const after2 = scorePacing(
      after1.newState,
      attempt({ attempts: 4, hintsUsed: 3, passed: false }),
    );
    expect(after2.directive.adjustment).toBe('insert_micro_step');
  });
});
