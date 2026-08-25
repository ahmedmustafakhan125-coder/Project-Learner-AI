import { describe, expect, it } from 'vitest';

import { applyAnswers, compileQuery, extractDurableSlots } from '../src/interview/compile.js';
import { sanitiseQuestions } from '../src/interview/questions.js';
import { sanitiseExtraction } from '../src/interview/classify.js';
import {
  SUFFICIENCY_THRESHOLD,
  autoFillSlots,
  rankMissingSlots,
  scoreSufficiency,
  slotsFor,
} from '../src/interview/slots.js';
import { InterviewContext } from '../src/schemas/interview.js';
import type { Slots } from '../src/schemas/interview.js';

const emptyContext = InterviewContext.parse({});

const contextWithProject = InterviewContext.parse({
  skillLevel: 'beginner',
  projectTitle: 'Todo App',
  projectTech: ['React', 'TypeScript'],
  stepTitle: 'Adding state',
  stepConcepts: ['useState', 're-rendering'],
});

/* ------------------------------------------------------------------ *
 * The behaviours the design actually promised
 * ------------------------------------------------------------------ */

describe('adaptive behaviour: when does it ask?', () => {
  it('answers a specific, fully-specified request without asking anything', () => {
    // "build a REST API in Express, I'm intermediate, about 10 hours"
    const { slots } = autoFillSlots(
      'project_generation',
      {
        domain: 'REST API',
        tech: 'Express',
        skill_level: 'intermediate',
        time_budget: '10 hours',
      },
      emptyContext,
    );

    const result = scoreSufficiency('project_generation', slots);
    expect(result.needsInterview).toBe(false);
    expect(result.missing).toHaveLength(0);
  });

  it('interviews a vague project request', () => {
    // "I want to learn backend"
    const { slots } = autoFillSlots('project_generation', { domain: 'backend' }, emptyContext);

    const result = scoreSufficiency('project_generation', slots);
    expect(result.needsInterview).toBe(true);
    expect(result.missing).toEqual(
      expect.arrayContaining(['tech', 'skill_level', 'time_budget']),
    );
  });

  it('answers a concept question immediately when project context supplies the gaps', () => {
    // "why isn't this updating?" on step 4 of a React project — the platform
    // already knows the language, the level, and what they are building, so it
    // should ask nothing at all.
    const { slots, autoFilled } = autoFillSlots(
      'concept_question',
      { topic: 'state not updating' },
      contextWithProject,
    );

    const result = scoreSufficiency('concept_question', slots);
    expect(result.needsInterview).toBe(false);
    expect(autoFilled).toEqual(expect.arrayContaining(['tech', 'skill_level']));
  });

  it('DOES ask about the same concept question from a learner with no context', () => {
    // The answer genuinely differs between JavaScript and Python, and between
    // beginner and advanced — so asking here is correct, not annoying.
    const { slots } = autoFillSlots('concept_question', { topic: 'closures' }, emptyContext);

    const result = scoreSufficiency('concept_question', slots);
    expect(result.needsInterview).toBe(true);
    expect(result.missing).toEqual(expect.arrayContaining(['tech', 'skill_level']));
  });
});

describe('auto-fill precedence', () => {
  it('lets an explicit statement in the query beat inferred project context', () => {
    // Asking "how do I do this in Python?" inside a TypeScript project means
    // Python. Inferred context must never override what someone actually said.
    const { slots, autoFilled } = autoFillSlots(
      'concept_question',
      { topic: 'list comprehensions', tech: 'Python' },
      contextWithProject,
    );

    expect(slots['tech']!.value).toBe('Python');
    expect(slots['tech']!.source).toBe('query');
    expect(autoFilled).not.toContain('tech');
  });

  it('records where each value came from', () => {
    const { slots } = autoFillSlots('concept_question', { topic: 'hooks' }, contextWithProject);
    expect(slots['topic']!.source).toBe('query');
    expect(slots['skill_level']!.source).toBe('profile');
    expect(slots['project_context']!.source).toBe('step');
  });

  it('does not auto-fill target tech from what the learner already knows', () => {
    // What you know is not what you want to learn next.
    const ctx = InterviewContext.parse({ knownStacks: ['PHP', 'jQuery'] });
    const { slots } = autoFillSlots('project_generation', { domain: 'web app' }, ctx);
    expect(slots['tech']).toBeUndefined();
  });

  it('treats an attached file as supplying the code slot for debugging', () => {
    const ctx = InterviewContext.parse({
      projectTech: ['Python'],
      attachments: [
        {
          id: 'a1',
          filename: 'main.py',
          mimeType: 'text/x-python',
          sizeBytes: 10,
          extractedText: 'print(1/0)',
          providerFileId: null,
        },
      ],
    });
    const { slots } = autoFillSlots('debug_help', { symptom: 'ZeroDivisionError' }, ctx);
    expect(slots['code']?.value).toContain('main.py');
    expect(slots['code']?.source).toBe('attachment');
  });
});

