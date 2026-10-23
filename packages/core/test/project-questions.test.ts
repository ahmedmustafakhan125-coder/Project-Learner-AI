import type { LLMProvider, LLMRequest } from '@ai-edu/llm';
import { PROJECT_TIERS } from '@ai-edu/llm';
import { describe, expect, it } from 'vitest';

import { compileQuery } from '../src/interview/compile.js';
import {
  INTERVIEW_BUDGET,
  ScopeSignals,
  detectProfile,
  parseTimeBudget,
  scopedSlots,
  scoreComplexity,
} from '../src/interview/complexity.js';
import {
  PROJECT_KINDS,
  RECOMMEND_STACK,
  STACKS_BY_PROFILE,
  answerSignals,
  projectQuestions,
  scopeQuestions,
  unsureKind,
} from '../src/interview/projectQuestions.js';
import { beginInterview, continueInterview } from '../src/interview/run.js';
import { slotsFor } from '../src/interview/slots.js';
import { PROFILES } from '../src/profiles/index.js';
import { PROFILE_IDS } from '../src/profiles/types.js';
import { namedTechnologies } from '../src/research/candidates.js';
import { InterviewContext } from '../src/schemas/interview.js';
import type { InterviewQuestion, Slots } from '../src/schemas/interview.js';

/**
 * The project page's questions, written by code.
 *
 * The model used to word them, and the stack question came back as a bare text
 * box a beginner could not answer. These pin what replaced it: the same form
 * for the same request, stack options that each explain themselves with one
 * recommended, the kind asked when the message is vague, a second round only
 * for a project big enough to need one, and no model call to write any of it.
 */

const said = (values: Record<string, string>): Slots =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v, source: 'query' as const }]));

const values = (q: InterviewQuestion | undefined) => (q?.options ?? []).map((o) => o.value);
const names = (profile: keyof typeof STACKS_BY_PROFILE) => STACKS_BY_PROFILE[profile].map((s) => s.name);
const recommendedFirst = (profile: keyof typeof STACKS_BY_PROFILE) => {
  const stacks = STACKS_BY_PROFILE[profile];
  return [...stacks.filter((s) => s.why), ...stacks.filter((s) => !s.why)].map((s) => s.name);
};

