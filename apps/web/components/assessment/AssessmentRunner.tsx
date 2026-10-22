'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, type AnsweredVivaQuestion, type AssessmentView } from '@ai-edu/api-client';

import { api } from '../../lib/api';
import { AssessmentReport, type AttemptSummary } from './AssessmentReport';
import { McqResult, McqRound } from './McqRound';
import { GradeCard, VivaQuestionCard } from './VivaRound';

/**
 * One sitting, from the gate to the report.
 *
 * Every state lives on the server — reload mid-viva and it resumes at the next
 * unanswered question — so this component only renders the stage the server
 * says the sitting is in.
 */

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

function onDate(iso: string | null): string {
  if (!iso) return 'soon';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? 'soon'
    : date.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

const STAGES = ['Multiple choice', 'Viva', 'Result'] as const;

function stageOf(view: AssessmentView): number {
  if (view.status === 'mcq' || view.status === 'mcq_failed') return 0;
  if (view.status === 'viva') return 1;
  return 2;
}

export function AssessmentRunner({ id }: { id: string }) {
  const router = useRouter();
  const [view, setView] = useState<AssessmentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The grade just returned, shown before moving on to the next question. */
  const [justGraded, setJustGraded] = useState<AnsweredVivaQuestion | null>(null);
  const [history, setHistory] = useState<AttemptSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .getAssessment(id)
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describe(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Once graded, the brain holds every attempt on this concept.
  useEffect(() => {
    if (view?.status !== 'graded') return;
    api
      .getBrainNode(`concept:${view.conceptKey}`)
      .then((detail) => setHistory(detail.assessments.map((a) => ({ attemptNumber: a.attemptNumber, vivaScore: a.vivaScore }))))
      .catch(() => setHistory([]));
  }, [view?.status, view?.conceptKey]);

  const submitMcq = useCallback(
    async (answers: number[]) => {
      setBusy(true);
      setError(null);
      try {
        setView(await api.submitMcq(id, answers));
      } catch (err) {
        setError(describe(err));
      } finally {
        setBusy(false);
      }
    },
    [id],
  );

  const submitViva = useCallback(
    async (questionIndex: number, answer: string) => {
      setBusy(true);
      setError(null);
      try {
        const result = await api.submitVivaAnswer(id, questionIndex, answer);
        setView(result.assessment);
        setJustGraded(result.grade);
      } catch (err) {
        setError(describe(err));
      } finally {
        setBusy(false);
      }
    },
    [id],
  );

  const retake = useCallback(async () => {
    if (!view) return;
    setBusy(true);
    setError(null);
    try {
      const { assessment } = await api.startAssessment(view.conceptKey);
      setJustGraded(null);
      router.push(`/assess/${assessment.id}`);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }, [view, router]);

  if (error && !view) {
    return (
      <main className="shell assess-page">
        <div className="notice error">{error}</div>
        <Link className="btn" href="/brain">
          Back to your brain
        </Link>
      </main>
    );
  }
  if (!view) {
    return (
      <main className="shell assess-page">
        <p className="skeleton">Loading your assessment…</p>
      </main>
    );
  }

  const stage = stageOf(view);
  const vivaOpen = view.status === 'viva';

  return (
    <main className="shell assess-page">
      <header className="assess-head">
        <div className="assess-kicker">
          Assessment · attempt {view.attemptNumber}
        </div>
        <h1>{view.conceptLabel}</h1>
        <ol className="assess-stages" aria-label="Progress">
          {STAGES.map((name, i) => (
            <li key={name} className={i < stage ? 'is-done' : i === stage ? 'is-current' : ''} aria-current={i === stage ? 'step' : undefined}>
              {name}
            </li>
          ))}
        </ol>
      </header>

      {view.stuck && view.status !== 'graded' && (
        <div className="notice warn">
          This is attempt {view.attemptNumber} on {view.conceptLabel}. Sometimes a different concept first makes this
          one click — <Link href="/brain">pick another from your brain</Link> and come back. Or carry on; it is your call.
        </div>
      )}

      {error && <div className="notice error">{error}</div>}

      {view.status === 'mcq' && <McqRound questions={view.mcq} busy={busy} onSubmit={(a) => void submitMcq(a)} />}

      {view.status === 'mcq_failed' && (
        <>
          <div className="notice info">
            <strong>
              {view.mcqResult?.score ?? 0} of {view.mcqResult?.total ?? 5}.
            </strong>{' '}
            The viva opens once the basics are solid — go back over the answers below, and the gate reopens{' '}
            {onDate(view.retakeAfter)}.{' '}
            <Link href={`/ask?q=${encodeURIComponent(`Explain ${view.conceptLabel} again — I keep getting the basics wrong`)}`}>
              Ask the tutors to re-explain it
            </Link>
            .
          </div>
          <McqResult view={view} />
        </>
      )}

      {vivaOpen && justGraded && (
        <GradeCard
          grade={justGraded}
          prompt={view.viva[justGraded.questionIndex]?.prompt ?? ''}
          onNext={() => setJustGraded(null)}
        />
      )}

      {vivaOpen && !justGraded && view.nextQuestion !== null && (
        <>
          {view.mcqResult && (
            <p className="muted assess-gate-note">
              Multiple choice passed, {view.mcqResult.score}/{view.mcqResult.total}. Now five open questions, five
              marks each.
            </p>
          )}
          <VivaQuestionCard
            key={view.nextQuestion}
            view={view}
            index={view.nextQuestion}
            busy={busy}
            onSubmit={(answer) => void submitViva(view.nextQuestion as number, answer)}
          />
        </>
      )}

      {view.status === 'graded' && <AssessmentReport view={view} history={history} onRetake={() => void retake()} />}
    </main>
  );
}
