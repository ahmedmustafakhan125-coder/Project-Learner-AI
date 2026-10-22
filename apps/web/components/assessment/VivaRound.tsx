'use client';

import { useState } from 'react';
import type { AnsweredVivaQuestion, AssessmentView } from '@ai-edu/api-client';

import { CodeEditor } from '../CodeEditor';
import { renderInline, renderMarkdown } from '../../lib/markdown';

/**
 * One viva question at a time. The rubric is shown BEFORE the learner
 * answers: it is fair, it makes for better answers, and it turns grading into
 * checking rather than interpreting.
 */

const SNIPPET_LANGUAGES = [
  { id: 'js', label: 'JavaScript', path: 'snippet.js' },
  { id: 'ts', label: 'TypeScript', path: 'snippet.ts' },
  { id: 'py', label: 'Python', path: 'snippet.py' },
  { id: 'sql', label: 'SQL', path: 'snippet.sql' },
];

const MAX_ANSWER = 6000;

/** Prose plus an optional code snippet, as one answer the grader reads in order. */
export function composeAnswer(text: string, code: string, language: string): string {
  const prose = text.trim();
  const snippet = code.trim();
  if (!snippet) return prose;
  return `${prose}\n\n\`\`\`${language}\n${snippet}\n\`\`\``.trim();
}

export function VivaQuestionCard({
  view,
  index,
  busy,
  onSubmit,
}: {
  view: AssessmentView;
  index: number;
  busy: boolean;
  onSubmit: (answer: string) => void;
}) {
  const question = view.viva[index];
  const [text, setText] = useState('');
  const [withCode, setWithCode] = useState(false);
  const [language, setLanguage] = useState(SNIPPET_LANGUAGES[0]!);
  const [code, setCode] = useState('');

  if (!question) return null;
  const answer = composeAnswer(text, withCode ? code : '', language.id);
  const tooLong = answer.length > MAX_ANSWER;

  return (
    <form
      className="assess-card viva-card"
      onSubmit={(event) => {
        event.preventDefault();
        if (answer && !tooLong) onSubmit(answer);
      }}
    >
      <div className="viva-progress">
        Question {index + 1} of {view.viva.length}
        <span className="muted"> · {view.answers.length} answered</span>
      </div>
      <div className="viva-prompt">{renderMarkdown(question.prompt, `v${index}`)}</div>

      <div className="viva-rubric">
        <h3>What earns marks</h3>
        <ul>
          {question.rubric.map((c) => (
            <li key={c.id}>
              <span className="viva-marks">{c.marks}</span> {c.text}
            </li>
          ))}
        </ul>
      </div>

      <label className="viva-answer">
        <span>Your answer</span>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={7}
          disabled={busy}
          placeholder="Explain it as you would to a colleague. Say what is happening, why, and what you would do."
        />
      </label>

      {withCode ? (
        <div className="viva-code">
          <div className="viva-code-head">
            <select
              className="control"
              value={language.id}
              onChange={(event) => setLanguage(SNIPPET_LANGUAGES.find((l) => l.id === event.target.value) ?? SNIPPET_LANGUAGES[0]!)}
              disabled={busy}
              aria-label="Snippet language"
            >
              {SNIPPET_LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
            <button type="button" className="linklike" onClick={() => setWithCode(false)} disabled={busy}>
              Remove code
            </button>
          </div>
          <CodeEditor
            key={language.path}
            files={[{ path: language.path, contents: code }]}
            onChange={(files) => setCode(files[0]?.contents ?? '')}
          />
        </div>
      ) : (
        <button type="button" className="linklike viva-add-code" onClick={() => setWithCode(true)} disabled={busy}>
          + Add a code snippet
        </button>
      )}

      <div className="assess-actions">
        <span className={tooLong ? 'notice-inline error' : 'muted'}>
          {tooLong ? `Too long by ${answer.length - MAX_ANSWER} characters` : `${answer.length} / ${MAX_ANSWER}`}
        </span>
        <button type="submit" className="btn primary" disabled={!answer || tooLong || busy}>
          {busy ? 'Grading… an examiner is checking each criterion' : 'Submit for grading'}
        </button>
      </div>
    </form>
  );
}

/** How one answer was marked: each criterion, met or missed, with the words that earned it. */
export function GradeCard({
  grade,
  prompt,
  onNext,
  nextLabel,
}: {
  grade: AnsweredVivaQuestion;
  prompt: string;
  onNext?: () => void;
  nextLabel?: string;
}) {
  return (
    <section className="assess-card grade-card">
      <div className="grade-head">
        <h3>
          Question {grade.questionIndex + 1}: {grade.score} / {grade.max}
        </h3>
      </div>
      <div className="grade-prompt muted">{renderInline(prompt, `gp${grade.questionIndex}`)}</div>
      <ul className="grade-criteria">
        {grade.criteria.map((c) => (
          <li key={c.id} className={c.met ? 'is-met' : 'is-missed'}>
            <span className="grade-mark" aria-label={c.met ? 'Met' : 'Missed'}>
              {c.met ? '✓' : '✗'}
            </span>
            <div>
              <div>
                {c.text} <span className="muted">({c.marks})</span>
              </div>
              {c.met && c.evidence && <blockquote>“{c.evidence}”</blockquote>}
            </div>
          </li>
        ))}
      </ul>
      {onNext && (
        <div className="assess-actions">
          <span />
          <button type="button" className="btn primary" onClick={onNext}>
            {nextLabel ?? 'Next question'}
          </button>
        </div>
      )}
    </section>
  );
}
