'use client';

import { useState } from 'react';
import type { AssessmentView } from '@ai-edu/api-client';

import { renderInline } from '../../lib/markdown';

/**
 * The multiple-choice gate: five questions, four options each, marked by the
 * server against a key the browser has never seen.
 */
export function McqRound({
  questions,
  busy,
  onSubmit,
}: {
  questions: AssessmentView['mcq'];
  busy: boolean;
  onSubmit: (answers: number[]) => void;
}) {
  const [answers, setAnswers] = useState<Array<number | null>>(() => questions.map(() => null));
  const complete = answers.every((a) => a !== null);

  return (
    <form
      className="assess-card"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete) onSubmit(answers as number[]);
      }}
    >
      <p className="assess-lede">
        Five quick questions first. Get four right and the viva opens — open questions marked against a rubric you
        will see before you answer.
      </p>
      <ol className="mcq-list">
        {questions.map((q, i) => (
          <li key={i} className="mcq-question">
            <fieldset>
              <legend>{renderInline(q.prompt, `q${i}`)}</legend>
              {q.options.map((option, j) => (
                <label key={j} className={`mcq-option${answers[i] === j ? ' is-chosen' : ''}`}>
                  <input
                    type="radio"
                    name={`mcq-${i}`}
                    value={j}
                    checked={answers[i] === j}
                    disabled={busy}
                    onChange={() => setAnswers((prev) => prev.map((a, k) => (k === i ? j : a)))}
                  />
                  <span>{renderInline(option, `q${i}o${j}`)}</span>
                </label>
              ))}
            </fieldset>
          </li>
        ))}
      </ol>
      <div className="assess-actions">
        <span className="muted">
          {answers.filter((a) => a !== null).length} of {questions.length} answered
        </span>
        <button type="submit" className="btn primary" disabled={!complete || busy}>
          {busy ? 'Marking…' : 'Check my answers'}
        </button>
      </div>
    </form>
  );
}

/** The gate, marked: what was chosen, what was right, and why. */
export function McqResult({ view }: { view: AssessmentView }) {
  const result = view.mcqResult;
  if (!result) return null;
  return (
    <section className={`assess-card mcq-result ${result.passed ? 'is-pass' : 'is-fail'}`}>
      <h2>
        Multiple choice: {result.score} / {result.total}
      </h2>
      <ol className="mcq-list">
        {view.mcq.map((q, i) => {
          const chosen = result.answers[i];
          const right = result.correctIndexes[i];
          const ok = chosen === right;
          return (
            <li key={i} className={`mcq-question ${ok ? 'is-right' : 'is-wrong'}`}>
              <div className="mcq-mark" aria-label={ok ? 'Correct' : 'Incorrect'}>
                {ok ? '✓' : '✗'}
              </div>
              <div>
                <div className="mcq-prompt">{renderInline(q.prompt, `r${i}`)}</div>
                {!ok && chosen !== undefined && (
                  <div className="muted">
                    You chose: {renderInline(q.options[chosen] ?? '', `r${i}c`)}
                  </div>
                )}
                <div>
                  Answer: <strong>{renderInline(q.options[right ?? 0] ?? '', `r${i}a`)}</strong>
                </div>
                {result.explanations[i] && <div className="mcq-why">{result.explanations[i]}</div>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
