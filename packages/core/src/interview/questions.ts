import type { LLMProvider } from '@ai-edu/llm';
import type { AbortSignalLike } from '../platform.js';
import type { QueryIntent } from '../schemas/common.js';
import { MAX_QUESTIONS, QuestionSet } from '../schemas/interview.js';
import type { InterviewQuestion } from '../schemas/interview.js';
import { rankMissingSlots, slotDef } from './slots.js';

/**
 * Step 3 of the interview: phrase questions for the slots that are still empty.
 *
 * The model chooses wording and options; it does not choose *which* slots to
 * ask about. That list arrives already computed and ranked, so the interview
 * cannot expand itself into an interrogation because a prompt drifted.
 */

const SYSTEM = `You write short intake questions for a programming learner.

You are given a learner's message and a list of facts still needed. Write ONE
question per requested fact, in the order given, and no others.

Rules:
- Ask about the requested slots only. Never add a question of your own.
- Phrase each question in plain language a beginner would understand.
- Offer concrete multiple-choice options wherever the answer is likely to fall
  into a small set. Options must be short enough to read as chips.
- Use type "text" only when options genuinely cannot be enumerated.
- "why" must say, in one short clause, what the answer will change about the
  response they get. Never restate the question.
- Never ask for information the learner has already given in their message.
- Sound like a helpful person, not a form. No preamble, no pleasantries.`;

export interface GenerateQuestionsOptions {
  provider: LLMProvider;
  intent: QueryIntent;
  rawQuery: string;
  /** Slot keys still unfilled, from `scoreSufficiency`. */
  missing: string[];
  signal?: AbortSignalLike;
}

export async function generateQuestions(
  options: GenerateQuestionsOptions,
): Promise<InterviewQuestion[]> {
  const { provider, intent, rawQuery, missing, signal } = options;

  const wanted = rankMissingSlots(intent, missing).slice(0, MAX_QUESTIONS);
  if (wanted.length === 0) return [];

  const spec = wanted
    .map((def) => {
      const options = def.suggestedOptions?.length
        ? `\n     suggested options: ${def.suggestedOptions.join(' | ')}`
        : '';
      return `  - slot "${def.key}" (${def.label}): ${def.description}${options}`;
    })
    .join('\n');

  const result = await provider.structured(
    {
      model: provider.modelId,
      maxTokens: 2048,
      reasoning: 'low',
      system: [{ text: SYSTEM, cacheBoundary: true }],
      messages: [
        {
          role: 'user',
          content:
            `Learner's message:\n"""\n${rawQuery}\n"""\n\n` +
            `Facts still needed (write exactly one question for each, in this order):\n${spec}`,
        },
      ],
      ...(signal ? { signal } : {}),
    },
    QuestionSet,
  );

  return sanitiseQuestions(intent, result.data.questions, wanted.map((d) => d.key));
}

/**
 * Keep only questions that map to a slot we actually asked for, in the order we
 * asked, deduplicated, and capped. A model that returns an extra "just one more
 * thing" question must not be able to lengthen the interview.
 */
export function sanitiseQuestions(
  intent: QueryIntent,
  questions: InterviewQuestion[],
  requestedSlots: string[],
): InterviewQuestion[] {
  const allowed = new Set(requestedSlots);
  const seen = new Set<string>();
  const kept: InterviewQuestion[] = [];

  for (const question of questions) {
    if (!allowed.has(question.slot)) continue;
    if (seen.has(question.slot)) continue;
    if (!question.question?.trim()) continue;

    seen.add(question.slot);
    kept.push({
      ...question,
      question: question.question.trim(),
      why: question.why?.trim() || `Helps tailor the answer to your ${labelFor(intent, question.slot)}.`,
      // A single-choice question with no options cannot be rendered as chips.
      type: question.type === 'text' || question.options.length === 0 ? 'text' : question.type,
      options: question.options.filter((o) => o.label?.trim() && o.value?.trim()),
    });
  }

  // Preserve the requested priority order rather than the model's ordering.
  kept.sort((a, b) => requestedSlots.indexOf(a.slot) - requestedSlots.indexOf(b.slot));
  return kept.slice(0, MAX_QUESTIONS);
}

function labelFor(intent: QueryIntent, slot: string): string {
  return slotDef(intent, slot)?.label.toLowerCase() ?? 'situation';
}
