'use client';

import Link from 'next/link';
import type { AssessmentView } from '@ai-edu/api-client';

import { GradeCard } from './VivaRound';

/**
 * The result of a sitting: the total, every question's marking, and where the
 * learner stands across all their attempts — 12 then 22 is the story, not 22.
 */

export interface AttemptSummary {
  attemptNumber: number;
  vivaScore: number;
}

function onDate(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function AssessmentReport({
  view,
  history,
  onRetake,
}: {
  view: AssessmentView;
  history: AttemptSummary[];
  onRetake: () => void;
}) {
  const report = view.report;
  if (!report) return null;
  const retakeOpen = !view.retakeAfter || Date.parse(view.retakeAfter) <= Date.now();

  return (
    <>
      <section className={`assess-card assess-total ${report.passed ? 'is-pass' : 'is-fail'}`}>
        <div className="assess-score">
          <span className="assess-score-value">{report.total}</span>
          <span className="assess-score-max">/ {report.max}</span>
        </div>
        <div>
          <h2>{report.passed ? 'It stuck.' : 'Not yet — and now you know exactly where.'}</h2>
          <p>
            {report.passed
              ? `${view.conceptLabel} is now marked as assessed in your brain.`
              : `The criteria you missed are below, and they are now in your brain as things to watch.`}
          </p>
          {history.length > 1 && (
            <p className="assess-trajectory" aria-label="Your attempts">
              {history.map((h, i) => (
                <span key={h.attemptNumber}>
                  {i > 0 && ' → '}
                  <strong>{h.vivaScore}</strong>/25
                </span>
              ))}
            </p>
          )}
        </div>
      </section>

      {!report.passed && (
        <div className="notice info">
          {retakeOpen ? (
            <>
              A retake is open — different questions on the same concept.{' '}
              <button type="button" className="linklike" onClick={onRetake}>
                Start the retake
              </button>
            </>
          ) : (
            <>A retake opens {onDate(view.retakeAfter)}. Use the time to go over what you missed.</>
          )}
        </div>
      )}

      {report.questions.map((q) => (
        <GradeCard
          key={q.index}
          prompt={q.prompt}
          grade={{
            questionIndex: q.index,
            answer: view.answers.find((a) => a.questionIndex === q.index)?.answer ?? '',
            score: q.score,
            max: q.max,
            criteria: q.criteria,
          }}
        />
      ))}

      <div className="assess-actions">
        <Link className="btn" href={`/brain?focus=${encodeURIComponent(`concept:${view.conceptKey}`)}`}>
          See {view.conceptLabel} in your brain
        </Link>
        <Link className="btn" href={`/ask?q=${encodeURIComponent(`Help me with ${view.conceptLabel} — the parts I missed in my assessment`)}`}>
          Ask the tutors about it
        </Link>
      </div>
    </>
  );
}
