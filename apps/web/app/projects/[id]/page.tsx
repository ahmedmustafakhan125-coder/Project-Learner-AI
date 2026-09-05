'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ProjectDetail, StepContent } from '@ai-edu/api-client';
import { ApiError } from '@ai-edu/api-client';

import { AuthGate } from '../../../components/AuthGate';
import { FinishedProject } from '../../../components/FinishedProject';
import { ProjectTutor } from '../../../components/ProjectTutor';
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
  /** The finished-project view replaces the step body rather than sitting under it. */
  const [showFinished, setShowFinished] = useState(false);
  /*
   * The tutor rail.
   *
   * Open state lives here rather than in the panel so it survives switching
   * steps - the conversation spans the project, and having it close every time
   * the learner moves would make it feel like a per-step widget.
   */
  const [tutorOpen, setTutorOpen] = useState(false);
  /*
   * Bumped whenever something the gate reads has changed.
   *
   * The tutor and the hint ladder are driven by the same counters, so pressing
   * submit or opening a hint has to move what the tutor says is outstanding.
   * A token rather than the values themselves: the page does not own them, it
   * only knows when they are stale.
   */
  const [progressToken, setProgressToken] = useState(0);

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

  /**
   * Move the frontier forward after a pass.
   *
   * `advanceStep` has existed on the server since the beginning and nothing
   * ever called it, so `current_step_index` never left 0 and no step ever
   * unlocked. The refetch afterwards is what actually redraws the navigator —
   * the lock state is computed server-side, so the client asks rather than
   * guessing at it.
   */
  const advance = useCallback(
    async (stepIndex: number) => {
      try {
        await api.advanceStep(projectId, stepIndex);
      } catch {
        // A failed advance is not the learner's problem: the attempt passed and
        // is recorded, so the next refetch unlocks the step anyway.
      }
      try {
        setDetail(await api.getProject(projectId));
      } catch {
        // Leave the page as it is; the lock will be right on the next load.
      }
    },
    [projectId],
  );

  /**
   * Write this step again, because it came out wrong.
   *
   * Lives here rather than in StepView because the page owns the cache: the
   * rewritten step has to replace the cached copy or the learner would keep
   * seeing the broken one until a reload.
   */
  const regenerateStep = useCallback(
    async (index: number): Promise<void> => {
      setLoadingStep(index);
      setError(null);
      try {
        const { step } = await api.expandStep(projectId, index, true);
        setSteps((prev) => ({ ...prev, [index]: step }));
      } catch (err) {
        setError(describe(err));
      } finally {
        setLoadingStep(null);
      }
    },
    [projectId],
  );

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
        // simply be fetched again, blocking, when they actually get there. A
        // step refused for being locked is the same: the navigator already says
        // so, and an error banner would just repeat it.
        if (blocking && !(err instanceof ApiError && err.code === 'step_locked')) {
          setError(describe(err));
        }
      } finally {
        inFlight.current.delete(index);
        if (blocking) setLoadingStep(null);
      }
    },
    [projectId, steps],
  );

  /**
   * Keeps the cached step in step with what the learner has done.
   *
   * Steps are cached here and `StepView` is keyed per step, so switching away
   * unmounts it and coming back remounts against whatever was fetched at page
   * load. Without this, everything spent in between — hints opened, the
   * explanation revealed, the checkpoint passed — was read back from the stale
   * copy and looked undone. It was on the server the whole time; it simply was
   * not on screen again until a reload.
   */
  const patchStep = useCallback((index: number, patch: Partial<StepContent>): void => {
    setSteps((prev) => {
      const step = prev[index];
      return step ? { ...prev, [index]: { ...step, ...patch } } : prev;
    });
  }, []);

  useEffect(() => {
    if (!detail || showFinished) return;
    void (async () => {
      await ensureStep(active, true);
      // Warm the next one only after the current one has landed, so the
      // learner's own step is never queued behind a prefetch.
      if (detail.steps.some((s) => s.stepIndex === active + 1)) {
        void ensureStep(active + 1, false);
      }
    })();
  }, [detail, active, ensureStep, showFinished]);

  if (error && !detail) return <main className="shell"><div className="notice error">{error}</div></main>;
  if (!detail) return <main className="shell"><p className="skeleton">Loading project…</p></main>;

  const current = steps[active];
  const activeStep = detail.steps.find((step) => step.stepIndex === active);
  const passedCount = detail.steps.filter((step) => step.passed).length;

  return (
    <main className="shell wide">
      <Link href="/projects" className="page-back">
        <span aria-hidden="true">←</span> Back to library
      </Link>

      <header className="masthead">
        <div>
          <h1>{detail.project.title as string}</h1>
          <div className="sub">
            {showFinished
              ? `${passedCount} of ${detail.steps.length} steps complete`
              : `Step ${active + 1} of ${detail.steps.length}`}
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
                  className={`step-link ${step.unlocked ? '' : 'locked'}`}
                  aria-current={!showFinished && step.stepIndex === active ? 'step' : undefined}
                  onClick={() => {
                    setShowFinished(false);
                    setActive(step.stepIndex);
                  }}
                  // Locked steps stay clickable on purpose: they are readable,
                  // and a control that does nothing when pressed teaches less
                  // than one that opens and explains why it is closed.
                  title={
                    step.unlocked
                      ? undefined
                      : `Readable now — pass step ${step.stepIndex} to start it`
                  }
                >
                  <span className="num">{step.stepIndex + 1}</span>
                  <span className="label">
                    {step.title}
                    <span className="muted"> · {step.estMinutes ?? '?'} min</span>
                  </span>
                  {/* A passed step is the only unambiguous progress signal the
                      navigator has; without it every step looks identical. */}
                  {step.passed && <span className="step-passed" title="Passed">✓</span>}
                  {!step.passed && !step.unlocked && (
                    <span className="step-locked" title="Not open yet">🔒</span>
                  )}
                  {!step.passed && step.unlocked && !step.expanded && (
                    <span className="pending" title="Not written yet">○</span>
                  )}
                </button>
              </li>
            ))}
          </ol>

          {/* The finished project sits at the end of the list because that is
              where it belongs in the sequence — it is what the steps add up to. */}
          <button
            type="button"
            className="step-link step-link-finish"
            aria-current={showFinished ? 'step' : undefined}
            onClick={() => setShowFinished(true)}
          >
            <span className="num">★</span>
            <span className="label">
              Finished project
              <span className="muted"> · README, files &amp; download</span>
            </span>
          </button>
        </nav>

        <section className="step-body">
          {showFinished && (
            <FinishedProject
              projectId={projectId}
              projectTitle={detail.project.title as string}
              passedCount={passedCount}
              totalSteps={detail.steps.length}
            />
          )}

          {!showFinished && loadingStep === active && (
            <p className="skeleton">
              Writing this step<span className="caret" />
            </p>
          )}
          {/* Keyed by step: without it React reuses one instance across steps,
              carrying the previous step's editor contents, attempt count and
              revealed explanation into the next one. */}
          {!showFinished && current && (
            <StepView
              key={active}
              step={current}
              projectId={projectId}
              locked={!activeStep?.unlocked}
              blockedBy={activeStep?.unlocked ? null : active - 1}
              onDraftSaved={(files) => patchStep(active, { draftFiles: files })}
              onStateChange={(patch) => patchStep(active, patch)}
              onRegenerate={() => void regenerateStep(active)}
              onAskTutor={() => setTutorOpen(true)}
              onPassed={() => void advance(active)}
              onGateInputChanged={() => setProgressToken((t) => t + 1)}
            />
          )}
          {/* A locked step beyond the prefetch window has not been written and
              will not be: generation stops one step past the frontier. The stub
              from the blueprint is all there is to show, and saying so beats a
              spinner that never resolves. */}
          {!showFinished && !current && loadingStep !== active && (
            <p className="skeleton">
              {activeStep?.unlocked
                ? 'This step has not been written yet.'
                : `This step is written once you reach it. Pass step ${active} to open it.`}
            </p>
          )}
        </section>

        {/*
          Docked beside the work rather than floating over it: the learner reads
          their code and the answer at the same time, and a panel that covers
          the thing being discussed gets closed to look and reopened to read.
        */}
        <ProjectTutor
          projectId={projectId}
          stepIndex={showFinished ? null : active}
          progressToken={progressToken}
          open={tutorOpen}
          onOpenChange={setTutorOpen}
        />
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
