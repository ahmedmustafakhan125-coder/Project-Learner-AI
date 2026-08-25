import type { QueryIntent } from '../schemas/common.js';
import type { InterviewContext, Slots, SufficiencyScore } from '../schemas/interview.js';

/**
 * The slot catalogue.
 *
 * This is deliberately hand-written rather than model-generated. The model
 * decides *what the learner said*; this file decides *what we need to know*.
 * Keeping that boundary means the interview asks a predictable set of things,
 * can be unit-tested with no API, and cannot drift into interrogating people
 * because a prompt changed.
 */

export interface SlotDef {
  key: string;
  label: string;
  /** Given to the classifier so it knows what to look for in the raw query. */
  description: string;
  /** Relative importance in the sufficiency score. */
  weight: number;
  required: boolean;
  /**
   * Fill from what is already known, before any question is generated. This is
   * what makes the interview adaptive rather than a fixed form: a learner on
   * step 4 of a React project should not be asked which language they are using.
   */
  autoFill?: (ctx: InterviewContext) => string | null;
  /** Seeds the question generator so options feel concrete. */
  suggestedOptions?: string[];
}

const fromSkill = (ctx: InterviewContext): string | null => ctx.skillLevel;
const fromProjectTech = (ctx: InterviewContext): string | null =>
  ctx.projectTech.length ? ctx.projectTech.join(', ') : null;

