'use client';

import type { ProjectBlueprint } from '@ai-edu/core';

/**
 * The plan, before anything is committed.
 *
 * Shows the honest numbers — total hours, per-step minutes, prerequisites —
 * because the decision this screen exists to support is "is this the right size
 * for me?". Hiding a 40-hour estimate to make the project look approachable
 * just moves the abandonment to step 4.
 */

export interface BlueprintReviewProps {
  blueprint: ProjectBlueprint;
  busy: boolean;
  onAccept: () => void;
  onRegenerate: () => void;
}

export function BlueprintReview({ blueprint, busy, onAccept, onRegenerate }: BlueprintReviewProps) {
  const totalMinutes = blueprint.steps.reduce((sum, step) => sum + step.estMinutes, 0);

  return (
    <section className="blueprint" aria-label="Proposed project">
      <div className="blueprint-head">
        <h2>{blueprint.title}</h2>
        <p className="summary">{blueprint.summary}</p>
        <div className="facts">
          <span>{blueprint.steps.length} steps</span>
          <span>~{blueprint.estimatedHours} hours</span>
          <span>{Math.round(totalMinutes / blueprint.steps.length)} min per step average</span>
        </div>
      </div>

      <div className="blueprint-grid">
        <div>
          <h3>You will learn</h3>
          <ul className="tight">
            {blueprint.learningObjectives.map((objective) => (
              <li key={objective}>{objective}</li>
            ))}
          </ul>

          {blueprint.prerequisites.length > 0 && (
            <>
              <h3>You should already know</h3>
              <ul className="tight">
                {blueprint.prerequisites.map((prerequisite) => (
                  <li key={prerequisite}>{prerequisite}</li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div>
          <h3>Built with</h3>
          <ul className="stack">
            {blueprint.techStack.map((tech) => (
              <li key={tech.name}>
                <strong>{tech.name}</strong> <span className="muted">— {tech.role}</span>
                {/* The justification is the teaching content, not decoration. */}
                <div className="why">{tech.why}</div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <h3>The steps</h3>
      <ol className="steps">
        {blueprint.steps.map((step, index) => (
          <li key={`${index}-${step.title}`}>
            <div className="step-head">
              <span className="step-title">{step.title}</span>
              <span className="muted">{step.estMinutes} min</span>
            </div>
            <div className="muted">{step.objective}</div>
            {step.concepts.length > 0 && (
              <div className="concepts">
                {step.concepts.map((concept) => (
                  <span className="tag" key={concept}>
                    {concept}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>

      <div className="actions">
        <button className="btn primary" onClick={onAccept} disabled={busy}>
          {busy ? 'Creating…' : 'Start this project'}
        </button>
        <button className="btn" onClick={onRegenerate} disabled={busy}>
          Plan a different one
        </button>
      </div>
      <p className="muted" style={{ marginTop: 10 }}>
        Nothing is saved until you start. Each step is written as you reach it, so the later
        ones can adapt to how you are getting on.
      </p>
    </section>
  );
}
