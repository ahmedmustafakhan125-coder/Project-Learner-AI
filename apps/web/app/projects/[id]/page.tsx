'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import type { ProjectDetail, SourceFile, StepContent } from '@ai-edu/api-client';
import { ApiError } from '@ai-edu/api-client';

import { AuthGate } from '../../../components/AuthGate';
import { StepView } from '../../../components/StepView';
import { api } from '../../../lib/api';

/**
 * The project shell: step navigator on the left, the current step on the right.
 *
 * Steps are written on demand, so this component owns the expansion policy —
 * fetch what the learner needs now, then quietly warm the next one while they
 * read. Without the prefetch, finishing a step would mean staring at a spinner
 * every single time.
 */

export default function ProjectPage() {
  return (
    <AuthGate>
      <ProjectShell />
    </AuthGate>
  );
}

function ProjectShell() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;

  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [active, setActive] = useState(0);
  const [steps, setSteps] = useState<Record<number, StepContent>>({});
  const [loadingStep, setLoadingStep] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Guards against a re-render firing a second expansion for a step already in
  // flight — that would bill twice for the same generation.
  const inFlight = useRef<Set<number>>(new Set());

  useEffect(() => {
    api
      .getProject(projectId)
      .then((result) => {
        setDetail(result);
        setActive(result.currentStepIndex);
      })
      .catch((err) => setError(describe(err)));
  }, [projectId]);

  const ensureStep = useCallback(
    async (index: number, blocking: boolean): Promise<void> => {
      if (steps[index] || inFlight.current.has(index)) return;

      inFlight.current.add(index);
      if (blocking) setLoadingStep(index);

      try {
        const { step } = await api.expandStep(projectId, index);
        setSteps((prev) => ({ ...prev, [index]: step }));
        setDetail((prev) =>
          prev
            ? {
                ...prev,
                steps: prev.steps.map((s) => (s.stepIndex === index ? { ...s, expanded: true } : s)),
              }
            : prev,
        );
      } catch (err) {
        // A background prefetch failing is not the learner's problem — it will
        // simply be fetched again, blocking, when they actually get there.
        if (blocking) setError(describe(err));
      } finally {
        inFlight.current.delete(index);
        if (blocking) setLoadingStep(null);
      }
    },
    [projectId, steps],
  );

  // Keeps the cached step in step with what the learner has saved, so returning
  // to a step reopens their work rather than the scaffolding.
  const rememberDraft = useCallback((index: number, files: SourceFile[]): void => {
    setSteps((prev) => {
      const step = prev[index];
      return step ? { ...prev, [index]: { ...step, draftFiles: files } } : prev;
    });
  }, []);

  useEffect(() => {
    if (!detail) return;
    void (async () => {
      await ensureStep(active, true);
      // Warm the next one only after the current one has landed, so the
      // learner's own step is never queued behind a prefetch.
      if (detail.steps.some((s) => s.stepIndex === active + 1)) {
        void ensureStep(active + 1, false);
      }
    })();
  }, [detail, active, ensureStep]);

  if (error && !detail) return <main className="shell"><div className="notice error">{error}</div></main>;
  if (!detail) return <main className="shell"><p className="skeleton">Loading project…</p></main>;

  const current = steps[active];

  return (
    <main className="shell wide">
      <header className="masthead">
        <div>
          <h1>{detail.project.title as string}</h1>
          <div className="sub">
            Step {active + 1} of {detail.steps.length}
          </div>
        </div>
      </header>

      {error && <div className="notice error">{error}</div>}

      <div className="project-layout">
        <nav className="step-nav" aria-label="Steps">
          <ol>
            {detail.steps.map((step) => (
              <li key={step.id}>
                <button
                  className="step-link"
                  aria-current={step.stepIndex === active ? 'step' : undefined}
                  onClick={() => setActive(step.stepIndex)}
                >
                  <span className="num">{step.stepIndex + 1}</span>
                  <span className="label">
                    {step.title}
                    <span className="muted"> · {step.estMinutes ?? '?'} min</span>
                  </span>
                  {/* Marks steps not yet written, so an unwritten step reads as
                      "not there yet" rather than as something broken. */}
                  {!step.expanded && <span className="pending" title="Not written yet">○</span>}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <section className="step-body">
          {loadingStep === active && (
            <p className="skeleton">
              Writing this step<span className="caret" />
            </p>
          )}
          {/* Keyed by step: without it React reuses one instance across steps,
              carrying the previous step's editor contents, attempt count and
              revealed explanation into the next one. */}
          {current && (
            <StepView
              key={active}
              step={current}
              projectId={projectId}
              onDraftSaved={(files) => rememberDraft(active, files)}
            />
          )}
          {!current && loadingStep !== active && (
            <p className="skeleton">This step has not been written yet.</p>
          )}
        </section>
      </div>
    </main>
  );
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'budget_exceeded') return err.message;
    if (err.code === 'generation_failed') return `${err.message} Try opening the step again.`;
    if (err.status === 404) return 'That project does not exist, or is not yours.';
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}
