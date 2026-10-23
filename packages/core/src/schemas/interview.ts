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
export type QuestionOption = z.infer<typeof QuestionOption>;

/** A question as the model writes it. `QuestionSet` asks for exactly this shape. */
const ModelQuestion = z.object({
  /** The slot this question fills. Must be one of the declared missing slots. */
  slot: z.string(),
  question: z.string(),
  /** Shown as helper text — people answer better when they know what it is for. */
  why: z.string(),
  type: z.enum(['single', 'multi', 'text']),
  options: z.array(QuestionOption).default([]),
  allowOther: z.boolean().default(true),
});

/** What a stack option is, so a learner can choose one without knowing its name already. */
export const OptionDetail = z.object({
  /** The languages it is written in. */
  language: z.string(),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  /** The kind of project it fits best. */
  bestFor: z.string(),
  /** What the learner comes away understanding. */
  learn: z.string(),
});
export type OptionDetail = z.infer<typeof OptionDetail>;

/** An option on a question code wrote: the model's option plus what explains it. */
export const ChoiceOption = QuestionOption.extend({
  /** One line under the label. */
  hint: z.string().optional(),
  detail: OptionDetail.optional(),
  /** Why this is the option to start with. Set on at most one option. */
  recommended: z.string().optional(),
});
export type ChoiceOption = z.infer<typeof ChoiceOption>;

/**
 * A question as the learner sees it. The extra fields are set only by the
 * project page's questions, which code writes (`projectQuestions`); the model
 * is never asked for them, so its schema is unchanged.
 */
export const InterviewQuestion = ModelQuestion.extend({
  options: z.array(ChoiceOption).default([]),
  /** Hint inside the free-text box. */
  placeholder: z.string().optional(),
  /**
   * Chips that replace `options` once another question in the same round is
   * answered with one of its own chips, keyed by that chip's value. The stack
   * question follows the kind of project.
   */
  follows: z
    .object({
      slot: z.string(),
      options: z.record(z.string(), z.array(ChoiceOption)),
    })
    .optional(),
});
export type InterviewQuestion = z.infer<typeof InterviewQuestion>;

/** Hard cap. More than this reads as a form, and people abandon forms. */
export const MAX_QUESTIONS = 5;

export const QuestionSet = z.object({
  questions: z.array(ModelQuestion).max(MAX_QUESTIONS),
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

/**
 * Who is asking. `ask` is the workspace, with the questions worded by the
 * model. `project` is the project page with PROJECT_LEARNER on: always a
 * project request, with the questions written by code (`projectQuestions`).
 */
export const InterviewPurpose = z.enum(['ask', 'project']);
export type InterviewPurpose = z.infer<typeof InterviewPurpose>;

export const InterviewState = z.object({
  rawQuery: z.string(),
  purpose: InterviewPurpose.default('ask'),
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
