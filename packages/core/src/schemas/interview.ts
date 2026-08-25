import { z } from 'zod';
import { AttachmentRef, QueryIntent, SkillLevel } from './common.js';

/**
 * Context interview schemas.
 *
 * The division of labour matters: the model only ever *extracts* and *phrases*.
 * Which slots exist, whether enough is known, and what the final query looks
 * like are all decided by deterministic code — so the interview is testable
 * without touching an API and behaves the same on every provider.
 */

/* ------------------------------------------------------------------ *
 * Slots
 * ------------------------------------------------------------------ */

export const SlotValue = z.object({
  value: z.string(),
  /** Where this came from — drives whether it can be trusted without asking. */
  source: z.enum(['query', 'profile', 'project', 'step', 'attachment', 'answer']),
});
export type SlotValue = z.infer<typeof SlotValue>;

export const Slots = z.record(z.string(), SlotValue);
export type Slots = z.infer<typeof Slots>;

/* ------------------------------------------------------------------ *
 * Model-facing shapes
 * ------------------------------------------------------------------ */

/**
 * What the classifier returns. It reads the raw query and reports the intent
 * plus any slot values it can already see in the text. It does NOT decide
 * sufficiency — that is scored by a pure function.
 */
export const ClassificationResult = z.object({
  intent: QueryIntent,
  /** Slot key → value the model found stated or clearly implied in the query. */
  extracted: z.record(z.string(), z.string()),
  /** One short sentence, shown in debug tooling only. */
  reasoning: z.string().default(''),
});
export type ClassificationResult = z.infer<typeof ClassificationResult>;

export const QuestionOption = z.object({
  label: z.string(),
  value: z.string(),
});

export const InterviewQuestion = z.object({
  /** The slot this question fills. Must be one of the declared missing slots. */
  slot: z.string(),
  question: z.string(),
  /** Shown as helper text — people answer better when they know what it is for. */
  why: z.string(),
  type: z.enum(['single', 'multi', 'text']),
  options: z.array(QuestionOption).default([]),
  allowOther: z.boolean().default(true),
});
export type InterviewQuestion = z.infer<typeof InterviewQuestion>;

/** Hard cap. More than this reads as a form, and people abandon forms. */
export const MAX_QUESTIONS = 5;

export const QuestionSet = z.object({
  questions: z.array(InterviewQuestion).max(MAX_QUESTIONS),
});
export type QuestionSet = z.infer<typeof QuestionSet>;

/* ------------------------------------------------------------------ *
 * Pipeline state
 * ------------------------------------------------------------------ */

/** Everything already known before the learner is asked anything. */
export const InterviewContext = z.object({
  skillLevel: SkillLevel.nullable().default(null),
  knownStacks: z.array(z.string()).default([]),
  goals: z.array(z.string()).default([]),
  projectTitle: z.string().nullable().default(null),
  projectTech: z.array(z.string()).default([]),
  stepTitle: z.string().nullable().default(null),
  stepConcepts: z.array(z.string()).default([]),
  attachments: z.array(AttachmentRef).default([]),
});
export type InterviewContext = z.infer<typeof InterviewContext>;

export const SufficiencyScore = z.object({
  /** 0..1 — the share of required slots that are filled, weighted. */
  score: z.number().min(0).max(1),
  missing: z.array(z.string()),
  /** True when the pipeline should ask before proceeding. */
  needsInterview: z.boolean(),
});
export type SufficiencyScore = z.infer<typeof SufficiencyScore>;

/** At most one follow-up round; two is an interrogation. */
export const MAX_ROUNDS = 2;

export const InterviewState = z.object({
  rawQuery: z.string(),
  intent: QueryIntent,
  slots: Slots,
  /** Slot keys filled without asking — used to explain "why so few questions?". */
  autoFilled: z.array(z.string()).default([]),
  questions: z.array(InterviewQuestion).default([]),
  round: z.number().int().min(0).default(0),
  sufficiency: z.number().min(0).max(1).default(0),
  skipped: z.boolean().default(false),
  status: z.enum(['assessing', 'awaiting_answers', 'ready']),
});
export type InterviewState = z.infer<typeof InterviewState>;

/**
 * The artifact that actually reaches the model. Not the raw query — this is
 * what gets fanned out and cached.
 */
export const CompiledQuery = z.object({
  intent: QueryIntent,
  originalQuery: z.string(),
  /** Rendered canonical block: the question plus every resolved slot. */
  text: z.string(),
  slots: Slots,
  attachments: z.array(AttachmentRef).default([]),
  /** True when the learner pressed Skip and some required slots stayed empty. */
  partial: z.boolean().default(false),
});
export type CompiledQuery = z.infer<typeof CompiledQuery>;
