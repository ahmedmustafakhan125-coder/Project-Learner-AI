/**
 * Grader calibration, against a real model.
 *
 * The viva grader is a model, and a model's judgement drifts with every prompt
 * change and every model swap. This suite grades a fixed set of answers whose
 * marks a human has set, and fails if the grader agrees with the human on
 * fewer than 80% of them — "agrees" meaning within one mark.
 *
 * Opt-in, because it calls a real provider and costs money:
 *
 *   npm run test:calibration --workspace @ai-edu/api
 *
 * It reads keys from the repository's .env like the API does, uses the
 * `review` task's model, and skips itself when no provider is configured.
 *
 * Read the fixture's `reviewed` flag before trusting the number. The starting
 * set was drafted, not marked by a teacher; agreement with a draft proves
 * consistency, not correctness.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { GraderOutput, buildGraderRequest, graderContext, scoreFromCriteria } from '@ai-edu/core';
import type { RubricCriterion } from '@ai-edu/core';
import { createProviderForTask } from '@ai-edu/llm';
import type { LLMProvider } from '@ai-edu/llm';

interface Fixture {
  concept: string;
  reviewed: boolean;
  questions: Array<{ id: string; prompt: string; rubric: RubricCriterion[] }>;
  answers: Array<{ question: string; answer: string; human: Record<string, boolean>; score: number }>;
}

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/core/fixtures/assessment');
const fixture = JSON.parse(readFileSync(resolve(FIXTURE_DIR, 'closures.calibration.json'), 'utf-8')) as Fixture;

const AGREEMENT_REQUIRED = 0.8;

let provider: LLMProvider | null = null;
try {
  provider = createProviderForTask('assessment');
} catch {
  provider = null;
}

describe.skipIf(!provider)(`grader calibration — ${fixture.concept}${fixture.reviewed ? '' : ' (DRAFT marks)'}`, () => {
  it(`agrees with the human mark, within one, on at least ${AGREEMENT_REQUIRED * 100}% of answers`, async () => {
    const llm = provider as LLMProvider;
    const rows: Array<{ answer: string; human: number; model: number; agrees: boolean }> = [];

    for (const item of fixture.answers) {
      const question = fixture.questions.find((q) => q.id === item.question);
      if (!question) throw new Error(`fixture answer refers to unknown question ${item.question}`);
      const context = graderContext({ prompt: question.prompt, rubric: question.rubric, topic: '' }, item.answer);
      const result = await llm.structured(buildGraderRequest(llm.modelId, context), GraderOutput);
      const grade = scoreFromCriteria(context, result.data);
      rows.push({
        answer: item.answer.slice(0, 50),
        human: item.score,
        model: grade.score,
        agrees: Math.abs(grade.score - item.score) <= 1,
      });
    }

    const agreement = rows.filter((r) => r.agrees).length / rows.length;
    console.table(rows);
    console.log(
      `agreement ${(agreement * 100).toFixed(0)}% on ${rows.length} answers, model ${llm.modelId}` +
        (fixture.reviewed ? '' : ' — against DRAFT marks; have a human review the fixture'),
    );
    expect(agreement).toBeGreaterThanOrEqual(AGREEMENT_REQUIRED);
  }, 300_000);
});
