import { describe, expect, it } from 'vitest';

import {
  MASTERY_RULES,
  NO_MASTERY,
  afterCheckpoint,
  afterQuestion,
  afterViva,
  roundMastery,
} from '../src/brain/mastery.js';
import type { Mastery } from '../src/brain/mastery.js';

/** A small seeded PRNG, so the property checks below are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the viva formula (fixed by the specification)', () => {
  it('12/25 then 22/25 produces the expected score and confidence', () => {
    const first = afterViva(NO_MASTERY, 12, 1);
    expect(first.score).toBeCloseTo(0.3 * (12 / 25), 10); // 0.144
    expect(first.confidence).toBeCloseTo(0.15, 10);

    const second = afterViva(first, 22, 2);
    expect(second.score).toBeCloseTo(0.7 * 0.144 + 0.3 * (22 / 25), 10); // 0.3648
    expect(second.confidence).toBeCloseTo(0.15 + 0.15 / 2, 10); // 0.225
    expect(roundMastery(second.score)).toBe(0.365);
  });

  it('weights the old score 0.7 and the new evidence 0.3', () => {
    expect(afterViva({ score: 0.5, confidence: 0 }, 25, 1).score).toBeCloseTo(0.65, 10);
    expect(afterViva({ score: 0.5, confidence: 0 }, 0, 1).score).toBeCloseTo(0.35, 10);
  });

  it('never lets confidence pass 1', () => {
    let m: Mastery = NO_MASTERY;
    for (let i = 0; i < 20; i += 1) m = afterViva(m, 25, 1);
    expect(m.confidence).toBe(1);
  });

  it('treats a nonsense attempt number as a first attempt', () => {
    expect(afterViva(NO_MASTERY, 20, 0)).toEqual(afterViva(NO_MASTERY, 20, 1));
  });
});

describe('everyday evidence', () => {
  it('a question moves mastery toward 0.75, never past it', () => {
    let m: Mastery = NO_MASTERY;
    for (let i = 0; i < 200; i += 1) m = afterQuestion(m);
    expect(m.score).toBeLessThanOrEqual(MASTERY_RULES.questionAnswered.target);
    expect(m.score).toBeGreaterThan(0.74);
  });

  it('asking alone takes about ten questions to reach the 0.6 offer threshold', () => {
    let m: Mastery = NO_MASTERY;
    let asked = 0;
    while (m.score < 0.6) {
      m = afterQuestion(m);
      asked += 1;
    }
    expect(asked).toBe(10);
  });

  it('a pass is worth more than a question; a fail pulls down', () => {
    const start: Mastery = { score: 0.5, confidence: 0.2 };
    expect(afterCheckpoint(start, true).score).toBeGreaterThan(afterQuestion(start).score);
    expect(afterCheckpoint(start, false).score).toBeLessThan(start.score);
  });
});

describe('properties, over seeded random histories', () => {
  const steps: Array<(m: Mastery, rand: () => number) => Mastery> = [
    (m) => afterQuestion(m),
    (m) => afterCheckpoint(m, true),
    (m) => afterCheckpoint(m, false),
    (m, rand) => afterViva(m, Math.floor(rand() * 26), 1 + Math.floor(rand() * 5)),
  ];

  it('score and confidence always stay in [0, 1]', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rand = mulberry32(seed);
      let m: Mastery = NO_MASTERY;
      for (let i = 0; i < 60; i += 1) {
        m = (steps[Math.floor(rand() * steps.length)] as (typeof steps)[number])(m, rand);
        expect(m.score).toBeGreaterThanOrEqual(0);
        expect(m.score).toBeLessThanOrEqual(1);
        expect(m.confidence).toBeGreaterThanOrEqual(0);
        expect(m.confidence).toBeLessThanOrEqual(1);
      }
    }
  });

  it('every update moves the score toward its evidence, never away', () => {
    const rand = mulberry32(42);
    for (let i = 0; i < 500; i += 1) {
      const m: Mastery = { score: rand(), confidence: rand() };
      const marks = Math.floor(rand() * 26);
      const cases: Array<[Mastery, number]> = [
        [afterQuestion(m), MASTERY_RULES.questionAnswered.target],
        [afterCheckpoint(m, true), MASTERY_RULES.checkpointPassed.target],
        [afterCheckpoint(m, false), MASTERY_RULES.checkpointFailed.target],
        [afterViva(m, marks, 1), marks / 25],
      ];
      for (const [next, target] of cases) {
        expect(Math.abs(next.score - target)).toBeLessThanOrEqual(Math.abs(m.score - target) + 1e-12);
      }
    }
  });

  it('confidence never decreases', () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 500; i += 1) {
      const m: Mastery = { score: rand(), confidence: rand() };
      for (const step of steps) expect(step(m, rand).confidence).toBeGreaterThanOrEqual(m.confidence);
    }
  });
});