describe('projectQuestions', () => {
  const todo = { rawQuery: 'I want to build a todo app', slots: said({ skill_level: 'beginner' }), missing: ['domain', 'tech', 'time_budget'] };

  it('asks the kind of project, then the stack, then time, in fixed words', () => {
    const questions = projectQuestions(todo);
    expect(questions.map((q) => q.slot)).toEqual(['domain', 'tech', 'time_budget']);
    expect(questions.map((q) => q.question)).toEqual([
      'What kind of project is it?',
      'What do you want to build it with?',
      'How much time can you give it in total?',
    ]);
  });

  it('gives the same form for the same request', () => {
    expect(projectQuestions(todo)).toEqual(projectQuestions(todo));
  });

  it('explains every stack: its language, difficulty, what it is best at and what you learn', () => {
    const stack = projectQuestions(todo).find((q) => q.slot === 'tech')!;
    expect(stack.why).toContain('Your stack is');
    expect(stack.type).toBe('single');
    expect(stack.allowOther).toBe(true);
    expect(stack.placeholder).toBeTruthy();
    for (const choice of stack.options.slice(0, -1)) {
      expect(choice.detail?.language, choice.label).toBeTruthy();
      expect(['easy', 'medium', 'hard']).toContain(choice.detail?.difficulty);
      expect(choice.detail?.bestFor, choice.label).toBeTruthy();
      expect(choice.detail?.learn, choice.label).toBeTruthy();
    }
  });

  it('recommends one stack first, with the reason, and offers "choose for me" last', () => {
    const stack = projectQuestions(todo).find((q) => q.slot === 'tech')!;
    expect(stack.options[0]?.recommended).toBeTruthy();
    expect(stack.options.filter((o) => o.recommended)).toHaveLength(1);
    const last = stack.options.at(-1)!;
    expect(last.value).toBe(RECOMMEND_STACK);
    expect(last.hint).toMatch(/approve/);
    expect(last.detail).toBeUndefined();
  });

  it('recommends exactly one stack for every kind of software, and versions none', () => {
    for (const id of PROFILE_IDS) {
      expect(STACKS_BY_PROFILE[id].filter((s) => s.why), id).toHaveLength(1);
      for (const s of STACKS_BY_PROFILE[id]) expect(`${s.name} ${s.bestFor} ${s.learn}`, s.name).not.toMatch(/\bv?\d+(\.\d+)+\b/);
    }
  });

  it('lets the Stack Brief choose when the learner asks for a recommendation', () => {
    expect(namedTechnologies(said({ tech: RECOMMEND_STACK }), PROFILES.general)).toEqual([]);
  });

  it('switches the stack options to the kind of project picked beside it', () => {
    const stack = projectQuestions(todo).find((q) => q.slot === 'tech')!;
    expect(stack.follows?.slot).toBe('domain');
    expect(Object.keys(stack.follows?.options ?? {})).toEqual(PROJECT_KINDS.map((k) => k.label));
    expect(values({ ...stack, options: stack.follows!.options['Game']! })).toEqual([...recommendedFirst('game'), RECOMMEND_STACK]);
    expect(stack.follows!.options['Game']![0]?.recommended).toBeTruthy();
  });

  it('offers the stacks for the kind of software the message names, and no follow when the kind is known', () => {
    const kernel = projectQuestions({
      rawQuery: 'I want to write my own operating system',
      slots: said({ domain: 'operating system', skill_level: 'advanced', time_budget: '60 hours' }),
      missing: ['tech'],
    });
    expect(values(kernel[0])).toEqual(['C', 'Rust', 'Zig', RECOMMEND_STACK]);
    expect(kernel[0]?.options[0]?.recommended).toMatch(/guide/);
    expect(kernel[0]?.follows).toBeUndefined();
  });

  it('falls back to languages, Python recommended, when the kind is unclear', () => {
    const stack = projectQuestions(todo).find((q) => q.slot === 'tech')!;
    expect(values(stack)).toEqual([...names('general'), RECOMMEND_STACK]);
    expect(stack.options[0]?.label).toBe('Python');
  });

  it('offers only the three skill levels, as the plan reads them', () => {
    const [skill] = projectQuestions({ rawQuery: 'a game', slots: {}, missing: ['skill_level'] });
    expect(values(skill)).toEqual(['beginner', 'intermediate', 'advanced']);
    expect(skill?.allowOther).toBe(false);
  });

  it('offers time answers the tier scorer can read, and says they set the size', () => {
    const [time] = projectQuestions({ rawQuery: 'a game', slots: {}, missing: ['time_budget'] });
    expect(values(time).map(parseTimeBudget)).toEqual([4, 10, 25, 40]);
    expect(time?.why).toMatch(/how big/);
  });
});

describe('unsureKind', () => {
  it('is unsure of a kind no profile recognises, and sure of one it does', () => {
    expect(unsureKind('a recipe organiser', said({ domain: 'recipe organiser' }))).toBe(true);
    expect(unsureKind('my own operating system', said({ domain: 'operating system' }))).toBe(false);
    expect(unsureKind('a website for my bakery', said({ domain: 'website for my bakery' }))).toBe(false);
  });

  it('leaves a missing kind to the ordinary question', () => {
    expect(unsureKind('build something', {})).toBe(false);
  });
});

