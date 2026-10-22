/**
 * The calibration set must be internally consistent before it can measure
 * anything. Hermetic — no model is called; the live comparison is
 * calibration.live.test.ts.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { MARKS_PER_QUESTION, graderContext, scoreFromCriteria } from '@ai-edu/core';
import type { RubricCriterion } from '@ai-edu/core';

interface Fixture {
  reviewed: boolean;
  questions: Array<{ id: string; prompt: string; rubric: RubricCriterion[] }>;
  answers: Array<{ question: string; answer: string; human: Record<string, boolean>; score: number }>;
}

const fixture = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/core/fixtures/assessment/closures.calibration.json'),
    'utf-8',
  ),
) as Fixture;

describe('closures calibration fixture', () => {
  it('has at least ten answers, spread across the mark range', () => {
    expect(fixture.answers.length).toBeGreaterThanOrEqual(10);
    const scores = new Set(fixture.answers.map((a) => a.score));
    expect(scores.has(0) && scores.has(5)).toBe(true);
  });

  it('every rubric is worth exactly five marks', () => {
    for (const q of fixture.questions) {
      expect(q.rubric.reduce((sum, c) => sum + c.marks, 0)).toBe(MARKS_PER_QUESTION);
    }
  });

  it('every answer judges every criterion, and its score is the sum the grader would compute', () => {
    for (const item of fixture.answers) {
      const question = fixture.questions.find((q) => q.id === item.question);
      expect(question, `unknown question ${item.question}`).toBeDefined();
      if (!question) continue;
      expect(Object.keys(item.human).sort()).toEqual(question.rubric.map((c) => c.id).sort());

      // Feed the human's judgements through the real scoring, quoting the
      // whole answer as evidence: the arithmetic must land on the stated mark.
      const context = graderContext({ prompt: question.prompt, rubric: question.rubric, topic: '' }, item.answer);
      const result = scoreFromCriteria(context, {
        criteria: question.rubric.map((c) => ({ id: c.id, met: item.human[c.id] === true, evidence_quote: item.answer })),
        confidence: 'high',
      });
      expect(result.score, item.answer.slice(0, 40)).toBe(item.score);
    }
  });
});
