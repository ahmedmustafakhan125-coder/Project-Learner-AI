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
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
        <span className="logo-spark">✦</span>
        <h2>Context Alignment</h2>
      </div>
      <p className="lede">
        {questions.length === 1
          ? 'One detail will help tailor the four specialist answers.'
          : `${questions.length} quick details will help tailor the answers.`}{' '}
        Select what fits or skip directly to generation.
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
              placeholder="Type your context here…"
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
          {busy ? 'Working…' : 'Continue to Specialist Answers →'}
        </button>
        <button className="btn ghost" onClick={onSkip} disabled={busy}>
          Skip &amp; Answer Anyway
        </button>
        {answeredCount > 0 && (
          <span className="muted" style={{ marginLeft: 'auto', fontSize: '12.5px' }}>
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
          placeholder="Custom specification…"
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
