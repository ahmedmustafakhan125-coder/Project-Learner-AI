import type { AssessmentOffer } from '@ai-edu/api-client';

/**
 * "Want to test whether it stuck?" A suggestion, never homework: dismissible,
 * and after two "not now"s for a concept it stops being offered. The brain's
 * "Test me" button works whatever this says.
 */
export function AssessmentOfferCard({
  offer,
  busy,
  onTest,
  onDismiss,
}: {
  offer: AssessmentOffer;
  busy: boolean;
  onTest: () => void;
  onDismiss: () => void;
}) {
  return (
    <aside className="assess-offer" aria-label="Test yourself">
      <div>
        <strong>You have worked on {offer.label} enough to test it.</strong>{' '}
        <span className="muted">
          Five quick questions, then five open ones marked against a rubric — about fifteen minutes.
        </span>
      </div>
      <div className="assess-offer-actions">
        <button type="button" className="btn primary" onClick={onTest} disabled={busy}>
          {busy ? 'Writing your test…' : 'Test me'}
        </button>
        <button type="button" className="btn" onClick={onDismiss} disabled={busy}>
          Not now
        </button>
      </div>
    </aside>
  );
}