describe('the options agree with the rest of intake', () => {
  it.each(PROJECT_KINDS.map((k) => [k.label, k.profile] as const))('the kind "%s" scores to %s', (label, profile) => {
    expect(detectProfile(ScopeSignals.parse({}), said({ domain: label })).profile).toBe(profile);
  });

  it.each(Object.values(STACKS_BY_PROFILE).flatMap((stacks) => stacks.map((s) => s.name)))('"%s" names at least one technology', (stack) => {
    expect(namedTechnologies(said({ tech: stack }), PROFILES.general).length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * Round 2
 * ------------------------------------------------------------------ */

const BASE = said({ domain: 'Web app', tech: RECOMMEND_STACK, skill_level: 'beginner', time_budget: '~25 hours' });
const NO_SIGNALS = ScopeSignals.parse({});

describe('scopeQuestions (round 2)', () => {
  it('asks a big web app how it is used, where its data lives and who signs in, in fixed words', () => {
    const questions = scopeQuestions({ tier: 'T3', profile: PROFILES['web-fullstack'], slots: BASE, signals: NO_SIGNALS });
    expect(questions.map((q) => q.slot)).toEqual(['interface', 'data', 'users_auth', 'integrations', 'deploy_target']);
    expect(questions.map((q) => q.question).slice(0, 3)).toEqual([
      'Where will people use it?',
      'What does it need to remember?',
      'Who signs in?',
    ]);
    expect(questions.find((q) => q.slot === 'interface')?.type).toBe('multi');
    expect(values(questions.find((q) => q.slot === 'users_auth'))).toEqual(['Just me', 'Accounts with sign-in', 'Several roles']);
    for (const q of questions) expect(q.why, q.slot).toBeTruthy();
  });

  it('asks nothing of a project with one round: T1 and T2, every kind', () => {
    for (const id of PROFILE_IDS) {
      for (const tier of ['T1', 'T2'] as const) {
        expect(scopeQuestions({ tier, profile: PROFILES[id], slots: {}, signals: NO_SIGNALS }), `${id} ${tier}`).toEqual([]);
      }
    }
  });

  it('never asks more than the tier allows (invariant 18), nor a round-1 slot, nor what the stack settled', () => {
    const roundOne = new Set(slotsFor('project_generation').map((s) => s.key));
    for (const id of PROFILE_IDS) {
      for (const tier of PROJECT_TIERS) {
        const questions = scopeQuestions({ tier, profile: PROFILES[id], slots: {}, signals: NO_SIGNALS });
        expect(questions.length, `${id} ${tier}`).toBeLessThanOrEqual(INTERVIEW_BUDGET[tier].questionsPerRound);
        for (const q of questions) {
          expect(roundOne.has(q.slot), `${id} ${tier} ${q.slot}`).toBe(false);
          expect(['kernel_language', 'impl_language', 'ui_tech', 'frontend_pref']).not.toContain(q.slot);
        }
      }
    }
  });

  it('asks a kernel about its CPU and host, never about sign-in, storage or where people use it', () => {
    const slots = said({ domain: 'kernel', tech: 'C', skill_level: 'advanced', time_budget: '60 hours' });
    const asked = scopeQuestions({ tier: 'T5', profile: PROFILES['systems-os'], slots, signals: NO_SIGNALS }).map((q) => q.slot);
    expect(asked).toContain('target_arch');
    expect(asked).toContain('host_os');
    for (const slot of ['interface', 'data', 'users_auth', 'integrations', 'deploy_target']) expect(asked).not.toContain(slot);
  });

  it('explains every option of a question or none of them, so cards never sit half empty', () => {
    const asked = PROFILE_IDS.flatMap((id) =>
      (['T3', 'T4', 'T5'] as const).flatMap((tier) => scopeQuestions({ tier, profile: PROFILES[id], slots: {}, signals: NO_SIGNALS })),
    );
    const roundOne = projectQuestions({ rawQuery: 'something', slots: {}, missing: ['domain', 'tech', 'skill_level', 'time_budget'] });
    for (const q of [...roundOne, ...asked]) {
      const explained = q.options.map((o) => Boolean(o.hint || o.detail));
      expect(explained.every(Boolean) || !explained.some(Boolean), q.slot).toBe(true);
    }
  });

  it('skips what the message already said, in its words or its signals', () => {
    const signals = ScopeSignals.parse({ interfaces: ['web'], persistence: 'server-db', accounts: true });
    const fromSignals = scopeQuestions({ tier: 'T3', profile: PROFILES['web-fullstack'], slots: BASE, signals }).map((q) => q.slot);
    expect(fromSignals).toEqual(['integrations', 'deploy_target']);

    const slots = { ...BASE, ...said({ data: 'Postgres', users_auth: 'accounts' }) };
    const fromSlots = scopeQuestions({ tier: 'T3', profile: PROFILES['web-fullstack'], slots, signals: NO_SIGNALS }).map((q) => q.slot);
    expect(fromSlots).not.toContain('data');
    expect(fromSlots).not.toContain('users_auth');
  });
});

describe('answerSignals', () => {
  it('turns round-2 answers into the signals the tier scorer reads', () => {
    const next = answerSignals(NO_SIGNALS, {
      interface: 'Web page, Phone app',
      data: 'Server database',
      users_auth: 'Several roles',
      integrations: 'Payments, Email',
    });
    expect(next).toMatchObject({
      interfaces: ['web', 'mobile'],
      persistence: 'server-db',
      accounts: true,
      multiUser: true,
      payments: true,
      externalApis: true,
    });
  });

  it('lets an answer take back what the message implied, and keeps what it does not speak to', () => {
    const implied = ScopeSignals.parse({ accounts: true, realtime: true, externalApis: true, persistence: 'server-db' });
    const next = answerSignals(implied, { users_auth: 'Just me', integrations: 'None', data: 'Nothing' });
    expect(next).toMatchObject({ accounts: false, multiUser: false, externalApis: false, payments: false, persistence: 'none', realtime: true });
  });

  it('rescores the tier from the answers', () => {
    const profile = PROFILES['web-fullstack'];
    const implied = ScopeSignals.parse({ accounts: true, realtime: true, persistence: 'server-db' });
    const slots = said({ domain: 'Web app', time_budget: '40 hours' });
    expect(scoreComplexity(implied, profile, slots).tier).toBe('T3');
    const answered = answerSignals(implied, { users_auth: 'Just me', data: 'Nothing' });
    expect(scoreComplexity(answered, profile, slots).tier).toBe('T2');
  });
});

describe('round 2 reaches the plan', () => {
  it('renders the tier slots into the compiled query when intake passes the scoped slots', () => {
    const slots = { ...BASE, ...said({ data: 'Server database', users_auth: 'Accounts with sign-in' }) };
    const base = compileQuery({ intent: 'project_generation', rawQuery: 'a web app', slots });
    const scoped = compileQuery({ intent: 'project_generation', rawQuery: 'a web app', slots, slotDefs: scopedSlots('T3', PROFILES['web-fullstack']) });
    expect(base.text).not.toContain('Users and sign-in');
    expect(scoped.text).toContain('- Data: Server database');
    expect(scoped.text).toContain('- Users and sign-in: Accounts with sign-in');
  });
});

/* ------------------------------------------------------------------ *
 * The pipeline with purpose `project`
 * ------------------------------------------------------------------ */

/** Answers classify with what it is given and counts every structured call. */
function fakeProvider(classification: { intent: string; extracted: Record<string, string> }) {
  const calls: LLMRequest[] = [];
  const provider = {
    id: 'fake',
    modelId: 'fake-model',
    structured: async (request: LLMRequest, schema: { parse: (v: unknown) => unknown }) => {
      calls.push(request);
      const data =
        calls.length === 1
          ? {
              intent: classification.intent,
              extracted: Object.entries(classification.extracted).map(([slot, value]) => ({ slot, value })),
              reasoning: '',
            }
          : { questions: [{ slot: 'domain', question: 'Model-worded?', why: 'w', type: 'text', options: [], allowOther: true }] };
      return { data: schema.parse(data), usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    },
  } as unknown as LLMProvider;
  return { provider, calls };
}

describe('the project interview', () => {
  const context = InterviewContext.parse({ skillLevel: 'beginner' });

  it('treats the message as a project and writes the questions without a model call', async () => {
    // Read as a concept question, its tech still counts for the project.
    const { provider, calls } = fakeProvider({ intent: 'concept_question', extracted: { topic: 'todo lists', tech: 'React' } });
    const outcome = await beginInterview({ provider, rawQuery: 'teach me React with a todo app', context, purpose: 'project' });

    expect(calls).toHaveLength(1);
    expect(outcome.status).toBe('awaiting_answers');
    expect(outcome.state.intent).toBe('project_generation');
    expect(outcome.state.purpose).toBe('project');
    expect(outcome.state.slots['tech']?.value).toBe('React');
    if (outcome.status !== 'awaiting_answers') return;
    expect(outcome.questions.map((q) => q.slot)).toEqual(['domain', 'time_budget']);
    expect(outcome.questions[0]?.question).toBe('What kind of project is it?');
  });

  it('compiles the answers without another call', async () => {
    const { provider, calls } = fakeProvider({ intent: 'project_generation', extracted: {} });
    const first = await beginInterview({ provider, rawQuery: 'I want to build something', context, purpose: 'project' });
    expect(first.status).toBe('awaiting_answers');

    const next = await continueInterview({
      provider,
      state: first.state,
      answers: { domain: 'Game', tech: RECOMMEND_STACK, time_budget: '~10 hours' },
    });
    expect(calls).toHaveLength(1);
    expect(next.status).toBe('ready');
    if (next.status !== 'ready') return;
    expect(next.compiled.intent).toBe('project_generation');
    expect(next.compiled.text).toContain(`- Target technologies: ${RECOMMEND_STACK}`);
    expect(next.state.purpose).toBe('project');
  });

  it('asks the kind once when the message names it too vaguely to plan, though nothing else is missing', async () => {
    const extracted = { domain: 'recipe organiser', tech: 'Python', time_budget: '10 hours' };
    const { provider } = fakeProvider({ intent: 'project_generation', extracted });
    const first = await beginInterview({ provider, rawQuery: 'a recipe organiser in Python, about 10 hours', context, purpose: 'project' });
    expect(first.status).toBe('awaiting_answers');
    if (first.status !== 'awaiting_answers') return;
    expect(first.questions.map((q) => q.slot)).toEqual(['domain']);

    // Left blank, it is not asked again.
    const next = await continueInterview({ provider, state: first.state, answers: {} });
    expect(next.status).toBe('ready');
  });

  /*
   * Seen live: a web app offered web-app stacks, the learner picked "React +
   * Node.js", and React's lean to a front end made the kind read as unsure,
   * so the page asked "What kind of project is it?" after the stack.
   */
  it('never asks the kind after round 1, and never because of the stack picked', async () => {
    const extracted = { domain: 'web app for my book club', time_budget: '25 hours' };
    const { provider } = fakeProvider({ intent: 'project_generation', extracted });
    const first = await beginInterview({ provider, rawQuery: 'a web app for my book club', context, purpose: 'project' });
    expect(first.status).toBe('awaiting_answers');
    if (first.status !== 'awaiting_answers') return;
    expect(first.questions.map((q) => q.slot)).toEqual(['tech']);
    expect(first.questions[0]?.options[0]?.value).toBe('React + Node.js');

    expect(unsureKind('a web app for my book club', said({ ...extracted, tech: 'React + Node.js' }))).toBe(false);
    const next = await continueInterview({ provider, state: first.state, answers: { tech: 'React + Node.js' } });
    expect(next.status).toBe('ready');
  });

  it('asks nothing when the kind is clear and nothing is missing', async () => {
    const extracted = { domain: 'website', tech: 'React', time_budget: 'a few hours' };
    const { provider } = fakeProvider({ intent: 'project_generation', extracted });
    const outcome = await beginInterview({ provider, rawQuery: 'a website in React for a few hours', context, purpose: 'project' });
    expect(outcome.status).toBe('ready');
  });

  it('leaves the workspace interview to the model, as before', async () => {
    const { provider, calls } = fakeProvider({ intent: 'project_generation', extracted: { domain: 'recipe organiser' } });
    const outcome = await beginInterview({ provider, rawQuery: 'I want to build something', context });

    expect(calls).toHaveLength(2);
    expect(outcome.state.purpose).toBe('ask');
    if (outcome.status !== 'awaiting_answers') return;
    expect(outcome.questions[0]?.question).toBe('Model-worded?');
  });
});
