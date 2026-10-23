'use client';

import { useState } from 'react';
import type { ChoiceOption, InterviewQuestion, OptionDetail } from '@ai-edu/core';

/**
 * The project page's questions (PROJECT_LEARNER on).
 *
 * The server writes them in code (`projectQuestions` and `scopeQuestions` in
 * core), so the form is the same on every visit: numbered, each with what its
 * answer changes, options for the usual answers and a box for anything else.
 * Options that explain themselves are cards: every stack says what it is
 * written in, how hard it is, what it is best at and what you will learn, and
 * the recommended one says why. The stack options follow the kind of project
 * as soon as one is picked. Every question is optional — Skip leaves the
 * choices to the Stack Brief, which the learner approves before anything is
 * built.
 */

interface Answer {
  value: string;
  /** Typed in the box rather than picked: kept whatever the options become. */
  typed: boolean;
}

export interface ProjectQuestionsProps {
  questions: InterviewQuestion[];
  busy: boolean;
  onSubmit: (answers: Record<string, string>) => void;
  onSkip: () => void;
  heading?: string;
  lede?: string;
}

export const DIFFICULTY_LABEL: Record<OptionDetail['difficulty'], { label: string; dots: number }> = {
  easy: { label: 'Beginner-friendly', dots: 1 },
  medium: { label: 'Moderate', dots: 2 },
  hard: { label: 'Challenging', dots: 3 },
};

/** The options a question offers now: the ones that follow another answer, or its own. */
export function optionsFor(question: InterviewQuestion, answers: Record<string, string>): ChoiceOption[] {
  const followed = question.follows ? answers[question.follows.slot] : undefined;
  return (followed ? question.follows?.options[followed] : undefined) ?? question.options;
}

/**
 * What a question's answer is worth sending. A picked option the question no
 * longer offers is dropped: choosing "Game" after "React + Node.js" must not
 * send React as the stack for a game.
 */
function kept(question: InterviewQuestion, answer: Answer | undefined, offered: ChoiceOption[]): string {
  const value = answer?.value.trim() ?? '';
  if (!value || answer?.typed || question.type === 'text') return value;
  const allowed = new Set(offered.map((o) => o.value));
  // Only a multi-choice answer is a list; a single option may hold a comma itself.
  if (question.type !== 'multi') return allowed.has(value) ? value : '';
  return value
    .split(', ')
    .filter((v) => allowed.has(v))
    .join(', ');
}

/** Options with something to explain are cards; the rest stay chips. */
const explained = (options: ChoiceOption[]) => options.some((o) => o.detail || o.hint || o.recommended);

function Difficulty({ level }: { level: OptionDetail['difficulty'] }) {
  const { label, dots } = DIFFICULTY_LABEL[level];
  return (
    <span className={`pq-level is-${level}`}>
      <span className="pq-dots" aria-hidden="true">
        {[1, 2, 3].map((n) => (
          <i key={n} className={n <= dots ? 'on' : undefined} />
        ))}
      </span>
      {label}
    </span>
  );
}

export function OptionCard({ option, pressed, disabled, onPick }: { option: ChoiceOption; pressed: boolean; disabled: boolean; onPick: () => void }) {
  const { detail, hint, recommended } = option;
  return (
    <button
      type="button"
      className={`pq-card${detail ? ' is-stack' : ''}${recommended ? ' is-recommended' : ''}`}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onPick}
    >
      {recommended && <span className="pq-badge">Recommended</span>}
      <span className="pq-card-head">
        <span className="pq-card-label">{option.label}</span>
        <span className="pq-tick" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="12" height="12">
            <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </span>
      {detail && (
        <>
          <span className="pq-facts">
            <span className="pq-lang">{detail.language}</span>
            <Difficulty level={detail.difficulty} />
          </span>
          <span className="pq-line">
            <b>Best for</b> {detail.bestFor}
          </span>
          <span className="pq-line">
            <b>You’ll learn</b> {detail.learn}
          </span>
        </>
      )}
      {hint && <span className="pq-hint">{hint}</span>}
      {recommended && (
        <span className="pq-why">
          <b>Why we recommend it</b> {recommended}
        </span>
      )}
    </button>
  );
}

