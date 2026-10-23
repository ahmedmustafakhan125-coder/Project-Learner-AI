import type { DocRef, LayerChoice } from '@ai-edu/core';

import { refsFor } from '../lib/stackBrief';
import { SourcesList } from './SourcesList';
import { VerificationBadge } from './VerificationBadge';

/**
 * One layer of the Stack Brief: what it is, what it does here, why it beat
 * the alternatives, what it costs to learn, how its steps are checked and
 * the documentation behind it. Alternatives fold away under "Other options".
 */
export function LayerCard({ layer, label, sources }: { layer: LayerChoice; label: string; sources: DocRef[] }) {
  return (
    <article className="layer-card" aria-label={`${label}: ${layer.name}`}>
      <header className="layer-head">
        <span className="layer-label">{label}</span>
        <h4>
          {layer.name}
          {layer.versionMajor && <span className="layer-version"> v{layer.versionMajor}</span>}
        </h4>
        {layer.requestedByLearner && <span className="tag">You asked for this</span>}
        <VerificationBadge verification={layer.verification} />
      </header>

      <p className="layer-what">{layer.whatItIs}</p>
      <p>
        <strong>Here:</strong> {layer.roleHere}
      </p>
      <p>
        <strong>Why this one:</strong> {layer.whyChosen}
      </p>

      <div className="layer-proscons">
        <div>
          <h5>Pros</h5>
          <ul className="tight">
            {layer.pros.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
        <div>
          <h5>Cons</h5>
          <ul className="tight">
            {layer.cons.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      </div>

      <p className="muted">
        <strong>To learn:</strong> {layer.learnerCost}
      </p>

      {layer.assumptions.length > 0 && (
        <p className="layer-assumptions muted">Assumed: {layer.assumptions.join('; ')}</p>
      )}

      <SourcesList sources={refsFor(layer, sources)} heading={null} />

      {layer.alternatives.length > 0 && (
        <details className="layer-alternatives">
          <summary>Other options ({layer.alternatives.length})</summary>
          {layer.alternatives.map((alt) => (
            <div className="layer-alt" key={alt.name}>
              <strong>{alt.name}</strong> <span className="muted">· switching later: {alt.switchCost}</span>
              <div className="why">Pick it when {alt.pickWhen}</div>
              <div className="muted">+ {alt.pros.join('; ')}</div>
              <div className="muted">− {alt.cons.join('; ')}</div>
            </div>
          ))}
        </details>
      )}
    </article>
  );
}