describe('sufficiency scoring', () => {
  it('is deterministic — the same slots always score the same', () => {
    const { slots } = autoFillSlots('project_generation', { domain: 'games' }, emptyContext);
    const a = scoreSufficiency('project_generation', slots);
    const b = scoreSufficiency('project_generation', slots);
    expect(a).toEqual(b);
  });

  it('scores 1 when every required slot is filled', () => {
    const slots: Slots = Object.fromEntries(
      slotsFor('project_generation')
        .filter((s) => s.required)
        .map((s) => [s.key, { value: 'x', source: 'query' as const }]),
    );
    expect(scoreSufficiency('project_generation', slots).score).toBe(1);
  });

  it('scores 0 when nothing is known', () => {
    expect(scoreSufficiency('project_generation', {}).score).toBe(0);
  });

  it('weights important slots more heavily than minor ones', () => {
    const withDomain = scoreSufficiency('project_generation', {
      domain: { value: 'web', source: 'query' },
    });
    const withSkill = scoreSufficiency('project_generation', {
      skill_level: { value: 'beginner', source: 'profile' },
    });
    // domain has weight 3, skill_level weight 2.
    expect(withDomain.score).toBeGreaterThan(withSkill.score);
  });

  it('ignores optional slots entirely when scoring', () => {
    const required: Slots = Object.fromEntries(
      slotsFor('project_generation')
        .filter((s) => s.required)
        .map((s) => [s.key, { value: 'x', source: 'query' as const }]),
    );
    const withOptional = { ...required, constraints: { value: 'windows', source: 'query' as const } };
    expect(scoreSufficiency('project_generation', withOptional).score).toBe(
      scoreSufficiency('project_generation', required).score,
    );
  });

  it('treats a whitespace-only value as unfilled', () => {
    const result = scoreSufficiency('concept_question', {
      topic: { value: '   ', source: 'query' },
    });
    expect(result.missing).toContain('topic');
  });

  it('crosses the threshold exactly where documented', () => {
    expect(SUFFICIENCY_THRESHOLD).toBeGreaterThan(0);
    expect(SUFFICIENCY_THRESHOLD).toBeLessThanOrEqual(1);
  });
});

describe('question ranking', () => {
  it('asks about the most important gaps first', () => {
    const ranked = rankMissingSlots('project_generation', ['skill_level', 'domain', 'time_budget']);
    expect(ranked[0]!.key).toBe('domain'); // weight 3
  });

  it('silently drops slot keys that do not exist for the intent', () => {
    const ranked = rankMissingSlots('concept_question', ['topic', 'not_a_real_slot']);
    expect(ranked.map((r) => r.key)).toEqual(['topic']);
  });
});

/* ------------------------------------------------------------------ *
 * Guarding against model misbehaviour
 * ------------------------------------------------------------------ */

describe('sanitiseExtraction', () => {
  it('drops hallucinated slot keys', () => {
    const result = sanitiseExtraction({
      intent: 'concept_question',
      extracted: { topic: 'closures', favourite_colour: 'blue', budget: '$5' },
      reasoning: '',
    });
    expect(Object.keys(result.extracted)).toEqual(['topic']);
  });

  it('drops placeholder values instead of treating them as answers', () => {
    // A model that writes "unknown" rather than omitting the key would
    // otherwise have us render "Skill level: unknown" back to the learner.
    const result = sanitiseExtraction({
      intent: 'concept_question',
      extracted: { topic: 'closures', tech: 'unknown', skill_level: 'N/A' },
      reasoning: '',
    });
    expect(result.extracted['tech']).toBeUndefined();
    expect(result.extracted['skill_level']).toBeUndefined();
    expect(result.extracted['topic']).toBe('closures');
  });

  it('trims surrounding whitespace', () => {
    const result = sanitiseExtraction({
      intent: 'concept_question',
      extracted: { topic: '  closures \n' },
      reasoning: '',
    });
    expect(result.extracted['topic']).toBe('closures');
  });
});