export function ProjectQuestions({
  questions,
  busy,
  onSubmit,
  onSkip,
  heading = 'Before we plan it',
  lede = 'Answer what you can. Anything you skip is chosen for you, and you see and approve every choice before anything is built.',
}: ProjectQuestionsProps) {
  const [answers, setAnswers] = useState<Record<string, Answer>>({});

  const set = (slot: string, answer: Answer | null) =>
    setAnswers((prev) => {
      const next = { ...prev };
      if (answer && answer.value.trim()) next[slot] = answer;
      else delete next[slot];
      return next;
    });

  const raw = Object.fromEntries(Object.entries(answers).map(([slot, a]) => [slot, a.value]));
  const offered = new Map(questions.map((q) => [q.slot, optionsFor(q, raw)]));
  const sendable: Record<string, string> = {};
  for (const question of questions) {
    const value = kept(question, answers[question.slot], offered.get(question.slot) ?? []);
    if (value) sendable[question.slot] = value;
  }
  const answered = Object.keys(sendable).length;

  return (
    <section className="interview project-questions" aria-labelledby="pq-title">
      <h2 id="pq-title">{heading}</h2>
      <p className="lede">{lede}</p>

      <ol className="pq-list">
        {questions.map((question, index) => {
          const options = offered.get(question.slot) ?? [];
          const answer = answers[question.slot];
          const labelId = `pq-q-${question.slot}`;
          const value = sendable[question.slot];
          const selected =
            !answer || answer.typed || !value ? [] : question.type === 'multi' ? value.split(', ') : [value];

          const pick = (value: string) => {
            if (question.type !== 'multi') {
              set(question.slot, selected.includes(value) ? null : { value, typed: false });
              return;
            }
            const next = selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
            set(question.slot, { value: next.join(', '), typed: false });
          };

          const other = question.allowOther && (
            <input
              className={explained(options) ? 'textinput pq-other' : 'chip-input'}
              type="text"
              aria-label={`${question.question} Your own answer`}
              value={answer?.typed ? answer.value : ''}
              placeholder={question.placeholder ?? 'Something else'}
              disabled={busy}
              // Typing replaces the picked option rather than adding to it, so
              // two answers that disagree are never sent together.
              onChange={(e) => set(question.slot, { value: e.target.value, typed: true })}
            />
          );

          return (
            <li className="question pq-question" key={question.slot}>
              <span className="pq-num" aria-hidden="true">
                {index + 1}
              </span>
              <div className="pq-body">
                <div className="q" id={labelId}>
                  {question.question}
                </div>
                <div className="why">{question.why}</div>

                {question.type === 'text' || options.length === 0 ? (
                  <input
                    className="textinput pq-text"
                    type="text"
                    aria-labelledby={labelId}
                    value={answer?.value ?? ''}
                    placeholder={question.placeholder ?? 'Type your answer'}
                    disabled={busy}
                    onChange={(e) => set(question.slot, { value: e.target.value, typed: true })}
                  />
                ) : explained(options) ? (
                  <>
                    {/* Keyed by what is offered, so new options fade in when the kind changes. */}
                    <div className="pq-cards" role="group" aria-labelledby={labelId} key={options.map((o) => o.value).join('|')}>
                      {options.map((option) => (
                        <OptionCard
                          key={option.value}
                          option={option}
                          pressed={selected.includes(option.value)}
                          disabled={busy}
                          onPick={() => pick(option.value)}
                        />
                      ))}
                    </div>
                    {other}
                  </>
                ) : (
                  <div className="chips" role="group" aria-labelledby={labelId}>
                    {options.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className="chip"
                        aria-pressed={selected.includes(option.value)}
                        disabled={busy}
                        onClick={() => pick(option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                    {other}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="actions">
        <button type="button" className="btn primary" onClick={() => onSubmit(sendable)} disabled={busy}>
          {busy ? 'Working…' : 'Continue'}
        </button>
        <button type="button" className="btn ghost" onClick={onSkip} disabled={busy}>
          Skip — choose for me
        </button>
        {answered > 0 && (
          <span className="muted pq-count">
            {answered} of {questions.length} answered
          </span>
        )}
      </div>
    </section>
  );
}
