import { z } from 'zod';

/**
 * The assessment's shapes.
 *
 * Two gates. A cheap five-question multiple-choice gate, auto-marked by option
 * index with no model call, and then — only for a learner who passes it — a
 * five-question viva, each question worth exactly five marks against an
 * explicit rubric the learner sees before answering, for 25 in all.
 *
 * What the model produces is validated twice: once by these schemas, leniently,
 * so a near-miss does not cost a repair round trip; then by
 * `validateGeneratedAssessment`, strictly, because a rubric that does not add
 * up to five marks is not a rubric.
 */

export const MCQ_COUNT = 5;
export const MCQ_OPTIONS = 4;
/** Pass the gate with this many right. */
export const MCQ_PASS = 4;

export const VIVA_COUNT = 5;
export const MARKS_PER_QUESTION = 5;
export const VIVA_TOTAL = VIVA_COUNT * MARKS_PER_QUESTION;
/** Below this, a retake is offered. */
export const VIVA_PASS = 15;

export const RubricCriterion = z.object({
  /** Stable within its question, e.g. `c1`. Grades refer to criteria by id. */
  id: z.string().min(1),
  text: z.string().min(1),
  marks: z.number().int().min(1).max(MARKS_PER_QUESTION),
});
export type RubricCriterion = z.infer<typeof RubricCriterion>;

export const McqQuestion = z.object({
  prompt: z.string().min(1),
  options: z.array(z.string().min(1)),
  correctIndex: z.number().int(),
  /** Why the right answer is right — shown once the gate is marked. */
  explanation: z.string().default(''),
});
export type McqQuestion = z.infer<typeof McqQuestion>;

export const VivaQuestion = z.object({
  /** Situational and open: "your component re-renders forever; why, and what would you change?" */
  prompt: z.string().min(1),
  rubric: z.array(RubricCriterion),
  /** A few words naming what this question probes, so a retake can avoid it. */
  topic: z.string().default(''),
});
export type VivaQuestion = z.infer<typeof VivaQuestion>;

/** What the generator returns, before strict validation. */
export const GeneratedAssessment = z.object({
  mcq: z.array(McqQuestion).default([]),
  viva: z.array(VivaQuestion).default([]),
});
export type GeneratedAssessment = z.infer<typeof GeneratedAssessment>;

/** An MCQ as the learner sees it: no answer, no explanation. */
export interface PublicMcq {
  prompt: string;
  options: string[];
}

/** The part of an assessment that is safe to show before it is answered. */
export interface PublicAssessment {
  mcq: PublicMcq[];
  /** Rubrics are public on purpose — a learner should know what earns marks. */
  viva: VivaQuestion[];
}

/** What stays on the server until the gate is marked. */
export interface AssessmentKey {
  correctIndexes: number[];
  explanations: string[];
}

export type AssessmentStatus = 'mcq' | 'mcq_failed' | 'viva' | 'graded' | 'abandoned';

/* ------------------------------------------------------------------ *
 * Strict validation
 * ------------------------------------------------------------------ */

export type ValidationResult =
  | { ok: true; assessment: PublicAssessment; key: AssessmentKey }
  | { ok: false; issues: string[] };

const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * Hold generated questions to the format, and split them into what the learner
 * may see and what they may not. Extra questions are dropped; too few, a
 * malformed option set, or a rubric that does not total five marks is a
 * failure the caller retries.
 */
export function validateGeneratedAssessment(raw: GeneratedAssessment): ValidationResult {
  const issues: string[] = [];

  const mcq = raw.mcq.slice(0, MCQ_COUNT);
  if (mcq.length < MCQ_COUNT) issues.push(`expected ${MCQ_COUNT} multiple-choice questions, got ${mcq.length}`);
  mcq.forEach((q, i) => {
    const options = q.options.map(clean);
    if (options.length !== MCQ_OPTIONS) issues.push(`mcq ${i + 1}: expected ${MCQ_OPTIONS} options, got ${options.length}`);
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) issues.push(`mcq ${i + 1}: duplicate options`);
    if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= options.length) {
      issues.push(`mcq ${i + 1}: correctIndex ${q.correctIndex} is not an option`);
    }
  });

  const viva = raw.viva.slice(0, VIVA_COUNT);
  if (viva.length < VIVA_COUNT) issues.push(`expected ${VIVA_COUNT} viva questions, got ${viva.length}`);
  viva.forEach((q, i) => {
    const total = q.rubric.reduce((sum, c) => sum + c.marks, 0);
    if (total !== MARKS_PER_QUESTION) issues.push(`viva ${i + 1}: rubric totals ${total}, not ${MARKS_PER_QUESTION}`);
    if (new Set(q.rubric.map((c) => c.id)).size !== q.rubric.length) issues.push(`viva ${i + 1}: duplicate criterion ids`);
  });

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    assessment: {
      mcq: mcq.map((q) => ({ prompt: clean(q.prompt), options: q.options.map(clean) })),
      viva: viva.map((q) => ({
        prompt: q.prompt.trim(),
        topic: clean(q.topic),
        rubric: q.rubric.map((c) => ({ id: clean(c.id), text: clean(c.text), marks: c.marks })),
      })),
    },
    key: {
      correctIndexes: mcq.map((q) => q.correctIndex),
      explanations: mcq.map((q) => clean(q.explanation)),
    },
  };
}
