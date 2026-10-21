/**
 * The assessment screens, rendered to markup.
 *
 * What they must get right for the learner: the rubric is in front of them
 * before they answer, the gate shows nothing of its answers until it is
 * marked, a grade shows the words that earned each mark, and a retake's
 * story is told as a trajectory, not a single number.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AssessmentView } from '@ai-edu/api-client';

import { AssessmentOfferCard } from '../components/assessment/AssessmentOfferCard';
import { AssessmentReport } from '../components/assessment/AssessmentReport';
import { McqResult, McqRound } from '../components/assessment/McqRound';
import { GradeCard, VivaQuestionCard, composeAnswer } from '../components/assessment/VivaRound';

const noop = () => {};

function view(over: Partial<AssessmentView> = {}): AssessmentView {
  return {
    id: 'a1',
    conceptKey: 'closures',
    conceptLabel: 'Closures',
    attemptNumber: 1,
    status: 'mcq',
    createdAt: '2026-10-22T10:00:00Z',
    completedAt: null,
    mcq: Array.from({ length: 5 }, (_, i) => ({ prompt: `What does \`snippet ${i}\` log?`, options: ['0 1 2', '3 3 3', 'undefined', 'throws'] })),
    mcqResult: null,
    viva: Array.from({ length: 5 }, (_, i) => ({
      prompt: `Scenario ${i}: the loop prints 3 three times. Why?`,
      topic: `t${i}`,
      rubric: [
        { id: 'c1', text: 'names var as function-scoped', marks: 2 },
        { id: 'c2', text: 'proposes let', marks: 2 },
        { id: 'c3', text: 'explains the stale read', marks: 1 },
      ],
    })),
    answers: [],
    nextQuestion: 0,
    vivaScore: null,
    report: null,
    retakeAfter: null,
    stuck: false,
    ...over,
  };
}

describe('the multiple-choice gate', () => {
  it('renders five questions of four options, with nothing to say which is right', () => {
    const html = renderToStaticMarkup(<McqRound questions={view().mcq} busy={false} onSubmit={noop} />);
    expect(html.match(/<fieldset/g)).toHaveLength(5);
    expect(html.match(/type="radio"/g)).toHaveLength(20);
    expect(html).not.toMatch(/correct|is-right/i);
    // Cannot be submitted half-answered.
    expect(html).toMatch(/<button type="submit"[^>]*disabled/);
  });

  it('renders inline code in a prompt as code, not as backticks', () => {
    const html = renderToStaticMarkup(<McqRound questions={view().mcq} busy={false} onSubmit={noop} />);
    expect(html).toContain('<code');
    expect(html).not.toContain('`snippet 0`');
  });

  it('once marked, shows the right answer and why', () => {
    const marked = view({
      status: 'mcq_failed',
      mcqResult: { score: 2, total: 5, passed: false, answers: [1, 1, 0, 0, 0], correctIndexes: [1, 1, 2, 3, 0], explanations: ['', '', 'Because var is shared.', '', ''] },
    });
    const html = renderToStaticMarkup(<McqResult view={marked} />);
    expect(html).toContain('Multiple choice: 2 / 5');
    expect(html).toContain('Because var is shared.');
    expect(html).toContain('You chose:');
  });
});

describe('the viva', () => {
  it('puts the rubric in front of the learner before the answer box', () => {
    const html = renderToStaticMarkup(<VivaQuestionCard view={view({ status: 'viva' })} index={1} busy={false} onSubmit={noop} />);
    expect(html).toContain('Question 2 of 5');
    expect(html).toContain('What earns marks');
    expect(html.indexOf('names var as function-scoped')).toBeLessThan(html.indexOf('<textarea'));
  });

  it('composes prose and an optional snippet into one answer', () => {
    expect(composeAnswer('  var is shared  ', '', 'js')).toBe('var is shared');
    expect(composeAnswer('Use let:', 'for (let i = 0; i < 3; i++) {}', 'js')).toBe(
      'Use let:\n\n```js\nfor (let i = 0; i < 3; i++) {}\n```',
    );
  });

  it('shows each criterion met or missed, quoting the words that earned it', () => {
    const html = renderToStaticMarkup(
      <GradeCard
        prompt="Why?"
        grade={{
          questionIndex: 0,
          answer: 'var is function-scoped so i is shared',
          score: 2,
          max: 5,
          criteria: [
            { id: 'c1', text: 'names var as function-scoped', marks: 2, met: true, evidence: 'var is function-scoped' },
            { id: 'c2', text: 'proposes let', marks: 2, met: false, evidence: '' },
          ],
        }}
      />,
    );
    expect(html).toContain('Question 1: 2 / 5');
    expect(renderToStaticMarkup(<GradeCard prompt="Why does `count` stay **0**?" grade={{ questionIndex: 0, answer: '', score: 0, max: 5, criteria: [] }} />)).not.toContain('**0**');
    expect(html).toContain('“var is function-scoped”');
    expect(html).toContain('aria-label="Missed"');
  });
});

describe('the report', () => {
  const graded = (total: number, retakeAfter: string | null) =>
    view({
      status: 'graded',
      vivaScore: total,
      retakeAfter,
      report: {
        total,
        max: 25,
        passed: total >= 15,
        questions: [{ index: 0, prompt: 'Why?', score: 2, max: 5, criteria: [] }],
      },
    });

  it('tells a retake as a trajectory', () => {
    const html = renderToStaticMarkup(
      <AssessmentReport view={graded(22, null)} history={[{ attemptNumber: 1, vivaScore: 12 }, { attemptNumber: 2, vivaScore: 22 }]} onRetake={noop} />,
    );
    expect(html).toContain('It stuck.');
    // Compared as visible text: each attempt sits in its own element.
    expect(html.replace(/<[^>]+>/g, '')).toContain('12/25 → 22/25');
  });

  it('below the pass mark, offers the retake when it is open', () => {
    const html = renderToStaticMarkup(<AssessmentReport view={graded(10, new Date(Date.now() - 1000).toISOString())} history={[]} onRetake={noop} />);
    expect(html).toContain('Not yet');
    expect(html).toContain('Start the retake');
  });

  it('below the pass mark, says when the retake opens if it has not yet', () => {
    const html = renderToStaticMarkup(<AssessmentReport view={graded(10, new Date(Date.now() + 86_400_000).toISOString())} history={[]} onRetake={noop} />);
    expect(html).toContain('A retake opens');
    expect(html).not.toContain('Start the retake');
  });
});

describe('the offer', () => {
  it('is a suggestion the learner can turn down', () => {
    const html = renderToStaticMarkup(
      <AssessmentOfferCard offer={{ conceptKey: 'closures', label: 'Closures', score: 0.7 }} busy={false} onTest={noop} onDismiss={noop} />,
    );
    expect(html).toContain('You have worked on Closures enough to test it.');
    expect(html).toContain('Test me');
    expect(html).toContain('Not now');
  });
});
