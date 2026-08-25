import type { LLMProvider } from '@ai-edu/llm';
import type { AbortSignalLike } from '../platform.js';
import type { AttachmentRef } from '../schemas/common.js';
import { MAX_ROUNDS } from '../schemas/interview.js';
import type {
  CompiledQuery,
  InterviewContext,
  InterviewQuestion,
  InterviewState,
  Slots,
} from '../schemas/interview.js';
import { classifyQuery } from './classify.js';
import { applyAnswers, compileQuery } from './compile.js';
import { generateQuestions } from './questions.js';
import { autoFillSlots, scoreSufficiency } from './slots.js';

/**
 * The interview pipeline.
 *
 *   raw query
 *     -> classify (model)          what kind of question, what's already stated
 *     -> auto-fill (pure)          everything we can infer without asking
 *     -> score sufficiency (pure)  is that enough?
 *        |- enough  -> compile
 *        `- not     -> ask <=5 questions, then re-score (one follow-up max)
 *     -> CompiledQuery             the artifact that reaches the model
 *
 * Only two steps call a model. Everything that decides behaviour is pure, so
 * the interview's logic can be tested exhaustively with no network.
 */

export type InterviewOutcome =
  | { status: 'ready'; compiled: CompiledQuery; state: InterviewState }
  | { status: 'awaiting_answers'; questions: InterviewQuestion[]; state: InterviewState };

export interface BeginInterviewOptions {
  provider: LLMProvider;
  rawQuery: string;
  context: InterviewContext;
  attachments?: AttachmentRef[];
  signal?: AbortSignalLike;
}

export async function beginInterview(options: BeginInterviewOptions): Promise<InterviewOutcome> {
  const { provider, rawQuery, context, attachments = [], signal } = options;

  const classification = await classifyQuery({
    provider,
    rawQuery,
    ...(attachmentDigest(attachments) ? { attachmentText: attachmentDigest(attachments)! } : {}),
    ...(signal ? { signal } : {}),
  });

  const { slots, autoFilled } = autoFillSlots(classification.intent, classification.extracted, context);

  return advance({
    provider,
    rawQuery,
    intent: classification.intent,
    slots,
    autoFilled,
    attachments,
    round: 0,
    askedSlots: [],
    ...(signal ? { signal } : {}),
  });
}

export interface ContinueInterviewOptions {
  provider: LLMProvider;
  state: InterviewState;
  /** slot key → the learner's answer. Absent keys were left blank. */
  answers: Record<string, string>;
  attachments?: AttachmentRef[];
  /** True when the learner pressed Skip instead of answering. */
  skip?: boolean;
  signal?: AbortSignalLike;
}

export async function continueInterview(
  options: ContinueInterviewOptions,
): Promise<InterviewOutcome> {
  const { provider, state, answers, attachments = [], skip = false, signal } = options;

  const slots = applyAnswers(state.slots, answers);
  const askedSlots = state.questions.map((q) => q.slot);

  if (skip) {
    // Skip always compiles. An interview the learner cannot escape is worse
    // than an answer given with incomplete context.
    return ready({
      rawQuery: state.rawQuery,
      intent: state.intent,
      slots,
      autoFilled: state.autoFilled,
      attachments,
      round: state.round,
      skipped: true,
    });
  }

  return advance({
    provider,
    rawQuery: state.rawQuery,
    intent: state.intent,
    slots,
    autoFilled: state.autoFilled,
    attachments,
    round: state.round,
    askedSlots,
    ...(signal ? { signal } : {}),
  });
}

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

interface AdvanceArgs {
  provider: LLMProvider;
  rawQuery: string;
  intent: InterviewState['intent'];
  slots: Slots;
  autoFilled: string[];
  attachments: AttachmentRef[];
  round: number;
  /** Slots already put to the learner — never ask the same thing twice. */
  askedSlots: string[];
  signal?: AbortSignalLike;
}

async function advance(args: AdvanceArgs): Promise<InterviewOutcome> {
  const { provider, rawQuery, intent, slots, autoFilled, attachments, round, askedSlots, signal } =
    args;

  const sufficiency = scoreSufficiency(intent, slots);

  const outOfRounds = round >= MAX_ROUNDS;
  const stillMissing = sufficiency.missing.filter((key) => !askedSlots.includes(key));

  // Compile when we know enough, when we have run out of rounds, or when the
  // only gaps are ones the learner has already declined to fill. Re-asking a
  // question someone left blank is how an interview turns into a wall.
  if (!sufficiency.needsInterview || outOfRounds || stillMissing.length === 0) {
    return ready({
      rawQuery,
      intent,
      slots,
      autoFilled,
      attachments,
      round,
      skipped: sufficiency.missing.length > 0,
    });
  }

  const questions = await generateQuestions({
    provider,
    intent,
    rawQuery,
    missing: stillMissing,
    ...(signal ? { signal } : {}),
  });

  // If question generation returns nothing usable, proceed rather than stall.
  if (questions.length === 0) {
    return ready({
      rawQuery,
      intent,
      slots,
      autoFilled,
      attachments,
      round,
      skipped: sufficiency.missing.length > 0,
    });
  }

  return {
    status: 'awaiting_answers',
    questions,
    state: {
      rawQuery,
      intent,
      slots,
      autoFilled,
      questions,
      round: round + 1,
      sufficiency: sufficiency.score,
      skipped: false,
      status: 'awaiting_answers',
    },
  };
}

interface ReadyArgs {
  rawQuery: string;
  intent: InterviewState['intent'];
  slots: Slots;
  autoFilled: string[];
  attachments: AttachmentRef[];
  round: number;
  skipped: boolean;
}

function ready(args: ReadyArgs): InterviewOutcome {
  const { rawQuery, intent, slots, autoFilled, attachments, round, skipped } = args;
  const sufficiency = scoreSufficiency(intent, slots);

  return {
    status: 'ready',
    compiled: compileQuery({ intent, rawQuery, slots, attachments, skipped }),
    state: {
      rawQuery,
      intent,
      slots,
      autoFilled,
      questions: [],
      round,
      sufficiency: sufficiency.score,
      skipped,
      status: 'ready',
    },
  };
}

/** Cap on attachment text sent to the cheap classifier. */
const CLASSIFIER_ATTACHMENT_CHARS = 2000;

function attachmentDigest(attachments: AttachmentRef[]): string | null {
  const texts = attachments
    .map((a) => a.extractedText)
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0);

  if (!texts.length) return null;
  return texts.join('\n\n').slice(0, CLASSIFIER_ATTACHMENT_CHARS);
}