const fromProjectContext = (ctx: InterviewContext): string | null => {
  const parts = [
    ctx.projectTitle ? `project: ${ctx.projectTitle}` : null,
    ctx.stepTitle ? `current step: ${ctx.stepTitle}` : null,
    ctx.stepConcepts.length ? `concepts in play: ${ctx.stepConcepts.join(', ')}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join('; ') : null;
};

const fromAttachedCode = (ctx: InterviewContext): string | null => {
  const withText = ctx.attachments.filter((a) => a.extractedText);
  if (!withText.length) return null;
  return `attached: ${withText.map((a) => a.filename).join(', ')}`;
};

export const SLOT_CATALOG: Record<QueryIntent, SlotDef[]> = {
  project_generation: [
    {
      key: 'domain',
      label: 'Area of interest',
      description: 'The subject area or kind of thing they want to build.',
      weight: 3,
      required: true,
      suggestedOptions: ['Web app', 'API / backend', 'Data / ML', 'Game', 'CLI tool', 'Mobile'],
    },
    {
      key: 'tech',
      label: 'Target technologies',
      description: 'Languages, frameworks, or tools they want the project to use.',
      weight: 3,
      required: true,
      // Deliberately NOT auto-filled from knownStacks: what they already know is
      // not necessarily what they want to learn next.
    },
    {
      key: 'skill_level',
      label: 'Skill level',
      description: 'How experienced they are: beginner, intermediate, or advanced.',
      weight: 2,
      required: true,
      autoFill: fromSkill,
      suggestedOptions: ['beginner', 'intermediate', 'advanced'],
    },
    {
      key: 'time_budget',
      label: 'Time available',
      description: 'Roughly how much time they can spend in total.',
      weight: 2,
      required: true,
      suggestedOptions: ['A few hours', '~10 hours', '~25 hours', '40+ hours'],
    },
    {
      key: 'goal',
      label: 'Goal',
      description: 'Why they are building it — a job, a portfolio, coursework, curiosity.',
      weight: 1,
      required: false,
      autoFill: (ctx) => (ctx.goals.length ? ctx.goals.join(', ') : null),
      suggestedOptions: ['Job / interviews', 'Portfolio piece', 'Coursework', 'Curiosity'],
    },
    {
      key: 'constraints',
      label: 'Constraints',
      description: 'Anything limiting: OS, no paid services, must use a specific tool.',
      weight: 1,
      required: false,
    },
  ],

  concept_question: [
    {
      key: 'topic',
      label: 'Topic',
      description: 'The concept or thing being asked about.',
      weight: 3,
      required: true,
    },
    {
      key: 'tech',
      label: 'Language or framework',
      description: 'Which language or framework the answer should be grounded in.',
      weight: 2,
      required: true,
      autoFill: fromProjectTech,
    },
    {
      key: 'skill_level',
      label: 'Skill level',
      description: 'How deep the explanation should go.',
      weight: 2,
      required: true,
      autoFill: fromSkill,
      suggestedOptions: ['beginner', 'intermediate', 'advanced'],
    },
    {
      key: 'project_context',
      label: 'Project context',
      description: 'What they are currently building, if relevant.',
      weight: 1,
      required: false,
      autoFill: fromProjectContext,
    },
  ],

  debug_help: [
    {
      key: 'tech',
      label: 'Language or framework',
      description: 'The language or framework the broken code is written in.',
      weight: 3,
      required: true,
      autoFill: fromProjectTech,
    },
    {
      key: 'symptom',
      label: 'What goes wrong',
      description: 'The error message, or the incorrect behaviour observed.',
      weight: 3,
      required: true,
    },
    {
      key: 'expected',
      label: 'Expected behaviour',
      description: 'What they expected to happen instead.',
      weight: 2,
      required: true,
    },
    {
      key: 'code',
      label: 'The code',
      description: 'The relevant source, pasted or attached.',
      weight: 2,
      required: true,
      autoFill: fromAttachedCode,
    },
    {
      key: 'tried',
      label: 'Already tried',
      description: 'What they have already attempted.',
      weight: 1,
      required: false,
    },
  ],

  other: [
    {
      key: 'topic',
      label: 'Topic',
      description: 'What the question is about.',
      weight: 2,
      required: true,
    },
    {
      key: 'skill_level',
      label: 'Skill level',
      description: 'How deep the answer should go.',
      weight: 1,
      required: false,
      autoFill: fromSkill,
    },
  ],
};

export function slotsFor(intent: QueryIntent): SlotDef[] {
  return SLOT_CATALOG[intent];
}

export function slotDef(intent: QueryIntent, key: string): SlotDef | undefined {
  return SLOT_CATALOG[intent].find((s) => s.key === key);
}

/* ------------------------------------------------------------------ *
 * Auto-fill
 * ------------------------------------------------------------------ */

export interface AutoFillResult {
  slots: Slots;
  /** Keys filled without asking — lets the UI explain why so little was asked. */
  autoFilled: string[];
}

/**
 * Merge what the model extracted from the query with what we already know.
 *
 * Precedence is deliberate: an explicit statement in the query always beats
 * inferred context. Someone asking "how do I do this in Python?" while inside a
 * TypeScript project means Python.
 */
export function autoFillSlots(
  intent: QueryIntent,
  extracted: Record<string, string>,
  ctx: InterviewContext,
): AutoFillResult {
  const slots: Slots = {};
  const autoFilled: string[] = [];

  for (const def of slotsFor(intent)) {
    const fromQuery = extracted[def.key]?.trim();
    if (fromQuery) {
      slots[def.key] = { value: fromQuery, source: 'query' };
      continue;
    }

    const inferred = def.autoFill?.(ctx)?.trim();
    if (inferred) {
      slots[def.key] = { value: inferred, source: inferredSource(def.key, ctx) };
      autoFilled.push(def.key);
    }
  }

  return { slots, autoFilled };
}

function inferredSource(key: string, ctx: InterviewContext): Slots[string]['source'] {
  if (key === 'skill_level') return 'profile';
  if (key === 'code') return 'attachment';
  if (key === 'project_context') return ctx.stepTitle ? 'step' : 'project';
  return 'project';
}

/* ------------------------------------------------------------------ *
 * Sufficiency
 * ------------------------------------------------------------------ */

/**
 * Below this, ask. Tuned so that a fully-specified request ("build a REST API
 * in Express, I'm intermediate, about 10 hours") sails straight through, while
 * "I want to learn backend" does not.
 */
export const SUFFICIENCY_THRESHOLD = 0.75;

/**
 * Deterministic, not model-judged.
 *
 * Asking a model "is this enough context?" gives a different answer run to run
 * and cannot be unit-tested. Weighted required-slot coverage gives the same
 * answer every time and is trivial to reason about when the behaviour surprises
 * someone.
 */
export function scoreSufficiency(intent: QueryIntent, slots: Slots): SufficiencyScore {
  const required = slotsFor(intent).filter((s) => s.required);

  const totalWeight = required.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight === 0) {
    return { score: 1, missing: [], needsInterview: false };
  }

  let filledWeight = 0;
  const missing: string[] = [];

  for (const def of required) {
    if (slots[def.key]?.value?.trim()) filledWeight += def.weight;
    else missing.push(def.key);
  }

  const score = filledWeight / totalWeight;
  return {
    score,
    missing,
    needsInterview: score < SUFFICIENCY_THRESHOLD,
  };
}

/** Missing slots worth asking about, most important first, capped by the caller. */
export function rankMissingSlots(intent: QueryIntent, missing: string[]): SlotDef[] {
  return missing
    .map((key) => slotDef(intent, key))
    .filter((d): d is SlotDef => d !== undefined)
    .sort((a, b) => b.weight - a.weight);
}