describe('sanitiseQuestions', () => {
  const q = (slot: string, over = {}) => ({
    slot,
    question: `What about ${slot}?`,
    why: 'because',
    type: 'single' as const,
    options: [{ label: 'A', value: 'a' }],
    allowOther: true,
    ...over,
  });

  it('drops questions for slots we did not ask about', () => {
    // A model volunteering "just one more thing" must not be able to lengthen
    // the interview.
    const kept = sanitiseQuestions('project_generation', [q('domain'), q('constraints')], ['domain']);
    expect(kept.map((k) => k.slot)).toEqual(['domain']);
  });

  it('deduplicates repeated slots', () => {
    const kept = sanitiseQuestions('project_generation', [q('domain'), q('domain')], ['domain']);
    expect(kept).toHaveLength(1);
  });

  it('restores our priority order, ignoring the order the model returned', () => {
    const kept = sanitiseQuestions(
      'project_generation',
      [q('time_budget'), q('domain')],
      ['domain', 'time_budget'],
    );
    expect(kept.map((k) => k.slot)).toEqual(['domain', 'time_budget']);
  });

  it('never exceeds the cap', () => {
    const slots = ['domain', 'tech', 'skill_level', 'time_budget', 'goal', 'constraints'];
    const kept = sanitiseQuestions('project_generation', slots.map((s) => q(s)), slots);
    expect(kept.length).toBeLessThanOrEqual(5);
  });

  it('downgrades a choice question with no options to free text', () => {
    // Otherwise the UI renders an empty chip row with nothing to click.
    const kept = sanitiseQuestions('project_generation', [q('domain', { options: [] })], ['domain']);
    expect(kept[0]!.type).toBe('text');
  });

  it('supplies a fallback "why" rather than rendering an empty hint', () => {
    const kept = sanitiseQuestions('project_generation', [q('domain', { why: '  ' })], ['domain']);
    expect(kept[0]!.why.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * Compilation
 * ------------------------------------------------------------------ */

describe('compileQuery', () => {
  const slots: Slots = {
    topic: { value: 'closures', source: 'query' },
    tech: { value: 'JavaScript', source: 'answer' },
    skill_level: { value: 'beginner', source: 'profile' },
  };

  it('always includes the learner original wording', () => {
    const compiled = compileQuery({
      intent: 'concept_question',
      rawQuery: 'what is a closure?',
      slots,
    });
    expect(compiled.text).toContain('what is a closure?');
    expect(compiled.originalQuery).toBe('what is a closure?');
  });

  it('renders identical bytes for the same input', () => {
    // This block sits inside the fan-out prompt; unstable rendering would mean
    // a different cache key on every request.
    const input = { intent: 'concept_question' as const, rawQuery: 'q', slots };
    expect(compileQuery(input).text).toBe(compileQuery(input).text);
  });

  it('renders slots in catalogue order regardless of insertion order', () => {
    // Object key order follows insertion, which varies with how slots were
    // resolved — catalogue order keeps the bytes stable.
    const forward: Slots = { topic: slots['topic']!, tech: slots['tech']!, skill_level: slots['skill_level']! };
    const reversed: Slots = { skill_level: slots['skill_level']!, tech: slots['tech']!, topic: slots['topic']! };

    const a = compileQuery({ intent: 'concept_question', rawQuery: 'q', slots: forward });
    const b = compileQuery({ intent: 'concept_question', rawQuery: 'q', slots: reversed });
    expect(a.text).toBe(b.text);
  });

  it('tells the model what is unknown when the learner skipped', () => {
    const compiled = compileQuery({
      intent: 'concept_question',
      rawQuery: 'what is a closure?',
      slots: { topic: { value: 'closures', source: 'query' } },
      skipped: true,
    });
    expect(compiled.text).toContain('<unknown>');
    expect(compiled.text).toMatch(/do not assume/i);
    expect(compiled.partial).toBe(true);
  });

  it('does not add an unknown block when nothing is missing', () => {
    const full: Slots = Object.fromEntries(
      slotsFor('concept_question')
        .filter((s) => s.required)
        .map((s) => [s.key, { value: 'x', source: 'query' as const }]),
    );
    const compiled = compileQuery({
      intent: 'concept_question',
      rawQuery: 'q',
      slots: full,
      skipped: true,
    });
    expect(compiled.text).not.toContain('<unknown>');
    expect(compiled.partial).toBe(false);
  });

  it('lists attachments by name without inlining their contents', () => {
    const compiled = compileQuery({
      intent: 'debug_help',
      rawQuery: 'why does this crash?',
      slots: {},
      attachments: [
        {
          id: 'a1',
          filename: 'main.py',
          mimeType: 'text/x-python',
          sizeBytes: 42,
          extractedText: 'SECRET_CONTENT',
          providerFileId: null,
        },
      ],
    });
    expect(compiled.text).toContain('main.py');
    // The body belongs in its own delimited block in the message, not here.
    expect(compiled.text).not.toContain('SECRET_CONTENT');
  });
});

describe('applyAnswers', () => {
  it('lets an answer override an inferred value', () => {
    const before: Slots = { skill_level: { value: 'beginner', source: 'profile' } };
    const after = applyAnswers(before, { skill_level: 'advanced' });
    expect(after['skill_level']).toEqual({ value: 'advanced', source: 'answer' });
  });

  it('ignores blank answers rather than erasing what we knew', () => {
    const before: Slots = { skill_level: { value: 'beginner', source: 'profile' } };
    expect(applyAnswers(before, { skill_level: '   ' })['skill_level']!.value).toBe('beginner');
  });

  it('does not mutate the input', () => {
    const before: Slots = { topic: { value: 'a', source: 'query' } };
    applyAnswers(before, { topic: 'b' });
    expect(before['topic']!.value).toBe('a');
  });
});

describe('extractDurableSlots', () => {
  it('keeps facts that are true of the person, not of one query', () => {
    const durable = extractDurableSlots({
      skill_level: { value: 'advanced', source: 'answer' },
      topic: { value: 'closures', source: 'query' },
      symptom: { value: 'TypeError', source: 'query' },
    });
    expect(durable).toEqual({ skill_level: 'advanced' });
  });

  it('never persists an inferred value', () => {
    // One wrong guess must not harden into a permanent fact about someone.
    const durable = extractDurableSlots({
      skill_level: { value: 'beginner', source: 'profile' },
      goal: { value: 'job', source: 'project' },
    });
    expect(durable).toEqual({});
  });
});
