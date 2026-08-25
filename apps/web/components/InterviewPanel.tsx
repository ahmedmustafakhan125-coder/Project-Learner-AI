'use client';

import { useState } from 'react';
import type { InterviewQuestion } from '@ai-edu/core';

/**
 * The clarifying questions.
 *
 * Everything here is optional. Skip is always present and always compiles with
 * whatever is known — an interview a learner cannot escape is worse than an
 * answer given with incomplete context, and the compiled query tells the model
 * explicitly which facts were declined so it hedges only where it must.
 */

export interface InterviewPanelProps {
  questions: InterviewQuestion[];
  busy: boolean;
  onSubmit: (answers: Record<string, string>) => void;
  onSkip: () => void;
}

export function InterviewPanel({ questions, busy, onSubmit, onSkip }: InterviewPanelProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const set = (slot: string, value: string) =>
    setAnswers((prev) => ({ ...prev, [slot]: value }));

  const answeredCount = Object.values(answers).filter((v) => v.trim()).length;

  return (
    <section className="interview" aria-label="A few quick questions">
      <h2>A few quick questions</h2>
      <p className="lede">
        {questions.length === 1
          ? 'One thing would help me answer this properly.'
          : `${questions.length} things would help me answer this properly.`}{' '}
        Answer what you like — you can skip any of them.
      </p>

      {questions.map((question) => (
        <div className="question" key={question.slot}>
          <div className="q">{question.question}</div>
          <div className="why">{question.why}</div>

          {question.type === 'text' ? (
            <input
              className="textinput"
              type="text"
              value={answers[question.slot] ?? ''}
              onChange={(e) => set(question.slot, e.target.value)}
              placeholder="Type your answer…"
              disabled={busy}
            />
          ) : (
            <ChipRow
              question={question}
              value={answers[question.slot] ?? ''}
              onChange={(value) => set(question.slot, value)}
              disabled={busy}
            />
          )}
        </div>
      ))}

      <div className="actions">
        <button className="btn primary" onClick={() => onSubmit(answers)} disabled={busy}>
          {busy ? 'Working…' : 'Continue'}
        </button>
        <button className="btn ghost" onClick={onSkip} disabled={busy}>
          Skip &amp; answer anyway
        </button>
        {answeredCount > 0 && (
          <span className="muted">
            {answeredCount} of {questions.length} answered
          </span>
        )}
      </div>
    </section>
  );
}

function ChipRow({
  question,
  value,
  onChange,
  disabled,
}: {
  question: InterviewQuestion;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const [other, setOther] = useState('');
  const multi = question.type === 'multi';
  const selected = multi ? value.split(', ').filter(Boolean) : [value];

  const toggle = (option: string) => {
    if (!multi) {
      onChange(value === option ? '' : option);
      return;
    }
    const next = selected.includes(option)
      ? selected.filter((s) => s !== option)
      : [...selected, option];
    onChange(next.join(', '));
  };

  return (
    <div className="chips">
      {question.options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="chip"
          aria-pressed={selected.includes(option.value)}
          onClick={() => toggle(option.value)}
          disabled={disabled}
        >
          {option.label}
        </button>
      ))}

      {question.allowOther && (
        <input
          className="chip-input"
          type="text"
          value={other}
          placeholder="Something else…"
          disabled={disabled}
          onChange={(e) => {
            setOther(e.target.value);
            // Free text replaces the chip selection rather than appending to it,
            // so the learner never ends up submitting two contradictory answers.
            onChange(e.target.value);
          }}
        />
      )}
    </div>
  );
}
