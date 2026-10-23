'use client';

import type { ProgressStep } from '../lib/intakeProgress';

/**
 * One card for everything between the questions and the Stack Brief
 * (PROJECT_LEARNER): each step done, running, waiting or failed, and Try
 * again beside the step that failed. See lib/intakeProgress.ts.
 */
export interface IntakeProgressProps {
  steps: ProgressStep[];
  /** Shown under the failed step. */
  error?: string | null;
  onRetry?: () => void;
}

function Mark({ status }: { status: ProgressStep['status'] }) {
  if (status === 'done') {
    return (
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === 'failed') return <span aria-hidden="true">!</span>;
  return null;
}

const SPOKEN: Record<ProgressStep['status'], string> = {
  done: 'done',
  active: 'in progress',
  todo: 'not started',
  failed: 'failed',
};

export function IntakeProgress({ steps, error, onRetry }: IntakeProgressProps) {
  const failed = steps.some((s) => s.status === 'failed');
  // The bar moves only while the app works; the questions step waits on the learner.
  const working = steps.some((s) => s.status === 'active' && s.id !== 'questions');
  return (
    <section className={`plan-progress${failed ? ' is-failed' : ''}`} aria-label="Planning your project">
      {working && <div className="plan-progress-bar" aria-hidden="true" />}
      <ol className="plan-steps" aria-live="polite">
        {steps.map((step) => (
          <li key={step.id} className={`plan-step is-${step.status}`} aria-current={step.status === 'active' ? 'step' : undefined}>
            <span className="plan-step-mark">
              <Mark status={step.status} />
            </span>
            <span className="plan-step-text">
              <span className="plan-step-label">
                {step.label}
                <span className="sr-only">, {SPOKEN[step.status]}</span>
              </span>
              {/* Keyed by its text, so each new line fades in. */}
              {step.detail && (
                <span className="plan-step-detail" key={step.detail}>
                  {step.detail}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {failed && error && (
        <div className="plan-progress-error" role="alert">
          <p>{error}</p>
          {onRetry && (
            <button type="button" className="btn primary" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      )}
    </section>
  );
}
