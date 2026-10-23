/**
 * The project page's questions (PROJECT_LEARNER on), rendered to markup.
 *
 * The page used to borrow the workspace's panel, which promised "Specialist
 * Answers" and showed the stack question as an empty text box. These pin the
 * project panel: numbered questions in the server's words, stack cards that
 * each say what they are written in, how hard they are, what they are best at
 * and what you learn, one recommended with its reason, options that follow
 * the kind of project, and round 2 under its own heading.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PROFILES, RECOMMEND_STACK, STACKS_BY_PROFILE, ScopeSignals, projectQuestions, scopeQuestions } from '@ai-edu/core';

import { OptionCard, ProjectQuestions, optionsFor } from '../components/ProjectQuestions';

const noop = () => undefined;
const questions = projectQuestions({
  rawQuery: 'I want to build a todo app',
  slots: {},
  missing: ['domain', 'tech', 'skill_level', 'time_budget'],
});

describe('ProjectQuestions', () => {
  const html = renderToStaticMarkup(<ProjectQuestions questions={questions} busy={false} onSubmit={noop} onSkip={noop} />);

  it('numbers the questions and words them for a project', () => {
    expect(html).toContain('Before we plan it');
    expect(html.match(/class="pq-num"/g)).toHaveLength(4);
    expect(html).toContain('What do you want to build it with?');
    expect(html).toContain('Skip — choose for me');
    expect(html).not.toContain('Specialist');
  });

  it('shows every stack as a card that explains it, with a box for your own', () => {
    expect(html).toContain('Your stack is the languages, frameworks and tools');
    // The generic languages: seven stacks and "choose for me".
    expect(html.match(/class="pq-card( [^"]*)?"/g)).toHaveLength(8);
    expect(html.match(/<b>Best for<\/b>/g)).toHaveLength(7);
    expect(html.match(/<b>You’ll learn<\/b>/g)).toHaveLength(7);
    expect(html).toContain('Beginner-friendly');
    expect(html).toContain('Challenging');
    expect(html).toContain('placeholder="Or name your own, e.g. Vue and Firebase"');
  });

  it('recommends one stack, says why, and offers "choose for me"', () => {
    expect(html.match(/class="pq-badge"/g)).toHaveLength(1);
    expect(html).toContain('Why we recommend it');
    expect(html).toContain('Not sure — choose for me');
    expect(html).not.toContain(`>${RECOMMEND_STACK}<`);
  });

  it('keeps plain chips for options with nothing to explain, and no box for skill level', () => {
    expect(html).toContain('class="chip"');
    expect(html).not.toContain('aria-label="How much programming have you done? Your own answer"');
  });

  it('gives round 2 its own heading', () => {
    const more = scopeQuestions({
      tier: 'T3',
      profile: PROFILES['web-fullstack'],
      slots: { domain: { value: 'Web app', source: 'answer' } },
      signals: ScopeSignals.parse({}),
    });
    const round2 = renderToStaticMarkup(
      <ProjectQuestions questions={more} busy={false} onSubmit={noop} onSkip={noop} heading="A few more questions" lede="More moving parts." />,
    );
    expect(round2).toContain('A few more questions');
    expect(round2).toContain('Who signs in?');
    expect(round2).toContain('Everyone sees only their own data.');
    expect(round2).not.toContain('Before we plan it');
  });
});

describe('OptionCard', () => {
  it('marks the picked card for assistive technology', () => {
    const [option] = STACKS_BY_PROFILE.game.filter((s) => s.why).map(({ name, why, ...detail }) => ({ label: name, value: name, detail, recommended: why }));
    const card = renderToStaticMarkup(<OptionCard option={option!} pressed disabled={false} onPick={noop} />);
    expect(card).toContain('aria-pressed="true"');
    expect(card).toContain('JavaScript + HTML canvas');
    expect(card).toContain('Recommended');
  });
});

describe('optionsFor', () => {
  const stack = questions.find((q) => q.slot === 'tech')!;

  it('swaps the stack options once a kind of project is picked', () => {
    const game = optionsFor(stack, { domain: 'Game' }).map((o) => o.value);
    expect(game.at(-1)).toBe(RECOMMEND_STACK);
    expect(new Set(game.slice(0, -1))).toEqual(new Set(STACKS_BY_PROFILE.game.map((s) => s.name)));
  });

  it('keeps its own options for a kind typed in the box, or none yet', () => {
    expect(optionsFor(stack, { domain: 'a browser extension' })).toEqual(stack.options);
    expect(optionsFor(stack, {})).toEqual(stack.options);
  });
});
