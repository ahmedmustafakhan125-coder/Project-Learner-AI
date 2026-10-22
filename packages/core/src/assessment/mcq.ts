import { MCQ_PASS } from './schemas.js';
import type { AssessmentKey } from './schemas.js';

/**
 * Marking the multiple-choice gate. By option index, in code — no model is
 * asked, so the gate costs nothing and cannot be argued with.
 *
 * The gate exists to protect the viva. Grading five open answers takes five to
 * ten model calls; spending them on someone who has not yet absorbed the
 * basics helps nobody, least of all the learner.
 */

export interface McqResult {
  score: number;
  total: number;
  passed: boolean;
  /** Per question: did they choose the right option? */
  correct: boolean[];
}

export function scoreMcq(key: Pick<AssessmentKey, 'correctIndexes'>, answers: readonly number[]): McqResult {
  const correct = key.correctIndexes.map((right, i) => answers[i] === right);
  const score = correct.filter(Boolean).length;
  return { score, total: key.correctIndexes.length, passed: score >= MCQ_PASS, correct };
}
