import type { LLMProvider } from '@ai-edu/llm';
import type { AbortSignalLike } from '../platform.js';
import type { AttachmentRef } from '../schemas/common.js';
import { MAX_ROUNDS } from '../schemas/interview.js';
import type {
  CompiledQuery,
  InterviewContext,
  InterviewPurpose,
  InterviewQuestion,
  InterviewState,
  Slots,
} from '../schemas/interview.js';
import { classifyQuery } from './classify.js';
import { applyAnswers, compileQuery } from './compile.js';
import { projectQuestions, unsureKind } from './projectQuestions.js';
import { generateQuestions } from './questions.js';
import { autoFillSlots, scoreSufficiency, slotsFor } from './slots.js';

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
 *
 * With purpose `project` (the project page, PROJECT_LEARNER on) the request is
 * always a project, and the questions are written by code (`projectQuestions`),
 * so only classify calls a model.
 */

export type InterviewOutcome =
  | { status: 'ready'; compiled: CompiledQuery; state: InterviewState }
  | { status: 'awaiting_answers'; questions: InterviewQuestion[]; state: InterviewState };

export interface BeginInterviewOptions {
  provider: LLMProvider;
  rawQuery: string;
  context: InterviewContext;
  attachments?: AttachmentRef[];
  /** Defaults to `ask`. The caller sends `project` only with PROJECT_LEARNER on. */
  purpose?: InterviewPurpose;
  signal?: AbortSignalLike;
}

export async function beginInterview(options: BeginInterviewOptions): Promise<InterviewOutcome> {
  const { provider, rawQuery, context, attachments = [], purpose = 'ask', signal } = options;

  const classification = await classifyQuery({
    provider,
    rawQuery,
    ...(attachmentDigest(attachments) ? { attachmentText: attachmentDigest(attachments)! } : {}),
    ...(signal ? { signal } : {}),
  });

  // Everything typed on the project page is a project. Read as anything else,
  // the facts that hold for a project too (the tech, the skill level) are kept.
  const project = purpose === 'project';
  const intent = project ? 'project_generation' : classification.intent;
  const extracted =
    project && classification.intent !== 'project_generation'
      ? projectFacts(classification.extracted)
      : classification.extracted;

  const { slots, autoFilled } = autoFillSlots(intent, extracted, context);

  return advance({
    provider,
    rawQuery,
    purpose,
    intent,
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
      purpose: state.purpose,
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
    purpose: state.purpose,
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
  purpose: InterviewPurpose;
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
  const { provider, rawQuery, purpose, intent, slots, autoFilled, attachments, round, askedSlots, signal } =
    args;

  const sufficiency = scoreSufficiency(intent, slots);

  const outOfRounds = round >= MAX_ROUNDS;
  const stillMissing = sufficiency.missing.filter((key) => !askedSlots.includes(key));
  // On the project page, a kind of project named too vaguely to plan is asked
  // too, in the first round only: nothing after this shows the learner what
  // it was read as, and a later round must not question a kind it planned for.
  const kindUnsure = purpose === 'project' && round === 0 && unsureKind(rawQuery, slots);
  const toAsk = kindUnsure ? ['domain', ...stillMissing] : stillMissing;

  // Compile when we know enough, when we have run out of rounds, or when the
  // only gaps are ones the learner has already declined to fill. Re-asking a
  // question someone left blank is how an interview turns into a wall.
  if ((!sufficiency.needsInterview && !kindUnsure) || outOfRounds || toAsk.length === 0) {
    return ready({
      rawQuery,
      purpose,
      intent,
      slots,
      autoFilled,
      attachments,
      round,
      skipped: sufficiency.missing.length > 0,
    });
  }

  const questions =
    purpose === 'project'
      ? projectQuestions({ rawQuery, slots, missing: toAsk })
      : await generateQuestions({
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
      purpose,
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
      purpose,
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
  purpose: InterviewPurpose;
  intent: InterviewState['intent'];
  slots: Slots;
  autoFilled: string[];
  attachments: AttachmentRef[];
  round: number;
  skipped: boolean;
}

function ready(args: ReadyArgs): InterviewOutcome {
  const { rawQuery, purpose, intent, slots, autoFilled, attachments, round, skipped } = args;
  const sufficiency = scoreSufficiency(intent, slots);

  return {
    status: 'ready',
    compiled: compileQuery({ intent, rawQuery, slots, attachments, skipped }),
    state: {
      rawQuery,
      purpose,
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

/** The extracted facts that are project slots too: a concept question's tech and skill level. */
function projectFacts(extracted: Record<string, string>): Record<string, string> {
  const keys = new Set(slotsFor('project_generation').map((s) => s.key));
  return Object.fromEntries(Object.entries(extracted).filter(([key]) => keys.has(key)));
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
